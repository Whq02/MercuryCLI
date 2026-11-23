import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { llmhostFixture } from '../providers/lib/llmhostFixture.ts'
import { validateEngineRequest } from '../provider-compat/fixtures/engineRules.mjs'

assert.ok(process.env.MERCURY_CONFIG_DIR, 'a scratch MERCURY_CONFIG_DIR is required')
const f = await llmhostFixture()
const originalFetch = globalThis.fetch
globalThis.fetch = Object.assign(async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(input instanceof Request ? input.url : String(input))
  assert.equal(url.hostname, '127.0.0.1', 'all provider calls stay on loopback')
  if (url.pathname === '/v1/chat/completions') {
    const body = JSON.parse(typeof init?.body === 'string' ? init.body : await (input as Request).clone().text())
    assert.equal(validateEngineRequest('vllm', body), undefined)
  }
  return originalFetch(input, init)
}, originalFetch)
writeFileSync(join(f.home, 'settings.json'), JSON.stringify({ compatProvider: {
  keyless: { baseUrl: f.baseUrl, dialect: 'vllm', models: [f.model] },
  protected: { baseUrl: f.baseUrl, dialect: 'vllm', models: [f.model], keyCommand: 'exit 1' },
} }))
const { resetSettingsCache } = await import('../../src/platform/settings/settingsCache.ts')
resetSettingsCache()
const { writeStoredCompatApiKey } = await import('../../src/models/sign-in/account-ledger/providerSecrets.ts')
const { refreshSignInReads } = await import('../../src/daemon/session-seat/signInView.ts')
const { deriveScheduleAccountForModel, readLiveAccountFacts } = await import('../../src/daemon/saturn/saturnAccount.ts')
const { applyConcourseScheduleOp } = await import('../../src/daemon/saturn/saturn.ts')
const { tickSaturnOnce } = await import('../../src/daemon/saturn/saturnTicker.ts')
const { updateConcourseWorkers, concourseWorkersPath } = await import('../../src/daemon/concourse-workers/concourseWorkers.ts')
const { readSessionReceipts } = await import('../../src/daemon/switchboard/sessionReceipts.ts')
const { getProjectDir } = await import('../../src/sessions/transcripts/paths.ts')
const model = `compat/protected/${f.model}`
const keylessModel = `compat/keyless/${f.model}`
const dir = join(f.home, 'daemon')
const workspace = join(f.home, 'workspace')
mkdirSync(dir)
mkdirSync(workspace)
let checks = 0
let failures = 0
const check = (label: string, truth: unknown, detail?: unknown, hint?: string) => { checks++; if (!truth) failures++; console.log(`${truth ? 'PASS' : 'FAIL'} ${label}${!truth && detail !== undefined ? ' — ' + JSON.stringify(detail) : ''}${!truth && hint !== undefined ? ' — change: ' + hint : ''}`) }
const readRecord = () => JSON.parse(readFileSync(concourseWorkersPath(dir), 'utf8')).workers.fixture
const setKey = (present: boolean) => { writeStoredCompatApiKey(present ? f.key : null, 'protected'); refreshSignInReads(true) }
try {
  setKey(false)
  const missing = deriveScheduleAccountForModel(model)
  check('a keyless sibling cannot authorize the protected endpoint schedule', !missing.ok, missing, 'deriveScheduleAccountForModel in src/daemon/saturn/saturnAccount.ts must resolve the selected compat endpoint own key, not a keyless sibling')
  check('the missing-key sentence names the selected endpoint login', !missing.ok && missing.reason.includes('/logins compat/protected'), missing, 'the missing-key reason from deriveScheduleAccountForModel in src/daemon/saturn/saturnAccount.ts must name /logins compat/protected')
  check('an unconfigured endpoint cannot borrow another endpoint account', !deriveScheduleAccountForModel(`compat/absent/${f.model}`).ok, undefined, 'deriveScheduleAccountForModel in src/daemon/saturn/saturnAccount.ts must refuse an endpoint that is not in compatProvider settings')
  const keyless = deriveScheduleAccountForModel(keylessModel)
  check('the genuinely keyless endpoint keeps its own keyless source', keyless.ok && keyless.account.source === 'keyless', keyless, 'deriveScheduleAccountForModel in src/daemon/saturn/saturnAccount.ts must return source keyless for an endpoint with no keyCommand')
  setKey(true)
  const connected = deriveScheduleAccountForModel(model)
  check('the selected endpoint reads its stored key instead of the first endpoint source', connected.ok && connected.account.source === 'api-key', connected, 'deriveScheduleAccountForModel in src/daemon/saturn/saturnAccount.ts must read the stored key of the selected endpoint')
  check('the durable account carries the selected model identity without credential material', connected.ok && (connected.account as any).modelKey === model && !JSON.stringify(connected.account).includes(f.key), undefined, 'the account built by deriveScheduleAccountForModel in src/daemon/saturn/saturnAccount.ts must carry modelKey and never the key itself')
  const account = connected.ok ? JSON.parse(JSON.stringify(connected.account)) : { family: 'openai-compat', source: 'api-key', modelKey: model }
  check('fresh live facts read the same endpoint account', readLiveAccountFacts(account).credentialed, undefined, 'readLiveAccountFacts in src/daemon/saturn/saturnAccount.ts must read the selected endpoint stored key as credentialed')

  const sessionId = '00000000-0000-4000-8000-000000000046'
  const now = Date.now() + 1000
  updateConcourseWorkers(workers => { workers.fixture = { schema: 1, runnerId: 'fixture', sessionId, workspaceId: workspace, isolation: 'shared', modelKey: model, effort: 'max', spawnedAt: now - 5000, lastLiveAt: now - 5000, parkedAt: now - 1000 } as never }, dir)
  const add = applyConcourseScheduleOp(sessionId, { op: 'add', schedule: { when: { kind: 'at', atMs: now - 1 }, action: { kind: 'fire', prompt: 'WAKE-ON-ORIGINAL-ENDPOINT' }, onParked: 'wake' } }, 'operator:fixture', { deriveAccount: deriveScheduleAccountForModel }, dir)
  check('the scheduled wake is admitted with the endpoint credential present', add.outcome === 'applied', add, 'applyConcourseScheduleOp in src/daemon/saturn/saturn.ts must admit the add when deriveScheduleAccountForModel resolves the stored key')
  setKey(false)
  check('replayed account facts detect sign-out despite the keyless sibling', !readLiveAccountFacts(account).credentialed, undefined, 'readLiveAccountFacts in src/daemon/saturn/saturnAccount.ts must read the selected endpoint as signed out once its key is removed, whatever the keyless sibling says')
  let deliveries = 0
  let successful = 0
  let parked = false
  const ports = {
    now: () => now,
    records: () => [readRecord()],
    liveFacts: readLiveAccountFacts,
    deriveAccount: deriveScheduleAccountForModel,
    deliver: async (delivery: any) => {
      deliveries++
      parked = delivery.parked
      const rows = await f.run(model, [f.createUserMessage({ content: delivery.prompt })])
      const ok = rows.some(row => row.message.content.some((block: any) => block.type === 'text' && block.text === 'LLMHOST-READY')) && rows.every(row => !row.isApiErrorMessage)
      if (ok) successful++
      return { ok, ...(ok ? {} : { detail: 'fixture continuation did not answer' }) }
    },
    birth: async () => ({ ok: false, detail: 'not a birth schedule' }),
    screenOpen: () => true,
    dir,
  }
  const held = await tickSaturnOnce(ports)
  check('the missing endpoint key holds the wake before delivery or model use', held.held === 1 && deliveries === 0 && f.captures.length === 0, { held, deliveries, requests: f.captures.length }, 'tickSaturnOnce in src/daemon/saturn/saturnTicker.ts must hold a due fire whose account is signed out before deliver or any model request')
  check('the durable hold names sign-out of the selected account', readRecord().heldFires?.[0]?.reason === 'signed-out', readRecord().heldFires, 'the held fire written by tickSaturnOnce in src/daemon/saturn/saturnTicker.ts must carry reason signed-out')
  const receipt = readSessionReceipts(getProjectDir(workspace), sessionId).filter(row => row.kind === 'schedule-held').at(-1)
  check('the hold receipt names the selected endpoint remedy', receipt?.summary.includes('/logins compat/protected'), receipt?.summary, 'the schedule-held receipt row written by tickSaturnOnce in src/daemon/saturn/saturnTicker.ts must carry the /logins compat/protected remedy')
  setKey(true)
  const released = await tickSaturnOnce(ports)
  check('restoring its stored key replays the parked wake exactly once', released.replayed === 1 && successful === 1 && deliveries === 1 && parked, { released, successful, deliveries, parked }, 'tickSaturnOnce in src/daemon/saturn/saturnTicker.ts must replay the held fire once the key is back and deliver it once')
  check('the resumed request uses its exact wire model and stored endpoint key', f.captures.length === 1 && f.captures[0]?.body.model === f.model && f.captures[0]?.auth === `Bearer ${f.key}` && f.captures[0]?.body.reasoning_effort === 'max', f.captures.map(c => ({ model: c.body.model, auth: c.auth, effort: c.body.reasoning_effort })), 'the replayed delivery must send the wire model, the stored endpoint key and the recorded effort; check the account and model resolution in src/daemon/saturn/saturnAccount.ts')
  const again = await tickSaturnOnce(ports)
  check('the settled wake has no debt and never delivers twice', again.replayed === 0 && successful === 1 && (readRecord().heldFires?.length ?? 0) === 0, { again, successful, held: readRecord().heldFires }, 'tickSaturnOnce in src/daemon/saturn/saturnTicker.ts must clear the held fire after the replay and not deliver again')
} finally {
  globalThis.fetch = originalFetch
  f.close()
}
console.log(`COMPAT SCHEDULE ACCOUNT ${failures ? 'RED' : 'GREEN'} — ${checks - failures}/${checks}; production account readers, durable ticker, stored fixture key and loopback wake`)
process.exit(failures ? 1 : 0)
