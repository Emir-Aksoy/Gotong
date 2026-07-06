#!/usr/bin/env node
// Thin shim — actual logic lives in dist/main.js. Explicit call, NOT an
// import-side-effect: npm installs expose bins as SYMLINKS, so argv[1] is
// `.bin/gotong` and any "am I the main module?" heuristic inside the module
// body mis-answers (silent no-op). The shim KNOWS it is the entrypoint.
import { runCli } from '../dist/main.js'

const code = await runCli()
if (typeof code === 'number' && code !== 0) process.exit(code)
