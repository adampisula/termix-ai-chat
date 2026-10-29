# AI Chat

AI Chat adds an LLM chat to Termix that can run shell commands on your SSH hosts and read their output. It works like a coding agent for your servers: you describe what you want, the agent proposes commands, runs them through Termix's own SSH pipeline and reports what happened.

## Install

1. Install AI Chat from the Plugins tab.
2. Open Settings, AI Chat and pick a provider. Paste the matching API key (OpenRouter, OpenAI or Anthropic) and a default model id, like `anthropic/claude-sonnet-4.5`. Keys are stored encrypted and never sent to the browser.
3. Open the AI Chat tab from the sidebar.

Using the tab needs the Use AI Chat permission, which admins and users get by default.

## How it works

A chat is a conversation with one agent. The agent has one tool: `run_command`, which runs a non-interactive shell command on one of the hosts you can connect to and returns stdout, stderr and the exit code. The host list the agent sees is yours; it can pick any host per command. There is no automatic probing: the agent learns about a host by running commands on it.

Every command execution is audited with the plugin's id, the host and the command.

## Approval modes

Each chat has an approval mode, changeable from the chat toolbar:

- **Ask first** (default). Every command waits for you to press Run once or Deny. A denied command is reported back to the model; it is asked not to work around your denial.
- **Auto-run safe**. Commands that start with a prefix from your safe list run without asking; everything else waits. You can edit the list in Settings, AI Chat. Commands containing `;`, `&&`, `|`, redirections or command substitution are never auto-approved, whatever the list says. The list is a convenience, not a safety boundary.
- **Auto-run all**. Every command runs immediately. Use this only on hosts where you are comfortable with that.

If you do not answer an approval within 15 minutes the command is denied and the agent moves on.

## Models and reasoning

The chat toolbar has a model picker (loaded from your provider) and a reasoning-effort picker: none, low, medium or high. Effort maps to `reasoning_effort` on OpenAI, the `reasoning` object on OpenRouter and extended thinking on Anthropic. Settings, AI Chat holds the defaults new chats start with. Each provider also takes an optional base URL override, so proxies and compatible endpoints work.

## Limits

Admins can bound each command's timeout, the output kept per command and how many steps the agent may take per message in Settings, AI Chat. Long output is truncated with a marker so the model knows.

## History

Chats and their messages are stored on the server per user. You can rename or delete a chat from the sidebar; deleting removes its history. A run that is still going when you reload the page keeps running on the server; reopen the chat to see its result.

## Data handling

Your conversation text and command output go to the LLM provider you configured. API keys are stored encrypted by Termix. The plugin makes no network calls except to the provider you chose.
