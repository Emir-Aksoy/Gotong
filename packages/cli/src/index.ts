/**
 * Public surface of `@gotong/cli` — only `runCli` is re-exported. The
 * rest of the package is internal; consumers either invoke the bin
 * directly or call `runCli(argv)` programmatically (e.g. from inside
 * an integration test).
 */

export { runCli } from './main.js'
