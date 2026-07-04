# @gotong/service-datastore-sqlite

First-party Gotong plugin: SQLite-backed `datastore` service.
Implements [`DatastoreHandle`](../services-sdk/src/types/datastore.ts)
on top of one `.sqlite` file per declared datastore.

## Layout (under `ServiceInitCtx.rootDir`)

```
<rootDir>/
├─ agent/<agentId>/
│  ├─ cases.sqlite          ← one file per config.name
│  └─ sessions.sqlite
├─ workflow-run/<runId>/    ← when scope=workflow
├─ shared/<groupId>/        ← when scope=shared:<group>
└─ .trash/
   └─ <trashRefId>/
      ├─ meta.json
      └─ payload/           ← original owner directory
```

A single owner can declare multiple datastores by different
`config.name`s. Each name gets a dedicated `.sqlite` file so a
`DROP TABLE` in one never touches another. SoftDelete moves the
whole owner directory atomically, so all datastores travel together.

## Config schema

```yaml
uses:
  - type: datastore
    impl: sqlite
    config:
      name: cases                 # required — filesystem-safe id
      schema: |                   # optional DDL, run idempotently at attach
        CREATE TABLE IF NOT EXISTS cases (
          id TEXT PRIMARY KEY,
          industry TEXT,
          ts INTEGER
        );
      maxBytes: 50000000          # optional cap (default 50 MB)
```

| Field | Type | Default | Notes |
|---|---|---|---|
| `name` | `string` | — | Required. Same character class as agent ids: `[A-Za-z0-9._-]+`. Also the on-disk file stem. |
| `schema` | `string` | — | Optional. Runs through `db.exec()` at every `attach`. Use `IF NOT EXISTS` so repeated attaches stay idempotent. |
| `maxBytes` | `number` | `50 * 1024 * 1024` | Soft cap. Writes are rejected when the file is already past this size; reads always allowed. |

## API surface

### KV mode (`handle.kv`)

```ts
await handle.kv.set('industry', 'baker')
await handle.kv.get<string>('industry')   // 'baker'
await handle.kv.del('industry')
await handle.kv.keys('reports/')          // ['reports/q1', ...]
```

Implemented on top of a single `_kv` table the plugin creates
automatically. Values are stored JSON-encoded; non-JSON content
written by hand is returned as the raw string. KV is the right
choice for "one canonical fact per key" — names, counters, last-
session ids.

### SQL mode (`handle.sql`)

```ts
await handle.sql.exec(`
  INSERT INTO cases(id, industry, ts) VALUES (?, ?, ?)
`, ['c-1', 'baker', Date.now()])

const rows = await handle.sql.query<{ id: string }>(
  'SELECT id FROM cases WHERE industry = ?', ['baker'],
)
```

Use prepared parameters, not string concatenation. Internally the
plugin caches prepared statements keyed by SQL text, so the same
query body is parsed once even when called thousands of times.

## Lifecycle (RFC §3)

| Method | What it does |
|---|---|
| `init(ctx)` | Stash `rootDir`, mkdir `.trash`. |
| `validateConfig(raw)` | Strict schema; unknown keys throw. |
| `attach(owner, cfg)` | Open `<owner>/<cfg.name>.sqlite`, run optional schema DDL, return handle. |
| `detach(owner)` | Close every datastore that owner had. Data stays on disk. |
| `softDelete(owner)` | Move owner directory into `.trash/<trashId>/payload`. Deterministic id (hash) — re-call same day is idempotent. |
| `restore(trashRef)` | Move payload back; throws `TrashRestoreConflictError` if owner slot is taken. |
| `hardDelete(trashRef)` | rm -rf the trash entry. Irreversible. |
| `describe(owner)` | Sum of `.sqlite` sizes + count of files + preview of `_kv` rows. |
| `shutdown()` | Close every open handle. |

## Concurrency & durability

* WAL is on (`journal_mode=WAL`) — concurrent reads alongside one
  writer per process.
* Foreign keys are enforced (`foreign_keys=ON`) so schemas with FK
  constraints behave as authored.
* better-sqlite3 is synchronous; the handle wraps every call in
  async signatures to match `DatastoreHandle`. JS single-threaded
  execution removes the need for in-process locks.
* Two host processes pointing at the same workspace is unsupported
  — SQLite cross-process write contention will corrupt data.

## Versioning

`version: '0.1.0'` — major matches `services-sdk` major. The plugin
loader refuses to register on a mismatched major.
