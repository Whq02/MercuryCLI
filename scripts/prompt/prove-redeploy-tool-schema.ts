#!/usr/bin/env bun
import { spawn, spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { HANDOFF_ASK_MARK, bindingDropsFor, handoffTurn, isHandoffRequest, startFixtureApi, type CapturedRequest } from '../lib/fixtureApi.ts'
import { seedFirstRun } from '../lib/firstRunSeed.ts'

const root = resolve(import.meta.dir, '../..')
const arg = (name: string): string | undefined => {
  const at = process.argv.indexOf(name)
  return at < 0 ? undefined : process.argv[at + 1]
}
const dist = resolve(arg('--dist') ?? join(root, 'dist/mercury.mjs'))
const keep = process.argv.includes('--keep')
const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'redeploy-tool-schema-')))
const RETIRED = 'dangerouslyDisableSandbox'
const MODEL = 'claude-opus-4-8'
const GPT = 'gpt-6-astra'
let failures = 0
let checks = 0
const check = (name: string, good: boolean, detail = ''): void => {
  checks++
  if (!good) failures++
  console.log(`  [${good ? 'PASS' : 'FAIL'}] ${name}${good || !detail ? '' : ` — ${detail.slice(0, 700)}`}`)
}
const section = (title: string): void => console.log(`\n${'─'.repeat(76)}\n${title}\n${'─'.repeat(76)}`)
const j = (value: unknown): string => JSON.stringify(value)
const nodeFor = (bundle: string): string => {
  const vendored = join(dirname(bundle), 'vendor', 'node', 'bin', 'node')
  return existsSync(vendored) ? vendored : (Bun.which('node') ?? 'node')
}
const manifestOf = (bundle: string): { version?: string; buildTree?: string | null } => {
  try {
    return JSON.parse(readFileSync(join(dirname(bundle), 'manifest.json'), 'utf8')) as { version?: string; buildTree?: string | null }
  } catch {
    return {}
  }
}
const withoutCacheControl = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(withoutCacheControl)
  if (value === null || typeof value !== 'object') return value
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).filter(([key]) => key !== 'cache_control').map(([key, inner]) => [key, withoutCacheControl(inner)]))
}
type ToolRow = Record<string, unknown> & { name?: string }
const toolsOf = (body: unknown): ToolRow[] => ((body as { tools?: ToolRow[] } | null)?.tools ?? [])
const bashOf = (body: unknown): ToolRow | undefined => toolsOf(body).find(tool => tool.name === 'Bash')
const propertiesOf = (schema: unknown): string[] => Object.keys((schema as { properties?: Record<string, unknown> } | null)?.properties ?? {})

function buildOldDist(version: string): string {
  const tree = join(scratch, 'old-tree')
  mkdirSync(tree)
  const files = spawnSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { cwd: root, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 })
  if (files.status !== 0) throw new Error(files.stderr)
  for (const file of files.stdout.split('\0').filter(Boolean)) {
    const target = join(tree, file)
    mkdirSync(dirname(target), { recursive: true })
    cpSync(join(root, file), target)
  }
  symlinkSync(resolve(arg('--old-node-modules') ?? join(root, 'node_modules')), join(tree, 'node_modules'))
  const bashPath = join(tree, 'src/tools/BashTool/BashTool.tsx')
  const bash = readFileSync(bashPath, 'utf8')
  const schemaStart = 'function buildModelSchema() {\n  return z.strictObject({'
  if (bash.split(schemaStart).length !== 2 || bash.includes(RETIRED)) throw new Error('The predecessor fixture must add exactly one field to the current Bash schema')
  writeFileSync(bashPath, bash.replace(schemaStart, schemaStart + '\n    ' + RETIRED + ": semanticBoolean(z.boolean().optional()).describe('An explicit, dangerous override that runs the command without sandboxing.'),"))
  const normalizerPath = join(tree, 'src/utils/api.ts')
  const normalizer = readFileSync(normalizerPath, 'utf8')
  const rebuild = 'const rebuilt: Record<string, unknown> = { command, description: parsed.description }'
  if (normalizer.split(rebuild).length !== 2) throw new Error('The predecessor fixture needs exactly one Bash input normalizer')
  writeFileSync(normalizerPath, normalizer.replace(rebuild, rebuild + '\n      if (' + JSON.stringify(RETIRED) + ' in parsed) rebuilt[' + JSON.stringify(RETIRED) + '] = parsed[' + JSON.stringify(RETIRED) + ']'))
  const pkgPath = join(tree, 'package.json')
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { version?: string }
  if (version !== '') pkg.version = version
  writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`)
  for (const name of readdirSync(join(root, 'vendor'))) {
    if (name === 'desktop' || existsSync(join(tree, 'vendor', name))) continue
    if (name === 'embed' || name === 'embed-models') cpSync(join(root, 'vendor', name), join(tree, 'vendor', name), { recursive: true, dereference: true })
    else symlinkSync(join(root, 'vendor', name), join(tree, 'vendor', name))
  }
  const out = mkdtempSync(join(scratch, 'old-dist-'))
  const build = spawnSync('nice', ['-n', '10', process.execPath, 'run', 'build.ts'], { cwd: tree, env: { ...process.env, MERCURY_CONFIG_DIR: join(scratch, 'build-home'), MERCURY_BUILD_OUTDIR: out }, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  if (build.status !== 0) throw new Error('the predecessor fixture did not build: ' + (build.stdout + build.stderr).slice(-1500))
  return join(out, 'mercury.mjs')
}

type World = { home: string; cwd: string; config: string }
function world(name: string): World {
  const home = join(scratch, name)
  const cwd = join(home, 'work')
  mkdirSync(cwd, { recursive: true })
  mkdirSync(join(home, 'tmp'), { recursive: true })
  seedFirstRun(join(home, 'config'), [cwd])
  return { home, cwd, config: join(home, 'config') }
}
const envOf = (w: World, bundle: string, wire: Record<string, string>): Record<string, string> => ({
  HOME: w.home, PATH: `/usr/bin:/bin:${dirname(nodeFor(bundle))}`, TERM: 'dumb', TMPDIR: join(w.home, 'tmp'),
  MERCURY_CONFIG_DIR: w.config, MERCURY_CREDENTIAL_STORE: 'file', MERCURY_LOCAL_PROBE_TARGETS: 'none',
  MERCURY_DAEMON_DIR: join(w.home, 'daemon'), MERCURY_BOOT_PREFLIGHT: '0', BROWSER: '/usr/bin/true',
  MERCURY_THINKING_BINDING: 'drop_block', ...wire,
})
function run(bundle: string, w: World, wire: Record<string, string>, args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise(done => {
    const child = spawn(nodeFor(bundle), [bundle, 'run', ...args, '--format', 'rows', '--mode', 'sovereign'], { cwd: w.cwd, env: envOf(w, bundle, wire) })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', data => { stdout += data })
    child.stderr.on('data', data => { stderr += data })
    const timer = setTimeout(() => child.kill('SIGKILL'), 180_000)
    child.on('error', error => { clearTimeout(timer); done({ code: -1, stdout, stderr: `${stderr}\n${String(error)}` }) })
    child.on('close', code => { clearTimeout(timer); done({ code, stdout, stderr }) })
  })
}
function transcriptOf(w: World, sid: string): string {
  const found: string[] = []
  const walk = (dir: string): void => {
    if (!existsSync(dir)) return
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) walk(path)
      else if (entry.name === `${sid}.jsonl`) found.push(path)
    }
  }
  walk(join(w.config, 'projects'))
  return found.map(path => readFileSync(path, 'utf8')).join('\n')
}
const sidecarOf = (w: World, sid: string): string => join(w.config, 'sessions', sid, 'prefix-ledger.json')
const said = (request: CapturedRequest, words: string): boolean => request.raw.includes(words)

type ResponsesTurn = { text: string } | { call: Record<string, unknown>; id: string }
async function startResponses(script: ResponsesTurn[]): Promise<{ wire: Record<string, string>; bodies: Array<{ body: Record<string, unknown>; raw: string }>; close: () => void }> {
  const sse = (event: unknown): string => `data: ${j(event)}\n\n`
  const completed = (id: string): string => sse({ type: 'response.completed', response: { id, usage: { input_tokens: 2400, output_tokens: 40, input_tokens_details: { cached_tokens: 0 } } } })
  const text = (id: string, words: string): string => [sse({ type: 'response.created', response: { id } }), sse({ type: 'response.output_text.delta', delta: words }), sse({ type: 'response.output_item.done', item: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: words }] } }), completed(id)].join('')
  const call = (id: string, turn: { call: Record<string, unknown>; id: string }): string => {
    const args = j(turn.call)
    const item = { type: 'function_call', id: `fc_${turn.id}`, call_id: `call_${turn.id}`, name: 'Bash', arguments: args }
    return [
      sse({ type: 'response.created', response: { id } }),
      sse({ type: 'response.output_item.added', item: { type: 'reasoning', id: `rs_${turn.id}`, summary: [] } }),
      sse({ type: 'response.reasoning_summary_text.delta', item_id: `rs_${turn.id}`, delta: 'Run the command.' }),
      sse({ type: 'response.output_item.done', item: { type: 'reasoning', id: `rs_${turn.id}`, summary: [{ type: 'summary_text', text: 'Run the command.' }], encrypted_content: `fixture-reasoning-${turn.id}` } }),
      sse({ type: 'response.output_item.added', item: { ...item, arguments: '' } }),
      sse({ type: 'response.function_call_arguments.delta', item_id: item.id, delta: args }),
      sse({ type: 'response.output_item.done', item }),
      completed(id),
    ].join('')
  }
  const models = { models: [{ slug: GPT, display_name: 'GPT-6 Astra', supported_reasoning_levels: [{ effort: 'low', description: 'low' }, { effort: 'high', description: 'high' }], default_reasoning_level: 'high', visibility: 'list', priority: 1, context_window: 1_050_000, input_modalities: ['text', 'image'], supported_in_api: true }] }
  const queue = [...script]
  const bodies: Array<{ body: Record<string, unknown>; raw: string }> = []
  let seq = 0
  const server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', chunk => chunks.push(chunk as Buffer))
    req.on('end', () => {
      const path = (req.url ?? '').split('?')[0] ?? ''
      if (req.method === 'GET' && path.endsWith('/models')) {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(j(path.startsWith('/openai/') ? models : { data: [], has_more: false }))
        return
      }
      if (!(req.method === 'POST' && path.endsWith('/responses'))) {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end('{}')
        return
      }
      const raw = Buffer.concat(chunks).toString('utf8')
      const id = `resp_${++seq}`
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      if (raw.includes(HANDOFF_ASK_MARK)) {
        res.end(text(id, 'The note.'))
        return
      }
      bodies.push({ body: JSON.parse(raw) as Record<string, unknown>, raw })
      const turn = queue.shift() ?? { text: 'script exhausted' }
      res.end('call' in turn ? call(id, turn) : text(id, turn.text))
    })
  })
  await new Promise<void>(listening => server.listen(0, '127.0.0.1', listening))
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  return {
    wire: { OPENAI_API_KEY: 'fixture-openai-key', MERCURY_OPENAI_API_BASE: `${base}/openai/v1`, MERCURY_OPENAI_CHATGPT_BASE: `${base}/openai/chatgpt`, MERCURY_OPENAI_AUTH_BASE: `${base}/openai/auth`, ANTHROPIC_BASE_URL: `${base}/anthropic` },
    bodies,
    close: () => {
      server.closeAllConnections()
      server.close()
    },
  }
}
const anthropicWire = (url: string): Record<string, string> => ({ ANTHROPIC_BASE_URL: url, ANTHROPIC_API_KEY: 'proof-key-ci-gate-not-a-real-key' })
const messageRequests = (fixture: { messageRequests(): CapturedRequest[] }): CapturedRequest[] => fixture.messageRequests().filter(request => !isHandoffRequest(request))
const handoffs = () => [handoffTurn('The note.'), handoffTurn('The note.'), handoffTurn('The note.'), handoffTurn('The note.')]

try {
  section(`§0 the two builds: a session recorded by an earlier build, resumed by ${dist}`)
  console.log('  The published lineage rewrites history; the scratch predecessor restores the old Bash schema field and its normalizer passthrough.')
  const newManifest = manifestOf(dist)
  const oldDist = arg('--old-dist') !== undefined ? resolve(arg('--old-dist')!) : buildOldDist(newManifest.version ?? '')
  const oldManifest = manifestOf(oldDist)
  console.log(`  earlier: ${oldDist} (v${oldManifest.version ?? '?'}, tree ${oldManifest.buildTree ?? 'none'})`)
  console.log(`  redeployed: ${dist} (v${newManifest.version ?? '?'}, tree ${newManifest.buildTree ?? 'none'})`)
  check(`the earlier build's Bash tool still declares ${RETIRED}; the redeployed build carries the word nowhere`, readFileSync(oldDist, 'utf8').includes(RETIRED) && !readFileSync(dist, 'utf8').includes(RETIRED))
  check('both builds carry one version: the redeploy moved the source tree and left the version string as it was', typeof newManifest.version === 'string' && oldManifest.version === newManifest.version, `${oldManifest.version} → ${newManifest.version}`)
  check('the redeployed build names its own source tree, and it is not the earlier build\'s', typeof newManifest.buildTree === 'string' && newManifest.buildTree !== '' && newManifest.buildTree !== oldManifest.buildTree, `${oldManifest.buildTree} → ${newManifest.buildTree}`)
  const newTree = String(newManifest.buildTree ?? '').slice(0, 12)

  section('§1 the redeployed build\'s own Bash definition, from a fresh session on each road')
  let liveAnthropic: ToolRow | undefined
  {
    const w = world('anthropic-fresh')
    const fixture = await startFixtureApi([{ kind: 'text', text: 'FRESH-ANSWER', model: MODEL }, ...handoffs()], { bindingCheck: true })
    try {
      const fresh = await run(dist, w, anthropicWire(fixture.url), ['a fresh session', '--session-id', randomUUID(), '--model', MODEL])
      liveAnthropic = bashOf(messageRequests(fixture)[0]?.body)
      check('a fresh session on the Anthropic road offers Bash without the retired parameter', fresh.code === 0 && liveAnthropic !== undefined && !propertiesOf(liveAnthropic.input_schema).includes(RETIRED), `exit ${fresh.code}: ${fresh.stderr.slice(-300)}`)
    } finally {
      await fixture.close()
    }
  }
  let liveOpenai: ToolRow | undefined
  {
    const w = world('openai-fresh')
    const fixture = await startResponses([{ text: 'FRESH-ANSWER' }])
    try {
      const fresh = await run(dist, w, fixture.wire, ['a fresh session', '--session-id', randomUUID(), '--model', GPT])
      liveOpenai = bashOf(fixture.bodies[0]?.body)
      check('a fresh session on the OpenAI Responses road offers Bash without the retired parameter', fresh.code === 0 && liveOpenai !== undefined && !propertiesOf(liveOpenai.parameters).includes(RETIRED), `exit ${fresh.code}: ${fresh.stderr.slice(-300)}`)
    } finally {
      fixture.close()
    }
  }

  section('§2 Anthropic road, the sidecar kept: the session the earlier build recorded resumes on the redeployed build')
  {
    const w = world('anthropic-kept')
    const sid = randomUUID()
    const marker = join(w.home, 'retired-call-ran')
    const fixture = await startFixtureApi([
      { kind: 'tool_use', name: 'Bash', id: 'toolu_recorded', input: { command: 'true', description: 'A no-op', [RETIRED]: false }, thinking: 'Recorded thinking.', model: MODEL },
      { kind: 'text', text: 'RECORDED-ANSWER', thinking: 'Recorded answer.', model: MODEL },
      { kind: 'tool_use', name: 'Bash', id: 'toolu_retired', input: { command: `touch ${marker}`, description: 'Touch the marker', [RETIRED]: false }, thinking: 'Resumed thinking.', model: MODEL },
      { kind: 'text', text: 'RESUMED-ANSWER', model: MODEL },
      { kind: 'text', text: 'RESPAWNED-ANSWER', model: MODEL },
      ...handoffs(),
    ], { bindingCheck: true })
    try {
      const recorded = await run(oldDist, w, anthropicWire(fixture.url), ['record this work', '--session-id', sid, '--model', MODEL])
      const recordedRequest = messageRequests(fixture)[0]
      check('the earlier build recorded a session whose Bash call carries the retired field, beside its sidecar', recorded.code === 0 && recordedRequest !== undefined && propertiesOf(bashOf(recordedRequest.body)?.input_schema).includes(RETIRED) && transcriptOf(w, sid).includes(`"${RETIRED}":false`) && existsSync(sidecarOf(w, sid)), `exit ${recorded.code}: ${recorded.stderr.slice(-300)}`)
      const resumedAt = messageRequests(fixture).length
      const resumed = await run(dist, w, anthropicWire(fixture.url), ['resume this work', '--resume', sid, '--model', MODEL])
      const after = messageRequests(fixture).slice(resumedAt)
      const first = after.find(request => said(request, 'resume this work') && !said(request, 'toolu_retired'))
      const next = after.find(request => said(request, 'toolu_retired'))
      const bash = bashOf(first?.body)
      check('the resumed request offers the redeployed build\'s own Bash input schema byte for byte, without the retired parameter', resumed.code === 0 && bash !== undefined && j(bash.input_schema) === j(liveAnthropic?.input_schema) && !j(bash).includes(RETIRED), `exit ${resumed.code}; properties ${j(propertiesOf(bash?.input_schema))}; ${resumed.stderr.slice(-300)}`)
      const result = j((next?.body as { messages?: unknown[] } | undefined)?.messages?.at(-1) ?? null)
      check('a call that still carries the retired field is refused as an unknown input before execution, and the command never ran', next !== undefined && result.includes('toolu_retired') && result.includes('"is_error":true') && result.includes(RETIRED) && !existsSync(marker), result.slice(0, 500))
      check('the history replays as sent: the recorded call keeps its input verbatim on the wire', first !== undefined && j((first.body as { messages?: unknown }).messages).includes(`"${RETIRED}":false`))
      check('the system prompt replays byte-equal from the record', first !== undefined && recordedRequest !== undefined && j(withoutCacheControl((first.body as { system?: unknown }).system)) === j(withoutCacheControl((recordedRequest.body as { system?: unknown }).system)))
      const transcript = transcriptOf(w, sid)
      check('the thinking minted over the retired schema drops once at the resumed request, and the receipt names the update (lawful, expected once)', first !== undefined && bindingDropsFor(first.body).length > 0 && transcript.includes('Preserved thinking: the API dropped') && transcript.includes('after the update to') && !transcript.includes('Mercury rewrote'), `drops ${j(first ? bindingDropsFor(first.body) : null)}`)
      const sidecar = existsSync(sidecarOf(w, sid)) ? (JSON.parse(readFileSync(sidecarOf(w, sid), 'utf8')) as { build?: string; buildTree?: string }) : null
      check('the sidecar the redeployed build wrote names its source tree beside the version', sidecar !== null && sidecar.build === newManifest.version && sidecar.buildTree === newTree, j(sidecar === null ? null : { build: sidecar.build, buildTree: sidecar.buildTree }))
      section('§3 Anthropic road, the same build respawned: the record it wrote replays as first sent')
      const respawnedAt = messageRequests(fixture).length
      const respawned = await run(dist, w, anthropicWire(fixture.url), ['continue this work', '--resume', sid, '--model', MODEL])
      const again = messageRequests(fixture).slice(respawnedAt).find(request => said(request, 'continue this work'))
      check('a respawn on the same tree re-sends the resumed request\'s tools byte for byte and drops no reasoning', respawned.code === 0 && again !== undefined && first !== undefined && j(withoutCacheControl(toolsOf(again.body))) === j(withoutCacheControl(toolsOf(first.body))) && bindingDropsFor(again.body).length === 0, `exit ${respawned.code}; drops ${j(again ? bindingDropsFor(again.body) : null)}`)
    } finally {
      await fixture.close()
    }
  }

  section('§4 Anthropic road, the record alone (no sidecar beside it): the changed schema breaks the binding for that tool only')
  {
    const w = world('anthropic-record-only')
    const sid = randomUUID()
    const fixture = await startFixtureApi([
      { kind: 'tool_use', name: 'Bash', id: 'toolu_recorded', input: { command: 'true', description: 'A no-op', [RETIRED]: false }, thinking: 'Recorded thinking.', model: MODEL },
      { kind: 'text', text: 'RECORDED-ANSWER', thinking: 'Recorded answer.', model: MODEL },
      { kind: 'text', text: 'RESUMED-ANSWER', model: MODEL },
      ...handoffs(),
    ], { bindingCheck: true })
    try {
      const recorded = await run(oldDist, w, anthropicWire(fixture.url), ['record this work', '--session-id', sid, '--model', MODEL])
      const recordedRequest = messageRequests(fixture)[0]
      rmSync(sidecarOf(w, sid), { force: true })
      const resumedAt = messageRequests(fixture).length
      const resumed = await run(dist, w, anthropicWire(fixture.url), ['resume this work', '--resume', sid, '--model', MODEL])
      const first = messageRequests(fixture).slice(resumedAt).find(request => said(request, 'resume this work'))
      const bash = bashOf(first?.body)
      check('the resumed request offers the live Bash input schema although no sidecar says which build wrote the record', recorded.code === 0 && resumed.code === 0 && bash !== undefined && j(bash.input_schema) === j(liveAnthropic?.input_schema), `exit ${recorded.code}/${resumed.code}; properties ${j(propertiesOf(bash?.input_schema))}`)
      const others = (body: unknown): string => j(withoutCacheControl(toolsOf(body).filter(tool => tool.name !== 'Bash')))
      check('every other recorded definition replays byte for byte: the binding broke for Bash alone', first !== undefined && recordedRequest !== undefined && others(first.body) === others(recordedRequest.body))
      const transcript = transcriptOf(w, sid)
      check('the one drop it costs reads lawful and names the tool whose input changed', transcript.includes('Preserved thinking: the API dropped') && transcript.includes('takes different input now (Bash)'), transcript.match(/Preserved thinking:[^"]*/)?.[0] ?? 'no drop receipt')
    } finally {
      await fixture.close()
    }
  }

  section('§5 OpenAI Responses road: the session the earlier build recorded resumes on the redeployed build')
  {
    const w = world('openai-kept')
    const sid = randomUUID()
    const marker = join(w.home, 'retired-call-ran')
    const fixture = await startResponses([
      { call: { command: 'true', description: 'A no-op', [RETIRED]: false }, id: 'recorded' },
      { text: 'RECORDED-ANSWER' },
      { call: { command: `touch ${marker}`, description: 'Touch the marker', [RETIRED]: false }, id: 'retired' },
      { text: 'RESUMED-ANSWER' },
    ])
    try {
      const recorded = await run(oldDist, w, fixture.wire, ['record this work', '--session-id', sid, '--model', GPT])
      check('the earlier build recorded a Responses session whose Bash call carries the retired field', recorded.code === 0 && propertiesOf(bashOf(fixture.bodies[0]?.body)?.parameters).includes(RETIRED) && transcriptOf(w, sid).includes(`"${RETIRED}":false`), `exit ${recorded.code}: ${recorded.stderr.slice(-300)}`)
      const resumedAt = fixture.bodies.length
      const resumed = await run(dist, w, fixture.wire, ['resume this work', '--resume', sid, '--model', GPT])
      const after = fixture.bodies.slice(resumedAt)
      const first = after.find(request => request.raw.includes('resume this work') && !request.raw.includes('call_retired'))
      const next = after.find(request => request.raw.includes('call_retired'))
      const bash = bashOf(first?.body)
      check('the resumed request offers the redeployed build\'s own Bash parameters byte for byte, without the retired parameter', resumed.code === 0 && bash !== undefined && j(bash.parameters) === j(liveOpenai?.parameters) && !j(bash).includes(RETIRED), `exit ${resumed.code}; properties ${j(propertiesOf(bash?.parameters))}; ${resumed.stderr.slice(-300)}`)
      check('the gate refuses a call that still carries the retired field before execution, hands the model the correction, and the command never ran', next !== undefined && next.raw.includes('refused by the harness before execution') && next.raw.includes(RETIRED) && !existsSync(marker), next?.raw.slice(-600) ?? 'no request after the call')
      check('the history replays as sent: the recorded function call keeps its arguments verbatim on the wire', first !== undefined && first.raw.includes(`\\"${RETIRED}\\":false`))
    } finally {
      fixture.close()
    }
  }
} finally {
  if (keep || failures > 0) console.log(`\nkept: ${scratch}`)
  else rmSync(scratch, { recursive: true, force: true })
}
console.log(`\n${checks} checks, ${failures} failures`)
if (failures > 0) {
  console.log('REDEPLOY TOOL SCHEMA RED')
  process.exit(1)
}
console.log('REDEPLOY TOOL SCHEMA GREEN')
