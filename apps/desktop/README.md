# Desktop Host (Electrobun Prototype)

Experimental desktop host scaffold for Pixel Agents.

## Purpose
- Validate host-agnostic rendering flow outside VS Code.
- Keep runtime minimal while bridge contracts stabilize.
- Open a real desktop window via Electrobun for integration testing.

## Run
```bash
# from repository root (builds webview bundle + runs desktop host)
npm run dev:desktop
```

Direct desktop-host run (requires `dist/webview` prepared first):
```bash
# one-time dependency install
npm --prefix apps/desktop install

# build the shared webview bundle
npm run build:webview

# starts Electrobun dev runtime and opens a window
npm --prefix apps/desktop run app:desktop:start
```

Console-only prototype flow:
```bash
npm --prefix apps/desktop run app:desktop:start:console
```
