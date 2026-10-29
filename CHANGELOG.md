# Changelog

## 1.0.0

### Added

- AI Chat tab with per-user chat sessions and persisted history
- `run_command` tool the agent uses to run shell commands on hosts you can connect to
- Approval modes per chat: ask first, auto-run safe commands (prefix allowlist), auto-run all
- OpenRouter, OpenAI and Anthropic providers with model and reasoning-effort pickers
- Per-user encrypted API keys and optional base URL overrides
- Admin limits for command timeout, output size and steps per message
- Audit lines for every command execution
