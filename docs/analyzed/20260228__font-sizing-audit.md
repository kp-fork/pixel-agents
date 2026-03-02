# Font Sizing Audit (2026-02-28)

## 1) Typography Scale

| Token | Size |
|---|---:|
| `--pixel-font-xxs` | 10px |
| `--pixel-font-xs` | 12px |
| `--pixel-font-sm` | 15px |
| `--pixel-font-md` | 16px |
| `--pixel-font-lg` | 18px |
| `--pixel-font-xl` | 20px |
| `--pixel-font-2xl` | 22px |
| `--pixel-font-3xl` | 24px |
| `--pixel-font-4xl` | 26px |
| `--pixel-font-5xl` | 28px |

Source: `webview-ui/src/index.css`

## 2) Size Changes (Before -> After)

| Area | Element | Before | After |
|---|---|---:|---|
| Action bar | Edit action buttons (`Undo/Redo/Save/Reset`) | 22px | `--pixel-font-xl` (20px) |
| Action bar | `Reset?` confirm label | 22px | `--pixel-font-xl` (20px) |
| History hover card | Header container | 19px | `--pixel-font-md` (16px) |
| History hover card | Title | 15px | `--pixel-font-sm` (15px) |
| History hover card | Relative age | 10px | `--pixel-font-xxs` (10px) |
| History hover card | Meta lines (`Last active`, `Created`) | 16px | `--pixel-font-md` (16px) |
| History hover card | Preview text | 18px | `--pixel-font-lg` (18px) |
| Rotate hint | `Press R to rotate` | 20px | `--pixel-font-lg` (18px) |
| Floating overlay | History title chip | 15px | `--pixel-font-sm` (15px) |
| Floating overlay | History age chip | 10px | `--pixel-font-xxs` (10px) |
| Floating overlay | Activity text (sub/main) | 20/22px | `--pixel-font-lg` / `--pixel-font-xl` (18/20px) |
| Floating overlay | Close (`×`) | 26px | `--pixel-font-2xl` (22px) |
| Bottom toolbar | Main buttons (`+ Agent`, `Layout`, `Settings`) | 24px | `--pixel-font-2xl` (22px) |
| Settings modal | Header / menu item / close | 24px | `--pixel-font-2xl` (22px) |
| Settings modal | Toggle checkmark glyph | 12px | `--pixel-font-xs` (12px) |
| Zoom overlay | Zoom level (`2x`) | 26px | `--pixel-font-2xl` (22px) |
| Debug view | Tool/status lines | 22px | `--pixel-font-xl` (20px) |
| Debug view | Agent/close buttons | 26px | `--pixel-font-2xl` (22px) |
| Debug view | Root panel text baseline | 28px | `--pixel-font-3xl` (24px) |
| Editor toolbar | Main tool buttons | 22px | `--pixel-font-xl` (20px) |
| Editor toolbar | Category tabs | 20px | `--pixel-font-lg` (18px) |
| Editor toolbar | Slider labels/values, `Clear`, `Colorize` label | 20px | `--pixel-font-lg` (18px) |
| Agent labels | Sub/main label | 16/18px | `--pixel-font-md` / `--pixel-font-lg` (16/18px) |

## 3) Intent

- Keep history-specific readability choices (`title 15px`, `age 10px`) as-is.
- Reduce oversized controls by one step where the new `Edit Undo` font looked visually heavier.
- Remove hardcoded `px` font-size values in main UI components and bind to shared tokens for future global tuning.
