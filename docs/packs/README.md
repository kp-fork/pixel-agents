# Pixel Agents Pack Spec (Draft, Agent-Friendly)

This file is written for deterministic parsing by AI agents.

## Runtime status

- Menu exists: `Settings -> Import Pack (.zip)`.
- Current extension behavior: ZIP file picker only.
- Pack application to runtime assets/layout: not implemented yet.

## Spec version

- Name: `PackSpecV1`
- `manifest.packVersion` MUST be `1`.

## Canonical ZIP layout

Agent MUST expect these relative paths in the ZIP root:

```text
manifest.json
layouts/default-layout.json
assets/furniture/furniture-catalog.json
assets/furniture/custom/*.png   (optional when catalog.assets is empty)
```

## Required files and rules

### `manifest.json`

- MUST exist.
- MUST be valid JSON object.
- MUST contain:
  - `packVersion` (number, must be `1`)
  - `id` (string, stable unique id)
  - `name` (string)
  - `entryLayout` (string, relative path in ZIP)
  - `furnitureCatalog` (string, relative path in ZIP)
- SHOULD contain:
  - `description`, `author`, `createdAt`

Minimal valid example:

```json
{
  "packVersion": 1,
  "id": "example.template.pack",
  "name": "Template Pack",
  "description": "Minimal Pixel Agents pack template",
  "author": "your-name",
  "createdAt": "2026-02-28T00:00:00.000Z",
  "entryLayout": "layouts/default-layout.json",
  "furnitureCatalog": "assets/furniture/furniture-catalog.json"
}
```

### `layouts/default-layout.json`

- MUST exist at the path referenced by `manifest.entryLayout`.
- MUST be valid JSON.
- MUST satisfy:
  - `version === 1`
  - `cols` and `rows` are positive numbers
  - `tiles` is an array
  - `furniture` is an array
- SHOULD satisfy:
  - `tiles.length === cols * rows`

### `assets/furniture/furniture-catalog.json`

- MUST exist at the path referenced by `manifest.furnitureCatalog`.
- MUST be valid JSON object with `assets` array.
- Each asset item SHOULD include:
  - `id`, `name`, `label`, `category`, `file`, `width`, `height`, `footprintW`, `footprintH`, `isDesk`, `canPlaceOnWalls`
- `asset.file` MUST be path relative to `assets/`.
  - Example: `furniture/custom/office_cubicle_desk.png`

### `assets/furniture/custom/*.png`

- PNG files are optional only when `catalog.assets` is empty.
- If `catalog.assets[i].file` points to a PNG, that file MUST exist in ZIP.

## Validation checklist (for agents)

1. Open ZIP.
2. Assert required files exist.
3. Parse `manifest.json`.
4. Assert `packVersion === 1`.
5. Resolve `entryLayout` and `furnitureCatalog` from manifest.
6. Parse and validate layout minimum fields.
7. Parse catalog and validate asset records.
8. For each catalog asset, verify referenced PNG exists.
9. Report pass/fail with exact missing paths or invalid keys.

## Recommended naming

- Pack id prefix SHOULD be stable namespace.
  - Example: `teamname.theme.office.v1`
- Custom furniture ids SHOULD use a prefix.
  - Example: `TEAM_OFFICE_CUBICLE_DESK`

## Template location

- Template directory: `docs/packs/template/`

Create ZIP from template:

```bash
cd docs/packs/template
zip -r ../../sample-pack.zip .
```
