#!/usr/bin/env node
// Thin shim — actual logic lives in dist/main.js. Allows `gotong-host`
// to work after `pnpm install -g @gotong/host` or `pnpm exec gotong-host`.
import '../dist/main.js'
