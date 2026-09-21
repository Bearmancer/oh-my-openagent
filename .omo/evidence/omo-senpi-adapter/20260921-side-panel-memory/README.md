# Side panel - MEMORY section (increments 3 + 4 + 6)

Slug: `20260921-side-panel-memory`. Branch `feat/senpi-side-panel` (head of PR #8092).

## WHAT WAS TESTED

The new `memory` block of the side panel, on the real `senpi` binary, driven by a mouse and by a
real turn - not by a unit fake:

- `bun test packages/omo-senpi/src/components/side-panel` - 361 pass / 0 fail (32 new).
- `tsgo --noEmit -p packages/omo-senpi/tsconfig.json` - exit 0. Root `bun run typecheck` - exit 0.
- RED-then-GREEN for both new units, recorded verbatim in `red-then-green.txt`: the two test files
  failed with `Cannot find module './memory'` before a line of implementation existed.
- Live: `omo-panel --tui-mode fullscreen` (the branch build, isolated agent dir `~/.omo-panel/agent`)
  in a 200x50 tmux, cwd `/tmp/panel-memory-qa`, with `OMO_MEMORY_HOME` pointed at a throwaway
  memory root inside that workspace. The real `~/.omo/memory` was never read or written.
- The panel ran on DEFAULT section switches, which is the shipped path: an `omo.json` dropped in
  that scratch directory is not picked up (the loader resolves a project root, and a bare `/tmp`
  directory is not one), so `resolveOmoSidePanelSettings` answered the defaults over the user's
  global block - `sections.memory: true` among them. Verified directly rather than assumed:
  `loadSenpiOmoConfig({ cwd: "/tmp/panel-memory-qa" })` -> `sections` all `true`, `width: "26%"`.
  The section switch itself is covered by the wiring test that proves an off section never even
  resolves an identity.
- Seeded before the session: a `park.json` describing a parked identity (streak 3, parked two
  hours ago, a non-retryable bwrap failure with a 190-character detail) and a facts queue holding
  three batch files plus its own `consumed.json` and `cursor/` bookkeeping.
- Seeded into the LIVE session afterwards: a recall ledger with two surfaced paths and one pending
  nudge carrying the live session id.

## WHAT WAS OBSERVED

The column drew the block from the identity the host itself resolves
(`capture-memory-parked-200x50.txt`):

```
MEMORY  panel-memory-qa-9669387b
reflect parked · probe in 3h59
facts   3 queued
```

Three things this proves at once: the identity matches `resolveMemoryIdentity` over the workspace
cwd, the probe countdown is computed from `parkedAt` + the six-hour interval (parked 2h ago ->
3h59 left), and the queue count is 3 out of 5 directory entries, so `consumed.json` and `cursor/`
were correctly not counted as backlog.

A real SGR click on the `reflect` row (`ESC[<0;157;19M` / `m`) opened the frame
(`capture-memory-detail-frame-200x50.txt`):

```
memory
id      panel-memory-qa-9669387b
streak  3 failed
parked  2026-09-21T05:29:05.604Z
probe   2026-09-21T11:29:05.604Z
facts   3 queued
recall  nothing held

reflection sandbox refused to start

bwrap: Creating new namespace failed: Operation
not permitted. The kernel denies unprivileged
user namespaces on this host, so every automatic
reflection run dies before the model is reached.
```

The detail is wrapped, not cut - which is the entire reason the row is clickable.

Then the recall half, and this one went further than the seed
(`capture-memory-recall-200x50.txt`). After one real turn the column read `recall  3 surfaced`,
not the `1 waiting · 2 surfaced` that was seeded: the host's own recall drain consumed the pending
nudge at the prompt and ledgered it. The ledger on disk afterwards:

```json
"notes/open-threads.md": { "hash": "kibitzer-gate", "at": "2026-09-21T07:31:03.866Z" }
```

`hash: "kibitzer-gate"` and the pending directory left empty are the host's writes, not ours. So
the block is not reading a fixture - it is reading the live recall subsystem, and it followed a
state transition the test suite cannot stage.

### Gate

`bun run test:senpi` exits 1 on this tree with three distinct failures, and all three are dev's
(`gate-test-senpi.txt`, plus `dev-gate.txt` for the same gate on a pristine `origin/dev`):

| Test | Owner | Note |
| --- | --- | --- |
| `reflection sandbox with not-yet-created paths` | dev | `c25d6668d refactor(memory): make session-reachable probes async` |
| `event-bridge session_shutdown` | dev | `residentTaskIds` missing from dev's own test fake |
| `facts payload byte cap` | dev | passes in isolation (3 pass / 0 fail); nondeterministic under the full suite |

`git diff --name-only origin/dev...HEAD -- packages/omo-senpi/src/components/memory` is empty:
this increment does not touch a single file any of the three exercises.

## WHY IT IS ENOUGH

Every path the block can take was driven on the real surface rather than argued: parked (the
warning row and its countdown), the frame behind the click, the facts backlog with its
bookkeeping filtered out, and recall - including a transition the host performed on its own while
the panel watched. The remaining branches are pinned by the 32 colocated unit tests, which drive
the reader through an injected port: a streak that has not parked yet, an unreadable `park.json`,
a pending file owned by another session, a session with no id yet, and an identity that will not
resolve. The floor is proven by counting reads across turn boundaries rather than by waiting.

## WHAT WAS OMITTED

- The kibitzer's own liveness. `KibitzerSidecarState` (`idle | turn_running | reseeding | backoff |
  disposed`) lives inside the sidecar process and nothing persists it - `/memory doctor` does not
  check it either - so there is nothing on disk to read and a row claiming "awake" would be a
  guess. What the kibitzer leaves behind IS shown: the recall pair.
- The captures include the `usage` bars of the account the stand serves from. They are percentages
  and window labels only; no token, no account id, no credential appears in any artifact here.
- The park file was seeded rather than produced by three real failed reflection runs. Producing it
  honestly would require breaking the reflection sandbox three times on this host; the file format
  is written by `ReflectionParkFile.write` and parsed here by upstream's own
  `readReflectionParkFile`, so the shape is the host's, not ours.
