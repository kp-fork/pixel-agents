# Release Checklist

## Preconditions
- Clean working tree except intended release changes.
- `settings.json` in repo root reviewed (if used for local desktop-host tests).

## Quality Gates
Run in order:

```bash
npm run check-types
npm run test:runtime
npm run quality:lint-budget
npm run build
npm run package:vsix
```

## Expected Results
- `check-types`: pass
- `test:runtime`: pass
- `quality:lint-budget`: pass (no lint errors, warning count <= budget)
- `build`: pass
- `package:vsix`: produces `pixel-agents-local.vsix`

## Install Smoke Test
```bash
npm run install:vsix
```

Verify:
- `Pixel Agents: Show Runtime Info` logs full runtime snapshot to Output channel.
- History characters honor configured lookback/max-visible settings.
- `+ Agent` and history-session resume both open/focus the expected terminal.
