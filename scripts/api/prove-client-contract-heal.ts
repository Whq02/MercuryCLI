import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let failures = 0
let checks = 0
function check(label: string, ok: boolean, detail = ''): void {
  checks++
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log(`\n${'─'.repeat(76)}\n${t}\n${'─'.repeat(76)}`)
}
function compareVersions(a: string, b: string): number {
  const left = a.split('.').map(Number)
  const right = b.split('.').map(Number)
  for (let i = 0; i < 3; i++) {
    if ((left[i] ?? 0) < (right[i] ?? 0)) return -1
    if ((left[i] ?? 0) > (right[i] ?? 0)) return 1
  }
  return 0
}
function bump(v: string, patch: number): string {
  const parts = v.split('.')
  return `${parts[0]}.${parts[1]}.${Number(parts[2]) + patch}`
}
const dayOf = (ms: number | undefined): string => (typeof ms === 'number' ? new Date(ms).toISOString().slice(0, 10) : '')
const ROOT = join(import.meta.dir, '..', '..')

type RegistryMode =
  | { kind: 'ok'; version: string; holdMs?: number; onRead?: () => void }
  | { kind: 'status500' }
  | { kind: 'hang' }
  | { kind: 'noversion' }
let registryMode: RegistryMode = { kind: 'ok', version: '' }
let registryReads = 0
let registryLastUrl = ''
let registryLastAgent = ''
const registry = createServer((req, res) => {
  registryReads++
  registryLastUrl = req.url ?? ''
  registryLastAgent = String(req.headers['user-agent'] ?? '')
  const mode = registryMode
  if (mode.kind === 'hang') return
  if (mode.kind === 'status500') {
    res.writeHead(500, { 'content-type': 'text/plain' })
    res.end('boom')
    return
  }
  if (mode.kind === 'noversion') {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ name: '@anthropic-ai/claude-code' }))
    return
  }
  mode.onRead?.()
  const answer = (): void => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ name: '@anthropic-ai/claude-code', version: mode.version }))
  }
  if (mode.holdMs === undefined) answer()
  else setTimeout(answer, mode.holdMs)
})
await new Promise<void>(resolve => registry.listen(0, '127.0.0.1', resolve))
const registryPort = (registry.address() as { port: number }).port

let sideFloor = ''
const sideRequests: Array<{ version: string; system: Array<{ text?: string }> }> = []
const sideDoor = createServer((req, res) => {
  let raw = ''
  req.on('data', chunk => {
    raw += String(chunk)
  })
  req.on('end', () => {
    if (!(req.url ?? '').includes('/v1/messages')) {
      res.writeHead(200)
      res.end()
      return
    }
    const body = JSON.parse(raw || '{}') as { system?: Array<{ text?: string }> }
    const line = (body.system ?? []).map(b => b.text ?? '').find(t => t.startsWith('x-anthropic-billing-header: ')) ?? ''
    const version = /cc_version=(\d+\.\d+\.\d+)\./.exec(line)?.[1] ?? ''
    sideRequests.push({ version, system: body.system ?? [] })
    if (compareVersions(version, sideFloor) < 0) {
      res.writeHead(400, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: `${version} does not support this model; version ${sideFloor} or newer is required. Run claude update.`, details: { error_code: 'claude_code_version_too_old' } } }))
      return
    }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ id: 'msg_side', type: 'message', role: 'assistant', model: 'claude-opus-5-5', content: [{ type: 'text', text: 'side answered' }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } }))
  })
})
await new Promise<void>(resolve => sideDoor.listen(0, '127.0.0.1', resolve))
const sidePort = (sideDoor.address() as { port: number }).port

const DEAD_LETTER = 'http://127.0.0.1:1'
const scratchRoot = mkdtempSync(join(tmpdir(), 'client-contract-heal-'))
process.env.MERCURY_CONFIG_DIR = scratchRoot
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.ANTHROPIC_API_KEY = 'proof-key-ci-gate-not-a-real-key'
process.env.ANTHROPIC_BASE_URL = DEAD_LETTER
process.env.MERCURY_CUSTOM_OAUTH_URL = DEAD_LETTER
process.env.MERCURY_NPM_REGISTRY_BASE = `http://127.0.0.1:${registryPort}`
for (const key of ['NODE_ENV', 'CI', 'MERCURY_ANTHROPIC_CLIENT_CONTRACT', 'MERCURY_DISABLE_NONESSENTIAL_TRAFFIC', 'MERCURY_FAULT_INJECT', 'MERCURY_SCRIPTED_STREAM', 'ANTHROPIC_AUTH_TOKEN', 'MERCURY_OAUTH_TOKEN', 'MERCURY_OAUTH_TOKEN_FILE_DESCRIPTOR', 'MERCURY_API_KEY_FILE_DESCRIPTOR', 'MERCURY_BARE', 'HTTPS_PROXY', 'HTTP_PROXY', 'https_proxy', 'http_proxy']) delete process.env[key]
writeFileSync(join(scratchRoot, '.mercury.json'), JSON.stringify({ customApiKeyResponses: { approved: ['proof-key-ci-gate-not-a-real-key'.slice(-20)], rejected: [] } }))
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

const { enableConfigs } = await import('../../src/utils/config.js')
enableConfigs()
const envUtils = await import('../../src/utils/envUtils.js')
const { setIsInteractive } = await import('../../src/bootstrap/state.js')
const oauth = await import('../../src/constants/oauth.js')
const { queryModelWithStreaming } = await import('../../src/services/providers/anthropic/streamCore.js')
const { getEmptyToolPermissionContext } = await import('../../src/Tool.js')
const { createUserMessage } = await import('../../src/utils/messages.js')
const { asSystemPrompt } = await import('../../src/utils/systemPromptType.js')
const auth = await import('../../src/utils/auth.js')
const lawful = await import('../../src/services/providers/lawfulPrefixChange.js')
const { processOwnerForLane } = await import('../../src/services/run/resolveOwner.js')
const health = await import('../../src/utils/healthReport.js')
const ledger = await import('../../src/services/providers/anthropic/prefixLedger.js')
const { getAttributionHeader } = await import('../../src/constants/system.js')
const { sideQuery } = await import('../../src/utils/sideQuery.js')

const CONTRACT = oauth.ANTHROPIC_CLIENT_CONTRACT_VERSION
const NEWER = bump(CONTRACT, 9)
const NEWER_2 = bump(CONTRACT, 10)
const STILL_REFUSED_FLOOR = bump(CONTRACT, 20)
const OLDER = bump(CONTRACT, -1)
const ANSWERED_FLOOR = bump(CONTRACT, -50)
const MODEL = 'claude-opus-5-5'
const OWNER = String(processOwnerForLane(null))

type LearnedModule = typeof import('../../src/services/api/clientContractLearned.js')
let learnedModule: LearnedModule | null = null
try {
  learnedModule = await import('../../src/services/api/clientContractLearned.js')
} catch {}

setIsInteractive(true)

const homeOf = (name: string): string => join(scratchRoot, `home-${name}`)
function freshHome(name: string): string {
  const dir = homeOf(name)
  mkdirSync(dir, { recursive: true })
  envUtils.setAuthScope(dir)
  auth.clearOAuthTokenCache()
  return dir
}
function useHome(name: string): void {
  envUtils.setAuthScope(homeOf(name))
  auth.clearOAuthTokenCache()
}

type RecordFile = {
  learned?: { version?: string; learnedAtMs?: number }
  lastRead?: { atMs?: number; by?: string; answer?: { version?: string; failure?: { kind?: string; words?: string } } }
  lastPeekAtMs?: number
  _v?: number
  _rev?: { revision?: number }
}
const holdsNothing = (record: RecordFile | null): boolean => record === null || (record.learned === undefined && record.lastRead === undefined && record.lastPeekAtMs === undefined)
function readLearnedFile(home: string): RecordFile | null {
  try {
    return JSON.parse(readFileSync(join(home, 'client-contract.json'), 'utf8'))
  } catch {
    return null
  }
}
const lockLeft = (home: string): boolean => existsSync(join(home, 'client-contract.json.lock'))

type DoorRequest = { version: string; line: string; ua: string; body: string }
function makeDoor(floor: string): { fetchOverride: typeof fetch; requests: DoorRequest[] } {
  const requests: DoorRequest[] = []
  const fetchOverride: typeof fetch = async (_input, init) => {
    const raw = String(init?.body ?? '{}')
    const body = JSON.parse(raw) as { system?: Array<{ type?: string; text?: string }> }
    const line = (body.system ?? []).map(b => b.text ?? '').find(t => t.startsWith('x-anthropic-billing-header: ')) ?? ''
    const version = /cc_version=(\d+\.\d+\.\d+)\./.exec(line)?.[1] ?? ''
    const ua = new Headers(init?.headers).get('user-agent') ?? ''
    requests.push({ version, line, ua, body: raw })
    if (compareVersions(version, floor) < 0) {
      const payload = {
        type: 'error',
        error: {
          type: 'invalid_request_error',
          message: `${version} does not support this model; version ${floor} or newer is required. Run claude update.`,
          details: { error_code: 'claude_code_version_too_old' },
        },
      }
      return new Response(JSON.stringify(payload), { status: 400, headers: { 'content-type': 'application/json' } })
    }
    const event = (type: string, e: unknown): string => `event: ${type}\ndata: ${JSON.stringify(e)}\n\n`
    return new Response(
      [
        event('message_start', { type: 'message_start', message: { id: 'msg_heal', type: 'message', role: 'assistant', model: MODEL, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 0 } } }),
        event('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }),
        event('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'answered' } }),
        event('content_block_stop', { type: 'content_block_stop', index: 0 }),
        event('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 1 } }),
        event('message_stop', { type: 'message_stop' }),
      ].join(''),
      { headers: { 'content-type': 'text/event-stream' } },
    )
  }
  return { fetchOverride, requests }
}

async function drive(floor: string): Promise<{ requests: DoorRequest[]; answered: boolean; refusalText: string }> {
  const door = makeDoor(floor)
  let answered = false
  let refusalText = ''
  for await (const item of queryModelWithStreaming({
    messages: [createUserMessage({ content: 'Reply with one word.' })],
    systemPrompt: asSystemPrompt(['Reply briefly.']),
    thinkingConfig: { type: 'disabled' as const },
    tools: [],
    signal: new AbortController().signal,
    options: {
      model: MODEL,
      fetchOverride: door.fetchOverride,
      querySource: 'agent:contract-heal-fixture',
      isNonInteractiveSession: true,
      getToolPermissionContext: async () => getEmptyToolPermissionContext(),
      agents: [],
      hasAppendSystemPrompt: false,
      mcpTools: [],
      maxOutputTokensOverride: 64,
    } as never,
  })) {
    if (item.type === 'assistant') {
      const text = ((item.message as { content?: unknown }).content as Array<{ type?: string; text?: string }> | undefined)?.map(b => (b.type === 'text' ? b.text ?? '' : '')).join('') ?? ''
      if (item.isApiErrorMessage) refusalText = text
      else if (text.includes('answered')) answered = true
    }
  }
  return { requests: door.requests, answered, refusalText }
}

const sentences = (text: string): number => (text.match(/[.!?](?=\s|$)/g) ?? []).length

console.log('client-contract heal: the door\'s too-old refusal heals itself from the npm registry, once, and says what happened')

section('§1 the heal — a 400 too-old reads the registry once, retries once on the learned number, persists it')
check('the learned-contract module exists', learnedModule !== null, learnedModule === null ? 'src/services/api/clientContractLearned.js is absent' : '')
{
  const home = freshHome('heal')
  lawful.resetLawfulPrefixChanges()
  registryMode = { kind: 'ok', version: NEWER }
  const readsBefore = registryReads
  const result = await drive(NEWER)
  const [refused, retried] = result.requests
  check('the door saw exactly two requests (the refusal, then the healed retry)', result.requests.length === 2, result.requests.map(r => r.version).join(' -> '))
  check('the first request presented the constant', refused?.version === CONTRACT, refused?.version ?? 'none')
  check('the retry presented the learned number', retried?.version === NEWER, retried?.version ?? 'none')
  check('the attribution line kept its exact shape on the retry', /^x-anthropic-billing-header: cc_version=\d+\.\d+\.\d+\.\w+;/.test(retried?.line ?? ''), retried?.line ?? 'none')
  check('the retry line differs from the first only in the version', refused !== undefined && retried !== undefined && refused.line.replaceAll(refused.version, '') === retried.line.replaceAll(retried.version, ''), `${refused?.line} vs ${retried?.line}`)
  check('every other wire byte of the retry equals the refused request (only the attribution line moved)', refused !== undefined && retried !== undefined && refused.line !== '' && refused.body.replace(refused.line, '') === retried.body.replace(retried.line, ''), `${refused?.body.length ?? 0} vs ${retried?.body.length ?? 0} bytes`)
  check('the user-agent stayed the product agent on both requests', result.requests.length === 2 && result.requests.every(r => r.ua.startsWith('mercury/1.0.0') && !r.ua.includes(CONTRACT) && !r.ua.includes(NEWER)), result.requests.map(r => r.ua).join(' | '))
  check('the registry was read exactly once', registryReads - readsBefore === 1, `${registryReads - readsBefore} read(s)`)
  check('the read asked the registry latest document', registryLastUrl === '/@anthropic-ai/claude-code/latest', registryLastUrl)
  check('the registry read carries the product agent, never a contract number', registryLastAgent.startsWith('mercury/1.0.0') && !registryLastAgent.includes(CONTRACT) && !registryLastAgent.includes(NEWER), registryLastAgent)
  check('the drive answered after the heal (no refusal surfaced)', result.answered && result.refusalText === '', result.refusalText)
  const record = readLearnedFile(home)
  check('the learned number is persisted in the config home', record?.learned?.version === NEWER, JSON.stringify(record))
  check('the record rides the store kernel: its schema stamp and a committed revision', record?._v === 1 && typeof record._rev?.revision === 'number' && record._rev.revision >= 2, JSON.stringify({ _v: record?._v, _rev: record?._rev }))
  check('the persisted read is the registry answer, not a failure', record?.lastRead?.by === 'heal' && record.lastRead.answer?.version === NEWER && record.lastRead.answer.failure === undefined, JSON.stringify(record?.lastRead ?? null))
  const described = oauth.describeAnthropicClientContract()
  check('the next describe reads it back as source learned with the learned date', described.presented === NEWER && described.source === 'learned' && described.asOf === dayOf(record?.learned?.learnedAtMs), JSON.stringify(described))
  check('the retry carried exactly what describe answers now', retried?.version === described.presented, `${retried?.version} vs ${described.presented}`)
  check('a retry whose history binds no thinking to the moved line declares nothing (the ledger compared nothing)', lawful.pendingLawfulPrefixChange(OWNER) === null, String(lawful.pendingLawfulPrefixChange(OWNER)))
  check('the record lock was released', !lockLeft(home))
}

section('§2 a failing registry — the real refusal in one line, no retry, no loop, a quiet window between reads')
{
  const home = freshHome('fail500')
  lawful.resetLawfulPrefixChanges()
  registryMode = { kind: 'status500' }
  const readsBefore = registryReads
  const first = await drive(NEWER)
  check('the door saw exactly one request (no retry on a failed read)', first.requests.length === 1, first.requests.map(r => r.version).join(' -> '))
  check('the registry was read exactly once for the refusal', registryReads - readsBefore === 1, `${registryReads - readsBefore} read(s)`)
  check('the surfaced row is the real refusal naming the floor and what Mercury presents', first.refusalText.includes(`needs client version ${NEWER}`) && first.refusalText.includes(`Mercury presents ${CONTRACT} (constant)`), first.refusalText)
  check('the row says the registry read failed, in one sentence', first.refusalText.includes('the registry read failed: HTTP 500 — not retried') && sentences(first.refusalText) === 1, first.refusalText)
  check('no learned number was persisted', readLearnedFile(home)?.learned === undefined, JSON.stringify(readLearnedFile(home)))
  check('the failure is stamped for the doctor row', readLearnedFile(home)?.lastRead?.answer?.failure?.kind === 'status', JSON.stringify(readLearnedFile(home)?.lastRead ?? null))
  check('a refusal that was not retried declares no prefix change', lawful.pendingLawfulPrefixChange(OWNER) === null, String(lawful.pendingLawfulPrefixChange(OWNER)))
  const second = await drive(NEWER)
  check('a second refusal within the quiet window reads the registry nothing again', registryReads - readsBefore === 1, `${registryReads - readsBefore} read(s)`)
  check('the second refusal still surfaced (no loop, no hang)', second.requests.length === 1 && second.refusalText.includes(`needs client version ${NEWER}`), second.refusalText)
  check('the quiet-windowed refusal names the earlier failed read and the window, and says it did not read', second.refusalText.includes('the last registry read, under 10 min ago, failed: HTTP 500 — not retried') && !second.refusalText.includes('the registry read failed:'), second.refusalText)
}

section('§3 the retry that is still refused — the row tells the whole story in one sentence')
{
  const home = freshHome('still-refused')
  registryMode = { kind: 'ok', version: NEWER_2 }
  const readsBefore = registryReads
  const result = await drive(STILL_REFUSED_FLOOR)
  check('the door saw exactly two requests', result.requests.length === 2, result.requests.map(r => r.version).join(' -> '))
  check('the retry presented the number the registry answered', result.requests[1]?.version === NEWER_2, result.requests[1]?.version ?? 'none')
  check('the registry was read exactly once', registryReads - readsBefore === 1, `${registryReads - readsBefore} read(s)`)
  check('the row names the presented number, its source, the registry answer and the retry', result.refusalText.includes(`Mercury presented ${CONTRACT} (constant) — the registry said ${NEWER_2}; retried once — still refused`), result.refusalText)
  check('the row keeps the override remedy at the floor', result.refusalText.includes(`MERCURY_ANTHROPIC_CLIENT_CONTRACT=${STILL_REFUSED_FLOOR}`), result.refusalText)
  check('the row stays one sentence', sentences(result.refusalText) === 1, result.refusalText)
  const record = readLearnedFile(home)
  check('the newer-than-constant answer is still persisted as learned', record?.learned?.version === NEWER_2, JSON.stringify(record))
  const described = oauth.describeAnthropicClientContract()
  check('the next describe presents it as learned', described.presented === NEWER_2 && described.source === 'learned', JSON.stringify(described))
}

section('§4 the failure shapes — timeout, a body without a version, an answer that is not newer, traffic off')
{
  freshHome('hang')
  registryMode = { kind: 'hang' }
  const readsBefore = registryReads
  const timeout = await drive(NEWER)
  check('a hanging registry costs one request and one read, then the real refusal', timeout.requests.length === 1 && registryReads - readsBefore === 1, `${timeout.requests.length} request(s), ${registryReads - readsBefore} read(s)`)
  check('the row names the timeout and its deadline', timeout.refusalText.includes('the registry read failed: timeout after 3 s — not retried'), timeout.refusalText)
}
{
  freshHome('noversion')
  registryMode = { kind: 'noversion' }
  const readsBefore = registryReads
  const shape = await drive(NEWER)
  check('a body without a version is refused, not retried', shape.requests.length === 1 && registryReads - readsBefore === 1, `${shape.requests.length} request(s), ${registryReads - readsBefore} read(s)`)
  check('the row names the shape failure', shape.refusalText.includes('the registry read failed: the answer carried no version — not retried'), shape.refusalText)
}
{
  const home = freshHome('not-newer')
  registryMode = { kind: 'ok', version: OLDER }
  const readsBefore = registryReads
  const older = await drive(NEWER)
  check('a registry answer older than the presented number is not retried', older.requests.length === 1 && registryReads - readsBefore === 1, `${older.requests.length} request(s), ${registryReads - readsBefore} read(s)`)
  check('the row says the answer was not newer and was not retried', older.refusalText.includes(`the registry said ${OLDER}, not newer than the presented ${CONTRACT} — not retried`), older.refusalText)
  check('an older answer is never learned', readLearnedFile(home)?.learned === undefined, JSON.stringify(readLearnedFile(home)))
  const described = oauth.describeAnthropicClientContract()
  check('the presentation keeps the constant', described.presented === CONTRACT && described.source === 'constant', JSON.stringify(described))
}
{
  const home = freshHome('traffic-off')
  registryMode = { kind: 'ok', version: NEWER }
  const readsBefore = registryReads
  process.env.MERCURY_DISABLE_NONESSENTIAL_TRAFFIC = '1'
  const off = await drive(NEWER)
  delete process.env.MERCURY_DISABLE_NONESSENTIAL_TRAFFIC
  check('the essential-traffic posture reads the registry nothing and does not retry', off.requests.length === 1 && registryReads === readsBefore, `${off.requests.length} request(s), ${registryReads - readsBefore} read(s)`)
  check('the row names the posture that kept the read dark', off.refusalText.includes('the registry read is off (MERCURY_DISABLE_NONESSENTIAL_TRAFFIC) — not retried'), off.refusalText)
  check('nothing was written under the posture', readLearnedFile(home) === null, JSON.stringify(readLearnedFile(home)))
}

section('§5 precedence — the override wins over a learned number; a learned number older than the constant never presents')
{
  const home = freshHome('override')
  registryMode = { kind: 'ok', version: NEWER }
  await drive(NEWER)
  check('the heal landed the learned number first', readLearnedFile(home)?.learned?.version === NEWER, JSON.stringify(readLearnedFile(home)))
  const belowOverride = bump(CONTRACT, -41)
  process.env.MERCURY_ANTHROPIC_CLIENT_CONTRACT = belowOverride
  const described = oauth.describeAnthropicClientContract()
  check('a valid override wins over the learned number', described.presented === belowOverride && described.source === 'override', JSON.stringify(described))
  const readsBefore = registryReads
  const refused = await drive(bump(CONTRACT, -40))
  check('an override refusal reads the registry nothing', registryReads - readsBefore === 0, `${registryReads - readsBefore} read(s)`)
  check('the override refusal surfaced once, names its source and keeps its remedy', refused.requests.length === 1 && refused.requests[0]?.version === belowOverride && refused.refusalText.includes(`Mercury presents ${belowOverride} (override)`) && refused.refusalText.includes(`MERCURY_ANTHROPIC_CLIENT_CONTRACT=${bump(CONTRACT, -40)}`), refused.refusalText)
  delete process.env.MERCURY_ANTHROPIC_CLIENT_CONTRACT
  const restored = oauth.describeAnthropicClientContract()
  check('unsetting the override restores the learned number', restored.presented === NEWER && restored.source === 'learned', JSON.stringify(restored))
}
{
  const home = freshHome('older-learned')
  writeFileSync(join(home, 'client-contract.json'), JSON.stringify({ learned: { version: bump(CONTRACT, -181), learnedAtMs: Date.now(), origin: 'registry.npmjs.org' }, _v: 1 }))
  const described = oauth.describeAnthropicClientContract()
  check('a learned number older than the constant is never presented', described.presented === CONTRACT && described.source === 'constant', JSON.stringify(described))
  const line = getAttributionHeader('fp10')
  check('the attribution line carries the constant, not the older learned number', line.includes(`cc_version=${CONTRACT}.fp10;`), line)
}

section('§6 the daily peek — started once by a session boot, gated, once a day per config home, presented on the next request')
check('the peek owner exists', typeof learnedModule?.startClientContractPeek === 'function' && typeof learnedModule.peekClientContract === 'function' && typeof learnedModule.pendingClientContractPeek === 'function', learnedModule === null ? 'module absent' : '')
{
  const home = freshHome('peek-learns')
  registryMode = { kind: 'ok', version: NEWER }
  const early = oauth.describeAnthropicClientContract()
  const readsBefore = registryReads
  const outcome = await learnedModule?.peekClientContract()
  check('a describe before the peek presents the constant', early.presented === CONTRACT && early.source === 'constant', JSON.stringify(early))
  check('the peek reads once and learns a newer-than-constant number', outcome?.kind === 'read' && outcome.learned === true && registryReads - readsBefore === 1, JSON.stringify(outcome))
  const stamped = readLearnedFile(home)
  check('the peek persisted the number, its day stamp and its read', stamped?.learned?.version === NEWER && typeof stamped.lastPeekAtMs === 'number' && stamped.lastRead?.by === 'peek' && stamped.lastRead.answer?.version === NEWER, JSON.stringify(stamped))
  const after = oauth.describeAnthropicClientContract()
  check('the settled peek presents on the next describe in the same process (the early describe latched nothing)', after.presented === NEWER && after.source === 'learned', JSON.stringify(after))
  const next = await drive(ANSWERED_FLOOR)
  check('the next request in the same process carries the peeked number', next.answered && next.requests.length === 1 && next.requests[0]?.version === NEWER, next.requests.map(r => r.version).join(' -> '))
  const again = await learnedModule?.peekClientContract()
  check('a second peek the same day in the same config home reads nothing', again?.kind === 'skipped' && again.why === 'today' && registryReads - readsBefore === 1, JSON.stringify(again))
  check('the peek released its record lock', !lockLeft(home))
}
{
  const home = freshHome('peek-older')
  registryMode = { kind: 'ok', version: OLDER }
  const readsBefore = registryReads
  const outcome = await learnedModule?.peekClientContract()
  check('an answer older than the constant is read once and not learned', outcome?.kind === 'read' && outcome.learned === false && registryReads - readsBefore === 1 && readLearnedFile(home)?.learned === undefined, JSON.stringify(outcome))
  check('…and still stamps the day (the registry answered)', typeof readLearnedFile(home)?.lastPeekAtMs === 'number', JSON.stringify(readLearnedFile(home)))
}
{
  const home = freshHome('peek-fail')
  registryMode = { kind: 'status500' }
  const readsBefore = registryReads
  const failed = await learnedModule?.peekClientContract()
  check('a failing registry is read once; the failure is recorded and the day is not stamped', failed?.kind === 'read' && failed.answer.ok === false && readLearnedFile(home)?.lastPeekAtMs === undefined && readLearnedFile(home)?.lastRead?.answer?.failure?.kind === 'status', JSON.stringify(readLearnedFile(home)))
  const soon = await learnedModule?.peekClientContract()
  check('a second peek inside the quiet window reads nothing (no hammering after a failure)', soon?.kind === 'skipped' && soon.why === 'window' && registryReads - readsBefore === 1, JSON.stringify(soon))
}
{
  const home = freshHome('peek-adopts')
  const early = oauth.describeAnthropicClientContract()
  writeFileSync(join(home, 'client-contract.json'), JSON.stringify({ learned: { version: NEWER_2, learnedAtMs: Date.now(), from: 'another session', by: 'peek' }, lastPeekAtMs: Date.now(), _v: 1 }))
  const readsBefore = registryReads
  const outcome = await learnedModule?.peekClientContract()
  check("a peek that finds today's peek already done by another session reads nothing and adopts its number", early.source === 'constant' && outcome?.kind === 'skipped' && outcome.why === 'today' && outcome.adopted === NEWER_2 && registryReads === readsBefore, JSON.stringify(outcome))
  const adopted = oauth.describeAnthropicClientContract()
  check('…which this process presents from its next request', adopted.presented === NEWER_2 && adopted.source === 'learned', JSON.stringify(adopted))
}
{
  const home = freshHome('peek-gates')
  registryMode = { kind: 'ok', version: NEWER }
  const readsBefore = registryReads
  process.env.MERCURY_DISABLE_NONESSENTIAL_TRAFFIC = '1'
  const off = await learnedModule?.peekClientContract()
  delete process.env.MERCURY_DISABLE_NONESSENTIAL_TRAFFIC
  check('the essential-traffic posture keeps the peek dark', off?.kind === 'skipped' && off.why === 'traffic-off', JSON.stringify(off))
  process.env.MERCURY_ANTHROPIC_CLIENT_CONTRACT = CONTRACT
  const overridden = await learnedModule?.peekClientContract()
  delete process.env.MERCURY_ANTHROPIC_CLIENT_CONTRACT
  check('an operator override keeps the peek dark', overridden?.kind === 'skipped' && overridden.why === 'override', JSON.stringify(overridden))
  const key = process.env.ANTHROPIC_API_KEY
  delete process.env.ANTHROPIC_API_KEY
  auth.clearOAuthTokenCache()
  const keyless = await learnedModule?.peekClientContract()
  process.env.ANTHROPIC_API_KEY = key
  auth.clearOAuthTokenCache()
  check('a home with no Anthropic credential peeks nothing', keyless?.kind === 'skipped' && keyless.why === 'no-credential', JSON.stringify(keyless))
  check('none of those gates reached the registry or wrote a record', registryReads === readsBefore && readLearnedFile(home) === null, JSON.stringify(readLearnedFile(home)))
  const savedBase = process.env.MERCURY_NPM_REGISTRY_BASE
  const savedFetch = globalThis.fetch
  const stubbed: string[] = []
  globalThis.fetch = (async (input: unknown) => {
    stubbed.push(typeof input === 'string' ? input : input instanceof Request ? input.url : String(input))
    throw Object.assign(new Error('a proof never reaches the network'), { code: 'ECONNREFUSED' })
  }) as typeof fetch
  try {
    delete process.env.MERCURY_NPM_REGISTRY_BASE
    const gateway = await learnedModule?.peekClientContract()
    check('an Anthropic lane on a gateway or local box, with no registry named, peeks nothing', gateway?.kind === 'skipped' && gateway.why === 'lane' && stubbed.length === 0, JSON.stringify(gateway))
    delete process.env.ANTHROPIC_BASE_URL
    process.env.MERCURY_SCRIPTED_STREAM = 'slow-text'
    const scripted = await learnedModule?.peekClientContract()
    delete process.env.MERCURY_SCRIPTED_STREAM
    check('a first-party lane whose model stream is scripted (no real wire) peeks nothing', scripted?.kind === 'skipped' && scripted.why === 'lane' && stubbed.length === 0, JSON.stringify(scripted))
    const firstParty = await learnedModule?.peekClientContract()
    check('the first-party Anthropic lane opens the peek against the public registry (answered here by a stub, never the network)', firstParty?.kind === 'read' && stubbed.length === 1 && stubbed[0] === 'https://registry.npmjs.org/@anthropic-ai/claude-code/latest', `${JSON.stringify(firstParty)}; ${stubbed.join(' ')}`)
  } finally {
    globalThis.fetch = savedFetch
    process.env.ANTHROPIC_BASE_URL = DEAD_LETTER
    if (savedBase !== undefined) process.env.MERCURY_NPM_REGISTRY_BASE = savedBase
  }
}
{
  freshHome('peek-once')
  registryMode = { kind: 'ok', version: OLDER }
  const readsBefore = registryReads
  const first = learnedModule?.startClientContractPeek()
  const second = learnedModule?.startClientContractPeek()
  check('a boot start returns at once without reading, and a second start is the same peek (once per process)', first !== undefined && first === second && registryReads === readsBefore && learnedModule?.pendingClientContractPeek() === first)
  const outcome = await first
  check('the started peek reads the registry once in the background', outcome?.kind === 'read' && registryReads - readsBefore === 1, JSON.stringify(outcome))
}

section('§7 the doctor row — the presented number, its source, and a failed or unsaved read in the same line')
check('the doctor exposes the Client contract check', typeof health.clientContractCheck === 'function')
if (typeof health.clientContractCheck === 'function') {
  const rowIn = async (name: string): Promise<{ status: string; evidence: string }> => {
    useHome(name)
    return health.clientContractCheck().run()
  }
  const learnedDay = dayOf(readLearnedFile(homeOf('heal'))?.learned?.learnedAtMs)
  const learnedRow = await rowIn('heal')
  check('a learned number is named with its date and its source', learnedRow.status === 'ok' && learnedRow.evidence === `subscription door presents cc_version ${NEWER} · learned ${learnedDay} from the registry`, learnedRow.evidence)
  const failedRow = await rowIn('fail500')
  check('a failed heal read is said in the same line', failedRow.status === 'ok' && /^subscription door presents cc_version \d+\.\d+\.\d+ · constant · MERCURY_ANTHROPIC_CLIENT_CONTRACT=<version> overrides · the heal's last registry read failed \d+[smhd] ago: HTTP 500$/.test(failedRow.evidence), failedRow.evidence)
  const peekRow = await rowIn('peek-older')
  check('a clean peek adds nothing to the constant row', peekRow.evidence === `subscription door presents cc_version ${CONTRACT} · constant · MERCURY_ANTHROPIC_CLIENT_CONTRACT=<version> overrides`, peekRow.evidence)
  const belowOverride = bump(CONTRACT, -41)
  process.env.MERCURY_ANTHROPIC_CLIENT_CONTRACT = belowOverride
  const overrideRow = await rowIn('heal')
  delete process.env.MERCURY_ANTHROPIC_CLIENT_CONTRACT
  check('an override is named as the source', overrideRow.evidence === `subscription door presents cc_version ${belowOverride} · MERCURY_ANTHROPIC_CLIENT_CONTRACT override`, overrideRow.evidence)
  const home = freshHome('holds')
  oauth.describeAnthropicClientContract()
  writeFileSync(join(home, 'client-contract.json'), JSON.stringify({ learned: { version: NEWER_2, learnedAtMs: Date.now(), from: 'another session', by: 'heal' }, _v: 1 }))
  const holdsRow = await health.clientContractCheck().run()
  check('a newer number another session stored is named, with when this session presents it', holdsRow.evidence === `subscription door presents cc_version ${CONTRACT} · constant · MERCURY_ANTHROPIC_CLIENT_CONTRACT=<version> overrides · the config home holds ${NEWER_2} (learned ${dayOf(Date.now())}), presented from the next start or the next too-old refusal`, holdsRow.evidence)
  const readsBefore = registryReads
  const healed = await drive(NEWER_2)
  check('a too-old refusal adopts it with no registry read and retries once', healed.requests.length === 2 && healed.requests[1]?.version === NEWER_2 && healed.answered && registryReads === readsBefore, `${healed.requests.map(r => r.version).join(' -> ')}; ${registryReads - readsBefore} read(s)`)
}

section('§8 durable publication — a refused write is said, never claimed as saved')
{
  const home = freshHome('claim-refused')
  registryMode = { kind: 'ok', version: NEWER }
  const readsBefore = registryReads
  process.env.MERCURY_FAULT_INJECT = 'rename@client-contract.json:eacces'
  const refused = await drive(NEWER)
  delete process.env.MERCURY_FAULT_INJECT
  check('a config home that refuses the claim reads the registry nothing and does not retry', refused.requests.length === 1 && registryReads === readsBefore, `${refused.requests.length} request(s), ${registryReads - readsBefore} read(s)`)
  check('the row says the read was not attempted and why, in one sentence', refused.refusalText.includes('the registry read was not attempted: the config home refused its record (EACCES) — not retried') && sentences(refused.refusalText) === 1, refused.refusalText)
  check('no claim, no learned number and no day stamp were saved (at most the empty store the kernel seeds before its lock)', holdsNothing(readLearnedFile(home)), JSON.stringify(readLearnedFile(home)))
  if (typeof health.clientContractCheck === 'function') {
    const row = await health.clientContractCheck().run()
    check('the doctor row names the refused claim', row.evidence.endsWith(' · the heal could not claim its registry read: the config home refused its record (EACCES)'), row.evidence)
  }
}
{
  const home = freshHome('answer-unsaved')
  const readsBefore = registryReads
  registryMode = {
    kind: 'ok',
    version: NEWER,
    onRead: () => {
      process.env.MERCURY_FAULT_INJECT = 'rename@client-contract.json:eacces'
    },
  }
  const result = await drive(NEWER)
  delete process.env.MERCURY_FAULT_INJECT
  check('a refused save of the answer still retries once on the number the registry said', result.requests.length === 2 && result.requests[1]?.version === NEWER && result.answered && registryReads - readsBefore === 1, `${result.requests.map(r => r.version).join(' -> ')}; ${registryReads - readsBefore} read(s)`)
  const record = readLearnedFile(home)
  check('the config home holds only the claim: no learned number and no answer is claimed as saved', record !== null && record.learned === undefined && record.lastRead?.by === 'heal' && record.lastRead.answer === undefined, JSON.stringify(record))
  const described = oauth.describeAnthropicClientContract()
  check('this process presents the learned number it could not save', described.presented === NEWER && described.source === 'learned', JSON.stringify(described))
  if (typeof health.clientContractCheck === 'function') {
    const row = await health.clientContractCheck().run()
    check('the doctor row says the answer was not saved', row.evidence === `subscription door presents cc_version ${NEWER} · learned ${dayOf(Date.now())} from the registry · the last registry answer was not saved to the config home (EACCES)`, row.evidence)
  }
}
{
  const home = freshHome('peek-lock')
  const readsBefore = registryReads
  registryMode = {
    kind: 'ok',
    version: NEWER,
    onRead: () => {
      mkdirSync(join(home, 'client-contract.json.lock'), { recursive: true })
    },
  }
  const outcome = await learnedModule?.peekClientContract()
  const described = oauth.describeAnthropicClientContract()
  check('a peek whose answer cannot take the record lock still presents it in this process, reported as not saved', outcome?.kind === 'read' && outcome.learned === true && outcome.unsaved === 'ELOCKED' && registryReads - readsBefore === 1 && described.presented === NEWER && described.source === 'learned', JSON.stringify({ outcome, described }))
  const record = readLearnedFile(home)
  check('…and nothing claims it was saved: the config home holds the bare claim, no learned number and no day stamp', record !== null && record.learned === undefined && record.lastPeekAtMs === undefined && record.lastRead?.by === 'peek' && record.lastRead.answer === undefined, JSON.stringify(record))
  rmSync(join(home, 'client-contract.json.lock'), { recursive: true, force: true })
}
check('the words of a still-refused retry whose answer was not saved say so in the one sentence', learnedModule?.clientContractStory({ kind: 'retry', sent: { presented: CONTRACT, source: 'constant' }, to: NEWER, via: 'registry', unsaved: 'EACCES' }) === `Mercury presented ${CONTRACT} (constant) — the registry said ${NEWER}, not saved to the config home (EACCES); retried once — still refused`)

section('§9 the quiet window is claimed across processes — two sessions refused together make one registry read')
{
  const sharedHome = join(scratchRoot, 'home-cross')
  mkdirSync(sharedHome, { recursive: true })
  registryMode = { kind: 'ok', version: NEWER, holdMs: 800 }
  const readsBefore = registryReads
  const childEnv: NodeJS.ProcessEnv = { ...process.env, MERCURY_CONFIG_DIR: sharedHome, HEAL_SENT: CONTRACT, HEAL_FLOOR: NEWER }
  delete childEnv.MERCURY_FAULT_INJECT
  const runChild = (): Promise<{ code: number | null; out: string; err: string }> =>
    new Promise(resolve => {
      const child = spawn(process.execPath, ['run', join(ROOT, 'scripts', 'api', 'client-contract-heal-child.ts')], { cwd: ROOT, env: childEnv })
      let out = ''
      let err = ''
      child.stdout.on('data', d => {
        out += String(d)
      })
      child.stderr.on('data', d => {
        err += String(d)
      })
      const killer = setTimeout(() => child.kill('SIGKILL'), 30_000)
      child.on('close', code => {
        clearTimeout(killer)
        resolve({ code, out, err })
      })
    })
  const [a, b] = await Promise.all([runChild(), runChild()])
  const outcomeOf = (out: string): { kind?: string; to?: string; via?: string } | null => {
    try {
      return JSON.parse(out.trim().split('\n').filter(Boolean).at(-1) ?? 'null')
    } catch {
      return null
    }
  }
  const outcomes = [outcomeOf(a.out), outcomeOf(b.out)]
  check('both sessions ran to an outcome', a.code === 0 && b.code === 0 && outcomes.every(o => o !== null), `${a.code}/${b.code} ${a.err.slice(-300)} ${b.err.slice(-300)}`)
  check('the two sessions made exactly one registry read between them', registryReads - readsBefore === 1, `${registryReads - readsBefore} read(s)`)
  check('both sessions retry once on the number that one read learned', outcomes.every(o => o?.kind === 'retry' && o.to === NEWER), JSON.stringify(outcomes))
  check('exactly one of them read the registry; the other took its answer', outcomes.filter(o => o?.via === 'registry').length === 1 && outcomes.filter(o => o?.via === 'peer' || o?.via === 'stored').length === 1, JSON.stringify(outcomes))
  check('the shared record holds the learned number and no lock remains', readLearnedFile(sharedHome)?.learned?.version === NEWER && !lockLeft(sharedHome), JSON.stringify(readLearnedFile(sharedHome)))
}

section('§10 a moved number reads as a lawful prefix change — named by the ledger, declared by the owner rule')
{
  freshHome('ledger')
  const owner = 'contract-move-owner'
  const key = `${owner}|first|${MODEL}`
  const lineOld = getAttributionHeader('fp77')
  const lineNew = lineOld.replace(`cc_version=${CONTRACT}.`, `cc_version=${NEWER}.`)
  const lineWork = lineOld.replace(/;$/, '; cc_workload=cron;')
  const messages = [
    { role: 'user', content: [{ type: 'text', text: 'first question' }] },
    { role: 'assistant', content: [{ type: 'thinking', thinking: 'reasoning bound to the prefix', signature: 'sig-bound' }, { type: 'text', text: 'first answer' }] },
    { role: 'user', content: [{ type: 'text', text: 'second question' }] },
  ]
  const parts = (line: string) => ({ system: [{ type: 'text', text: line }, { type: 'text', text: 'You are a Mercury agent.' }], tools: [], messages })
  ledger.judgeAndRecordPrefix(owner, key, parts(lineOld) as never)
  const moved = ledger.judgeAndRecordPrefix(owner, key, parts(lineNew) as never)
  check('the ledger names block 0 of the system prompt when only the contract number moved', moved.mismatch !== null && moved.mismatch.path.startsWith('system[0]'), JSON.stringify(moved.mismatch))
  const reason = learnedModule?.clientContractMoveOf(moved.mismatch) ?? null
  check('the move is recognised as the contract number and named with both numbers', reason === `the client-contract number the door presents moved from ${CONTRACT} to ${NEWER}`, String(reason))
  ledger.judgeAndRecordPrefix(owner, key, parts(lineOld) as never)
  const workload = ledger.judgeAndRecordPrefix(owner, key, parts(lineWork) as never)
  check('any other move of the attribution line is not called a contract move', workload.mismatch !== null && learnedModule?.clientContractMoveOf(workload.mismatch) === null, JSON.stringify(workload.mismatch))
  check('a move elsewhere in the prompt is not called a contract move', learnedModule?.clientContractMoveOf({ path: 'system[1].text@char 4', before: lineOld, after: lineNew }) === null)
  const stream = readFileSync(join(ROOT, 'src/services/providers/anthropic/streamCore.ts'), 'utf8')
  check('the request builder declares the named move through the owner rule, for the conversation that sent it', stream.includes('const contractMove = clientContractMoveOf(verdict.mismatch)') && stream.includes('declareLawfulPrefixChange(rosterOwnerKey, contractMove)'))
}

section('§11 the side query heals the same refusal — one read, one retry on the learned number')
{
  const home = freshHome('side')
  registryMode = { kind: 'ok', version: NEWER }
  sideFloor = NEWER
  sideRequests.length = 0
  const readsBefore = registryReads
  process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${sidePort}`
  let answer = ''
  let thrown = ''
  try {
    const response = await sideQuery({ model: MODEL, messages: [{ role: 'user', content: 'side question' }], querySource: 'contract-heal-side', max_tokens: 16 })
    answer = ((response as { content?: Array<{ text?: string }> }).content ?? []).map(b => b.text ?? '').join('')
  } catch (error) {
    thrown = String(error)
  } finally {
    process.env.ANTHROPIC_BASE_URL = DEAD_LETTER
  }
  check('the refused side query was retried once on the learned number and answered', answer === 'side answered' && sideRequests.length === 2 && sideRequests[0]?.version === CONTRACT && sideRequests[1]?.version === NEWER, `${thrown} ${sideRequests.map(r => r.version).join(' -> ')}`)
  check('the side query read the registry once', registryReads - readsBefore === 1, `${registryReads - readsBefore} read(s)`)
  check('only the attribution block moved on the side query retry', sideRequests.length === 2 && JSON.stringify(sideRequests[0]!.system.slice(1)) === JSON.stringify(sideRequests[1]!.system.slice(1)), JSON.stringify(sideRequests.map(r => r.system.length)))
  check('the learned number is persisted for the next request', readLearnedFile(home)?.learned?.version === NEWER, JSON.stringify(readLearnedFile(home)))
}
{
  freshHome('side-fail')
  registryMode = { kind: 'status500' }
  sideFloor = NEWER
  sideRequests.length = 0
  const readsBefore = registryReads
  process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${sidePort}`
  let caught: unknown = null
  try {
    await sideQuery({ model: MODEL, messages: [{ role: 'user', content: 'side question' }], querySource: 'contract-heal-side', max_tokens: 16 })
  } catch (error) {
    caught = error
  } finally {
    process.env.ANTHROPIC_BASE_URL = DEAD_LETTER
  }
  const heal = caught === null ? undefined : learnedModule?.clientContractHealOf(caught)
  check('a side query whose registry read fails is not retried and rethrows the real refusal with what happened', caught !== null && sideRequests.length === 1 && registryReads - readsBefore === 1 && heal?.kind === 'failed', `${String(caught)} ${JSON.stringify(heal)}`)
}

envUtils.clearAuthScope()
auth.clearOAuthTokenCache()
registry.closeAllConnections?.()
registry.close()
sideDoor.closeAllConnections?.()
sideDoor.close()
rmSync(scratchRoot, { recursive: true, force: true })
console.log('\n' + '='.repeat(76))
if (failures > 0) {
  console.log(`❌ client-contract heal: ${failures} of ${checks} check(s) failed`)
  process.exit(1)
}
console.log(`✅ client-contract heal: ${checks} checks passed — one read, one retry, persisted or said unsaved, windowed across processes, peeked once a day`)
process.exit(0)
