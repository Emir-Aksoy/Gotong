/**
 * `@aipehub/service-artifact-file`
 *
 * First-party `artifact:file` plugin. Default export is a factory
 * (per services-sdk loader convention).
 */

import { ArtifactFilePlugin } from './plugin.js'

export { ArtifactFilePlugin } from './plugin.js'
export { ArtifactFileHandle } from './handle.js'
export { validateArtifactFileConfig, mimeAllowed } from './config.js'
export type { ArtifactFileConfig } from './config.js'
export { guessMime } from './mime.js'
export { sanitisePath } from './paths.js'

export default function createArtifactFilePlugin(): ArtifactFilePlugin {
  return new ArtifactFilePlugin()
}
