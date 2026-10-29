# AI Chat

An LLM chat for [Termix](https://termix.site) that can run commands on your SSH hosts and read their output — an opencode-style agent for your servers, built as a Termix plugin.

You describe what you want; the agent proposes shell commands, runs them on the hosts you can connect to through Termix's own SSH pipeline, and iterates on the results until it can answer.

## Features

- Chat with an LLM that runs commands on your hosts via `ctx.ssh` (jump hosts, proxies, every auth type just work)
- Three approval modes per chat: **ask first**, **auto-run safe** (prefix allowlist, shell metacharacters always refused) and **auto-run all**
- Asks you for a key passphrase, password or TOTP code in the chat when a host needs it, and keeps the connection open so you type it once per session
- Model and reasoning-effort picker per chat; the model list is searchable; OpenRouter, OpenAI and Anthropic adapters with optional base URL overrides
- Chat history persisted per user on the server
- Per-user, encrypted API keys; every executed command is audited
- Admin limits: command timeout, output size per command, steps per message
- Setting to show the chat as a rail tab or a sidebar panel entry

## Requirements

- A Termix server, 26.10 or newer, with this plugin installed
- An API key for at least one provider (OpenRouter, OpenAI or Anthropic), set in Settings, AI Chat

## Development

```bash
npm install
npm run migrations
npm test            # vitest
npm run typecheck
npm run validate
npm run build
npx termix-plugin dev --server http://localhost:8080 --key tmx_...
```

`npx termix-plugin dev` builds the plugin and installs it on a Termix server with plugin developer mode on, rebuilding on every save. See [docs/index.md](docs/index.md) for what the plugin does and [the Termix plugin docs](https://docs.termix.site/develop) for the SDK.

## Releases

Pushing to `main` builds, tests and packs the version `manifest.json` declares and publishes it as a GitHub release with build provenance — but only when that version has no release yet. To release a new version, bump it in `manifest.json`, `package.json` and `CHANGELOG.md`, then push. The `.github/workflows/release.yml` workflow (run by hand from a `dev-X.Y.Z` branch) is still there for betas and overwrites.

## Security notes

- The safe-command allowlist is a UX convenience, not a security boundary. "Ask first" is the default approval mode.
- Every command execution writes an audit line with the host and command.
- API keys are stored encrypted by Termix and never sent to the browser.

## License

Apache-2.0
