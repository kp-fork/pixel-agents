#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LAYOUT_DIR="$ROOT_DIR/docs/layouts"
PACK_DIR="$ROOT_DIR/packs"
SOURCES_DIR="$PACK_DIR/sources"

mkdir -p "$SOURCES_DIR"

shopt -s nullglob
layout_files=("$LAYOUT_DIR"/*.json)

if [[ ${#layout_files[@]} -eq 0 ]]; then
  echo "No layout json files found in $LAYOUT_DIR"
  exit 0
fi

created_at="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
count=0

for layout_path in "${layout_files[@]}"; do
  base="$(basename "$layout_path" .json)"
  slug="${base#*__}"

  pack_source_dir="$SOURCES_DIR/$base"
  pack_zip_path="$PACK_DIR/${base}.pack.zip"

  rm -rf "$pack_source_dir"
  rm -f "$pack_zip_path"

  mkdir -p "$pack_source_dir/layouts" "$pack_source_dir/assets/furniture/custom"
  cp "$layout_path" "$pack_source_dir/layouts/default-layout.json"

  cat > "$pack_source_dir/assets/furniture/furniture-catalog.json" <<CATALOG
{
  "generatedAt": "$created_at",
  "assets": []
}
CATALOG

  cat > "$pack_source_dir/manifest.json" <<MANIFEST
{
  "packVersion": 1,
  "id": "kp.pixel-agents.layout.${slug}.v1",
  "name": "Pixel Agents ${slug} Pack",
  "description": "Generated from docs/layouts/${base}.json",
  "author": "pixel-agents",
  "createdAt": "$created_at",
  "entryLayout": "layouts/default-layout.json",
  "furnitureCatalog": "assets/furniture/furniture-catalog.json"
}
MANIFEST

  (
    cd "$pack_source_dir"
    zip -qr "$pack_zip_path" .
  )

  echo "Generated: ${pack_zip_path#$ROOT_DIR/}"
  count=$((count + 1))
done

echo "Done. Generated $count pack(s)."
