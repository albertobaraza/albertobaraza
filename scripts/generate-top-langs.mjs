#!/usr/bin/env node
// Aggregates language byte counts across every repo owned by GH_USERNAME
// (public and private, via a PAT with repo scope) and renders an SVG
// "Top Languages" card. Run on a schedule by .github/workflows/top-langs.yml
// so private repos count toward the stats, unlike third-party badge services
// that only see what the public API exposes.

import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const TOKEN = process.env.GH_TOKEN;
const USERNAME = process.env.GH_USERNAME;
if (!TOKEN) throw new Error("GH_TOKEN env var is required");
if (!USERNAME) throw new Error("GH_USERNAME env var is required");

const LANGS_COUNT = Number(process.env.LANGS_COUNT ?? 10);
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
const BG_COLOR = process.env.BG_COLOR ?? "1c1917";
const HIDE_BORDER = process.env.HIDE_BORDER !== "false";
const OUT_PATH = process.env.OUT_PATH ?? "assets/top-langs.svg";

const API = "https://api.github.com";

async function gh(url) {
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "top-langs-generator",
    },
  });
  if (!res.ok) {
    throw new Error(`GitHub API ${res.status} for ${url}: ${await res.text()}`);
  }
  return res.json();
}

async function listAllPages(url) {
  const repos = [];
  for (let page = 1; ; page++) {
    const batch = await gh(`${url}${url.includes("?") ? "&" : "?"}per_page=100&page=${page}`);
    repos.push(...batch);
    if (batch.length < 100) break;
  }
  return repos;
}

async function listOwnedRepos() {
  const owned = await listAllPages(`${API}/user/repos?affiliation=owner&visibility=all`);
  const orgRepos = await Promise.all(
    INCLUDE_ORGS.map((org) => listAllPages(`${API}/orgs/${org}/repos?type=all`)),
  );

  const seen = new Map();
  for (const r of [...owned, ...orgRepos.flat()]) seen.set(r.full_name, r);

  return [...seen.values()].filter(
    (r) => (INCLUDE_FORKS || !r.fork) && !EXCLUDE_REPOS.has(r.name),
  );
}

async function aggregateLanguages(repos) {
  const totals = new Map();
  const results = await Promise.all(
    repos.map((r) => gh(`${API}/repos/${r.full_name}/languages`).catch(() => ({}))),
  );
  for (const langs of results) {
    for (const [name, bytes] of Object.entries(langs)) {
      totals.set(name, (totals.get(name) ?? 0) + bytes);
    }
  }
  return totals;
}

function hashColor(name) {
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = (hash << 5) - hash + name.charCodeAt(i);
  const hue = Math.abs(hash) % 360;
  return `hsl(${hue}, 55%, 55%)`;
}

function renderSvg(topLangs, colorMap) {
  const width = 300;
  const rowHeight = 40;
  const top = 55;
  const height = top + topLangs.length * rowHeight + 15;
  const barWidth = width - 50;

  const sum = topLangs.reduce((acc, [, bytes]) => acc + bytes, 0);

  const rows = topLangs
    .map(([name, bytes], i) => {
      const percent = sum === 0 ? 0 : (bytes / sum) * 100;
      const color = colorMap[name] ?? hashColor(name);
      const filled = (percent / 100) * barWidth;
      const y = i * rowHeight;
      return `
    <g transform="translate(25, ${top + y})">
      <circle cx="5" cy="6" r="5" fill="${color}"/>
      <text x="18" y="10" class="lang-name">${escapeXml(name)}</text>
      <text x="${barWidth}" y="10" class="lang-percent" text-anchor="end">${percent.toFixed(1)}%</text>
      <rect x="0" y="20" width="${barWidth}" height="6" rx="3" fill="#2f2b28"/>
      <rect x="0" y="20" width="${filled.toFixed(2)}" height="6" rx="3" fill="${color}"/>
    </g>`;
    })
    .join("");

  return `<svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" fill="none" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Top Languages">
  <style>
    .header { font: 600 18px 'Segoe UI', Ubuntu, Sans-Serif; fill: #${TITLE_COLOR}; }
    .lang-name, .lang-percent { font: 400 13px 'Segoe UI', Ubuntu, Sans-Serif; fill: #${TEXT_COLOR}; }
  </style>
  <rect x="0.5" y="0.5" rx="4.5" width="${width - 1}" height="${height - 1}" fill="#${BG_COLOR}" stroke="#e4e2e2" stroke-opacity="${HIDE_BORDER ? 0 : 1}"/>
  <text x="25" y="35" class="header">Top Languages</text>
  ${rows}
</svg>
`;
}

function escapeXml(s) {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[c]);
}

async function main() {
  const colorMap = JSON.parse(await readFile(path.join(__dirname, "language-colors.json"), "utf8"));

  const repos = await listOwnedRepos();
  const totals = await aggregateLanguages(repos);

  const topLangs = [...totals.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, LANGS_COUNT);

  const svg = renderSvg(topLangs, colorMap);

  const outPath = path.join(process.cwd(), OUT_PATH);
  await mkdir(path.dirname(outPath), { recursive: true });
  await writeFile(outPath, svg);
  console.log(`Wrote ${outPath} from ${repos.length} repos, ${topLangs.length} languages.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
