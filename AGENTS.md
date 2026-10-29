# AGENTS.md

This repo is a [Termix](https://github.com/Termix-SSH/Termix) plugin. These notes are for AI coding tools.

## Read first

Before changing anything, read `node_modules/@termix-ssh/plugin-sdk/PLUGIN-GUIDE.md`. It covers the
manifest, backend, database, frontend, UI, testing, releasing and submitting to the community registry,
and it matches the SDK version installed here. If it is missing, run `npm install`. If it is still missing,
the SDK is older than 1.0.6: run `npm install -D @termix-ssh/plugin-sdk@latest` or read
https://docs.termix.site/develop instead.

If the guide and the SDK's TypeScript types disagree, the types are right.

## First time setup

If `manifest.json` still has the id `hello-world`, this plugin was just made from the template. Ask the
user for the plugin's id, name and description, then:

1. In `manifest.json`, set `id`, `name`, `description`, `author`, `repository`, `docs`, `category`,
   `icon` and `features`. The id is lowercase with dashes and can't change after the first release.
2. Rename every `hello-world`, `hello_world` and `Hello World` to match: `package.json`,
   `locales/en.json`, the index name in `src/backend/tables.ts`, the API paths in `src/backend/routes.ts`,
   the tab id in `src/frontend/index.tsx`, the tests, `docs/index.md`, `CONTRIBUTING.md` and `README.md`.
3. Delete `migrations/` and run `npm run migrations` so the tables use the new id.
4. Replace the example notes feature with the real one, and fill in "About this plugin" below.

## Commands

```bash
npm run build        # bundle into dist/
npm test             # run the tests
npm run typecheck    # type check
npm run validate     # check manifest.json, migrations, changelog and docs
npm run migrations   # write migrations after changing src/backend/tables.ts
npm run pack         # write <id>-<version>.tmxplug
npm run format       # format with Prettier
```

`npx termix-plugin dev --server <url> --key <tmx_...>` installs the plugin on a Termix server with
developer mode on and reinstalls it on every save. Don't start it unless the user asks.

## Layouts and themes

A plugin can also be a layout (`contributes.layouts`, capability `ui:layout`, `app.registerLayout` in the
frontend, shell state from `useShell()`) or add themes (`contributes.themes`, capability `ui:theme`, one CSS
file per theme scoped under `.<id>`). A theme only plugin has no `src/`: just `manifest.json`, `themes/*.css`,
`locales/` and a test that runs `validateThemeCss()`. The guide's "Layouts and themes" section has the rules.

## Done means

- `npm test`, `npm run typecheck`, `npm run validate`, `npm run build` and `npm run format:check` pass
- `npx termix-plugin migrations --check` passes
- New UI text is in `locales/en.json`, new routes have an `@openapi` block and a test
- `docs/` and the section below still match what the plugin does
- User facing changes are in `CHANGELOG.md` under the version they ship in

## About this plugin

- What it does: an LLM chat whose agent can run shell commands on the user's SSH hosts. One tool,
  `run_command`, via `ctx.ssh.exec`, with the acting user's connect access checked per call.
- Layout: `src/backend/providers/` holds thin streaming adapters over `ctx.fetch` (no provider SDKs);
  `src/backend/agent/` holds the run loop, the approval registry, the allowlist matcher and the
  command executor; `src/backend/routes.ts` wires chats, runs, SSE streaming, approvals, models and hosts.
- Decisions that are not obvious:
  - Runs are driven from the backend and streamed over SSE (`GET /runs/:id/stream`). Approvals block the
    loop on an in-memory promise the approvals route resolves, with a 15 minute timeout to a denial.
  - One run per chat at a time (`chatBusy`), so message `seq` numbers never race.
  - The `json()` parts column is plain text at the driver level: serialize with `JSON.stringify` and
    parse on read. Do not pass objects to it.
  - The model and reasoning effort for a run come from the POST body, falling back to the user's saved
    settings; the chat row only stores the approval mode.
  - The allowlist prefix match refuses any command containing `; & | < > \` $`, so a safe prefix cannot
    smuggle a second command.
- Things that have bitten: `better-sqlite3` needs prebuilt binaries (pinned 12.4.1 for Node 24 ABI;
  13.x has none), `requires` in manifest settings only accepts boolean fields, and the manifest rejects
  `$schema`.
- Releases: pushing to main runs `release-on-push.yml`, which releases the manifest version unless its
  tag exists. A push without a version bump does nothing; the shared `release.yml` (dev branches, beta,
  overwrite) stays for the registry flow.
