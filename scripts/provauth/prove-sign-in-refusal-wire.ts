import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { pinSourceRef } from '../lib/settingsPopupHarness.ts'

pinSourceRef()
const home = mkdtempSync(join(tmpdir(), 'sign-in-refusal-wire-'))
process.env.MERCURY_CONFIG_DIR = home
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
delete process.env.MERCURY_HOME
for (const name of Object.keys(process.env)) if (/API_KEY|AUTH_TOKEN|OAUTH_TOKEN|HF_TOKEN|MERCURY_MODEL/.test(name)) delete process.env[name]
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
let failures = 0
const check = (label: string, ok: boolean, detail = '') => { if (!ok) failures++; console.log(`[${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`) }
const statuses = new Map<string, number>()
const calls: Array<{ family: string; path: string; status: number; model?: string }> = []
const sse = (value: unknown) => `data: ${JSON.stringify(value)}\n\n`
const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(req) {
  const url = new URL(req.url)
  const family = url.pathname.split('/')[1]!
  const status = statuses.get(family) ?? 200
  if (req.method === 'GET') return Response.json({ data: [{ id: 'fixture/model', context_length: 32768, supported_parameters: ['tools'], providers: [] }] })
  const body = await req.json() as Record<string, unknown>
  calls.push({ family, path: url.pathname, status, model: body.model as string })
  if (status !== 200) return Response.json({ error: { code: status, message: 'The fixture refused this stored credential' } }, { status })
  const model = body.model as string
  if (url.pathname.endsWith('/responses')) {
    const item = { id: 'msg_fixture', type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'OK', annotations: [] }] }
    return new Response(sse({ type: 'response.created', response: { id: 'r_fixture', model, status: 'in_progress' } }) + sse({ type: 'response.output_item.added', item: { ...item, status: 'in_progress', content: [] } }) + sse({ type: 'response.output_text.delta', item_id: item.id, delta: 'OK' }) + sse({ type: 'response.output_item.done', item }) + sse({ type: 'response.completed', response: { id: 'r_fixture', model, status: 'completed', output: [item], usage: { input_tokens: 3, output_tokens: 1 } } }) + 'data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } })
  }
  return new Response(sse({ id: 'fixture', model, choices: [{ index: 0, delta: { role: 'assistant', content: 'OK' }, finish_reason: null }] }) + sse({ id: 'fixture', model, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 } }) + 'data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } })
} })
const base = `http://127.0.0.1:${server.port}`
process.env.MERCURY_DEEPSEEK_API_BASE = `${base}/deepseek`
process.env.MERCURY_OPENROUTER_API_BASE = `${base}/openrouter`
process.env.MERCURY_OPENROUTER_AUTH_BASE = `${base}/openrouter`
process.env.MERCURY_HUGGINGFACE_API_BASE = `${base}/huggingface`
process.env.MERCURY_HUGGINGFACE_HUB_BASE = `${base}/huggingface`
const { enableConfigs } = await import('../../src/platform/settings/config.js')
enableConfigs()
const secrets = await import('../../src/models/sign-in/account-ledger/providerSecrets.js')
const { captureSignInRequest, observeSignInResponse, readSignInRefusal } = await import('../../src/models/roads/signInRefusal.js')
const { recordSignIn } = await import('../../src/models/sign-in/account-ledger/signInLedger.js')
const { composeSignInView, summarizeSignInView } = await import('../../src/daemon/session-seat/signInView.js')
const { collectLoginsScreenFacts, loginsCatalogue, loginsRowStateOf } = await import('../../src/screen/boot-face/BootLoginsScreen.js')
const { routedCallModel } = await import('../../src/models/roads/callModelRouter.js')
const { getEmptyToolPermissionContext } = await import('../../src/tools/kit/tool.js')
const { createUserMessage } = await import('../../src/engine/messages/messages.js')
const { clearToolRosterLatches } = await import('../../src/models/roads/toolEconomy.js')
async function turn(model: string) {
  clearToolRosterLatches()
  const output: string[] = []
  for await (const item of routedCallModel({ messages: [createUserMessage({ content: 'Say OK' })], systemPrompt: ['Fixture system'] as never, thinkingConfig: { type: 'disabled' }, tools: [], signal: new AbortController().signal, options: { model, querySource: 'main_thread', isNonInteractiveSession: true, getToolPermissionContext: async () => getEmptyToolPermissionContext(), agents: [], hasAppendSystemPrompt: false, mcpTools: [], hasPendingMcpServers: false } as never })) {
    if (item.type === 'assistant') output.push(...item.message.content.filter(b => b.type === 'text').map(b => (b as { text: string }).text))
  }
  return output.join('')
}
try {
  const rows = [
    { family: 'deepseek', model: 'deepseek-chat', store: secrets.writeStoredDeepseekApiKey },
    { family: 'openrouter', model: 'openrouter/fixture/model', store: secrets.writeStoredOpenrouterApiKey },
    { family: 'huggingface', model: 'huggingface/fixture/model', store: secrets.writeStoredHuggingfaceApiKey },
  ]
  for (const row of rows) {
    row.store(`fixture-${row.family}-key`)
    for (const status of [401, 403]) {
      statuses.set(row.family, status)
      const before = calls.length
      await turn(row.model)
      check(`${row.family}: refused request reached the wire`, calls.slice(before).some(call => call.family === row.family && call.status === status), `no ${status} request to the ${row.family} fixture was recorded; check that routedCallModel in src/models/roads/callModelRouter.ts still sends the turn to this family's provider road`)
      const refusal = readSignInRefusal(row.family)
      check(`${row.family}: HTTP ${status} persists for the stored credential`, refusal?.status === status, `${JSON.stringify(refusal)}; the provider road must call observeSignInResponse (src/models/roads/signInRefusal.ts) with the wire status`)
      const view = composeSignInView({ refresh: true })
      check(`${row.family}: health view reads refused instead of usable`, view.families.find(f => f.family === row.family)?.usable === false && summarizeSignInView(view).includes(`refused (HTTP ${status}`), `composeSignInView or summarizeSignInView in src/daemon/session-seat/signInView.ts does not report the stored refusal: ${summarizeSignInView(view)}`)
      const facts = collectLoginsScreenFacts()
      const arm = loginsCatalogue().find(arm => arm.familyId === row.family)!
      check(`${row.family}: logins carries the same timestamp`, !!refusal && loginsRowStateOf(arm, facts).chip.includes(new Date(refusal.at).toISOString().replace(/\.\d{3}Z$/, 'Z')), `loginsRowStateOf (src/screen/boot-face/logins/facts.ts) must show the refusal timestamp from readSignInRefusal; chip: ${refusal ? loginsRowStateOf(arm, facts).chip : 'no refusal was stored'}`)
      statuses.set(row.family, 200)
      const reply = await turn(row.model)
      check(`${row.family}: retry is sent and settles after refusal`, reply === 'OK', `${reply}; a stored refusal must not block the next request in routedCallModel (src/models/roads/callModelRouter.ts)`)
      check(`${row.family}: the successful turn clears the refusal`, readSignInRefusal(row.family) === undefined, 'observeSignInResponse in src/models/roads/signInRefusal.ts must clear the stored refusal on a 2xx for the same credential')
    }
  }
  const old = captureSignInRequest('deepseek', 'fixture-deepseek-key')
  secrets.writeStoredDeepseekApiKey('fixture-deepseek-replaced-key')
  observeSignInResponse(old, 401)
  check('a late old request cannot refuse the new sign-in', readSignInRefusal('deepseek') === undefined, 'observeSignInResponse in src/models/roads/signInRefusal.ts must ignore a response whose credential or generation no longer matches the stored key')
  const current = captureSignInRequest('deepseek', 'fixture-deepseek-replaced-key')
  observeSignInResponse(current, 401)
  check('the current request can refuse the current key', readSignInRefusal('deepseek')?.status === 401, 'observeSignInResponse in src/models/roads/signInRefusal.ts must store a 401 for the current key')
  observeSignInResponse(captureSignInRequest('deepseek', 'fixture-other-key'), 200)
  check('success on another key cannot clear this refusal', readSignInRefusal('deepseek')?.status === 401, 'captureSignInRequest in src/models/roads/signInRefusal.ts must return no observation when the wire credential is not the current key')
  process.env.DEEPSEEK_API_KEY = 'fixture-env-key'
  check('a stored refusal is not attributed to an environment override', readSignInRefusal('deepseek') === undefined, 'readSignInRefusal in src/models/roads/signInRefusal.ts must compare the stored refusal identity with the current credential, which is now the environment key')
  observeSignInResponse(captureSignInRequest('deepseek', 'fixture-env-key'), 403)
  delete process.env.DEEPSEEK_API_KEY
  check('an environment refusal cannot overwrite the stored key refusal', readSignInRefusal('deepseek')?.status === 401, 'observeSignInResponse in src/models/roads/signInRefusal.ts must not replace the stored-key refusal with one for the environment key')
  recordSignIn('deepseek', 'operator-switch')
  check('a default-provider switch is not a successful sign-in', readSignInRefusal('deepseek')?.status === 401, 'recordSignIn in src/models/sign-in/account-ledger/signInLedger.ts must not clear the refusal memo kept by src/models/roads/signInRefusal.ts')
  const concurrent = captureSignInRequest('deepseek', 'fixture-deepseek-replaced-key')
  observeSignInResponse(captureSignInRequest('deepseek', 'fixture-deepseek-replaced-key'), 403)
  observeSignInResponse(concurrent, 200)
  check('a successful in-flight request clears an intervening refusal on the same key', readSignInRefusal('deepseek') === undefined, 'observeSignInResponse in src/models/roads/signInRefusal.ts must clear a 2xx for the same credential even when a refusal was stored after the request was captured')
  const previousGeneration = captureSignInRequest('deepseek', 'fixture-deepseek-replaced-key')
  secrets.writeStoredDeepseekApiKey('fixture-deepseek-replaced-key')
  observeSignInResponse(previousGeneration, 401)
  check('a new sign-in with the same key also fences an earlier request', readSignInRefusal('deepseek') === undefined, 'writeStoredDeepseekApiKey must change the generation that captureSignInRequest records, so observeSignInResponse in src/models/roads/signInRefusal.ts drops the earlier request')
  observeSignInResponse(captureSignInRequest('deepseek', 'fixture-deepseek-replaced-key'), 401)
  const path = join(home, '.sign-in-refusals', 'deepseek.json')
  const stored = readFileSync(path, 'utf8')
  check('the memo contains no credential and has private permissions', !stored.includes('fixture-') && (process.platform === 'win32' || (statSync(path).mode & 0o777) === 0o600), 'publishSignInRecord in src/models/roads/signInRefusal.ts must write the memo without the key and with mode 0600')
} finally { server.stop(true); rmSync(home, { recursive: true, force: true }) }
console.log(failures ? `sign-in-refusal-wire: ${failures} FAILURE(S)` : 'sign-in-refusal-wire: ALL LAWS HOLD')
process.exit(failures ? 1 : 0)
