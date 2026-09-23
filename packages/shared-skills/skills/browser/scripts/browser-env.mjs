import { execFile } from "node:child_process"
import { existsSync } from "node:fs"
import { homedir, platform } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"

const run = promisify(execFile)

export const STORE_LISTINGS = {
  chrome: "https://chromewebstore.google.com/detail/hhcmgoofomhgciiibhipgmgkgnoenaoi",
  edge: "https://microsoftedge.microsoft.com/addons/detail/browserskill/emacgiaaaiojkkpkddmmdfhmokgmnikg",
}

export const SUPPORTED_PLATFORMS = new Set(["darwin", "linux", "win32"])

export function localBinCandidates() {
  const bin = join(homedir(), ".local", "bin")
  return platform() === "win32" ? [join(bin, "bsk.exe"), join(bin, "bsk")] : [join(bin, "bsk")]
}

export async function resolveCli() {
  for (const candidate of localBinCandidates()) {
    if (existsSync(candidate)) return candidate
  }
  try {
    await run("bsk", ["--version"], { timeout: 15000, windowsHide: true })
    return "bsk"
  } catch {
    return undefined
  }
}

export async function readStatus(cli) {
  const { stdout } = await run(cli, ["status", "--json"], { timeout: 30000, windowsHide: true })
  return JSON.parse(stdout)
}

export function connectedBrowsers(status) {
  const browsers = status?.browsers
  return Array.isArray(browsers) ? browsers : []
}
