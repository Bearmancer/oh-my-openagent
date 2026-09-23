# Command semantics

Everything here cost a failed attempt to learn. Read it before improvising.

## Sessions

```bash
bsk session start --json --no-focus --name "<task>"   # keep session_id
bsk session list
bsk session stop <id> --json                          # positional id, not --session
```

Every session-scoped command needs `--session <id>`. `--no-focus` keeps the Agent Window from
stealing focus; drop it only when the user is watching on purpose.

## Reading

| Command | Returns |
|---|---|
| `observe --session <id>` | semantic tree with `@eN` refs and perception probes — **the default read** |
| `snapshot --session <id>` | static accessibility tree |
| `get-html --session <id>` | exact markup, hidden metadata |
| `screenshot --session <id> --out <path>` | PNG; add `--full-page` for a long capture |
| `evaluate "<js>" --session <id> --json` | `{ok, value}` — **check `.ok`; exit code 0 does not mean the script succeeded** |
| `console` / `network` | buffered log lines and responses |

**Refs are reissued by every `observe` and `snapshot`.** Read a ref and act on it in the same
cycle. A ref captured two calls ago silently addresses a different element — this is how a click
lands on the neighbouring row.

`observe --max-tokens <n>` bounds a large page. There is no default cap.

## Acting

| Need | Command |
|---|---|
| Click | `click @e3 --session <id>` |
| Fill | `fill @e3 --value "text" --session <id>` |
| Select | `select @e3 --value "<option value>" --session <id>` |
| Key | `press Enter --ref @e3 --session <id>` |
| Hover | `hover @e3 --session <id>` |
| Scroll into view | `scroll-to @e3 --session <id>` |
| Wheel | `wheel --delta-y 600 --session <id>` |
| Focus / blur | `focus @e3` / `blur @e3` |
| Upload / download | `upload --file <path>` / `download --out <path>` |

Traps:

- `select` takes the option's **value attribute**, not its visible label.
- `fill` and `click` accept a CSS selector; **`press --ref` does not** — it answers
  `ref_not_found` for a selector. `press` without `--ref` goes to the focused node.
- A menu that a `click` opens can be toggled shut by that same click. `focus` then
  `press Enter` opens it reliably.
- Hover-only controls report `element not visible`: hover the trigger, observe, then act on the
  revealed item's fresh ref. Markers like `[has-submenu]` and `[expanded]` identify triggers;
  `observe --probe-hover` finds one when no marker does, at the cost of touching the live page.
- The clipboard is unavailable in a window started `--no-focus` (no document focus), so read
  values out of the DOM instead.

## Borrowing a user tab

```bash
bsk tab list --scope user
bsk tab borrow <tab-id>
bsk tab return <tab-id>
```

Borrowing asks the user to confirm. Never invent a tab id, never repeat a denied borrow, and
always return what you borrowed (`session stop` also returns them).

## Failures

| Symptom | Meaning | Response |
|---|---|---|
| `browsers: []` | extension not connected | ask the user to open the browser / enable the extension |
| daemon missing | idle exit or reboot | none; the next call restarts it |
| `cdp_failed: Cannot access a chrome-extension:// URL of different extension` | another extension injected a frame, so the debugger cannot attach to that tab | transient and page-specific; collapse the work into one `evaluate` and retry, or navigate away and back |
| `permission_denied: element not visible` | hover-gated or clipped control | drive its menu instead |
| `ref_not_found` | stale ref, or a selector passed to `press` | observe again; use a real ref |
| version skew warning | CLI and extension disagree | `bsk update` after finishing sessions; the extension updates through its store |

**Two identical failures select a different approach. A third identical attempt is a defect.**

## Sandboxed hosts

If the host kills background children after each command, the daemon cannot survive between calls.
Set `BSK_AUTO_START=0`, share one `BSK_HOME` across every call, and start
`bsk daemon start --foreground` in the host's persistent background task. Check readiness with
`bsk status --json` in a separate call before continuing. Do not loop on launches, delete runtime
files, or restart a daemon another task is using.
