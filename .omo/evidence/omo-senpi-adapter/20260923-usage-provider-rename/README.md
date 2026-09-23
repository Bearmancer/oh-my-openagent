# Side panel - the usage bars stopped refreshing after senpi renamed its providers

Slug: `20260923-usage-provider-rename`. Branch `feat/senpi-side-panel`. Reported from the user's
own client: the USAGE heading read `43h33 ago` and the numbers never moved.

## WHAT WAS TESTED

That the usage poller finds a credential on an install carrying senpi's CURRENT provider names,
and still finds one on an install that predates the rename.

- `bun test .../side-panel/usage` - 40 pass / 0 fail (`red.txt` first: the new cases fail with
  `Export named 'resolveUsageCredentialFrom' not found` before the implementation exists).
- `bun test .../side-panel` - 387 pass / 0 fail. `tsgo -p packages/omo-senpi` - exit 0.
- Live on the real binary, on the machine that reported it: the client was re-patched, a session
  started, and the machine-wide cache file was watched for a write.

## WHAT WAS OBSERVED

The cause, from the user's own `auth.json`:

| the panel asked for | auth.json actually carries |
| --- | --- |
| `claude-sdk-oauth` | `anthropic-subscription` (2 accounts, pinned `work`) |
| `openai-codex` | `chatgpt-subscription` |

A provider that is absent from auth.json is treated as "nobody signed into it", which is silent by
design - so there was no credential, no request, no error line, and the section kept drawing its
last good numbers while the heading counted the hours.

Before the fix the cache file had not been written since `2026-09-21T11:32:57Z` (2626 minutes,
matching the `43h33 ago` on screen). After the fix, one session wrote it immediately:

```
USAGE  0s ago
claude
5h      ███▋░░┊░░░░░░░░░░░░░░░░░░░░░  13%  3h51
7d      ┊░░░░░░░░░░░░░░░░░░░░░░░░░░░   2%  Wed 07:59
Fable   ┊░░░░░░░░░░░░░░░░░░░░░░░░░░░   0%  Wed 08:00
account work
codex
5h      ░░░░░┊░░░░░░░░░░░░░░░░░░░░░░   0%  4h00
```

Both providers wrote entries with `accountState: "ok"` and an `updatedAt` of now. The 7d window
moved 36% -> 2%: the week had rolled over during the outage, which is the frozen figure the user
had been reading.

## WHY IT IS ENOUGH

The failure was a name lookup, and both names are now covered by tests that would fail on either
half: current-name-only, retired-name-only, both-present (current wins), and health recorded under
the retired pool key while auth uses the current one - that last one is real, because auth.json and
`credential-pool-state.json` were renamed on different schedules. The live run proves the end of
the chain the unit tests cannot reach: a real credential, a real HTTP poll, and a real cache write.

## WHAT WAS OMITTED

- No test pins the literal strings `anthropic-subscription` / `chatgpt-subscription` as the only
  valid names; upstream may rename again, and the ordered list is the mechanism that survives it.
- The bars' own rendering is untouched and already covered by the usage section's suite.
- Captures show percentages and window labels of the account in use; no token, account id or
  credential appears in any artifact.
