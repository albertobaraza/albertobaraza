#!/usr/bin/env node
// Fetches commit contribution counts per repository for GH_USERNAME over the
// last DAYS_BACK days (via the GraphQL contributionsCollection API, so private
// repos count too) and renders an SVG "Most Active Repos" card in the same
// visual style as top-langs.svg. Run on a schedule by
// .github/workflows/recent-repos.yml.

import { writeFile, mkdir } from "node:fs/promises";
import path from "node:path";

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

const TITLE_COLOR = process.env.TITLE_COLOR ?? "0891b2";
const TEXT_COLOR = process.env.TEXT_COLOR ?? "ffffff";
const SUBTITLE_COLOR = process.env.SUBTITLE_COLOR ?? "a8a29e";
const BG_COLOR = process.env.BG_COLOR ?? "1c1917";
const HIDE_BORDER = process.env.HIDE_BORDER !== "false";
const OUT_PATH = process.env.OUT_PATH ?? "assets/recent-repos.svg";

const API = "https://api.github.com/graphql";

async function fetchCommitsByRepo(from, to) {
  const query = `
    query($from: DateTime!, $to: DateTime!) {
      viewer {
        contributionsCollection(from: $from, to: $to) {
          commitContributionsByRepository(maxRepositories: 100) {
            repository {
              name
              isFork
              owner { login }
              primaryLanguage { name color }
            }
            contributions { totalCount }
          }
        }
      }
    }`;

  const res = await fetch(API, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      "Content-Type": "application/json",
      "User-Agent": "recent-repos-generator",
    },
    body: JSON.stringify({ query, variables: { from, to } }),
  });
  if (!res.ok) {
    throw new Error(`GitHub GraphQL API ${res.status}: ${await res.text()}`);
  }
  const json = await res.json();
  if (json.errors) {
    throw new Error(`GitHub GraphQL errors: ${JSON.stringify(json.errors)}`);
  }
  return json.data.viewer.contributionsCollection.commitContributionsByRepository;
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
  const to = new Date();
  const from = new Date(to.getTime() - DAYS_BACK * 24 * 60 * 60 * 1000);

  const byRepo = await fetchCommitsByRepo(from.toISOString(), to.toISOString());

  const repos = byRepo
    .filter(
      (r) =>
        r.repository.owner.login.toLowerCase() === USERNAME.toLowerCase() &&
        (INCLUDE_FORKS || !r.repository.isFork) &&
        !EXCLUDE_REPOS.has(r.repository.name),
    )
    .map((r) => ({
      name: r.repository.name,
      count: r.contributions.totalCount,
      color: r.repository.primaryLanguage?.color ?? hashColor(r.repository.name),
    }))
    .sort((a, b) => b.count - a.count)
    .slice(0, REPOS_COUNT);

  const svg = renderSvg(repos, DAYS_BACK);

  const outPath = path.join(process.cwd(), OUT_PATH);
  await mkdir(path.dirname(outPath), { recursive: true });
  await writeFile(outPath, svg);
  console.log(`Wrote ${outPath} from ${repos.length} repos (last ${DAYS_BACK} days).`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
