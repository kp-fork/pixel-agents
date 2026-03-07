# Desktop Interaction Gate Report Template

## Metadata
- Date:
- Branch / Commit:
- Runner:
- OS / Shell:

## Gate Scope
- [ ] `+ Agent` path
- [ ] History session click path
- [ ] Terminal toggle (off/on) path
- [ ] Trace lock (`trace start == trace ack`)
- [ ] Contract loop (stale input/resize/close guard)

## Commands
```bash
npm run test:desktop-interaction
npm run test:desktop
npm run test:desktop-contract-loop
```

## Results
- `test:desktop-interaction`:
- `test:desktop`:
- `test:desktop-contract-loop`:

## Evidence (Key Logs)
- interaction step markers:
- interaction PASS/FAIL marker:
- trace id start/ack:
- stale guard logs:

## Verdict
- [ ] PASS (release gate satisfied)
- [ ] FAIL (blocked)
- Reason:

## Follow-ups
- Action items:
- Owner:
- ETA:
