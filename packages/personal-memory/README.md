# @gotong/personal-memory

The memory engine the resident **personal butler** stands on. M1 of the
butler build (see `docs/zh/PERSONAL-BUTLER-DESIGN.md`). 对标 OpenClaw /
Hermes 的文件优先记忆 + 前缀缓存友好的冻结块。

Leaf package — depends only on `@gotong/core`, `@gotong/llm`,
`@gotong/services-sdk`. No host, no identity, no LLM credentials.

## What's in the box

| Export | What it does |
|---|---|
| `renderFrozenBlock(entries, opts)` | Pure, **byte-stable** renderer: a SET of memory entries → a markdown block. Independent of input order (re-sorts `ts` desc, ties by `id`; one entry = one line). |
| `MemorySession` | Computes the frozen block **once per session** and caches it. New memories written mid-session land on disk but don't mutate the cached block — they surface next session. |
| `MemoryToolset` | `remember` / `recall` / `forget` exposed as LLM tools (implements `LlmAgentToolset`). Tool failures come back as `isError`, never thrown. |
| `MemoryAugmentedAgent` | `LlmAgent` + frozen-block injection (front of the system prompt) + the memory toolset composed into `tools`. |

## Why "frozen" — prompt-cache preservation

Anthropic / OpenAI prompt caching keys on a **byte-identical prefix**. If the
system prompt shifts between turns, the cache misses and every turn re-bills
the whole prefix. So the memory block is computed once at session start and
kept identical for the rest of the session — exactly Hermes' model. The block
draws from curated `semantic` memory (the profile); raw `episodic` history is
fetched on demand via the `recall` tool, not poured into every prompt.

```ts
import { MemoryAugmentedAgent } from '@gotong/personal-memory'

const butler = new MemoryAugmentedAgent({
  id: 'butler',
  provider,                 // any LlmProvider
  memory: services.memory,  // a per-user MemoryHandle (or pass via services)
  system: 'You are my personal butler.',
  tools: dispatchToolset,   // optional — memory tools compose alongside
})
```

The model writes durable facts with `remember` (they appear in the next
session's frozen block) and digs up older history with `recall`. In M1 all
three memory tools run directly — they only touch the butler's own per-user
memory. Hub-mutating / spending / sending tools are approval-gated in a later
milestone (Phase 16 inbox), per the North Star: the framework proposes,
sensitive actions wait for a human.

## Tests

```sh
pnpm --filter @gotong/personal-memory test
```

Covers: frozen-block determinism + cap, session memoization + mid-session
freeze, toolset round-trip + validation, and an integration test proving the
system prefix stays byte-identical across turns and that a mid-session
`remember` surfaces only in the next session.
