#!/usr/bin/env node
import { platform } from "node:os"
import { connectedBrowsers, readStatus, resolveCli, STORE_LISTINGS, SUPPORTED_PLATFORMS } from "./browser-env.mjs"

const REMEDIES = {
  ready: "Start a session: bsk session start --json --no-focus --name \"<task>\"",
  "no-extension": `Ask the user to install and enable the extension, then re-run this doctor.\n  Chrome: ${STORE_LISTINGS.chrome}\n  Edge:   ${STORE_LISTINGS.edge}`,
  "no-cli": "Install the CLI: node \"<skill-root>/scripts/browser-install.mjs\", then re-run this doctor.",
  "no-browser-support": "This platform has no supported browser. Say so and stop; do not substitute another engine.",
}

async function diagnose() {
  if (!SUPPORTED_PLATFORMS.has(platform())) {
    return { state: "no-browser-support", platform: platform() }
  }
  const cli = await resolveCli()
  if (cli === undefined) return { state: "no-cli", platform: platform() }

  let status
  try {
    status = await readStatus(cli)
  } catch (error) {
    return { state: "no-extension", platform: platform(), cli, detail: `status failed: ${error.message}` }
  }
  const browsers = connectedBrowsers(status)
  if (browsers.length === 0) return { state: "no-extension", platform: platform(), cli }
  return { state: "ready", platform: platform(), cli, browsers: browsers.length }
}

const report = await diagnose()
const json = process.argv.includes("--json")
if (json) {
  console.log(JSON.stringify({ ...report, remedy: REMEDIES[report.state] }, null, 2))
} else {
  console.log(`state: ${report.state}`)
  if (report.cli) console.log(`cli:   ${report.cli}`)
  if (report.browsers) console.log(`browsers connected: ${report.browsers}`)
  if (report.detail) console.log(`detail: ${report.detail}`)
  console.log(`\n${REMEDIES[report.state]}`)
}
process.exit(report.state === "ready" ? 0 : 1)
