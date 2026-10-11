# Database Layer

`sqlite.js` is the shared SQLite connection adapter. It uses `node:sqlite` when
available; unsupported runtimes disable SQLite-backed features without moving or
deleting user data.

The existing stores keep their schemas, migrations and queries:

- `../backend/memory/store.js`: long-term memory, provenance, versions and embeddings.
- `../backend/cache/store.js`: eligible model response cache.

Actual databases remain in the workspace's private `.agent-data/` directory:

- `.agent-data/memory.sqlite`
- `.agent-data/cache.sqlite`

Sessions, model metadata and other service state also remain in `.agent-data/`.
This reorganization does not change their paths or perform a data migration.
Do not commit runtime databases, encrypted secrets or session records to Git.
