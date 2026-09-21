# Side panel: children the engine is holding

Branch `feat/senpi-side-panel`, on top of the goal section and the merge onto current dev.

## WHAT WAS WRONG

The engine does not kill a host-session child when its daemon disappears or the host drains: it
parks it. `senpi-task/src/lifecycle/host-session-record.ts` writes a `suspension_reason`
(`daemon_unavailable` or `host_draining`) and leaves the record's `status` alone, because the child
is revivable and its status is about the run, not about who is holding it.

The panel read `status` and nothing else, so a parked child was drawn as a running one - a filled
glyph, counted in "N running", with an elapsed time that kept growing. The column's whole job for
that row is to say what a child is doing, and for the one state a user might need to act on it said
the opposite.

## WHAT CHANGED

- `data/task-records.ts` folds a suspension reason into a `suspended` panel status, but **only for
  a live child**: a reason left on a completed or failed record describes a past life, so terminal
  records keep their terminal status.
- The heading counts parked children on their own - `1 running · 1 parked · 1 done` - because
  folding them into either side claims the engine is working on something it is holding, or that it
  finished something it did not.
- The card names the reason (`parked  daemon_unavailable`). A dead daemon and a draining host ask
  different things of the user, and "suspended" alone leaves the obvious question unanswered.

## HOW IT WAS CHECKED

Four failing-first tests, each checked against the unfixed code:

| test | what it pins |
|---|---|
| a running record with a reason maps to `suspended` | the defect itself |
| a completed record with a stale reason stays `finished` | the guard against over-correcting |
| the heading counts running, parked and done apart | the count that was lying |
| the card carries the reason | what a click is for |

- Component suite: 329 tests, 0 fail.
- `tsgo --noEmit -p packages/omo-senpi/tsconfig.json` - clean.

## WHAT WAS OBSERVED LIVE

Driven on the REAL `senpi` binary in `--tui-mode fullscreen` (200x50 tmux pane, stand agent dir
`~/.omo-panel/agent`, workspace `/tmp/panel-goal-qa`). Rather than spawn a child and kill its
daemon - a model turn plus a race - the two records were written through the engine's OWN store and
its own `seedRecord` helper, then mutated exactly the way the lifecycle mutates them:

```
seedRecord(store, { task_id: "st_0a00002b", status: "running", residency_state: "resident",
                    runner_kind: "host-session" })
store.mutate("st_0a00002b", (r) => ({ ...r, suspension_reason: "daemon_unavailable" }))
```

The panel read them through its ordinary reader - the engine's record store, scoped by
`parent_session_id` - and drew (`capture-parked-child-200x50.txt`):

```
AGENTS  1 running · 1 parked · 0 done
● read the extraction spec  27s
‖ collect the batch results  27s
```

A real SGR mouse click on the parked row (`ESC [ < 0 ; 156 ; 22 M` / `m`) opened its card
(`capture-parked-card-200x50.txt`):

```
status  ‖ suspended
elapsed 38s
parked  daemon_unavailable
```

Before this change the same two records drew "2 running" with a filled glyph on both, and the card
said `running` with nothing about the daemon.

## WHAT WAS OMITTED

The suspension was written into the record rather than produced by killing a live daemon. The engine
side of that transition has its own proof in `senpi-task`'s chaos harness
(`__adversarial__/chaos-host.test.ts` asserts `suspension_reason === "daemon_unavailable"` after a
real daemon loss); what this change owns is what the panel does with the record once it says that,
and that is what was driven here.

## GATES, AND THE UPSTREAM RED

`bun run test:senpi` on this tree: 4005 tests, **2 failures, both upstream and both outside this
branch's diff**:

- `reflection sandbox with not-yet-created paths > ... the bwrap transform is built ...` - the test
  helper unwraps the transform synchronously and throws "Transform returned a Promise in a sync
  context". The file's last change on dev is `c25d6668d refactor(memory): make session-reachable
  probes async` (2026-09-17), which is the refactor that made it async.
- `event-bridge session_shutdown > ... no captured session id ...` -
  `engine.manager.residentTaskIds is not a function`. `residentTaskIds` arrives in dev's tip commit,
  `5cb5690a6 wip(senpi-task): checkpoint - reclaim terminal children (todo 7, host crash recovery)`
  (2026-09-21), which calls it from production code without teaching the test's fake manager about
  it.

`git diff --name-only origin/dev...HEAD -- packages/omo-senpi/src/components/memory
packages/omo-senpi/src/components/task` is empty: this branch touches neither component. The root
`bun run typecheck` - what CI runs across every package - is clean on this tree.
