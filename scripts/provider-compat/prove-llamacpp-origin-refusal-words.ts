import { spawnSync } from 'node:child_process'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const childHome = process.argv[2] === '--scratch-home' ? process.argv[3] : undefined
const HOME = childHome ?? mkdtempSync(join(process.env.MERCURY_TMPDIR ?? tmpdir(), 'llamacpp-origin-refusal-'))
if (childHome === undefined) {
  let status = 1
  try {
    const child = spawnSync(process.execPath, [fileURLToPath(import.meta.url), '--scratch-home', HOME], { env: { ...process.env, HOME, USERPROFILE: HOME }, stdio: 'inherit' })
    status = child.status ?? 1
  } finally {
    rmSync(HOME, { recursive: true, force: true })
  }
  process.exit(status)
}
if (realpathSync(homedir()) !== realpathSync(HOME)) throw new Error('The llama.cpp origin refusal proof requires its scratch HOME at process start.')

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
delete process.env.NODE_ENV
for (const k of ['ANTHROPIC_BASE_URL', 'MERCURY_MODEL', 'MERCURY_LOCAL_API_KEY', 'MERCURY_LOCAL_BASE_URL', 'MERCURY_COMPAT_API_KEY', 'MERCURY_COMPAT_BASE_URL', 'MERCURY_COMPAT_LAB_API_KEY', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy']) {
  delete process.env[k]
}
process.env.MERCURY_CONFIG_DIR = HOME
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
process.env.MERCURY_TOOL_DEFER = '0'

let failures = 0
let checks = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  checks++
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
}
const section = (t: string): void => {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}
const guard = setTimeout(() => {
  console.log('\nTIMEOUT — the llama.cpp origin refusal proof exceeded 120s')
  process.exit(1)
}, 120_000)
guard.unref?.()

const RECORDED = JSON.parse(readFileSync(join(import.meta.dir, 'fixtures', 'llamacpp-origin-refusal.json'), 'utf8')) as { status: number; contentType: string; body: string; serverLog: string }
const OTHER_403 = JSON.stringify({ error: { message: 'Forbidden', type: 'permission_error', code: 403 } })
const MODEL = 'qwen3.5-2b'
const NAMED_HOST = 'llm.example.test:27181'
const WIRE = 'api-permission_error: Cross-origin request not allowed (see --cors-origins)'
const NAMED_WORDS = `API Error: lab refused the request (${WIRE}) — start this llama.cpp server with --cors-origins http://${NAMED_HOST}, or reach it by a loopback address`
const FORWARDED_WORDS = `API Error: lab refused the request (${WIRE}) — a forwarder in front of this llama.cpp server sent it another Host: start the server with --cors-origins naming the address its log shows after "host =", or forward the Host unchanged`
const credentialWords = (name: string, wire: string): string => `API Error: ${name} rejected the credential (${wire}) — /logins compat/${name} replaces this endpoint's key; MERCURY_COMPAT_${name.toUpperCase()}_API_KEY takes precedence when set.`

const seen: Array<{ method: string; path: string; host: string; key: string }> = []
function refusing(body: string): Promise<{ server: Server; root: string }> {
  return new Promise(resolve => {
    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      req.on('data', () => {})
      req.on('end', () => {
        seen.push({ method: req.method ?? '', path: (req.url ?? '').split('?')[0]!, host: String(req.headers['x-asked-host'] ?? req.headers.host ?? ''), key: String(req.headers.authorization ?? '') })
        res.writeHead(RECORDED.status, { 'content-type': RECORDED.contentType })
        res.end(body)
      })
    })
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address !== null ? address.port : 0
      resolve({ server, root: `http://127.0.0.1:${port}` })
    })
  })
}

const origin = await refusing(RECORDED.body)
const other = await refusing(OTHER_403)
const realFetch = globalThis.fetch
globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url)
  if (url.host !== NAMED_HOST) return realFetch(input, init)
  const forwarded = new URL(url.pathname + url.search, origin.root)
  return realFetch(forwarded, { ...init, headers: { ...Object.fromEntries(new Headers(init?.headers).entries()), 'x-asked-host': url.host } })
}) as typeof fetch

const KEY_HELPER = join(HOME, 'key-helper.mjs')
writeFileSync(KEY_HELPER, "import { readFileSync, writeFileSync } from 'node:fs'\nconst [file, kind] = process.argv.slice(2)\nlet runs = 0\ntry { runs = Number(readFileSync(file, 'utf8')) } catch {}\nwriteFileSync(file, String(runs + 1))\nprocess.stdout.write(kind === 'turning' ? `fixture-key-${runs + 1}` : 'fixture-key-one')\n")
const keyRuns = (name: string): number => { try { return Number(readFileSync(join(HOME, `${name}.runs`), 'utf8')) } catch { return 0 } }
const keyCommand = (name: string): string => `"${process.execPath}" "${KEY_HELPER}" "${join(HOME, `${name}.runs`)}" ${name}`
const SETTINGS = JSON.stringify({ compatProvider: {
  lab: { baseUrl: `http://${NAMED_HOST}/v1`, dialect: 'llamacpp', models: [MODEL] },
  sealed: { baseUrl: `http://${NAMED_HOST}/v1`, dialect: 'llamacpp', models: [MODEL], keyCommand: keyCommand('sealed') },
  turning: { baseUrl: `http://${NAMED_HOST}/v1`, dialect: 'llamacpp', models: [MODEL], keyCommand: keyCommand('turning') },
  near: { baseUrl: `${origin.root}/v1`, dialect: 'llamacpp', models: [MODEL] },
  gate: { baseUrl: `${other.root}/v1`, dialect: 'llamacpp', models: [MODEL] },
  rack: { baseUrl: `${origin.root}/v1`, dialect: 'vllm', models: [MODEL] },
} }) + '\n'
writeFileSync(join(HOME, 'settings.json'), SETTINGS)

const { enableConfigs } = await import('../../src/utils/config/globalConfig.ts')
enableConfigs()
const bootstrap = await import('../../src/bootstrap/state.ts')
bootstrap.setIsInteractive(false)
const { resetSettingsCache } = await import('../../src/utils/settings/settingsCache.ts')
resetSettingsCache()
const { routedCallModel } = await import('../../src/services/providers/callModelRouter.ts')
const { getEmptyToolPermissionContext } = await import('../../src/Tool.ts')
const { createUserMessage } = await import('../../src/utils/messages.ts')
const { compatFaultToTypedError, compatTerminalFaultText } = await import('../../src/services/providers/openaicompat/compatChatCallModel.ts')
const { mapCompatHttpFailure } = await import('../../src/services/providers/openaicompat/compatChatClient.ts')
const { readSignInRefusal } = await import('../../src/utils/accounts/signInRefusal.ts')
const { writeStoredCompatApiKey } = await import('../../src/services/providers/providerSecrets.ts')
type Message = import('../../src/types/message.ts').Message

const permissionContext = getEmptyToolPermissionContext()
async function refusalOf(model: string): Promise<{ words: string[]; posts: number; keys: string[] }> {
  const before = seen.length
  const words: string[] = []
  try {
    const stream = routedCallModel({
      messages: [createUserMessage({ content: 'Reply with the single word pong.' }) as Message],
      systemPrompt: ['You are a fixture assistant.'] as never,
      thinkingConfig: { type: 'disabled' } as never,
      tools: [],
      signal: new AbortController().signal,
      options: {
        getToolPermissionContext: async () => permissionContext,
        model,
        isNonInteractiveSession: true,
        querySource: 'main_thread' as never,
        agents: [],
        hasAppendSystemPrompt: false,
        mcpTools: [],
        hasPendingMcpServers: false,
      } as never,
    })
    for await (const message of stream) {
      const m = message as { type?: string; isApiErrorMessage?: boolean; message?: { content?: Array<{ type?: string; text?: string }> } }
      if (m.type === 'assistant' && m.isApiErrorMessage) words.push((m.message?.content ?? []).map(part => part.text ?? '').join(''))
    }
  } catch (error) {
    words.push(`threw: ${error instanceof Error ? error.message : String(error)}`)
  }
  const posts = seen.slice(before).filter(hit => hit.method === 'POST' && hit.path === '/v1/chat/completions')
  return { words, posts: posts.length, keys: posts.map(hit => hit.key) }
}

section('§0 the recorded answer is the one llama.cpp 1.0.0 gives a request it holds to be cross-origin')
const fault = mapCompatHttpFailure(RECORDED.status, JSON.parse(RECORDED.body))
const typed = compatFaultToTypedError(fault)
{
  check('HTTP 403, a permission_error whose words name --cors-origins', RECORDED.status === 403 && fault.status === 403 && fault.message === 'Cross-origin request not allowed (see --cors-origins)' && fault.code === 'api-permission_error', `${fault.status} ${fault.code}: ${fault.message}`)
  check('the server\'s own log names the Host it refused after "host ="', RECORDED.serverLog.includes(`host = '${NAMED_HOST}'`))
  check('a 403 lands in the credential class, where the words of this proof are chosen', typed === 'authentication_failed', typed)
}

section('§1 the sentence — the endpoint first, the wire\'s words in parentheses, then what to do about the origin rule')
{
  const profile = { dialect: 'llamacpp', providerLabel: 'lab', credentialHint: 'fixture', authRemedy: '/logins compat/lab replaces this endpoint\'s key; MERCURY_COMPAT_LAB_API_KEY takes precedence when set.' }
  const at = (requestUrl: string | undefined, dialect = 'llamacpp', from = fault): string => compatTerminalFaultText({ ...profile, dialect } as never, from, compatFaultToTypedError(from), requestUrl === undefined ? undefined : { requestUrl } as never)
  check('an endpoint reached under a name of its own is told the exact address to allow', at(`http://${NAMED_HOST}/v1/chat/completions`) === NAMED_WORDS, at(`http://${NAMED_HOST}/v1/chat/completions`))
  check('the address is the endpoint\'s scheme, host and port as the request\'s Host carried them: a default port is left out', at('https://llm.example.test/v1/chat/completions').includes('--cors-origins https://llm.example.test, or reach') && at('http://llm.example.test:80/v1/chat/completions').includes('--cors-origins http://llm.example.test, or reach'), at('https://llm.example.test/v1/chat/completions'))
  for (const address of ['http://127.0.0.1:27182', 'http://localhost:8080', 'http://[::1]:8080', 'http://127.8.9.10:8080', 'http://0.0.0.0:8080']) {
    check(`an endpoint under a loopback name (${address}) is told a forwarder changed the Host, with no address Mercury cannot know`, at(`${address}/v1/chat/completions`) === FORWARDED_WORDS, at(`${address}/v1/chat/completions`))
  }
  const otherFault = mapCompatHttpFailure(403, JSON.parse(OTHER_403))
  check('a 403 of another cause reads as it read: the credential sentence and its remedy', at(`http://${NAMED_HOST}/v1/chat/completions`, 'llamacpp', otherFault) === credentialWords('lab', 'api-permission_error: Forbidden'), at(`http://${NAMED_HOST}/v1/chat/completions`, 'llamacpp', otherFault))
  check('the same words from an engine of another dialect read as they read', at(`http://${NAMED_HOST}/v1/chat/completions`, 'vllm') === credentialWords('lab', WIRE), at(`http://${NAMED_HOST}/v1/chat/completions`, 'vllm'))
  const unauthorised = mapCompatHttpFailure(401, { error: { message: 'Invalid API Key', type: 'authentication_error', code: 401 } })
  check('llama.cpp\'s own refusal of a key reads as it read', at(`http://${NAMED_HOST}/v1/chat/completions`, 'llamacpp', unauthorised) === credentialWords('lab', 'api-authentication_error: Invalid API Key'), at(`http://${NAMED_HOST}/v1/chat/completions`, 'llamacpp', unauthorised))
}

section('§2 the road — a turn against a server that answers the recorded 403 ends in that sentence')
{
  const named = await refusalOf(`compat/lab/${MODEL}`)
  check('the request was addressed to the endpoint\'s own name', seen.some(hit => hit.method === 'POST' && hit.path === '/v1/chat/completions' && hit.host === NAMED_HOST) && named.posts === 1, JSON.stringify(seen.slice(-3)))
  check('an endpoint under a name of its own ends in the address to allow', named.words.length === 1 && named.words[0] === NAMED_WORDS, named.words.join(' | '))
  const near = await refusalOf(`compat/near/${MODEL}`)
  check('an endpoint under a loopback name ends in the forwarder sentence', near.words.length === 1 && near.words[0] === FORWARDED_WORDS.replace('API Error: lab ', 'API Error: near '), near.words.join(' | '))
  const gate = await refusalOf(`compat/gate/${MODEL}`)
  check('a 403 of another cause ends as it ended', gate.words.length === 1 && gate.words[0] === credentialWords('gate', 'api-permission_error: Forbidden'), gate.words.join(' | '))
  const rack = await refusalOf(`compat/rack/${MODEL}`)
  check('the same 403 from a vLLM endpoint ends as it ended', rack.words.length === 1 && rack.words[0] === credentialWords('rack', WIRE), rack.words.join(' | '))
}

section('§3 the origin rule is not a refused credential — no note of a refused key, no second key asked for, nothing sent twice')
{
  writeFileSync(join(HOME, 'settings.json'), JSON.stringify({ compatProvider: { baseUrl: `http://${NAMED_HOST}/v1`, dialect: 'llamacpp', models: [MODEL] } }) + '\n')
  resetSettingsCache()
  writeStoredCompatApiKey('fixture-key-stored')
  const single = await refusalOf(`compat/${MODEL}`)
  check('no key command, a key kept by /logins: the address to allow, the request sent once with that key', single.words.length === 1 && single.words[0] === NAMED_WORDS.replace('API Error: lab ', 'API Error: Custom endpoint ') && single.posts === 1 && single.keys.join(',') === 'Bearer fixture-key-stored', `${single.words.join(' | ')} · ${single.posts} ${single.keys.join(',')}`)
  check('and no note is left that the endpoint refused that key', readSignInRefusal('openai-compat') === undefined, JSON.stringify(readSignInRefusal('openai-compat')))
  writeStoredCompatApiKey(null)
  writeFileSync(join(HOME, 'settings.json'), SETTINGS)
  resetSettingsCache()
  const sealed = await refusalOf(`compat/sealed/${MODEL}`)
  check('a command that gives the same key: the address to allow, in place of an expired sign-in', sealed.words.length === 1 && sealed.words[0] === NAMED_WORDS.replace('API Error: lab ', 'API Error: sealed '), sealed.words.join(' | '))
  check('the request went once with the command\'s key, and the command was asked once', sealed.posts === 1 && sealed.keys.join(',') === 'Bearer fixture-key-one' && keyRuns('sealed') === 1, `${sealed.posts} ${sealed.keys.join(',')} runs=${keyRuns('sealed')}`)
  const turning = await refusalOf(`compat/turning/${MODEL}`)
  check('a command that gives a new key each time: the same sentence', turning.words.length === 1 && turning.words[0] === NAMED_WORDS.replace('API Error: lab ', 'API Error: turning '), turning.words.join(' | '))
  check('the request went once with the first key: no second key was asked for and nothing was sent again', turning.posts === 1 && turning.keys.join(',') === 'Bearer fixture-key-1' && keyRuns('turning') === 1, `${turning.posts} ${turning.keys.join(',')} runs=${keyRuns('turning')}`)
}

origin.server.close()
other.server.close()
console.log(`\n${checks - failures}/${checks} checks passed`)
if (failures > 0) {
  console.log(`❌ ${failures} LLAMA.CPP ORIGIN REFUSAL PROOF(S) FAILED`)
  process.exit(1)
}
console.log('✅ ALL LLAMA.CPP ORIGIN REFUSAL PROOFS PASS')
process.exit(0)
