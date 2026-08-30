#!/usr/bin/env bash
# Read-only sanity check for generate-top-langs.mjs: prints a per-repo language
# breakdown plus the aggregated totals, and writes the same data as JSON to
# data/summary.json and data/by-repo.json (gitignored) so you can eyeball
# whether the numbers behind assets/top-langs.svg actually match reality.
# Uses the same filtering rules (owner-affiliated repos, forks excluded by
# default) via `gh api`.
#
# Note: GitHub's languages API reports bytes per language, not line counts —
# that's the metric used throughout ("count" = bytes).
set -euo pipefail

GH_USERNAME="${GH_USERNAME:-$(gh api user --jq .login)}"
INCLUDE_FORKS="${INCLUDE_FORKS:-false}"
EXCLUDE_REPOS="${EXCLUDE_REPOS:-}"

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DATA_DIR="${DATA_DIR:-${REPO_ROOT}/data}"
SUMMARY_OUT_PATH="${SUMMARY_OUT_PATH:-${DATA_DIR}/summary.json}"
BY_REPO_OUT_PATH="${BY_REPO_OUT_PATH:-${DATA_DIR}/by-repo.json}"

IFS=',' read -ra EXCLUDE_ARR <<< "$EXCLUDE_REPOS"
exclude_json=$(printf '%s\n' "${EXCLUDE_ARR[@]}" | jq -R . | jq -s .)

echo "Fetching repos owned by ${GH_USERNAME}..." >&2

repos=$(gh api --paginate "/user/repos?per_page=100&affiliation=owner&visibility=all" \
  --jq '.[] | {name, full_name, fork, private}')

repos=$(jq -s \
  --argjson include_forks "$INCLUDE_FORKS" \
  --argjson exclude "$exclude_json" \
  '[.[] | select(($include_forks or (.fork | not)) and (.name as $n | $exclude | index($n) | not))]' \
  <<< "$repos")

repo_count=$(jq 'length' <<< "$repos")
echo "Considering ${repo_count} repos (forks $( [ "$INCLUDE_FORKS" = true ] && echo included || echo excluded))." >&2
echo

# by_repo_entries accumulates [{full_name, visibility, languages: {name: bytes}}, ...]
by_repo_entries="[]"

echo "=== Per-repo breakdown ==="
while IFS= read -r repo; do
  full_name=$(jq -r '.full_name' <<< "$repo")
  visibility=$(jq -r 'if .private then "private" else "public" end' <<< "$repo")

  langs=$(gh api "/repos/${full_name}/languages")
  total=$(jq '[.[]] | add // 0' <<< "$langs")

  if [ "$total" -eq 0 ]; then
    echo "- ${full_name} (${visibility}): no detected languages"
  else
    echo "- ${full_name} (${visibility}), ${total} bytes:"
    jq -r --argjson total "$total" \
      'to_entries | sort_by(-.value) | .[] | "    \(.key): \(.value) bytes (\((.value / $total * 100) | . * 10 | round / 10)%)"' \
      <<< "$langs"
  fi

  by_repo_entries=$(jq \
    --arg full_name "$full_name" \
    --arg visibility "$visibility" \
    --argjson langs "$langs" \
    --argjson total "$total" \
    '. + [{
      full_name: $full_name,
      visibility: $visibility,
      total_count: $total,
      languages: (
        $langs | to_entries | sort_by(-.value) | map({
          name: .key,
          count: .value,
          percent: (if $total == 0 then 0 else ((.value / $total * 100) | . * 10 | round / 10) end)
        })
      )
    }]' \
    <<< "$by_repo_entries")
done < <(jq -c '.[]' <<< "$repos")

echo
echo "=== Aggregated totals (what the SVG should show) ==="
grand_total=$(jq '[.[].languages[].count] | add // 0' <<< "$by_repo_entries")

summary_languages=$(jq --argjson total "$grand_total" \
  '[.[].languages[]] | group_by(.name) | map({name: .[0].name, count: (map(.count) | add)}) | sort_by(-.count) |
   map(. + {percent: (if $total == 0 then 0 else ((.count / $total * 100) | . * 10 | round / 10) end)})' \
  <<< "$by_repo_entries")

jq -r '.[] | "\(.name): \(.count) bytes (\(.percent)%)"' <<< "$summary_languages"

echo
echo "Grand total bytes across all counted repos: ${grand_total}"

mkdir -p "$DATA_DIR"
generated_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

jq -n \
  --arg generated_at "$generated_at" \
  --arg username "$GH_USERNAME" \
  --argjson repo_count "$repo_count" \
  --argjson grand_total "$grand_total" \
  --argjson summary_languages "$summary_languages" \
  '{
    generated_at: $generated_at,
    username: $username,
    repo_count: $repo_count,
    unit: "bytes",
    total_count: $grand_total,
    languages: $summary_languages
  }' > "$SUMMARY_OUT_PATH"

jq -n \
  --arg generated_at "$generated_at" \
  --arg username "$GH_USERNAME" \
  --argjson by_repo_entries "$by_repo_entries" \
  '{
    generated_at: $generated_at,
    username: $username,
    unit: "bytes",
    repos: (
      $by_repo_entries | map({key: .full_name, value: {
        visibility: .visibility,
        total_count: .total_count,
        languages: .languages
      }}) | from_entries
    )
  }' > "$BY_REPO_OUT_PATH"

echo
echo "Wrote ${SUMMARY_OUT_PATH}"
echo "Wrote ${BY_REPO_OUT_PATH}"
