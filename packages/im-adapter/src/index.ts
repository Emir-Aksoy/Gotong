/**
 * @gotong/im-adapter — public surface.
 *
 * Concrete bridges (@gotong/im-telegram, @gotong/im-matrix, …)
 * import shapes + the parser from here. Hosts import the
 * `ImBindingResolver` contract to wire identity into bridges.
 */

export { parseImCommand } from './command-parser.js'
export type {
  ImBridge,
  ImUser,
  ImMessage,
  ImAttachment,
  ImCommand,
  ImBindingResolver,
  ClaimResult,
} from './types.js'
