#!/usr/bin/env bun
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dir, '..', '..')
const scratch = mkdtempSync(join(tmpdir(), 'openrouter-refused-'))
const home = join(scratch, 'home')
mkdirSync(home, { recursive: true })
for (const name of Object.keys(process.env)) {
  if (/^(MERCURY_|ANTHROPIC_|CLAUDE_|OPENROUTER_|OPENAI_|ZAI_|GOOGLE_|GEMINI_|MOONSHOT_|DEEPSEEK_|HF_|HUGGINGFACE_|XAI_|MISTRAL_|NOUS_|OPENCODE_)/.test(name) || /proxy/i.test(name)) delete process.env[name]
}
Object.assign(process.env, {
  MERCURY_CONFIG_DIR: home,
  MERCURY_AUTH_SCOPE_DIR: home,
  MERCURY_CREDENTIAL_STORE: 'file',
  MERCURY_LOCAL_PROBE_TARGETS: 'none',
  MERCURY_HELM_CONSOLE: '0',
  MERCURY_EVOLUTION_LEDGER: '0',
  ANTHROPIC_API_KEY: 'proof-key-ci-gate-not-a-real-key',
})
for (const name of ['ANTHROPIC_BASE_URL', 'MERCURY_OPENAI_AUTH_BASE', 'MERCURY_OPENAI_CHATGPT_BASE', 'MERCURY_OPENAI_API_BASE', 'MERCURY_OPENROUTER_AUTH_BASE', 'MERCURY_GEMINI_API_BASE', 'MERCURY_GEMINI_OAUTH_AUTH_BASE', 'MERCURY_GEMINI_OAUTH_TOKEN_BASE', 'MERCURY_ZAI_API_BASE', 'MERCURY_MOONSHOT_API_BASE', 'MERCURY_MOONSHOT_OAUTH_BASE', 'MERCURY_MOONSHOT_CODING_BASE', 'MERCURY_DEEPSEEK_API_BASE', 'MERCURY_HUGGINGFACE_API_BASE', 'MERCURY_HUGGINGFACE_HUB_BASE', 'MERCURY_LOCAL_BASE_URL', 'MERCURY_COMPAT_BASE_URL', 'MERCURY_JEV_BASE', 'MERCURY_XAI_API_BASE', 'MERCURY_MISTRAL_API_BASE', 'MERCURY_NOUS_API_BASE', 'MERCURY_ZEN_API_BASE']) process.env[name] = 'http://127.0.0.1:1'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}
const j = (v: unknown): string => JSON.stringify(v)
const guard = setTimeout(() => {
  console.log('\n❌ TIMEOUT — the OpenRouter refused-key proof exceeded 180s')
  process.exit(1)
}, 180_000)
guard.unref?.()

const STORED_KEY = 'proof-openrouter-stored-key-0001'
const FRESH_KEY = 'proof-openrouter-stored-key-0002'
const WIRE_MESSAGE = 'API key expired.'
const REFUSED_NOTE = `OpenRouter refused the stored key (HTTP 401: ${WIRE_MESSAGE}) — /logins reconnects OpenRouter (the OAuth flow mints a fresh key), or set a valid OPENROUTER_API_KEY.`
const FIELD_LINE = `API Error: OpenRouter rejected the credential (http-401: ${WIRE_MESSAGE}) — /logins reconnects OpenRouter (the OAuth flow mints a fresh key), or set a valid OPENROUTER_API_KEY.`
const MODELS = { data: [{ id: 'deepseek/deepseek-v4-flash', name: 'DeepSeek: DeepSeek V4.1 Flash', context_length: 128000 }, { id: 'vendor/model', name: 'Vendor: Model', context_length: 64000 }] }
const KEY_PAYLOAD = { data: { label: 'fixture', usage: 1.5, limit: 20, limit_remaining: 18.5 } }
let keyStatus = 401
let chatStatus = 401
const hits: string[] = []
const server = Bun.serve({
  hostname: '127.0.0.1',
  port: 0,
  fetch(request) {
    const path = new URL(request.url).pathname
    const bearer = request.headers.get('authorization') ?? ''
    hits.push(`${request.method} ${path} ${bearer.endsWith(STORED_KEY) ? 'stored' : bearer.endsWith(FRESH_KEY) ? 'fresh' : 'other'}`)
    if (request.method === 'GET' && path.endsWith('/models')) return Response.json(MODELS)
    if (request.method === 'GET' && path.endsWith('/key')) {
      return keyStatus === 200 ? Response.json(KEY_PAYLOAD) : Response.json({ error: { code: keyStatus, message: WIRE_MESSAGE } }, { status: keyStatus })
    }
    if (request.method === 'POST' && path.endsWith('/chat/completions')) {
      if (chatStatus !== 200) return Response.json({ error: { code: chatStatus, message: WIRE_MESSAGE } }, { status: chatStatus })
      const sse = (obj: unknown): string => `data: ${JSON.stringify(obj)}\n\n`
      const body =
        sse({ id: 'chatcmpl-proof', object: 'chat.completion.chunk', model: 'vendor/model', choices: [{ index: 0, delta: { role: 'assistant', content: 'served' }, finish_reason: null }] }) +
        sse({ id: 'chatcmpl-proof', object: 'chat.completion.chunk', model: 'vendor/model', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 } }) +
        'data: [DONE]\n\n'
      return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } })
    }
    return new Response(null, { status: 404 })
  },
})
const base = `http://127.0.0.1:${server.port}`
process.env.MERCURY_OPENROUTER_API_BASE = base
const originalFetch = globalThis.fetch
const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
  if (url.origin !== base) throw new Error(`only the loopback fixture may be contacted (${url.origin})`)
  return originalFetch(input, { ...init, redirect: 'error' })
}) as typeof fetch
globalThis.fetch = fetchImpl
const { mock } = await import('bun:test')
async function stub(path: string, overrides: Record<string, unknown>): Promise<void> {
  const actual = await import(path)
  mock.module(path, () => ({ ...actual, ...overrides }))
}
await stub('../../src/utils/proxy.js', { getApiFetch: () => fetchImpl, getProxyFetchOptions: () => ({}) })

const { enableConfigs } = await import('../../src/utils/config.js')
enableConfigs()
const bootstrap = await import('../../src/bootstrap/state.js')
bootstrap.setIsInteractive(false)
const accounts = await import('../../src/services/providers/openrouter/openrouterAccounts.js')
const usageState = await import('../../src/services/providers/openrouter/openrouterUsageState.js')
const catalogue = await import('../../src/services/providers/openrouter/openrouterCatalogue.js')
const secrets = await import('../../src/utils/router/providerSecrets.js')
const slots = await import('../../src/services/providers/accountSlots.js')
const usability = await import('../../src/services/providers/providerUsability.js')
const usage = await import('../../src/services/providers/providerUsage.js')
const { loginsFamilyCounts } = await import('../../src/components/BootLoginsScreen.js')
const { openrouterLaneProfile } = await import('../../src/services/providers/openrouter/openrouterCallModel.js')
const { compatChatCallModel } = await import('../../src/services/providers/openaicompat/compatChatCallModel.js')
const { asSystemPrompt } = await import('../../src/utils/systemPromptType.js')
const { getEmptyToolPermissionContext } = await import('../../src/Tool.js')
import type { Message } from '../../src/types/message.ts'
import type { CompatCallModelParams } from '../../src/services/providers/openaicompat/compatChatCallModel.ts'

const user = (content: string): Message => ({ type: 'user', uuid: randomUUID(), timestamp: new Date().toISOString(), message: { role: 'user', content } }) as Message
const params = (): CompatCallModelParams => ({
  messages: [user('In one sentence: what is 17 times 23?')],
  systemPrompt: asSystemPrompt(['Only answer the request.']),
  thinkingConfig: { type: 'disabled' },
  tools: [],
  signal: new AbortController().signal,
  options: { model: 'openrouter/vendor/model', querySource: 'repl_main', onWait: () => {}, isNonInteractiveSession: true, getToolPermissionContext: async () => getEmptyToolPermissionContext(), agents: [], hasAppendSystemPrompt: false, mcpTools: [], maxOutputTokensOverride: undefined } as never,
})
type Row = { type?: string; isApiErrorMessage?: boolean; message?: { content: Array<{ text?: string }> } }
async function turn(): Promise<string> {
  const rows: Row[] = []
  for await (const item of compatChatCallModel(openrouterLaneProfile, params())) rows.push(item as Row)
  const last = [...rows].reverse().find(row => row.type === 'assistant')
  return last?.message?.content.map(block => block.text ?? '').join('') ?? '(no assistant row)'
}
const storedSlot = () => slots.deriveFamilySlotGroups().find(group => group.family.id === 'openrouter')?.slots.find(slot => slot.id === 'openrouter:stored-key')
const authFile = (): Record<string, unknown> => (existsSync(accounts.openrouterAuthPathForDisplay()) ? (JSON.parse(readFileSync(accounts.openrouterAuthPathForDisplay(), 'utf8')) as Record<string, unknown>) : {})
const freshRead = (): void => {
  usageState.__resetOpenrouterUsageStateForTest()
}
const childRead = (): { usable: boolean; blockers: string[]; signedIn: boolean | undefined; availability: string } | null => {
  const script = [
    "(globalThis).MACRO = { VERSION: '1.0.0' }",
    "const { enableConfigs } = await import('./src/utils/config.ts'); enableConfigs()",
    "const u = await import('./src/services/providers/providerUsability.ts')",
    "const s = await import('./src/services/providers/accountSlots.ts')",
    "const c = await import('./src/services/providers/openrouter/openrouterCatalogue.ts')",
    "const lane = u.resolveProviderUsability().openrouter",
    "const slot = s.deriveFamilySlotGroups().find(g => g.family.id === 'openrouter')?.slots.find(x => x.id === 'openrouter:stored-key')",
    "const a = c.getOpenrouterAvailability()",
    "console.log(JSON.stringify({ usable: lane.usable, blockers: lane.blockers, signedIn: slot?.signedIn, availability: a.state === 'disabled' ? `${a.why}: ${a.reason}` : a.state }))",
  ].join('\n')
  const r = Bun.spawnSync([process.execPath, '-e', script], { cwd: ROOT, env: { ...process.env, MERCURY_DISABLE_NONESSENTIAL_TRAFFIC: '1' }, stdout: 'pipe', stderr: 'pipe' })
  const out = r.stdout.toString().trim().split('\n').at(-1) ?? ''
  try {
    return JSON.parse(out) as ReturnType<typeof childRead>
  } catch {
    console.log(`  [dbg] child read failed: rc=${r.exitCode} stdout=${out.slice(0, 200)} stderr=${r.stderr.toString().slice(-400)}`)
    return null
  }
}

try {
  secrets.writeStoredOpenrouterApiKey(STORED_KEY)
  await catalogue.refreshOpenrouterCatalogue('stored')

  section('§0 before any refusal: the stored key reads as signed in and usable (the picture the box kept after the refusal)')
  {
    const lane = usability.resolveProviderUsability().openrouter
    check('the stored key counts as usable', lane.usable && lane.credential === 'api-key', j(lane))
    check('the stored slot reads signed in with no note', storedSlot()?.signedIn === true && storedSlot()?.stateNote === undefined, j(storedSlot()))
    const availability = catalogue.getOpenrouterAvailability()
    check('the catalogue lane is ready with the live rows (the /models list answers an expired key too)', availability.state === 'ready' && availability.modelCount === 2, j(availability))
  }

  section('§1 the wire refuses the stored key with the box\'s exact words, and the refusal is kept beside the credential — never the key itself')
  {
    chatStatus = 401
    const text = await turn()
    check('the turn\'s row carries the box\'s line', text === FIELD_LINE, text)
    const file = authFile()
    const refused = file.refused as Record<string, unknown> | undefined
    check('the auth store carries the refusal — the key\'s fingerprint, the source, the status and the wire\'s words', refused !== undefined && refused.source === 'stored' && refused.status === 401 && refused.message === WIRE_MESSAGE && typeof refused.fingerprint === 'string' && (refused.fingerprint as string).length === 12, j(refused))
    check('the store never carries the key value', !JSON.stringify(authFile()).includes(STORED_KEY))
  }

  section('§2 every surface reads the refusal from the store — the resolver, /logins, the Boot face count, the catalogue, the picker, the usage reader, and a separate process (health)')
  {
    freshRead()
    const lane = usability.resolveProviderUsability().openrouter
    check('the usability resolver: not usable, with the refused words', !lane.usable && lane.blockers.length === 1 && lane.blockers[0] === REFUSED_NOTE, j(lane))
    const slot = storedSlot()
    check('/logins: the stored slot is not signed in and carries the refused words', slot?.signedIn === false && slot.stateNote === REFUSED_NOTE, j(slot))
    const groups = slots.deriveFamilySlotGroups()
    const counts = loginsFamilyCounts(groups)
    const signedFamilies = counts.familyIds.filter(id => (groups.find(g => g.family.id === id)?.slots ?? []).some(s => s.signedIn))
    check('the Boot face count leaves OpenRouter out', counts.familyIds.includes('openrouter') && !signedFamilies.includes('openrouter'), j({ counts, signedFamilies }))
    const availability = catalogue.getOpenrouterAvailability()
    check('the catalogue lane is disabled as auth-invalid with the refused words', availability.state === 'disabled' && availability.why === 'auth-invalid' && availability.reason === REFUSED_NOTE, j(availability))
    const options = catalogue.getOpenrouterModelOptions()
    check('the picker leads with the sign-in row carrying the refused words', options[0]?.label === 'OpenRouter — sign in' && (options[0]?.description ?? '').startsWith(REFUSED_NOTE), j(options[0]))
    check('the cached catalogue rows stay visible, each unavailable for the same reason', options.length === 3 && options.slice(1).every(row => row.unavailable === REFUSED_NOTE && typeof row.value === 'string' && row.value.startsWith('openrouter/')), j(options.map(o => [o.value, o.unavailable])))
    const read = usage.usageForProvider('openrouter')
    check('the usage reader names the slot whose credit truth is unavailable', read.readerNote === 'credit truth unavailable for API key (stored)', j(read.readerNote))
    const child = childRead()
    check('a separate process (health\'s shape) reads the same refusal from the store', child !== null && child.usable === false && child.blockers[0] === REFUSED_NOTE && child.signedIn === false && child.availability === `auth-invalid: ${REFUSED_NOTE}`, j(child))
  }

  section('§3 a key the operator re-enters is a new credential: the old refusal no longer applies')
  {
    secrets.writeStoredOpenrouterApiKey(FRESH_KEY)
    freshRead()
    const lane = usability.resolveProviderUsability().openrouter
    check('the fresh key is usable', lane.usable && lane.blockers.length === 0, j(lane))
    check('the fresh slot is signed in with no note', storedSlot()?.signedIn === true && storedSlot()?.stateNote === undefined, j(storedSlot()))
    check('the catalogue lane is no longer auth-invalid', catalogue.getOpenrouterAvailability().state !== 'disabled' || (catalogue.getOpenrouterAvailability() as { why?: string }).why !== 'auth-invalid', j(catalogue.getOpenrouterAvailability()))
    secrets.writeStoredOpenrouterApiKey(STORED_KEY)
    freshRead()
    check('the refused key put back reads refused again (the mark is the key\'s)', usability.resolveProviderUsability().openrouter.usable === false)
  }

  section('§4 OpenRouter accepting the same key again clears the refusal: a 2xx from the wire, or a 2xx from the key probe')
  {
    openrouterLaneProfile.onResponseHeaders?.(new Headers(), 200)
    freshRead()
    check('a served turn clears the mark', usability.resolveProviderUsability().openrouter.usable === true && authFile().refused === undefined, j(authFile()))
    keyStatus = 401
    await usageState.refreshOpenrouterKeyUsage({ fetchImpl, force: true })
    check('the key probe\'s 401 marks the key refused with the same words', authFile().refused !== undefined && storedSlot()?.stateNote === REFUSED_NOTE && usability.resolveProviderUsability().openrouter.usable === false, `${j(storedSlot())} observed=${j(usageState.openrouterObservedKeyUsage())} hits=${hits.slice(-3).join('|')} file=${j(authFile().refused)}`)
    keyStatus = 200
    await usageState.refreshOpenrouterKeyUsage({ fetchImpl, force: true })
    check('the key probe\'s 200 clears it and the credit truth is read', authFile().refused === undefined && storedSlot()?.signedIn === true && usageState.openrouterObservedKeyUsage().usage?.limitRemaining === 18.5, j(storedSlot()))
    chatStatus = 200
    const text = await turn()
    check('a served turn answers', text === 'served', text)
    check('the lane stays usable after the served turn', usability.resolveProviderUsability().openrouter.usable === true)
  }
} finally {
  server.stop(true)
  globalThis.fetch = originalFetch
  rmSync(scratch, { recursive: true, force: true })
}

clearTimeout(guard)
console.log(failures ? `\n❌ openrouter refused key: ${failures} FAILED` : '\n✅ openrouter refused key: ALL PASS')
process.exit(failures ? 1 : 0)
