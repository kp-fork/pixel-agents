# Desktop Electrobun Host (Prototype)

Experimental desktop host scaffold for Pixel Agents.

## Purpose
- Validate host-agnostic rendering flow outside VS Code.
- Keep runtime minimal while bridge contracts stabilize.
- Open a real desktop window via Electrobun for integration testing.

## Run
```bash
# one-time dependency install
npm --prefix apps/desktop-electrobun install

# starts Electrobun dev runtime and opens a window
npm --prefix apps/desktop-electrobun run start
```

Console-only prototype flow:
```bash
npm --prefix apps/desktop-electrobun run start:console
```
