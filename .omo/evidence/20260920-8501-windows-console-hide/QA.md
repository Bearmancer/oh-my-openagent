# QA evidence - #8501 memory writes must not open a console window on Windows

Branch `fix/8501-windows-console-hide` off `origin/dev` @ `c51aa837d`. Host: macOS arm64 (Mac16,11),
bun 1.4.0 for tests, pinned bun 1.4.2 for the committed plugin bundles.

## What was tested

The defect is that console-subsystem children spawned without `windowsHide` allocate a fresh console
window on Windows, which Windows then foregrounds, so the user's active application loses focus on
every memory write. The flag is inert on posix, so the faithful observation point off Windows is the
options object handed to `node:child_process`. Four things were exercised:

1. The memory engine's git exec (`packages/memory-core/src/git/exec.ts`), which every `memory` tool
   auto-commit and post-turn sync runs through, including its Windows install-path fallbacks.
2. The lock protocol's process-start identity probe
   (`packages/memory-core/src/locks/process-identity.ts`), specifically the `powershell.exe`
   fallback taken whenever the in-process kernel32 reader cannot answer.
3. The thread worktree-root lookup (`packages/omo-senpi/src/components/thread/addressing.ts`), the
   third spawn site quoted in the issue.
4. That the added option does not break real spawning on posix: a real git child process chain
   driven through the patched `memory-core` exec.

## What was observed

### RED before the fix

    bun test packages/memory-core/src/git/exec.windows-console.test.ts \
             packages/memory-core/src/locks/process-identity.windows-console.test.ts
    0 pass / 3 fail
      expect(captured[0]?.options.windowsHide).toBe(true)  ->  Expected: true, Received: undefined
      windows fallback executables: [undefined, undefined] vs [true, true]

The probe test reached `toHaveLength(1)` and `command === "powershell.exe"` before failing, so the
PowerShell fallback really executed and really spawned; only the flag was missing.

    bun test packages/memory-core/src/windows-console-hide.test.ts
      offenders: ["git/exec.ts:80", "locks/process-identity.ts:12"]

    bun test packages/omo-senpi/src/windows-console-hide.test.ts
      offenders: ["components/formatter/formatter.ts:97", "components/formatter/formatter.ts:77",
                  "components/init-deep-advisor/git-helpers.ts:14", "install/local-launcher.ts:86"]

`addressing.windows-console.test.ts` was written after its fix, so it was proved by mutation
instead: deleting the `windowsHide: true` line produced
`[undefined, undefined]` vs `[true, true]`, and restoring it returned 1 pass (file restored
byte-identical, verified by comparison).

### GREEN after the fix

    bun test <the five console tests>                     10 pass / 0 fail
    bun test packages/memory-core/src                     1015 pass / 4 skip / 0 fail   (150s)
    bun test packages/omo-senpi/src/components/memory/worker packages/omo-senpi/src/components/thread
                                                          529 pass / 0 fail             (66s)

The four skips are the win32-only `process-start-time` cases, which skip on macOS by design.

### Real surface, posix

A real git child process chain through the patched exec (`/tmp/ulw8501-surface/real-git-exec.ts`):

    $ git init -q -b main            -> code=0
    $ git add memory.md              -> code=0
    $ git commit -q -m "memory: ..." -> code=0
    $ git log --oneline -1           -> code=0  8cfd653 memory: auto-commit through memory-core git exec

### Shipped artifact

The committed plugin bundles were stale after the source change
(`build-extension.mjs --check` reported `not current: stale-output`). They were regenerated with the
bun version CI pins (1.4.2, read out of `.github/workflows/ci.yml`), because the check is a byte
comparison and an ambient bun 1.4.0 build passes locally while failing CI.

    build-extension.mjs        exit 0
    build-install.mjs          exit 0
    build-extension.mjs --check  exit 0
    build-install.mjs --check    exit 0

The emitted helpers carry the flag:

    omo.js                      async function zT(e,t){...RT(e,t,{encoding:"utf8",timeout:2e3,windowsHide:!0},...)}
    memory-run-supervisor.mjs   async function ft(t,e){...st(t,e,{encoding:"utf8",timeout:2e3,windowsHide:!0},...)}

`windowsHide:!0` occurs 10 times in `omo.js` and 5 times in `memory-run-supervisor.mjs`.

## Why it is enough

The user-visible behavior is a Windows window-manager effect that cannot be produced on this host,
so it is covered at the two layers that decide it. The boundary tests assert the exact options
object Node hands to `CreateProcess`, which is what sets `CREATE_NO_WINDOW`; nothing between that
object and the OS is ours. The two audits then prove no production call site in either package is
left without the flag, and each audit was seen failing on the real offenders before the fix, so
neither is vacuous. The posix real-surface run proves the added option does not change spawning
behavior where it is inert, and CI's Windows shards run the same suites on the real OS.

The repo already owns a heavyweight real-Windows console probe
(`packages/senpi-task/src/runners/rpc-process.windows.test.ts`, which inspects actual window
handles). It was deliberately not extended to these sites: it holds a long-lived child to inspect,
while git and powershell here exit in milliseconds, so window-handle sampling would race and produce
a flaky gate. #8324 already tracks Windows CI timeouts; adding a racy probe would make that worse.

## What was omitted

No live `senpi` binary session was driven. This change adds one spawn option and changes no
adapter registration, tool contract, prompt, or config schema, and the option has no observable
effect on macOS, so a live session would produce no signal the boundary capture does not already
give. No secrets, tokens, env dumps, or auth material are recorded here; the real-surface transcript
contains only git plumbing output from a throwaway repository.

## Cleanup

    rm -rf /tmp/ulw8501-surface                                  (QA script)
    rm -rf /var/folders/.../T/ulw8501-repo-2bPqhp                (scratch git repository)
    no server, port, container, tmux session, or browser context was created
