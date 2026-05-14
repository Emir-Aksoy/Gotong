/**
 * Public surface of the host's services glue.
 *
 * Internal to `@aipehub/host`. Re-exported through `host/src/index.ts`
 * for tests; the production binary uses `bootstrapServices` directly
 * from `main.ts`.
 */

export {
  HubServices,
  pluginRootDir,
  ensurePluginRootDir,
  type AttachedHandle,
  type DetachedHandle,
  type ServiceUseSpec,
} from './hub-services.js'

export {
  bootstrapServices,
  type BootstrapServicesOpts,
  type BootstrapServicesResult,
} from './bootstrap.js'

export { LifecycleSweeper, type LifecycleSweeperOpts } from './sweeper.js'
