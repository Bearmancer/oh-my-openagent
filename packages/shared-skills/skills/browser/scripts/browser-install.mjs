#!/usr/bin/env node
import { spawn } from "node:child_process"
import { platform } from "node:os"
import { resolveCli, STORE_LISTINGS, SUPPORTED_PLATFORMS } from "./browser-env.mjs"

const UNIX_INSTALL = "curl -fsSL https://raw.githubusercontent.com/Tencent/BrowserSkill/main/install.sh | sh"
const WINDOWS_INSTALL = "irm https://raw.githubusercontent.com/Tencent/BrowserSkill/main/install.ps1 | iex"

function installCommand() {
  return platform() === "win32"
    ? { file: "powershell", args: ["-NoProfile", "-Command", WINDOWS_INSTALL], display: WINDOWS_INSTALL }
    : { file: "sh", args: ["-c", UNIX_INSTALL], display: UNIX_INSTALL }
}

function spawnInstaller({ file, args }) {
  return new Promise((resolve) => {
    const child = spawn(file, args, { stdio: "inherit", windowsHide: true })
    child.on("error", () => resolve(1))
    child.on("close", (code) => resolve(code ?? 1))
  })
}

if (!SUPPORTED_PLATFORMS.has(platform())) {
  console.error(`unsupported platform: ${platform()}. macOS, Linux and Windows x64 only.`)
  process.exit(1)
}

if (await resolveCli()) {
  console.log("bsk is already installed; run browser-doctor.mjs to check the extension.")
  process.exit(0)
}

const command = installCommand()
console.log(`installing the bsk CLI with the upstream installer:\n  ${command.display}\n`)
const code = await spawnInstaller(command)
if (code !== 0) {
  console.error(`\ninstaller exited ${code}. Report this instead of retrying blindly.`)
  process.exit(code)
}

console.log([
  "",
  "CLI installed. Two things remain, and only the user can do the first:",
  "",
  "1. Install the browser extension from the store, then enable it:",
  `     Chrome: ${STORE_LISTINGS.chrome}`,
  `     Edge:   ${STORE_LISTINGS.edge}`,
  "2. Re-run: node \"<skill-root>/scripts/browser-doctor.mjs\"",
  "",
  "If PATH does not pick up the CLI in this shell, use its absolute path under ~/.local/bin.",
].join("\n"))
