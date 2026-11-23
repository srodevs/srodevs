// Genera assets/stats.svg y assets/top-langs.svg usando la API GraphQL de GitHub.
// Sin dependencias: requiere Node 18+ (fetch nativo).
// Uso: GITHUB_TOKEN=xxx USERNAME=srodevs node scripts/generate-stats.mjs

import { writeFile, mkdir } from "node:fs/promises";

const TOKEN = process.env.GITHUB_TOKEN;
const USER = process.env.USERNAME || "srodevs";
const OUT = "assets";
const MAX_LANGS = 8;
// Ambas tarjetas comparten tamaño para que se alineen lado a lado en el README
const W = 467, H = 195;

if (!TOKEN) {
  console.error("Falta GITHUB_TOKEN");
  process.exit(1);
}

// Tema algolia
const T = {
  bg: "#050F2C",
  title: "#00AEFF",
  text: "#FFFFFF",
  icon: "#2DDE98",
  border: "#1b2a4e",
};

async function gql(query, variables) {
  const res = await fetch("https://api.github.com/graphql", {
    method: "POST",
    headers: { Authorization: `bearer ${TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ query, variables }),
  });
  const json = await res.json();
  if (!res.ok || json.errors) throw new Error(JSON.stringify(json.errors || json));
  return json.data;
}

const USER_QUERY = `
query($login: String!) {
  user(login: $login) {
    name
    login
    pullRequests { totalCount }
    issues { totalCount }
    contributionsCollection { contributionYears }
    repositoriesContributedTo(contributionTypes: [COMMIT, PULL_REQUEST, ISSUE, REPOSITORY]) { totalCount }
  }
}`;

const YEAR_QUERY = `
query($login: String!, $from: DateTime!, $to: DateTime!) {
  user(login: $login) {
    contributionsCollection(from: $from, to: $to) {
      totalCommitContributions
      restrictedContributionsCount
    }
  }
}`;

const REPOS_QUERY = `
query($login: String!, $after: String) {
  user(login: $login) {
    repositories(first: 100, after: $after, ownerAffiliations: OWNER, isFork: false) {
      pageInfo { hasNextPage endCursor }
      nodes {
        stargazerCount
        languages(first: 10, orderBy: { field: SIZE, direction: DESC }) {
          edges { size node { name color } }
        }
      }
    }
  }
}`;

async function fetchRepos() {
  const repos = [];
  let after = null;
  do {
    const { user } = await gql(REPOS_QUERY, { login: USER, after });
    repos.push(...user.repositories.nodes);
    after = user.repositories.pageInfo.hasNextPage ? user.repositories.pageInfo.endCursor : null;
  } while (after);
  return repos;
}

// Commits de todos los años (equivalente a include_all_commits + count_private)
async function fetchAllCommits(years) {
  const totals = await Promise.all(
    years.map(async (y) => {
      const { user } = await gql(YEAR_QUERY, {
        login: USER,
        from: `${y}-01-01T00:00:00Z`,
        to: `${y}-12-31T23:59:59Z`,
      });
      const c = user.contributionsCollection;
      return c.totalCommitContributions + c.restrictedContributionsCount;
    })
  );
  return totals.reduce((a, b) => a + b, 0);
}

const esc = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

const fmt = (n) => (n >= 1000 ? (n / 1000).toFixed(1).replace(/\.0$/, "") + "k" : String(n));

function statsSvg(user, stars, commits) {
  const rows = [
    ["⭐", "Total Stars", stars],
    ["🕒", "Total Commits", commits],
    ["🔀", "Total PRs", user.pullRequests.totalCount],
    ["❗", "Total Issues", user.issues.totalCount],
    ["📦", "Contribuyó a", user.repositoriesContributedTo.totalCount],
  ];
  const body = rows
    .map(
      ([icon, label, val], i) => `
    <g transform="translate(25, ${70 + i * 26})">
      <text class="icon" x="0" y="0">${icon}</text>
      <text class="label" x="28" y="0">${esc(label)}:</text>
      <text class="value" x="300" y="0">${fmt(val)}</text>
    </g>`
    )
    .join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="GitHub stats de ${esc(user.login)}">
  <style>
    .title { font: 600 18px 'Segoe UI', Ubuntu, Sans-Serif; fill: ${T.title}; }
    .label { font: 600 14px 'Segoe UI', Ubuntu, Sans-Serif; fill: ${T.text}; }
    .value { font: 700 14px 'Segoe UI', Ubuntu, Sans-Serif; fill: ${T.icon}; }
    .icon  { font: 14px sans-serif; }
  </style>
  <rect x="0.5" y="0.5" rx="4.5" width="${W - 1}" height="${H - 1}" fill="${T.bg}" stroke="${T.border}"/>
  <text class="title" x="25" y="35">GitHub Stats de ${esc(user.name || user.login)}</text>${body}
</svg>`;
}

function langsSvg(repos) {
  const totals = {};
  for (const r of repos)
    for (const { size, node } of r.languages.edges) {
      totals[node.name] ??= { size: 0, color: node.color || "#858585" };
      totals[node.name].size += size;
    }
  const sorted = Object.entries(totals).sort((a, b) => b[1].size - a[1].size).slice(0, MAX_LANGS);
  const sum = sorted.reduce((a, [, v]) => a + v.size, 0) || 1;
  const langs = sorted.map(([name, v]) => ({ name, color: v.color, pct: (v.size / sum) * 100 }));

  const barW = W - 50;

  let x = 0;
  const bar = langs
    .map((l) => {
      const w = (l.pct / 100) * barW;
      const seg = `<rect x="${x.toFixed(2)}" y="0" width="${w.toFixed(2)}" height="8" fill="${l.color}"/>`;
      x += w;
      return seg;
    })
    .join("");

  const items = langs
    .map((l, i) => {
      const cx = i % 2 === 0 ? 0 : 210;
      const cy = Math.floor(i / 2) * 26;
      return `
    <g transform="translate(${cx}, ${cy})">
      <circle cx="5" cy="6" r="5" fill="${l.color}"/>
      <text class="lang" x="16" y="10">${esc(l.name)} ${l.pct.toFixed(2)}%</text>
    </g>`;
    })
    .join("");

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="Lenguajes más usados">
  <style>
    .title { font: 600 18px 'Segoe UI', Ubuntu, Sans-Serif; fill: ${T.title}; }
    .lang  { font: 400 13px 'Segoe UI', Ubuntu, Sans-Serif; fill: ${T.text}; }
  </style>
  <rect x="0.5" y="0.5" rx="4.5" width="${W - 1}" height="${H - 1}" fill="${T.bg}" stroke="${T.border}"/>
  <text class="title" x="25" y="35">Lenguajes más usados</text>
  <defs><clipPath id="bar"><rect x="0" y="0" width="${barW}" height="8" rx="4"/></clipPath></defs>
  <g transform="translate(25, 55)"><g clip-path="url(#bar)">${bar}</g></g>
  <g transform="translate(25, 80)">${items}
  </g>
</svg>`;
}

const [{ user }, repos] = await Promise.all([gql(USER_QUERY, { login: USER }), fetchRepos()]);
const stars = repos.reduce((a, r) => a + r.stargazerCount, 0);
const commits = await fetchAllCommits(user.contributionsCollection.contributionYears);

await mkdir(OUT, { recursive: true });
await writeFile(`${OUT}/stats.svg`, statsSvg(user, stars, commits));
await writeFile(`${OUT}/top-langs.svg`, langsSvg(repos));
console.log(`OK: ${OUT}/stats.svg, ${OUT}/top-langs.svg`);
