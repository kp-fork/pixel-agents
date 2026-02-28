#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PACK_DIR="$ROOT_DIR/packs"
SOURCES_DIR="$PACK_DIR/sources"
GENERATED_DIR="$SOURCES_DIR/default"

LAYOUT_SRC="$ROOT_DIR/webview-ui/public/assets/default-layout.json"
CHARS_SRC_DIR="$ROOT_DIR/webview-ui/public/assets/characters"
CATALOG_SRC="$ROOT_DIR/assets/furniture/furniture-catalog.json"
CUSTOM_SRC_DIR="$ROOT_DIR/assets/furniture/custom"
CHAR_COUNT=6

if [[ ! -f "$LAYOUT_SRC" ]]; then
  echo "Missing default layout: $LAYOUT_SRC"
  exit 1
fi
if [[ ! -f "$CATALOG_SRC" ]]; then
  echo "Missing furniture catalog: $CATALOG_SRC"
  exit 1
fi

rm -rf "$GENERATED_DIR"
mkdir -p "$GENERATED_DIR/layouts" "$GENERATED_DIR/assets/furniture/custom" "$GENERATED_DIR/assets/characters"

cp "$LAYOUT_SRC" "$GENERATED_DIR/layouts/default-layout.json"
cp "$CATALOG_SRC" "$GENERATED_DIR/assets/furniture/furniture-catalog.json"
if [[ -d "$CUSTOM_SRC_DIR" ]]; then
  cp -R "$CUSTOM_SRC_DIR/." "$GENERATED_DIR/assets/furniture/custom/"
fi
has_chars=false
if [[ -d "$CHARS_SRC_DIR" ]]; then
  present=0
  for i in $(seq 0 $((CHAR_COUNT - 1))); do
    if [[ -f "$CHARS_SRC_DIR/char_${i}.png" ]]; then
      present=$((present + 1))
    fi
  done
  if [[ $present -eq $CHAR_COUNT ]]; then
    cp -R "$CHARS_SRC_DIR/." "$GENERATED_DIR/assets/characters/"
    has_chars=true
  elif [[ $present -gt 0 ]]; then
    echo "Incomplete character sprites in $CHARS_SRC_DIR (found $present/$CHAR_COUNT)"
    exit 1
  fi
fi

created_at="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
if [[ "$has_chars" == true ]]; then
  cat > "$GENERATED_DIR/manifest.json" <<MANIFEST
{
  "packVersion": 1,
  "id": "pixel-agents.default-layout.v1",
  "name": "Pixel Agents Default Pack",
  "description": "Default bundled layout + furniture pack",
  "author": "pixel-agents",
  "createdAt": "$created_at",
  "entryLayout": "layouts/default-layout.json",
  "furnitureCatalog": "assets/furniture/furniture-catalog.json",
  "characterSpritesDir": "assets/characters"
}
MANIFEST
else
  cat > "$GENERATED_DIR/manifest.json" <<MANIFEST
{
  "packVersion": 1,
  "id": "pixel-agents.default-layout.v1",
  "name": "Pixel Agents Default Pack",
  "description": "Default bundled layout + furniture pack",
  "author": "pixel-agents",
  "createdAt": "$created_at",
  "entryLayout": "layouts/default-layout.json",
  "furnitureCatalog": "assets/furniture/furniture-catalog.json"
}
MANIFEST
fi

rm -f "$PACK_DIR/default.pack.zip"
(
  cd "$GENERATED_DIR"
  zip -qr "$PACK_DIR/default.pack.zip" .
)

echo "Generated: packs/default.pack.zip"
