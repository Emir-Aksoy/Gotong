# gotong

The npx-able front door of [Gotong](https://github.com/Emir-Aksoy/Gotong)
(*gotong-royong* — the whole village shoulders the work together).

```bash
npx gotong start     # boot a full hub (web UI + WebSocket + IM bridges)
npx gotong doctor    # pre-flight environment check
npx gotong help
```

This is a thin meta package: the actual CLI is
[`@gotong/cli`](https://www.npmjs.com/package/@gotong/cli), and this package
additionally depends on [`@gotong/host`](https://www.npmjs.com/package/@gotong/host)
so that `start` finds a host to boot. Installing `@gotong/cli` alone gives the
lighter sidecar/scaffolding toolkit without the host closure.

Docs: [QUICKSTART](https://github.com/Emir-Aksoy/Gotong/blob/main/QUICKSTART.md)
· [中文文档](https://github.com/Emir-Aksoy/Gotong/tree/main/docs/zh)
