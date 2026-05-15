#!/usr/bin/env node
// Thin shim — actual logic lives in dist/main.js. Allows
// `aipehub <subcommand>` after `pnpm install -g @aipehub/cli` or
// `npx @aipehub/cli <subcommand>`.
import '../dist/main.js'
