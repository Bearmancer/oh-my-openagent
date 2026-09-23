# ATTRIBUTION / NOTICE

This skill (`browser`, part of `@oh-my-opencode/shared-skills`) is project-original documentation.
It drives a third-party tool that it does **not** redistribute.

## BrowserSkill — driven, not vendored

The attached engine this skill documents is **BrowserSkill** by Tencent.

- Upstream: https://github.com/Tencent/BrowserSkill
- License: MIT
- What ships here: documentation and two local helper scripts, authored by this project.
- What does NOT ship here: the `bsk` CLI, the daemon, the browser extension, or any upstream
  source. The user installs those from upstream's own installer and from the Chrome Web Store /
  Edge Add-ons listings. This package never bundles a browser binary or an extension payload.

MIT permits redistribution; we simply have no reason to, because upstream publishes signed
per-platform releases and store builds that stay current on their own.

## Owned-engine references

`references/owned-engine/` documents a *contract* for a code-driven browser — the escalation
ladder, viewport pinning, reading the network instead of the DOM, overlay and cross-origin
handling — not any particular package. The techniques are generic CDP practice. No third-party
source is reproduced.
