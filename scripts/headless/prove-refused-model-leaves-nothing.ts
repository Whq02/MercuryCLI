#!/usr/bin/env bun
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = join(HERE, '..', '..')
const DIST = join(REPO, 'dist', 'mercury.mjs')
if (!existsSync(DIST)) {
  console.error('✗ dist/mercury.mjs missing — run `bun run build.ts` first')
  process.exit(1)
}
let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
const clip = (text: string, limit = 240): string => JSON.stringify(text.length > limit ? `${text.slice(0, limit)}…` : text)
const BAD = 'no-such-model'
const API_KEY = 'fixture-key-000'
const { startFixtureApi, handoffTurn } = await import('../lib/fixtureApi.ts')
const api = await startFixtureApi([
  { kind: 'text', text: 'First answered.' },
  { kind: 'text', text: 'Continued.' },
  { kind: 'text', text: 'Gateway answered.' },
  { kind: 'text', text: 'Spare.' },
  handoffTurn(),
  handoffTurn(),
])

let tunnels = 0
const proxied: string[] = []
const proxy = http.createServer((req, res) => {
  const target = new URL(req.url ?? '/', 'http://api.anthropic.com')
  proxied.push(`${req.method} ${target.host}${target.pathname}`)
  const forward = http.request({ host: '127.0.0.1', port: api.port, method: req.method, path: `${target.pathname}${target.search}`, headers: req.headers }, answer => {
    res.writeHead(answer.statusCode ?? 502, answer.headers)
    answer.pipe(res)
  })
  forward.on('error', () => { res.writeHead(502); res.end() })
  req.pipe(forward)
})
proxy.on('connect', (_req, client, head) => {
  tunnels++
  const upstream = net.connect(api.port, '127.0.0.1', () => {
    client.write('HTTP/1.1 200 Connection Established\r\n\r\n')
    if (head.length > 0) upstream.write(head)
    upstream.pipe(client)
    client.pipe(upstream)
  })
  upstream.on('error', () => client.destroy())
  client.on('error', () => upstream.destroy())
})
const proxyPort = await new Promise<number>(resolve => proxy.listen(0, '127.0.0.1', () => resolve((proxy.address() as net.AddressInfo).port)))

type World = { home: string; cwd: string; configDir: string; env: Record<string, string> }
const mkHome = (tag: string, posture: 'first-party' | 'gateway'): World => {
  const home = mkdtempSync(join(tmpdir(), `badmodel-${tag}-home-`))
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), `badmodel-${tag}-cwd-`)))
  const configDir = join(home, '.mercury')
  mkdirSync(configDir, { recursive: true })
  writeFileSync(join(configDir, '.config.json'), JSON.stringify({
    theme: 'dark',
    hasCompletedOnboarding: true,
    customApiKeyResponses: { approved: [API_KEY.slice(-20)] },
    projects: { [cwd]: { hasTrustDialogAccepted: true, hasCompletedProjectOnboarding: true } },
  }))
  const nodeDir = dirname(process.execPath)
  const transport = posture === 'first-party'
    ? { ANTHROPIC_BASE_URL: 'http://api.anthropic.com', HTTP_PROXY: `http://127.0.0.1:${proxyPort}`, http_proxy: `http://127.0.0.1:${proxyPort}` }
    : { ANTHROPIC_BASE_URL: api.url }
  return {
    home, cwd, configDir,
    env: {
      HOME: home,
      PATH: `/usr/bin:/bin:${nodeDir}:${process.env.PATH ?? ''}`,
      TERM: 'xterm-256color',
      MERCURY_CONFIG_DIR: configDir,
      MERCURY_LOCAL_PROBE_TARGETS: 'none',
      MERCURY_DAEMON_DIR: join(home, 'daemon'),
      ANTHROPIC_API_KEY: API_KEY,
      ...transport,
    },
  }
}
const run = (world: World, args: string[]): Promise<{ code: number | null; out: string; err: string }> =>
  new Promise(resolve => {
    const c = spawn('node', [DIST, ...args], { cwd: world.cwd, env: world.env, stdio: ['pipe', 'pipe', 'pipe'] })
    let out = ''
    let err = ''
    c.stdout.on('data', d => (out += d))
    c.stderr.on('data', d => (err += d))
    c.stdin.end()
    const k = setTimeout(() => c.kill('SIGKILL'), 90_000)
    c.on('exit', code => { clearTimeout(k); resolve({ code, out, err }) })
  })
const walk = (dir: string): string[] => {
  if (!existsSync(dir)) return []
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) out.push(...walk(full))
    else out.push(full)
  }
  return out
}
const transcripts = (world: World): string[] => walk(join(world.configDir, 'projects')).filter(f => /[\\/][0-9a-f-]{36}\.jsonl$/.test(f))
const rowsOf = (out: string): Array<Record<string, unknown>> => out.split('\n').filter(l => l.startsWith('{')).map(l => { try { return JSON.parse(l) as Record<string, unknown> } catch { return {} } })
const turns = (): Array<{ body: unknown }> => api.messageRequests().filter(r => !r.path.includes('count_tokens'))
const modelsSent = (from: number): string[] => turns().slice(from).map(r => String((r.body as { model?: unknown } | null)?.model ?? ''))

console.log('§1 first-party posture: a refused --model leaves nothing behind')
{
  const w = mkHome('refused', 'first-party')
  const before = turns().length
  const text = await run(w, ['run', '--model', BAD, '--', 'hi'])
  console.log(`        stderr: ${clip(text.err.trim())}`)
  check('exit 1', text.code === 1, `code ${text.code}`)
  check("the refusal is the call's own sentence: the id named, 'is not a model id', 'Refused before any request'", text.err.includes(`'${BAD}' is not a model id`) && /Refused before any request/.test(text.err), clip(text.err))
  check('no model request went out (nothing reached the proxy)', turns().length === before && proxied.length === 0 && tunnels === 0, `${turns().length - before} request(s), proxied ${JSON.stringify(proxied)}, ${tunnels} tunnel(s)`)
  check('no transcript was written in the home', transcripts(w).length === 0, transcripts(w).join(','))
  const rows = await run(w, ['run', '--format', 'rows', '--model', BAD, '--', 'hi'])
  check('--format rows: the same refusal as one refused outcome row naming the id, exit 1, no other row, still no transcript', rows.code === 1 && rowsOf(rows.out).length === 1 && rowsOf(rows.out)[0]?.type === 'outcome' && String((rowsOf(rows.out)[0] as { status?: string }).status) === 'refused' && rows.out.includes(`'${BAD}' is not a model id`) && transcripts(w).length === 0, `${rows.code} · ${clip(rows.out)} · ${clip(rows.err)}`)
  rmSync(w.home, { recursive: true, force: true })
  rmSync(w.cwd, { recursive: true, force: true })
}

console.log('§2 first-party posture: a good run, then --continue over the transcript rewritten to the bad id')
{
  const w = mkHome('continue', 'first-party')
  const before = turns().length
  const first = await run(w, ['run', '--format', 'rows', '--', 'hello first'])
  const firstModel = modelsSent(before)[0] ?? ''
  check('the seed turn ran through the proxy to the first-party host on the default model', first.code === 0 && /First answered\./.test(first.out) && proxied.some(p => p.startsWith('POST api.anthropic.com/v1/messages')) && firstModel !== '' && firstModel !== BAD, `${first.code} · model ${firstModel} · proxied ${JSON.stringify(proxied)} · ${clip(first.err)}`)
  const files = transcripts(w)
  check('the seed left one transcript', files.length === 1, files.join(','))
  let rewritten = 0
  for (const file of walk(join(w.configDir, 'projects'))) {
    const text = readFileSync(file, 'utf8')
    if (!text.includes(firstModel)) continue
    writeFileSync(file, text.split(firstModel).join(BAD))
    rewritten++
  }
  check(`the transcript now carries '${BAD}' where the model was (${rewritten} file(s) rewritten)`, rewritten >= 1 && files.every(f => readFileSync(f, 'utf8').includes(BAD)))
  const mid = turns().length
  const cont = await run(w, ['run', '--continue', '--format', 'rows', '--', 'and then?'])
  const rows = rowsOf(cont.out)
  const notice = rows.find(r => r.type === 'notice' && String(r.text ?? '').includes(BAD))
  const session = rows.find(r => r.type === 'session') as { model?: string } | undefined
  console.log(`        notice: ${clip(String(notice?.text ?? '(none)'))}`)
  check('--continue completes on the default model (exit 0, the next scripted turn)', cont.code === 0 && /Continued\./.test(cont.out), `${cont.code} · ${clip(cont.err)} · ${clip(cont.out.slice(-300))}`)
  check(`the request carried the default model, never '${BAD}'`, modelsSent(mid).length === 1 && modelsSent(mid)[0] === firstModel, JSON.stringify(modelsSent(mid)))
  check('a notice row names the unusable recorded model and the model this run uses instead', notice !== undefined && String(notice.level) === 'warning' && String(notice.text).includes(`'${BAD}' is not usable`) && String(notice.text).includes(`this run uses ${firstModel} instead`), clip(JSON.stringify(notice ?? null)))
  check("the session row's model is the one that ran", session?.model === firstModel, JSON.stringify(session?.model))
  rmSync(w.home, { recursive: true, force: true })
  rmSync(w.cwd, { recursive: true, force: true })
}

console.log('§3 gateway posture (a re-pointed home lane owns its ids): unchanged — the id is admitted and sent')
{
  const w = mkHome('gateway', 'gateway')
  const before = turns().length
  const admitted = await run(w, ['run', '--model', BAD, '--', 'hi'])
  check('the run goes out to the gateway with the id as typed and completes (the turn and the leaving note both carry it)', admitted.code === 0 && /answered\.|Continued\.|Spare\./.test(admitted.out) && modelsSent(before).length >= 1 && modelsSent(before).every(m => m === BAD), `${admitted.code} · ${JSON.stringify(modelsSent(before))} · ${clip(admitted.err)}`)
  rmSync(w.home, { recursive: true, force: true })
  rmSync(w.cwd, { recursive: true, force: true })
}

console.log('§4 the decision is the router\'s own: the boot and the retention site read the same function')
{
  const router = readFileSync(join(REPO, 'src/services/providers/callModelRouter.ts'), 'utf8')
  const runSrc = readFileSync(join(REPO, 'src/cli/run.ts'), 'utf8')
  check('the router exports the before-any-request refusal over the same verdict and admission owner the call uses', /export async function modelRefusalBeforeAnyRequest\(model: string\)[\s\S]{0,400}classifyAfterLiveLists\(model\)[\s\S]{0,300}homeLaneAdmissionRefusal\(model\)/.test(router))
  check('the boot refuses a user-given --model before the stdio object and the session (the headless resolver carries the same before-any-request refusal)', runSrc.indexOf('resolveHeadlessModel(options.userSpecifiedModel)') !== -1 && runSrc.indexOf('resolveHeadlessModel(options.userSpecifiedModel)') < runSrc.indexOf('const io = new StructuredIO(') && /await modelRefusalBeforeAnyRequest\(model\)/.test(readFileSync(join(REPO, 'src/cli/headless/model.ts'), 'utf8')))
  check('the retention site skips a recorded model the resolver refuses and enqueues the notice naming the fallback (a recorded compat route refuses instead: never another provider)', /bootModel = await resolveHeadlessModel\(recorded\)\s*\n\s*setEngineModelOverride\(bootModel\)/.test(runSrc) && runSrc.includes("if (recorded.toLowerCase().startsWith('compat/')) {") && runSrc.includes("is not usable (${errorMessage(error)}) — this run uses ${getEngineModel()} instead."))
}

await api.close()
await new Promise<void>(resolve => proxy.close(() => resolve()))
console.log(failures === 0 ? '\nprove-refused-model-leaves-nothing: ALL LAWS HOLD' : `\nprove-refused-model-leaves-nothing: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
