#!/usr/bin/env node
// Thin shim — actual logic lives in dist/main.js. Allows
// `gotong <subcommand>` after `pnpm install -g @gotong/cli` or
// `npx @gotong/cli <subcommand>`.
import '../dist/main.js'
