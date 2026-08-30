#!/usr/bin/env node
// Fetches commit counts per repository for GH_USERNAME over the last
// DAYS_BACK days by listing owned repos (REST, same as generate-top-langs.mjs)
// and querying each one's default-branch commit history directly (GraphQL),
// so private repos count too. This only requires repo read access, unlike
// the contributionsCollection API, which is additionally gated by the
// "Include private contributions on my profile" setting. Renders an SVG
// "Most Active Repos" card in the same visual style as top-langs.svg. Run
// on a schedule by .github/workflows/recent-repos.yml.

import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const TOKEN = process.env.GH_TOKEN;
const USERNAME = process.env.GH_USERNAME;
if (!TOKEN) throw new Error("GH_TOKEN env var is required");
if (!USERNAME) throw new Error("GH_USERNAME env var is required");

const REPOS_COUNT = Number(process.env.REPOS_COUNT ?? 5);
const DAYS_BACK = Number(process.env.DAYS_BACK ?? 180);
const INCLUDE_FORKS = process.env.INCLUDE_FORKS === "true";
const EXCLUDE_REPOS = new Set(
  (process.env.EXCLUDE_REPOS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
);
const INCLUDE_ORGS = (process.env.INCLUDE_ORGS ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const TITLE_COLOR = process.env.TITLE_COLOR ?? "0891b2";
const TEXT_COLOR = process.env.TEXT_COLOR ?? "ffffff";
const SUBTITLE_COLOR = process.env.SUBTITLE_COLOR ?? "a8a29e";
const BG_COLOR = process.env.BG_COLOR ?? "1c1917";
const HIDE_BORDER = process.env.HIDE_BORDER !== "false";
const OUT_PATH = process.env.OUT_PATH ?? "assets/recent-repos.svg";

const REST_API = "https://api.github.com";
const GRAPHQL_API = "https://api.github.com/graphql";
const BATCH_SIZE = 40;

async function rest(url) {
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "recent-repos-generator",
    },
  });
  if (!res.ok) {
    throw new Error(`GitHub API ${res.status} for ${url}: ${await res.text()}`);
  }
  return res.json();
}

async function graphql(query, variables) {
  const res = await fetch(GRAPHQL_API, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      "Content-Type": "application/json",
      "User-Agent": "recent-repos-generator",
    },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) {
    throw new Error(`GitHub GraphQL API ${res.status}: ${await res.text()}`);
  }
  const json = await res.json();
  if (json.errors) {
    throw new Error(`GitHub GraphQL errors: ${JSON.stringify(json.errors)}`);
  }
  return json.data;
}

async function listAllPages(url) {
  const items = [];
  for (let page = 1; ; page++) {
    const batch = await rest(`${url}${url.includes("?") ? "&" : "?"}per_page=100&page=${page}`);
    items.push(...batch);
    if (batch.length < 100) break;
  }
  return items;
}

async function listOwnedRepos() {
  const owned = await listAllPages(`${REST_API}/user/repos?affiliation=owner&visibility=all`);
  const orgRepos = await Promise.all(
    INCLUDE_ORGS.map((org) => listAllPages(`${REST_API}/orgs/${org}/repos?type=all`)),
  );

  const seen = new Map();
  for (const r of [...owned, ...orgRepos.flat()]) seen.set(r.full_name, r);

  return [...seen.values()].filter(
    (r) => (INCLUDE_FORKS || !r.fork) && !EXCLUDE_REPOS.has(r.name),
  );
}

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

async function fetchCommitCounts(repos, authorId, from, to) {
  const counts = new Map();

  for (const batch of chunk(repos, BATCH_SIZE)) {
    const fields = batch
      .map(
        (r, i) => `r${i}: repository(owner: ${JSON.stringify(r.owner.login)}, name: ${JSON.stringify(r.name)}) {
          defaultBranchRef {
            target {
              ... on Commit {
                history(since: $from, until: $to, author: { id: $authorId }) {
                  totalCount
                }
              }
            }
          }
        }`,
      )
      .join("\n");

    const query = `query($from: GitTimestamp!, $to: GitTimestamp!, $authorId: ID!) {\n${fields}\n}`;
    const data = await graphql(query, { from, to, authorId });

    batch.forEach((r, i) => {
      const count = data[`r${i}`]?.defaultBranchRef?.target?.history?.totalCount ?? 0;
      if (count > 0) counts.set(r.full_name, count);
    });
  }

  return counts;
}

function truncate(name, maxChars = 28) {
  return name.length > maxChars ? `${name.slice(0, maxChars - 1)}…` : name;
}

function hashColor(name) {
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = (hash << 5) - hash + name.charCodeAt(i);
  const hue = Math.abs(hash) % 360;
  return `hsl(${hue}, 55%, 55%)`;
}

function renderSvg(repos, days) {
  const width = 300;
  const rowHeight = 40;
  const top = 70;
  const height = top + repos.length * rowHeight + 15;
  const barWidth = width - 50;

  const maxCount = Math.max(...repos.map((r) => r.count), 1);

  const rows = repos
    .map(({ name, count, color }, i) => {
      const filled = (count / maxCount) * barWidth;
      const y = i * rowHeight;
      return `
    <g transform="translate(25, ${top + y})">
      <circle cx="5" cy="6" r="5" fill="${color}"/>
      <text x="18" y="10" class="repo-name">${escapeXml(truncate(name))}</text>
      <text x="${barWidth}" y="10" class="repo-count" text-anchor="end">${count}</text>
      <rect x="0" y="20" width="${barWidth}" height="6" rx="3" fill="#2f2b28"/>
      <rect x="0" y="20" width="${filled.toFixed(2)}" height="6" rx="3" fill="${color}"/>
    </g>`;
    })
    .join("");

  return `<svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" fill="none" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Most Active Repos">
  <style>
    .header { font: 600 18px 'Segoe UI', Ubuntu, Sans-Serif; fill: #${TITLE_COLOR}; }
    .subtitle { font: 400 12px 'Segoe UI', Ubuntu, Sans-Serif; fill: #${SUBTITLE_COLOR}; }
    .repo-name, .repo-count { font: 400 13px 'Segoe UI', Ubuntu, Sans-Serif; fill: #${TEXT_COLOR}; }
  </style>
  <rect x="0.5" y="0.5" rx="4.5" width="${width - 1}" height="${height - 1}" fill="#${BG_COLOR}" stroke="#e4e2e2" stroke-opacity="${HIDE_BORDER ? 0 : 1}"/>
  <text x="25" y="35" class="header">Most Active Repos</text>
  <text x="25" y="53" class="subtitle">commits, last ${days} days</text>
  ${rows}
</svg>
`;
}

function escapeXml(s) {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[c]);
}

async function main() {
  const colorMap = JSON.parse(await readFile(path.join(__dirname, "language-colors.json"), "utf8"));

  const to = new Date();
  const from = new Date(to.getTime() - DAYS_BACK * 24 * 60 * 60 * 1000);

  const [repos, me] = await Promise.all([listOwnedRepos(), rest(`${REST_API}/user`)]);
  const counts = await fetchCommitCounts(repos, me.node_id, from.toISOString(), to.toISOString());
  const reposByFullName = new Map(repos.map((r) => [r.full_name, r]));

  const result = [...counts.entries()]
    .map(([fullName, count]) => {
      const r = reposByFullName.get(fullName);
      return {
        name: r.name,
        count,
        color: (r.language && colorMap[r.language]) ?? hashColor(r.name),
      };
    })
    .sort((a, b) => b.count - a.count)
    .slice(0, REPOS_COUNT);

  const svg = renderSvg(result, DAYS_BACK);

  const outPath = path.join(process.cwd(), OUT_PATH);
  await mkdir(path.dirname(outPath), { recursive: true });
  await writeFile(outPath, svg);
  console.log(`Wrote ${outPath} from ${result.length} repos (last ${DAYS_BACK} days).`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
