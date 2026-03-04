# Quality Gate Policy

## Required Checks
- `npm run check-types`
- `npm run test:runtime`
- `npm run quality:lint-budget`
- `npm run build`

## Lint Policy
- Lint **errors** are always blocking.
- Lint **warnings** are controlled by `docs/quality/lint-warning-budget.json`.
- A change is blocking if warning count exceeds the budget.
- When intentionally reducing warnings, update the budget downward in the same PR.

## Release Gate
- `npm run verify:ops` must pass before packaging.
- `npm run verify:ops:vsix` is the packaging gate for release artifacts.
