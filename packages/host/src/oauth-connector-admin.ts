/**
 * C-M2-M5a — host glue for the outbound OAuth connector admin surface.
 *
 * A thin pass-through from web's `OAuthConnectorAdminSurface` to the identity
 * store's OAuth connector facade. Extracted as a factory so main.ts adds one
 * line (same move as `createOAuthConnectSurface`). The store keeps the
 * client_secret + token set in the vault and its projection never carries
 * either, so web only ever sees `hasClientSecret` + `connected`.
 *
 * The annotated `OAuthConnectorAdminSurface` return type is load-bearing: if
 * web's surface and the identity facade ever drift, this stops compiling.
 */
import type {
  OAuthConnector,
  RegisterOAuthConnectorInput,
  UpdateOAuthConnectorInput,
} from '@gotong/identity'
import type { OAuthConnectorAdminSurface } from '@gotong/web'

/** The narrow identity facade this surface needs (IdentityStore satisfies it). */
export interface OAuthConnectorAdminIdentity {
  listOAuthConnectors(): OAuthConnector[]
  registerOAuthConnector(input: RegisterOAuthConnectorInput): OAuthConnector
  updateOAuthConnector(id: string, patch: UpdateOAuthConnectorInput): OAuthConnector
  removeOAuthConnector(id: string): boolean
  clearOAuthTokenSet(id: string): boolean
}

export function createOAuthConnectorAdminSurface(
  identity: OAuthConnectorAdminIdentity,
): OAuthConnectorAdminSurface {
  return {
    list: () => identity.listOAuthConnectors(),
    add: (input) => identity.registerOAuthConnector(input),
    update: (id, patch) => identity.updateOAuthConnector(id, patch),
    remove: (id) => identity.removeOAuthConnector(id),
    disconnect: (id) => identity.clearOAuthTokenSet(id),
  }
}
