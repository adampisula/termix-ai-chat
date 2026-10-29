# Changelog

## 1.2.0

### Added

- The agent can ask for a key passphrase, a password or a TOTP code in the chat: the question appears as a card while the command waits, and typed passphrases and passwords are remembered for the session
- Commands run over a pooled connection per user and host, so an unlocked host stays reachable without re-prompting

### Fixed

- The sidebar panel mode now actually lists the chat as an entry in the sidebar (the shell builds the panel from the tab registered under the same id, as the Alerts plugin does)

## 1.1.0

### Added

- Setting to show the chat as a rail tab or a sidebar panel
- Searchable, alphabetically sorted model picker

### Fixed

- Works on Termix 26.10 servers whose `ctx.ssh` has no `exec`: commands run over `ctx.ssh.connect` and a raw ssh2 channel instead
- Plugin id is `agent-chat`, so it installs alongside the AI Assistant (`ai`) plugin without a table-namespace clash

## 1.0.0

### Added

- AI Chat tab with per-user chat sessions and persisted history
- `run_command` tool the agent uses to run shell commands on hosts you can connect to
- Approval modes per chat: ask first, auto-run safe commands (prefix allowlist), auto-run all
- OpenRouter, OpenAI and Anthropic providers with model and reasoning-effort pickers
- Per-user encrypted API keys and optional base URL overrides
- Admin limits for command timeout, output size and steps per message
- Audit lines for every command execution
