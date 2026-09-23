# Installing the attached engine

Three pieces. The agent can install exactly one of them.

| Piece | Channel | Automatable |
|---|---|---|
| `bsk` CLI + daemon | upstream installer, GitHub Releases | **yes** |
| Browser extension | Chrome Web Store / Edge Add-ons | **no — a human clicks Install** |
| Daemon process | auto-starts on any `bsk` call | nothing to do |

## Supported

| | |
|---|---|
| Operating systems | macOS (Apple Silicon and Intel), Linux (x64, ARM64), Windows x64 |
| Browsers | Chrome, Microsoft Edge. Other Chromium browsers work where they accept store builds. |

## 1. The CLI

```bash
node "<skill-root>/scripts/browser-install.mjs"
```

That wraps upstream's official installer:

```bash
# macOS / Linux
curl -fsSL https://raw.githubusercontent.com/Tencent/BrowserSkill/main/install.sh | sh
export PATH="${BSK_INSTALL_DIR:-$HOME/.local/bin}:$PATH"

# Windows (PowerShell)
irm https://raw.githubusercontent.com/Tencent/BrowserSkill/main/install.ps1 | iex
```

The Unix installer cannot change its parent shell's `PATH`. A shell opened before the install may
still miss it, so either re-export in each call or use the absolute path (`$HOME/.local/bin/bsk`,
`bsk.exe` on Windows). Verify with `bsk --version`.

## 2. The extension

Give the user the listing for their browser and wait:

- Chrome: https://chromewebstore.google.com/detail/hhcmgoofomhgciiibhipgmgkgnoenaoi
- Edge: https://microsoftedge.microsoft.com/addons/detail/browserskill/emacgiaaaiojkkpkddmmdfhmokgmnikg

Then confirm it landed:

```bash
bsk status --json     # a non-empty "browsers" array means connected
```

An empty `browsers` list is not a failure to work around. Either the browser is closed or the
extension is not enabled; say which and ask.

## 3. Do not install upstream's skill

Upstream ships its own agent skill through `bsk install-skill`. **Do not run it here.** This
package already provides the skill, and upstream's copy installs under a different name into the
user skill directory, which takes precedence over a shipped skill — two descriptions of the same
CLI, one of them shadowing the one that knows about this package's recipes and helper scripts.

## Diagnosing

```bash
node "<skill-root>/scripts/browser-doctor.mjs"          # this package's view
bsk doctor                                              # upstream's own checks
bsk logs                                                # daemon log
```

The daemon exits about ten minutes after the last browser disconnects and is not a system service,
so a reboot also stops it. Both heal on the next `bsk` call — no repair needed.
