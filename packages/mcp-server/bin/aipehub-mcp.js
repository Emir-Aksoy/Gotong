#!/usr/bin/env node
// Thin shim — actual logic in dist/main.js. Lets MCP clients launch us
// via `npx @aipehub/mcp-server` or a global install.
import '../dist/main.js'
