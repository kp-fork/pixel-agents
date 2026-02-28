# Pixel Agents Packs

This document defines where pack files live and how to build/use them.

## Directory layout

```text
packs/
  README.md
  template/
    manifest.json
    layouts/default-layout.json
    assets/furniture/furniture-catalog.json
    assets/furniture/custom/*
  sources/
    <pack-name>/
      manifest.json
      layouts/default-layout.json
      assets/furniture/furniture-catalog.json
      assets/furniture/custom/*
  *.pack.zip
```

- `packs/sources/<pack-name>/...`: unpacked editable source of each pack.
- `packs/template/...`: starter template for new packs.
- `packs/*.pack.zip`: distributable/importable pack files.

## Build a pack

Generic command:

```bash
npm run build:pack -- <src-dir> <output-dir>
```

Example:

```bash
npm run build:pack -- packs/template packs
```

Output:

- `<output-dir>/<src-dir-basename>.pack.zip`

## Build all layout packs from docs/layouts

```bash
packs/build-layout-packs.sh
```

Outputs:

- `packs/*.pack.zip`
- `packs/sources/<layout-name>/...`

## Build default bundled pack zip

```bash
packs/build-default-pack.sh
```

Outputs:

- `packs/default.pack.zip`
- `packs/sources/default/...`

## Use a pack in extension

1. Open Pixel Agents panel.
2. `Layout` -> `From Pack (.zip)`.
3. Select one of `packs/*.pack.zip`.
4. Extension validates and installs it to `~/.pixel-agents/pack-current`.
5. Layout, furniture, and optional character sprites are applied immediately.

## Runtime notes

- Active pack persists across reloads.
- On first run, if no active pack exists, extension installs bundled default pack.

## Pack format (PackSpecV1)

`manifest.json` must include:

- `packVersion` (must be `1`)
- `id` (string)
- `name` (string)
- `entryLayout` (relative path)
- `furnitureCatalog` (relative path)
- `characterSpritesDir` (optional, relative path)

Canonical pack root:

```text
manifest.json
layouts/default-layout.json
assets/furniture/furniture-catalog.json
assets/furniture/custom/*.png
assets/characters/char_0.png ... char_5.png (optional)
```
