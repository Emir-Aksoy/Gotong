#!/usr/bin/env node
// Thin shim — actual logic lives in dist/main.js. Allows `aipehub-host`
// to work after `pnpm install -g @aipehub/host` or `pnpm exec aipehub-host`.
import '../dist/main.js'
