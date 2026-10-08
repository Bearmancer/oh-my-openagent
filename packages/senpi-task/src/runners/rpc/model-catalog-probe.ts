import { spawn, type ChildProcess } from "node:child_process"
import { closeSync, mkdtempSync, openSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import type { RpcSpawnDescriptor } from "./spawn"
import { terminateRpcChild } from "./terminate"

// Bun 1.4 cold starts of the full Senpi CLI on Windows have exceeded the original 20s budget.
// Keep the established POSIX ceiling while giving Windows ~46% headroom over the observed 20.5s probe.
export const PROBE_TIMEOUT_MS = process.platform === "win32" ? 30_000 : 20_000
const MAX_OUTPUT_BYTES = 2 * 1024 * 1024
const ANSI_ESCAPE = /\u001B\[[0-?]*[ -/]*[@-~]/g

export type ModelCatalogProbeResult = {
  readonly code: number | null
  readonly stdout: string
  readonly stderr: string
  readonly timedOut: boolean
}

export type ModelCatalogSpawnOptions = {
  readonly cwd: string
  readonly env: NodeJS.ProcessEnv
  /** stdout is a file descriptor, never a pipe: see `probeModelCatalog`. */
  readonly stdio: ["ignore", number, "pipe"]
  readonly shell: false
  readonly windowsHide: true
  readonly detached: boolean
}

export type ModelCatalogProbeOptions = {
  readonly timeoutMs?: number
  readonly spawnProcess?: (
    command: string,
    args: readonly string[],
    options: ModelCatalogSpawnOptions,
  ) => ChildProcess
  readonly terminateChild?: (child: ChildProcess) => Promise<void>
}

function appendBounded(current: string, chunk: Buffer): string {
  const next = current + chunk.toString("utf8")
  return next.length <= MAX_OUTPUT_BYTES ? next : next.slice(next.length - MAX_OUTPUT_BYTES)
}

function readCapturedStdout(path: string): string {
  const text = readFileSync(path, "utf8")
  return text.length <= MAX_OUTPUT_BYTES ? text : text.slice(text.length - MAX_OUTPUT_BYTES)
}

export function parseModelCatalog(output: string): ReadonlySet<string> {
  const models = new Set<string>()
  for (const rawLine of output.replace(ANSI_ESCAPE, "").split(/\r?\n/)) {
    const columns = rawLine.trim().split(/\s+/).filter((column) => column.length > 0)
    const provider = columns[0]
    const model = columns[1]
    if (provider === undefined || provider === "provider") continue
    if (model !== undefined && model !== "model") {
      models.add(`${provider}/${model}`)
      continue
    }
    if (provider.includes("/")) models.add(provider)
  }
  return models
}

/**
 * The catalog goes to a file, not a pipe. `senpi --list-models` writes its rows and calls
 * `process.exit(0)` at once; on a pipe the parent has not drained yet (a loaded host), every row past
 * the pipe buffer is dropped and the child still exits 0. The provider-sorted tail - `xai` - vanished
 * that way and admission rejected it as `model_not_in_child_profile` (#9068). A file write never
 * waits on the reader, so the listing is whole however slowly this process gets scheduled.
 */
export function probeModelCatalog(
  descriptor: RpcSpawnDescriptor,
  options: ModelCatalogProbeOptions = {},
): Promise<ModelCatalogProbeResult> {
  return new Promise((resolve) => {
    const spawnProcess = options.spawnProcess ?? ((command, args, spawnOptions) => (
      spawn(command, [...args], spawnOptions)
    ))
    const terminateChild = options.terminateChild ?? terminateRpcChild
    const captureDir = mkdtempSync(join(tmpdir(), "omo-model-catalog-"))
    const capturePath = join(captureDir, "stdout")
    const discardCapture = (): void => rmSync(captureDir, { recursive: true, force: true })
    let child: ChildProcess
    const stdoutFd = openSync(capturePath, "w")
    try {
      child = spawnProcess(descriptor.command, descriptor.args, {
        cwd: descriptor.cwd,
        env: descriptor.env,
        stdio: ["ignore", stdoutFd, "pipe"],
        shell: false,
        windowsHide: true,
        detached: process.platform !== "win32",
      })
    } catch (error) {
      discardCapture()
      throw error
    } finally {
      closeSync(stdoutFd)
    }
    if (child.stderr === null) {
      discardCapture()
      throw new Error("model catalog probe requires piped stderr")
    }
    let stderr = ""
    let settled = false
    let timingOut = false
    let timeout: ReturnType<typeof setTimeout> | undefined

    const finish = (result: Omit<ModelCatalogProbeResult, "stdout">): void => {
      if (settled) return
      settled = true
      if (timeout !== undefined) clearTimeout(timeout)
      let stdout: string
      try {
        stdout = readCapturedStdout(capturePath)
      } finally {
        discardCapture()
      }
      resolve({ ...result, stdout })
    }
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = appendBounded(stderr, chunk)
    })
    child.once("error", (error) => {
      if (timingOut) return
      finish({ code: null, stderr: `${stderr}\n${error.message}`, timedOut: false })
    })
    child.once("close", (code) => {
      if (timingOut) return
      finish({ code, stderr, timedOut: false })
    })
    timeout = setTimeout(() => {
      if (settled || timingOut) return
      timingOut = true
      void terminateChild(child).then(
        () => finish({ code: null, stderr, timedOut: true }),
        (error: unknown) => finish({
          code: null,
          stderr: `${stderr}\nfailed to terminate model catalog probe: ${
            error instanceof Error ? error.message : String(error)
          }`,
          timedOut: true,
        }),
      )
    }, options.timeoutMs ?? PROBE_TIMEOUT_MS)
    timeout.unref()
  })
}
