import { readFile, stat } from 'node:fs/promises'
import { parseExchangeEnvelope, verifyExchangeEnvelope } from '../packages/host/dist/exchange-envelope.js'
import { verifyDeliveryEvidence } from '../packages/host/dist/delivery-evidence.js'

async function readEnvelope(path) {
  if ((await stat(path)).size > 262144) throw new Error('Envelope exceeds 262144 bytes')
  const parsed = parseExchangeEnvelope(await readFile(path, 'utf8'))
  if (!parsed.ok) throw new Error(parsed.errors.join('; '))
  return parsed.envelope
}
try {
  const [resultPath, requestPath, ...extra] = process.argv.slice(2)
  if (!resultPath || !requestPath || extra.length) throw new Error('Usage: node scripts/verify-delivery.mjs <result.json> <original-request.json>')
  const result = await readEnvelope(resultPath)
  const request = await readEnvelope(requestPath)
  if (result.kind !== 'result' || request.kind !== 'request' || result.replyTo !== request.id) throw new Error('Result does not answer this request')
  if (!result.evidence) throw new Error('No delivery evidence; acceptance is untested')
  const signature = verifyExchangeEnvelope(result)
  const evidence = verifyDeliveryEvidence(result.evidence, result.payload, request)
  process.stdout.write(JSON.stringify({ resultId: result.id, signature, evidence }, null, 2) + '\n')
  if (!evidence.accepted || signature.state === 'invalid') process.exitCode = 1
} catch (err) {
  process.stderr.write((err instanceof Error ? err.message : String(err)) + '\n')
  process.exitCode = 1
}
