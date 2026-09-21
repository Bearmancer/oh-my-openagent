# Side panel - the kibitzer's wake log, and children the engine is not running (increments 2 + 4)

Slug: `20260921-side-panel-kibitzer-children`. Branch `feat/senpi-side-panel` (head of PR #8092).

## WHAT WAS TESTED

Two accuracy gaps, both driven on the real `senpi` binary:

1. **The resident kibitzer.** It decides what memory is surfaced, runs in its own process, and was
   invisible in the TUI. It leaves exactly one durable trace -
   `recall/sidecars/<base64url(session)>/wakes.ndjson`, one closed record per settled wake
   (`kibitzer/observe.ts`) - and the panel now reads its tail.
2. **Children the engine is no longer holding.** `senpi-task` persists `residency_state` beside
   `status`, and only `resident` means the child is live in this process. The ORDINARY daemon
   suspension writes **no** `suspension_reason` at all, so the previous increment's reason-only
   check still painted a detached child as running with its elapsed timer climbing.

Commands: `bun test packages/omo-senpi/src/components/side-panel` (382 pass / 0 fail),
`tsgo --noEmit -p packages/omo-senpi/tsconfig.json` (exit 0). RED-then-GREEN in
`red-then-green.txt`: 8 failures for the kibitzer behaviours and 4 for the children ones before a
line of implementation, with the no-regression cases passing throughout - which is what makes them
worth keeping.

Live: `omo-panel --tui-mode fullscreen` in a 200x50 tmux, cwd `/tmp/panel-memory-qa`,
`OMO_MEMORY_HOME` on a throwaway memory root. Seeded: three settled wakes for the LIVE session id
(the newest nine minutes old), and two child records through the engine's own record store - one
`running` + `rpc_detached` + `runner_kind: host-session` with no suspension reason, one
`running` + `resident` in-process.

## WHAT WAS OBSERVED

`capture-kibitzer-and-detached-200x50.txt`:

```
AGENTS  1 running · 1 parked · 0 done
‖ daemon child, detached  20s
▶ in-process child, live  20s

MEMORY  panel-memory-qa-9669387b
reflect parked · probe in 3h39
kibitz  3 wakes · 9m21 ago
facts   4 queued
```

`1 running · 1 parked` is the fix: before this increment both children counted as running, because
neither carries a suspension reason. `kibitz 3 wakes · 9m21 ago` is read from the sidecar's own
ndjson, and the age is measured against the newest record.

`facts 4 queued` is worth noting on its own: it was **3** in the previous capture. The host
enqueued another batch during the session, so the row is following the live queue rather than the
seed.

A real SGR click on the parked row (`capture-detached-child-card-200x50.txt`):

```
daemon child, detached  (agent)
status  ‖ suspended
elapsed 35s
parked  rpc_detached
runs    daemon session
id      st_0d000001
```

The reason falls back to the residency state in the host's own spelling, and the card names the
lane, which is the part that says how this child can fail.

## WHY IT IS ENOUGH

The two states that mattered were driven end to end on the real binary: a detached daemon child
with no reason of its own, and a kibitzer with settled wakes. The rest is pinned by colocated unit
tests that cannot be staged live without breaking a sandbox three times or racing a writer: a
resident child (no regression), a terminal record whose residency was disposed, a suspension
reason winning over the residency, a record from before these fields shipped, a torn ndjson line,
a diagnostic last wake, and a truncated tail reporting `40+ wakes` instead of a false total.

## WHAT WAS OMITTED

- **Admission waiting is not shown, because it is not durable.** Residency admission happens at
  start; before that the record is simply `pending`, which the column already draws as `queued`
  rather than running. There is no persisted "waiting for a slot" state to read, and inventing one
  from `pending` + `persisted_only` would be a guess.
- **The kibitzer's liveness** remains unshown for the reason in the previous increment: nothing
  persists it.
- The captures carry the usage bars of the account the stand serves from: percentages and window
  labels only, no token, account id or credential.
- The wake log was seeded rather than produced by three real kibitzer wakes, which would need a
  provider round trip per wake. The record shape is the host's own (`observe-record.ts`), and the
  reader is deliberately tolerant of every field it does not recognise.
