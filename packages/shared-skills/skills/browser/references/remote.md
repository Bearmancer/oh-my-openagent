# Agent here, browser there

The agent and the browser do not have to be the same machine. Upstream supports this directly;
nothing in this package needs to bridge it.

Shape:

- The **browser machine** needs only the extension.
- The **agent machine** runs the `bsk` CLI and this skill.
- They are joined by a daemon in server mode plus a pairing link.

```bash
bsk daemon start --mode server      # on the machine the agent runs on
```

Then follow upstream's pairing guide, which owns the current flag surface and the TLS
prerequisites: https://github.com/Tencent/BrowserSkill/blob/main/docs/remote-extension-connection.md

Once paired, every command in `commands.md` behaves identically; `--out` paths still resolve on
the machine that ran the command.

If pairing is not configured, say so and ask. Do not substitute a browser on the agent machine:
the point of the attached engine is the sessions that live in the user's browser, and a local
browser has none of them.
