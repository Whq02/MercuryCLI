import { proofHome } from '../lib/hermetic.ts'
import assert from 'node:assert/strict'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.2' }
process.env.MERCURY_CONFIG_DIR = proofHome
const { startXaiDeviceAuth } = await import('../../src/models/roads/xai/xaiOauth.ts')
const { startNousDeviceAuth } = await import('../../src/models/roads/nous/nousOauth.ts')
const { startMoonshotDeviceAuth } = await import('../../src/models/roads/moonshot/moonshotAccounts.ts')
const providers = [
  [startXaiDeviceAuth, 'https://x.ai/device'],
  [startNousDeviceAuth, 'https://portal.nousresearch.com/device'],
  [startMoonshotDeviceAuth, 'https://kimi.ai/device'],
] as const
const verificationUrlWhere = 'the verification URL check inside the start function named here: startXaiDeviceAuth in src/models/roads/xai/xaiOauth.ts, startNousDeviceAuth in src/models/roads/nous/nousOauth.ts, startMoonshotDeviceAuth in src/models/roads/moonshot/moonshotAccounts.ts'
for (const [start, valid] of providers) {
  const io = (uri: string, complete?: string) => ({ env: {}, fetchImpl: (async () => Response.json({ device_code: 'fixture-device', user_code: 'ABCD-1234', verification_uri: uri, ...(complete !== undefined ? { verification_uri_complete: complete } : {}), expires_in: 300, interval: 5 })) as typeof fetch })
  await assert.rejects(start(io('/device')), (error: unknown) => error instanceof Error && !(error instanceof TypeError) && /invalid verification URL/.test(error.message), `${start.name}: a relative verification_uri must throw an Error saying invalid verification URL (not a TypeError); fix ${verificationUrlWhere}`)
  await assert.rejects(start(io(valid, '/complete')), /invalid verification URL/, `${start.name}: a relative verification_uri_complete must throw an Error saying invalid verification URL; fix ${verificationUrlWhere}`)
  assert.equal((await start(io(valid))).verificationUri, valid, `${start.name}: an absolute verification_uri must come back unchanged as verificationUri; fix ${verificationUrlWhere}`)
}
console.log('P10 invalid relative device links receive a sign-in error, never a raw parser error or unusable link')
