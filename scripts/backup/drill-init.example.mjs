/**
 * Canonical seed script for the disaster-recovery drill in
 * `docs/OPERATIONS.md`.
 *
 * Adjust the workspace path + the absolute import path to match your
 * checkout, then run with:
 *
 *   node scripts/backup/drill-init.example.mjs
 *
 * After this script runs, /tmp/drill/space contains a realistic
 * mini-workspace you can back up, destroy, and restore as practice.
 *
 * NOT FOR PRODUCTION USE — the API keys here are fake placeholders
 * and the admin token is printed to stdout (a host normally hands it
 * over only on the first-run banner).
 */

import { Space } from '../../packages/core/dist/index.js'

const root = process.env.DRILL_ROOT ?? '/tmp/drill/space'

const result = await Space.init(root, {
  name: 'drill-workspace',
  adminDisplayName: 'DrillAdmin',
})

console.log('init:', {
  root,
  adminId: result.adminId,
  adminToken: result.adminToken,
})

// Realistic mini-state: one provider key, two managed agents, one worker.
await result.space.setProviderApiKey('anthropic', 'sk-ant-fakedrillkey')
await result.space.upsertAgent({ id: 'writer', allowedCapabilities: ['draft'] })
await result.space.upsertAgent({ id: 'reviewer', allowedCapabilities: ['review'] })

const { worker } = await result.space.createWorker('alice', ['draft', 'review'])
console.log('worker:', worker.id)

console.log('\n✓ drill workspace seeded at', root)
console.log('  - 1 admin (DrillAdmin)')
console.log('  - 2 agents (writer, reviewer)')
console.log('  - 1 worker (alice)')
console.log('  - 1 fake provider key (anthropic = sk-ant-fakedrillkey)')
