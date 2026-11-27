#!/usr/bin/env bash
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PREFIX="${MIRROR_PREFIX:-ghcr.io/xuyooo/qap}"
SELECT="${SELECT_IMAGE:-all}"
REPORT="${MIRROR_REPORT:-mirror-digests.tsv}"
[[ "$PREFIX" == "ghcr.io/xuyooo/qap" ]] || { echo "Unexpected mirror prefix" >&2; exit 1; }
if [[ "$SELECT" != all ]] && ! awk -F"|" -v id="$SELECT" '$1 == id {found=1} END {exit !found}' "$DIR/third-party-images.txt"; then
  echo "Unknown image ID: $SELECT" >&2; exit 1
fi
printf "id\tupstream\tmirror\tdigest\n" > "$REPORT"
while IFS="|" read -r id source suffix; do
  [[ -z "$id" || "$id" == \#* ]] && continue
  [[ "$SELECT" == all || "$id" == "$SELECT" ]] || continue
  [[ -n "$source" && -n "$suffix" ]] || { echo "Invalid image entry: $id" >&2; exit 1; }
  target="$PREFIX/$suffix"
  echo "==> $source -> $target"
  # Resolve the upstream tag once, then copy by digest so a mutable tag
  # cannot change between inspection and copy. Hash the raw manifest bytes.
  digest="sha256:$(skopeo inspect --retry-times 3 --raw "docker://$source" | sha256sum | cut -d" " -f1)"
  pinned="${source%:*}@$digest"
  skopeo copy --retry-times 3 --all --preserve-digests "docker://$pinned" "docker://$target"
  actual="sha256:$(skopeo inspect --retry-times 3 --raw "docker://$target" | sha256sum | cut -d" " -f1)"
  [[ "$actual" == "$digest" ]] || { echo "Manifest digest mismatch: $id" >&2; exit 1; }
  printf "%s\t%s\t%s\t%s\n" "$id" "$source" "$target" "$digest" >> "$REPORT"
  if [[ -n "${GITHUB_STEP_SUMMARY:-}" ]]; then
    printf -- "- `%s` → `%s@%s`\n" "$source" "${target%:*}" "$digest" >> "$GITHUB_STEP_SUMMARY"
  fi
done < "$DIR/third-party-images.txt"
