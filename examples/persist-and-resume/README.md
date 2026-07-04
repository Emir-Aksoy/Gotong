# persist-and-resume

Proves the Hub's transcript survives across process restarts — and proves the `Storage` interface is plug-and-play between the two first-party backends (`FileStorage` and `SqliteStorage`).

## Run

Four variants, each a separate command:

```bash
# JSONL file backend (default, zero native deps)
pnpm demo:persist:fresh      # wipe, write entries, exit
pnpm demo:persist:resume     # reopen the same file, append one more

# SQLite backend
pnpm demo:persist:sqlite:fresh
pnpm demo:persist:sqlite:resume
```

State lives under `examples/persist-and-resume/gotong-data/`. Delete that directory to start over.

## What this proves

- **Hub state is durable**: between `fresh` and `resume` the process exits completely; on resume the transcript loads from disk and the next entry slots in seamlessly.
- **Storage is pluggable**: the Hub itself doesn't change between the two demos. Only `new FileStorage(...)` vs `new SqliteStorage({ path })` differs in `pickStorage()`. Same `Storage` interface, same semantics, different write-amplification profile.
- **SQLite is opt-in**: `better-sqlite3` is a peer dep that only loads when you ask for it. The file backend is the zero-native-deps default.

Source: [`src/index.ts`](src/index.ts).
