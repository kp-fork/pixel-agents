# Pack Template Usage

## Fill these files

1. `manifest.json`
2. `layouts/default-layout.json`
3. `assets/furniture/furniture-catalog.json`
4. `assets/furniture/custom/*.png` (if catalog has assets)

## Rules

- Keep all paths relative to ZIP root.
- In catalog, `file` paths are relative to `assets/`.
  - Example: `furniture/custom/example.png`

## Build ZIP

```bash
cd packs/template
zip -r ../sample-pack.zip .
```

Or use the project command:

```bash
npm run build:pack -- packs/template packs
```
