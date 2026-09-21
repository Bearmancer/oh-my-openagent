# Side panel: the GOAL section

Branch `feat/senpi-side-panel` (the branch behind PR #8092), first increment of the catch-up with
everything omo gained since the panel was written: the session's registered goal.

## WHAT WAS TESTED

Whether the panel can show the goal a session is pursuing, driving the REAL `senpi` binary
(2026.9.20) in `--tui-mode fullscreen` inside a 200x50 tmux pane, against its own agent dir
(`~/.omo-panel/agent`), in a scratch workspace (`/tmp/panel-goal-qa`). Three things had to hold on
the real host rather than in a fixture: that the host hands an extension the goal store path at
all, that the column follows the file while the session runs, and that a click on the objective
opens the part of it the column cannot fit.

## WHERE THE STORE ACTUALLY LIVES

`goalStoreFile` is not a value the host copies onto the context - it is a live getter,
`goalFilePath(goalStoreRef(sessionManager, cwd))`, and `goalStoreRef` answers **two different
places**:

- `<sessionDir>/extensions/goal/<sessionId>.json` once the session has a session file, and
- `<agentDir>/extensions/goal/no-session/<cwdKey>/<sessionId>.json` while `getSessionFile()` is
  still undefined - that is, before the session's first turn.

This cost a QA cycle and is worth writing down: a goal seeded into a session that had never taken a
turn was invisible not because the wiring was wrong but because the host was reading the other
store. It also settles the refresh question - `--continue` and `--resume` both start a NEW thread
id when the previous session has no turns, so the store cannot be pre-seeded for a session that
does not exist yet.

## WHAT WAS OBSERVED

1. **The block renders from the host's own path** (`capture-goal-active-200x50.txt`):

   ```
   GOAL  active · 2h14
   Extend the side panel with the subsystems omo gaine…
   tokens  148K
   budget  ██████████████▍░░░░░░░░░░░░░░░░░░░░░░░░ 37%
   loops   1 · 1 unattended
   ```

2. **The column follows the live file, not a snapshot.** The seeded record said 6 consecutive and 4
   unattended continuations; the screen says `1 · 1`, because the host's own usage accounting
   rewrote the record during the turn and the panel re-read it on the ordinary refresh. That is the
   behaviour the design argues for (no goal event exists to subscribe to), observed rather than
   assumed.

3. **A click opens the whole objective** (`capture-goal-click-200x50.txt`). A real SGR mouse report
   (`ESC [ < 0 ; 155 ; 8 M` / `m`) delivered into the pane at the objective row's own coordinates
   opened the framed viewer titled `goal`. The objective's tail - `parked reflections and child
   accuracy` - is present in the viewer capture and absent from the row capture, which is the whole
   point of the click.

4. **A budget-limited goal renders in the host's own words** (`capture-goal-budget-limited-200x50.txt`):

   ```
   GOAL  limited by budget · 2h14
   tokens  412K
   budget  ███████████████████████████████████████ 103%
   ```

   This is the case the first implementation would have drawn as **nothing at all**. Reading the
   writer (`packages/pi-goal/src/goal/store.ts`) showed five statuses - `active`, `paused`,
   `blocked`, `budgetLimited`, `complete` - where the reader accepted three, so a paused or
   over-budget goal was dropped as an invalid record: the block would vanish exactly when the goal
   stopped moving. Fixed with failing-first tests (two in the reader, two in the row builder), and
   the label is the host's own `goalStatusLabel` wording so the footer and the column cannot
   describe one goal in two ways.

## WHY IT IS ENOUGH

The path under test is: host getter -> `panelFactsFrom` -> `data/goal.ts` -> `sections/goal.ts` ->
rows -> OSC 8 link -> click -> viewer. Cases 1, 3 and 4 drive all of it on the real binary,
including the parts no fixture can fake - that the host publishes the path to an extension at all,
and that the panel's escapes survive the compositor into the frame the host hit-tests. The unit
tests carry the branching around it: torn and half-written JSON, an unknown status, an absent file,
a path the host never published, the `mtime`/`size` gate that keeps an unchanged store to one
`stat`, and the rows that are omitted when their numbers would only ever say zero.

## WHAT WAS OMITTED

- `paused` was driven live afterwards, on the build that carries this branch merged onto current
  dev: `capture-goal-paused-after-dev-merge-200x50.txt` shows `GOAL  paused · 1h00` with the loop
  counters, which also re-proves the whole block against 716 commits of upstream drift.
- No goal was created through the real `create_goal` tool: the tool writes the same file this seam
  reads, and driving it costs a model turn per state. The store is the seam under test.
- The scratch session's agent took one exploratory turn of its own while the stand was open (it read
  the workspace it was started in). It touched nothing outside `/tmp/panel-goal-qa` and the stand's
  own agent dir.

## GATES

- Component suite (`packages/omo-senpi/src/components/side-panel`): 324 tests, 0 fail.
- `tsgo --noEmit -p packages/omo-senpi/tsconfig.json` - clean.
- `bun run test:senpi` - exit 0: 3703 pass, 3 skip, 0 fail across 447 files, plus the evidence-dir
  resolver suite. Full numbers in `gate-test-senpi.txt`.
- One earlier run of the same gate failed `facts payload byte cap` in the memory component. Repeated
  runs of that file alone pin it as a pre-existing flake (1 failure in 6) whose cause is same-
  millisecond publish ordering, not this change; `gate-test-senpi.txt` carries the reasoning and it
  is left as a follow-up for that component.
