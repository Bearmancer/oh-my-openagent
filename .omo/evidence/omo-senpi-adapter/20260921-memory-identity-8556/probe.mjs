#!/usr/bin/env bun
// Live probe for #8556: a session bound under workspace A is re-opened by a process whose cwd is
// workspace B (the incident's `apps/server`). PASS = no conflict notice, the next run's system
// prompt still carries identity A's sentinel, and the memory tool writes into identity A's repo.
// `--plugin-root` selects which built bundle answers, so the same probe is the RED control against
// the bundle on origin/dev.
import { spawnSync } from "node:child_process"
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs"
import { delimiter, dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

import { createSandbox } from "../../../../packages/omo-senpi/scripts/qa/drive.mjs"
import { resolveMemoryIdentity } from "../../../../packages/memory-core/src/identity/resolve.ts"

const scriptDir = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(scriptDir, "..", "..", "..", "..")
const qaDir = join(repoRoot, "packages", "omo-senpi", "scripts", "qa")
const mockProviderEntry = join(qaDir, "task-e2e-mock-provider.ts")

function arg(name, fallback) {
  const index = process.argv.indexOf(name)
  return index === -1 ? fallback : process.argv[index + 1]
}

const pluginRoot = arg("--plugin-root", join(repoRoot, "packages", "omo-senpi", "plugin"))
const label = arg("--label", "fixed")
const outDir = arg("--out", scriptDir)

function findOnPath(bin) {
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    const candidate = resolve(dir || ".", bin)
    if (existsSync(candidate)) return candidate
  }
  return null
}

const senpiBin = process.env.SENPI_BIN ?? findOnPath("senpi")
if (senpiBin === null) throw new Error("senpi binary not found (set SENPI_BIN)")

const sandbox = createSandbox()
const workspaceA = sandbox.cwd
const workspaceB = join(sandbox.root, "apps", "server")
const memoryHome = join(sandbox.root, "memory")
const sessionDir = join(sandbox.agentDir, "sessions")
for (const dir of [workspaceA, workspaceB, sandbox.agentDir, sandbox.xdgConfigHome, sandbox.homeDir, sessionDir]) {
  mkdirSync(dir, { recursive: true })
}
writeFileSync(join(sandbox.agentDir, "settings.json"), `${JSON.stringify({ defaultProjectTrust: "ask", packages: [pluginRoot] }, null, 2)}\n`)
writeFileSync(join(sandbox.agentDir, "trust.json"), `${JSON.stringify({ [workspaceA]: true, [workspaceB]: true }, null, 2)}\n`)
writeFileSync(join(sandbox.agentDir, "auth.json"), `${JSON.stringify({ "omo-mock": { type: "api_key", key: "mock" } }, null, 2)}\n`)

const omoConfig = {
  categories: { quick: { description: "QA mock quick category", model: "omo-mock/mock-1" } },
  memory: { enabled: true, reflection: { trigger: { step_count: 0, on_compaction: false } }, dream: { enabled: false } },
}
for (const workspace of [workspaceA, workspaceB]) {
  mkdirSync(join(workspace, ".omo"), { recursive: true })
  writeFileSync(join(workspace, ".omo", "omo.json"), `${JSON.stringify(omoConfig, null, 2)}\n`)
}

const env = { OMO_MEMORY_HOME: memoryHome }
const identityA = resolveMemoryIdentity("auto", workspaceA, env)
const identityB = resolveMemoryIdentity("auto", workspaceB, env)

function writeScript(path, reason, file) {
  writeFileSync(path, `${JSON.stringify({
    parentSteps: [
      { type: "tool_call", name: "memory", arguments: { command: "create", file_path: file, description: "probe note", file_text: `${reason}\n`, reason } },
      { type: "text", text: "done" },
    ],
    childSteps: [{ type: "text", text: "unused" }],
  }, null, 2)}\n`)
}

function runSenpi({ cwd, scriptPath, dumpPath, sessionArgs, prompt }) {
  const run = spawnSync(senpiBin, [
    "-e", mockProviderEntry,
    "-p", "--mode", "json",
    "--provider", "omo-mock", "--model", "mock-1",
    "--session-dir", sessionDir,
    ...sessionArgs,
    prompt,
  ], {
    cwd,
    env: {
      ...process.env,
      SENPI_CODING_AGENT_DIR: sandbox.agentDir,
      XDG_CONFIG_HOME: sandbox.xdgConfigHome,
      XDG_DATA_HOME: sandbox.xdgDataHome,
      XDG_CACHE_HOME: sandbox.xdgCacheHome,
      OMO_MEMORY_HOME: memoryHome,
      MOCK_SCRIPT_PATH: scriptPath,
      MOCK_DUMP_SYSTEM: dumpPath,
    },
    encoding: "utf8",
    timeout: 180_000,
  })
  return { status: run.status, stdout: run.stdout ?? "", stderr: run.stderr ?? "" }
}

// A headless (-p) session routes its identity to a transient run root (#7765), so the identity the
// memory tool actually served is read from its own write notice rather than from a fixed path.
function writeNotices(output) {
  const notices = []
  for (const line of output.split("\n")) {
    if (!line.startsWith("{")) continue
    let event
    try { event = JSON.parse(line) } catch { continue }
    const details = event?.result?.details ?? event?.message?.details
    const notice = details?.writeNotice
    if (notice !== undefined && typeof notice.identity === "string") notices.push(notice)
  }
  return notices
}

const scriptA = join(sandbox.root, "script-a.json")
const scriptB = join(sandbox.root, "script-b.json")
writeScript(scriptA, "probe bind under workspace A", "notes/a.md")
writeScript(scriptB, "probe write after reattach from workspace B", "notes/b.md")

const first = runSenpi({
  cwd: workspaceA,
  scriptPath: scriptA,
  dumpPath: join(sandbox.root, "system-a.log"),
  sessionArgs: ["--session-id", "probe-8556"],
  prompt: "remember the probe note",
})

const sessionFiles = existsSync(sessionDir) ? readdirSync(sessionDir).filter((name) => name.endsWith(".jsonl")) : []
const sessionFile = sessionFiles.length === 1 ? join(sessionDir, sessionFiles[0]) : undefined

const second = sessionFile === undefined ? { status: null, stdout: "", stderr: "no session file" } : runSenpi({
  cwd: workspaceB,
  scriptPath: scriptB,
  dumpPath: join(sandbox.root, "system-b.log"),
  sessionArgs: ["--session", sessionFile],
  prompt: "write the second probe note",
})

const systemB = existsSync(join(sandbox.root, "system-b.log")) ? readFileSync(join(sandbox.root, "system-b.log"), "utf8") : ""
const secondOutput = `${second.stdout}\n${second.stderr}`
const noticesA = writeNotices(first.stdout)
const noticesB = writeNotices(second.stdout)
const servedA = noticesA.at(0)?.identity
const servedB = noticesB.at(0)?.identity
const conflictLine = secondOutput.split("\n").find((line) => line.includes("memory identity conflict"))

const checks = [
  { name: "run A bound identity A", ok: first.status === 0 && servedA === identityA.id, detail: `status=${first.status} served=${servedA}` },
  { name: "reattach from workspace B exits clean", ok: second.status === 0, detail: `status=${second.status}` },
  { name: "no memory identity conflict after reattach", ok: conflictLine === undefined, detail: conflictLine === undefined ? "absent" : conflictLine.slice(0, 300) },
  { name: "reattached system prompt carries identity A", ok: systemB.includes(`<!-- senpi-memory:${identityA.id}:begin -->`), detail: `sentinel=${systemB.includes(`<!-- senpi-memory:${identityA.id}:begin -->`)}` },
  { name: "memory tool after reattach answers with identity A", ok: servedB === identityA.id, detail: `served=${servedB} subject=${noticesB.at(0)?.subject}` },
  { name: "identity B never served", ok: servedA !== identityB.id && servedB !== identityB.id, detail: `identityB=${identityB.id}` },
]

const report = {
  label,
  pluginRoot,
  senpiBin,
  sandboxRoot: sandbox.root,
  workspaceA,
  workspaceB,
  identityA: identityA.id,
  identityB: identityB.id,
  sessionFile,
  checks,
  verdict: checks.every((check) => check.ok) ? "PASS" : "FAIL",
}
mkdirSync(outDir, { recursive: true })
writeFileSync(join(outDir, `probe-${label}.json`), `${JSON.stringify(report, null, 2)}\n`)
writeFileSync(join(outDir, `probe-${label}-run-a.log`), `${first.stdout}\n----- stderr -----\n${first.stderr}\n`)
writeFileSync(join(outDir, `probe-${label}-run-b.log`), `${second.stdout}\n----- stderr -----\n${second.stderr}\n`)
for (const check of checks) console.log(`${check.ok ? "PASS" : "FAIL"} ${check.name} :: ${check.detail}`)
console.log(`VERDICT ${report.verdict} (${label})`)
process.exit(report.verdict === "PASS" ? 0 : 1)
