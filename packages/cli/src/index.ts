/**
 * Public surface of `@gotong/cli` — `runCli` plus the FDE-M3 `provision`
 * body (programmatic install+schedules+acceptance against a running hub;
 * its injectable out/err/fetch seams are what integration tests and
 * deploy scripts want). The rest of the package is internal; consumers
 * either invoke the bin directly or call these from code.
 */

export { runCli } from './main.js'
export { provision, type ProvisionDeps } from './commands/provision.js'
