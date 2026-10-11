# Project Layout

```text
personal-agent/
  backend/                   Agent runtime, CLI, Gateway and tool services
    workbench/               Workbench HTTP server and extension state store
  frontend/
    workbench/               Live workbench, extension pages and demo UI
    models/                  Model connection configuration UI
  database/                  Shared SQLite adapter and storage documentation
  test/                      Backend unit and integration tests
    frontend/                Playwright UI tests
    fixtures/performance/    Versioned evaluation input files
  scripts/                   Startup helpers, test runner and evaluation tools
    eval/                    Evaluation cases, model adapter and report builder
  docs/                      Architecture, usage guides and implementation plans
  skills/                    Project-provided Markdown skills
  artifacts/                 Generated screenshots, reports and verification logs
  .agent-data/               Private runtime data; never committed
  .codex/                    Local tool state; never committed
  node_modules/              Installed dependencies; never committed
  package.json               Root commands and dependencies
  package-lock.json          Reproducible dependency versions
  .env.example               Example configuration without real secrets
  .gitignore                 Private/generated file exclusions
```

## Ownership

The frontend contains browser assets only. HTTP entry points and server-side
stores belong to the backend. Database connection code is in `database/`; memory
and cache schemas remain with their owning backend stores. The actual database
files and user configuration remain under `.agent-data/` to preserve existing
workspaces and their security boundary.

The live UI remains at `/live.html`, the demo at `/index.html`, and extension
management at `/extensions/plugins` and `/extensions/skills`. Browser storage
keys and HTTP routes have not changed.

## Commands

Run all commands from the project root:

- `npm start`: terminal Agent.
- `npm run workbench`: Workbench with the existing sandbox startup check.
- `npm run preview`: local Workbench server without that startup entry point.
- `npm run models`: model configuration server.
- `npm run gateway`: local Gateway.
- `npm test`: backend and frontend tests, excluding fixture scripts.
- `npm run test:backend`: backend tests only.
- `npm run test:ui`: all three frontend test suites.
- `npm run perf:smoke`: local evaluation smoke test.
- `npm run clean:generated`: remove only the known disposable test/log/cache files.

Preview cleanup with `powershell -NoProfile -File scripts/clean-generated.ps1 -WhatIf`.
Run cleanup only after stopping tests and services that might be using these files.

The test runner discovers only `*.test.js`, so browser fixture scripts are never
executed as Node tests. UI screenshots go to `artifacts/screenshots/`; evaluation
reports go to `artifacts/performance/`.

## Cleanup Policy

Stale `.test-gateway-sandbox-flow-*` workspaces, old server logs, root-level test
output and Python bytecode are disposable. The gateway sandbox test now removes
its temporary workspace after each run. Historical performance reports and UI
screenshots have been retained under `artifacts/`.

Keep `.agent-data/`, source, tests, documentation, skills and dependency manifests.
Before reorganization, source was backed up outside the project in
`D:\personal-agent-backups\`. This backup is not Git history or a runtime-data
backup.
