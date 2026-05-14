/**
 * `datastore` service type — typed key/value + relational storage.
 *
 * Two access modes on the same handle:
 *   - `kv`  for quick "remember this fact under this key" usage
 *   - `sql` for actual queryable data (counts, joins, aggregates)
 *
 * Agents may use either or both. The MVP file plugin lays kv on top
 * of a small JSON file; the MVP sqlite plugin lays kv on a single
 * `_kv` table inside the same .sqlite database.
 *
 * The sql interface is intentionally low-level — no migration system,
 * no ORM. Agents that want structure declare it in the yaml:
 *
 *     uses:
 *       - type: datastore
 *         impl: sqlite
 *         config:
 *           name: cases
 *           schema: |
 *             CREATE TABLE IF NOT EXISTS cases (
 *               id TEXT PRIMARY KEY, industry TEXT, ts INTEGER
 *             );
 *
 * The plugin runs `schema` at `attach` time. Agents then just call
 * `query`/`exec` like a thin driver.
 */

export interface DatastoreHandle {
  /**
   * The `config.name` this datastore was attached with. The host's
   * `LocalAgentPool.buildCtx` uses this to key the `ctx.datastore`
   * record so an agent that declared `cases` and `sessions` reads
   * them by those names. Plugins MUST expose this verbatim — using
   * the original config name lets agents and the admin UI line up.
   */
  readonly name: string
  readonly kv: KvHandle
  readonly sql: SqlHandle
}

export interface KvHandle {
  get<T = unknown>(key: string): Promise<T | undefined>
  set(key: string, value: unknown): Promise<void>
  del(key: string): Promise<void>
  /** All keys under `prefix` (empty string = all). Order undefined. */
  keys(prefix?: string): Promise<string[]>
}

export interface SqlHandle {
  /**
   * Execute DDL or DML. Returns the row count the underlying driver
   * reports as changed (INSERT / UPDATE / DELETE) or 0 for DDL.
   *
   * SQL injection: bind `params` instead of concatenating. Plugins
   * MUST use prepared statements internally.
   */
  exec(sql: string, params?: unknown[]): Promise<{ changes: number }>

  /**
   * SELECT and return rows as plain objects. `T` lets callers cast
   * the row shape — runtime is `Record<string, unknown>`.
   */
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>
}
