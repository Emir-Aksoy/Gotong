/**
 * @gotong/hub-steward — public barrel.
 *
 * Ships the vocabulary + classifier (SW-M1) + the `HubStewardAgent` and its
 * prompt / proposal-extraction pipeline (SW-M2). The host wiring (plan / apply /
 * approval broker) lives in `@gotong/host`, not here.
 */

export * from './types.js'
export * from './classify.js'
export * from './prompt.js'
export * from './agent.js'
