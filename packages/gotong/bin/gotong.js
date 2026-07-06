#!/usr/bin/env node
// Unscoped alias so `npx gotong <cmd>` works with zero ceremony. The real CLI
// lives in @gotong/cli; this package exists to (a) own the short name and
// (b) pull @gotong/host into the install closure, so `npx gotong start`
// boots a FULL hub (`start` resolves the host lazily and hands the process
// over to it). Explicit call, not an import-side-effect: npm exposes bins as
// symlinks, so argv-based "am I main?" heuristics mis-answer here.
import { runCli } from '@gotong/cli'

const code = await runCli()
if (typeof code === 'number' && code !== 0) process.exit(code)
