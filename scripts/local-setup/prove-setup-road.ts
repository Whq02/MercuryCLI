#!/usr/bin/env bun
import '../lib/hermetic.ts'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
delete process.env.MERCURY_LOCAL_API_KEY
delete process.env.MERCURY_LOCAL_BASE_URL
delete process.env.MERCURY_LOCAL_PROBE_TARGETS
delete process.env.MERCURY_MODEL

const { proofHome } = await import('../lib/hermetic.ts')
const setup = await import('../../src/services/localSetup/index.ts')
const memory = await import('../../src/services/localServer/localServerMemory.ts')
const memory_truth = await import('../../src/services/localServer/localServerTruth.ts')
type LocalServerTruth = import('../../src/services/localServer/localServerTruth.ts').LocalServerTruth
const { localWindowSettingOf } = await import('../../src/services/providers/local/localWindow.ts')
const { enableConfigs } = await import('../../src/utils/config.ts')
enableConfigs()

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t)
}

const TAG = setup.SETUP_MODEL_TAG
const GIB = 1024 ** 3
const GB = 1000 ** 3
const WEIGHTS = 6594474711
const KV_LIST = [0, 0, 0, 4, 0, 0, 0, 4, 0, 0, 0, 4, 0, 0, 0, 4, 0, 0, 0, 4, 0, 0, 0, 4, 0, 0, 0, 4, 0, 0, 0, 4]
const HYBRID_INFO: Record<string, unknown> = {
  'general.architecture': 'qwen35',
  'general.parameter_count': 9653104368,
  'qwen35.attention.head_count': 16,
  'qwen35.attention.head_count_kv': KV_LIST,
  'qwen35.attention.key_length': 256,
  'qwen35.attention.value_length': 256,
  'qwen35.block_count': 32,
  'qwen35.context_length': 262144,
  'qwen35.embedding_length': 4096,
  'qwen35.full_attention_interval': 4,
}
const DENSE_INFO: Record<string, unknown> = {
  'general.architecture': 'qwen35',
  'qwen35.attention.head_count': 16,
  'qwen35.attention.head_count_kv': 8,
  'qwen35.attention.key_length': 256,
  'qwen35.attention.value_length': 256,
  'qwen35.block_count': 32,
  'qwen35.context_length': 262144,
  'qwen35.embedding_length': 4096,
}

type Hit = { method: string; url: string; body: string }
type Fixture = {
  server: Server
  root: string
  port: number
  state: { up: boolean; listed: string[]; info: Record<string, unknown>; pullError?: string }
  hits: Hit[]
  close: () => Promise<void>
}

function tagRow(name: string): Record<string, unknown> {
  return { name, model: name, modified_at: '2025-05-01T00:00:00Z', size: WEIGHTS, digest: '6488c96fa5faab64bb65cbd30d4289e20e6130ef535a93ef9a49f42eda893ea7', details: { parent_model: '', format: 'gguf', family: 'qwen35', families: ['qwen35'], parameter_size: '9.7B', quantization_level: 'Q4_K_M', context_length: 262144, embedding_length: 4096 }, capabilities: ['completion', 'vision', 'tools', 'thinking'] }
}

function ndjson(res: ServerResponse, rows: unknown[], gapMs: number): void {
  res.writeHead(200, { 'content-type': 'application/x-ndjson' })
  let i = 0
  const tick = (): void => {
    if (i >= rows.length) {
      res.end()
      return
    }
    res.write(`${JSON.stringify(rows[i++])}\n`)
    setTimeout(tick, gapMs)
  }
  tick()
}

function fixtureOllama(): Promise<Fixture> {
  const state: Fixture['state'] = { up: false, listed: [], info: HYBRID_INFO }
  const hits: Hit[] = []
  return new Promise(resolve => {
    const server = createServer((req, res) => {
      let body = ''
      req.on('data', chunk => {
        body += String(chunk)
      })
      req.on('end', () => {
        const url = req.url ?? ''
        const method = req.method ?? 'GET'
        hits.push({ method, url, body })
        if (!state.up) {
          req.socket.destroy()
          return
        }
        const json = (status: number, payload: unknown): void => {
          res.writeHead(status, { 'content-type': 'application/json' })
          res.end(JSON.stringify(payload))
        }
        if (url === '/api/version') return json(200, { version: '0.34.4' })
        if (url === '/api/tags') return json(200, { models: state.listed.map(tagRow) })
        if (url === '/api/ps') return json(200, { models: [] })
        if (url === '/api/show') {
          const model = String((JSON.parse(body || '{}') as { model?: string }).model ?? '')
          if (!state.listed.includes(model)) return json(404, { error: `model '${model}' not found` })
          return json(200, { capabilities: ['completion', 'vision', 'tools', 'thinking'], details: tagRow(model).details, model_info: state.info, parameters: 'top_p 0.95\ntemperature 1', template: '{{ .Prompt }}' })
        }
        if (url === '/api/pull' && method === 'POST') {
          const model = String((JSON.parse(body || '{}') as { model?: string }).model ?? '')
          if (state.pullError) return ndjson(res, [{ status: 'pulling manifest' }, { error: state.pullError }], 5)
          const digest = 'sha256:dec52a44569a2a25341c4e4d3fee25846eed4f6f0b936278e3a3c900bb99d37c'
          const rows = [
            { status: 'pulling manifest' },
            { status: `pulling ${digest.slice(7)}`, digest, total: WEIGHTS, completed: 241970 },
            { status: `pulling ${digest.slice(7)}`, digest, total: WEIGHTS, completed: 3297237356 },
            { status: `pulling ${digest.slice(7)}`, digest, total: WEIGHTS, completed: WEIGHTS },
            { status: 'verifying sha256 digest' },
            { status: 'writing manifest' },
            { status: 'success' },
          ]
          setTimeout(() => {
            if (!state.listed.includes(model)) state.listed.push(model)
          }, 5 * 20)
          return ndjson(res, rows, 20)
        }
        if (url === '/api/chat' && method === 'POST') {
          const parsed = JSON.parse(body || '{}') as { model?: string }
          const model = String(parsed.model ?? '')
          if (!state.listed.includes(model)) return json(404, { error: `model '${model}' not found` })
          const rows = [
            { model, created_at: '2025-05-01T00:00:00Z', message: { role: 'assistant', content: 'ready' }, done: false },
            { model, created_at: '2025-05-01T00:00:41Z', message: { role: 'assistant', content: '' }, done: true, done_reason: 'stop', total_duration: 41_000_000_000, load_duration: 5_200_000_000, prompt_eval_count: 14, prompt_eval_duration: 300_000_000, eval_count: 2, eval_duration: 200_000_000 },
          ]
          return ndjson(res, rows, 5)
        }
        if (url === '/api/generate' || url === '/v1/chat/completions' || url === '/api/create' || url === '/api/delete') return json(500, { error: `the proof must never call ${url}` })
        return json(404, { error: 'not found' })
      })
    })
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address !== null ? address.port : 0
      resolve({ server, root: `http://127.0.0.1:${port}`, port, state, hits, close: () => new Promise(r => server.close(() => r())) })
    })
  })
}

function sse(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}\n\n`
}

function fixtureLmStudio(): Promise<{ root: string; hits: Hit[]; close: () => Promise<void> }> {
  const hits: Hit[] = []
  return new Promise(resolve => {
    const server = createServer((req, res) => {
      let body = ''
      req.on('data', chunk => {
        body += String(chunk)
      })
      req.on('end', () => {
        const url = req.url ?? ''
        hits.push({ method: req.method ?? 'GET', url, body })
        if (url === '/api/v1/models') {
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ models: [{ type: 'llm', publisher: 'google', key: 'google/gemma-4-26b-a4b', display_name: 'Gemma 4 26B A4B', architecture: 'gemma4', size_bytes: 17990911801, params_string: '26B-A4B', loaded_instances: [{ id: 'google/gemma-4-26b-a4b', config: { context_length: 8192 } }], max_context_length: 131072, format: 'gguf', capabilities: { vision: true, trained_for_tool_use: true } }] }))
          return
        }
        if (url === '/v1/chat/completions') {
          const model = String((JSON.parse(body || '{}') as { model?: string }).model ?? '')
          res.writeHead(200, { 'content-type': 'text/event-stream' })
          res.write(sse({ id: 'chatcmpl-1', object: 'chat.completion.chunk', created: 1, model, choices: [{ index: 0, delta: { role: 'assistant', content: 'ready' }, finish_reason: null }] }))
          res.write(sse({ id: 'chatcmpl-1', object: 'chat.completion.chunk', created: 1, model, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }))
          res.write(sse({ id: 'chatcmpl-1', object: 'chat.completion.chunk', created: 1, model, choices: [], usage: { prompt_tokens: 9, completion_tokens: 1, total_tokens: 10 } }))
          res.write('data: [DONE]\n\n')
          res.end()
          return
        }
        res.writeHead(404, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: 'not found' }))
      })
    })
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address !== null ? address.port : 0
      resolve({ root: `http://127.0.0.1:${port}`, hits, close: () => new Promise(r => server.close(() => r())) })
    })
  })
}

type Machine = {
  platform: NodeJS.Platform
  onPath: Record<string, string>
  files: Set<string>
  execs: Array<{ file: string; args: string[]; detached: boolean }>
  onExec?: (file: string, args: string[]) => setup.ExecResult | undefined
}

const IN_PROCESS_DOOR: setup.SessionModelDoor = {
  carrier: 'in-process',
  setModel: async () => {
    throw new Error('the in-process door is never asked to set a model: the state setter settles it')
  },
}

type DaemonDoor = setup.SessionModelDoor & { asked: string[]; answer: setup.SessionSwitchReceipt }

function daemonDoor(answer: setup.SessionSwitchReceipt = { state: 'applied' }): DaemonDoor {
  const door: DaemonDoor = {
    carrier: 'daemon',
    asked: [],
    answer,
    setModel: async setting => {
      door.asked.push(String(setting))
      return door.answer
    },
  }
  return door
}

const OWNER_USABLE = Math.round(36.9 * GIB)
const OWNER_LOG_SOURCE = "the server's own gpu memory line in /fixture/home/.ollama/logs/server.log (Metal)"

function fixtureTruth(platform: NodeJS.Platform, totalMemoryBytes: number): LocalServerTruth {
  const machine = totalMemoryBytes === 51539607552 ? { platform, totalMemoryBytes, usableMemoryBytes: OWNER_USABLE, usableSource: OWNER_LOG_SOURCE } : memory_truth.defaultMachineTruth(platform, totalMemoryBytes)
  return { loaded: [], listed: [], runners: [], launchForm: { kind: 'unknown', note: 'fixture' }, machine, readAtMs: 0 }
}

function machineIo(m: Machine, fx: Fixture | undefined, extra: Partial<setup.SetupIo> = {}): setup.SetupIo {
  const totalMemoryBytes = extra.totalMemoryBytes ?? 51539607552
  return {
    env: { PATH: '/nowhere', ...(fx ? { MERCURY_LOCAL_PROBE_TARGETS: `ollama=${fx.root}` } : {}), ...(extra.env ?? {}) },
    platform: m.platform,
    home: '/fixture/home',
    configHome: proofHome,
    fetchImpl: globalThis.fetch,
    timeoutMs: 400,
    startWaitMs: 3_000,
    installWaitMs: 3_000,
    sleep: ms => new Promise(r => setTimeout(r, Math.min(ms, 20))),
    which: async name => m.onPath[name],
    exists: path => m.files.has(path),
    realpath: path => path,
    exec: async (file, args, opts) => {
      m.execs.push({ file, args, detached: opts?.detached === true })
      const answer = m.onExec?.(file, args)
      if (answer) return answer
      return { rc: 1, stdout: '', stderr: `fixture: ${file} ${args.join(' ')} not answered`, lastLine: 'not answered' }
    },
    totalMemoryBytes,
    parallelSlots: 1,
    readTruth: async () => fixtureTruth(m.platform, totalMemoryBytes),
    focusedConnector: () => IN_PROCESS_DOOR,
    ...extra,
  }
}

function bareMachine(platform: NodeJS.Platform = 'darwin'): Machine {
  return { platform, onPath: {}, files: new Set(), execs: [] }
}

const FIXTURE_BIN = '/fixture/bin/ollama'

function withBinary(m: Machine, fx: Fixture): Machine {
  m.onPath.ollama = FIXTURE_BIN
  m.onExec = (file, args) => {
    if (file === FIXTURE_BIN && args[0] === 'serve') {
      fx.state.up = true
      return { rc: 0, stdout: '', stderr: '', lastLine: 'pid 4242', pid: 4242, detached: true }
    }
    return undefined
  }
  return m
}

function stepEvents(events: setup.SetupEvent[]): string[] {
  return events.map(e => (e.type === 'step' ? `step ${e.plan.label}` : e.type === 'result' ? `result ${e.result.label} ${e.result.outcome}` : e.type === 'progress' ? `progress ${e.label}` : `done ${e.summary.reason}`))
}

async function walk(consent: setup.SetupConsentFn, io: setup.SetupIo): Promise<{ events: setup.SetupEvent[]; summary: setup.SetupSummary }> {
  const events: setup.SetupEvent[] = []
  const road = setup.runSetupRoad(consent, io)
  for (;;) {
    const next = await road.next()
    if (next.done) return { events, summary: next.value }
    events.push(next.value)
  }
}

section('§1 the base line: the module exists and freezes the names the command, the dialog and the drive import')
{
  const names = ['detectLocalServers', 'findOllamaInstall', 'planInstall', 'runInstall', 'waitForInstall', 'planStart', 'startServer', 'waitForOllama', 'pullModel', 'modelListed', 'chooseWindow', 'chooseWindowFrom', 'pickAndProve', 'runSetupRoad', 'summaryWords', 'ollamaRootOf', 'probeWords', 'resolveSetupIo', 'shellArgv', 'setupModelIdOf', 'pullProgressLine', 'windowWords', 'readOllamaVersion']
  for (const name of names) check(`index.ts exports ${name}`, typeof (setup as Record<string, unknown>)[name] === 'function')
  check('the tested tag and id', TAG === 'qwen3.5:9b' && setup.SETUP_MODEL_ID === 'local/qwen3.5:9b')
  check('the keys line', setup.SETUP_KEYS_LINE === '↵ run · s skip · esc stop')
  check('the ladder is 32k · 64k · 128k · 256k', setup.SETUP_WINDOW_LADDER.join(',') === '32768,65536,131072,262144')
  check('the docs table cites four roads (brew, dmg, script, exe)', setup.INSTALL_DOCS.map(d => d.via).sort().join(',') === 'brew,dmg,exe,script')
  for (const doc of setup.INSTALL_DOCS) check(`the ${doc.platform}/${doc.via} excerpt names its command's road`, doc.via === 'dmg' ? doc.excerpt.includes('Ollama.dmg') && doc.command.includes('Ollama.dmg') : doc.via === 'exe' ? doc.excerpt.includes('OllamaSetup.exe') && doc.command.includes('OllamaSetup.exe') : doc.via === 'script' ? doc.excerpt.includes('curl -fsSL https://ollama.com/install.sh | sh') && doc.command === 'curl -fsSL https://ollama.com/install.sh | sh' : doc.excerpt.includes('brew install ollama') && doc.command === 'brew install ollama', doc.excerpt)
}

section('§2 step 1 with nothing answering, step 2 with nothing installed, step 2b per platform')
{
  const fx = await fixtureOllama()
  const m = bareMachine('darwin')
  const io = machineIo(m, fx)
  const found = await setup.detectLocalServers(io)
  check('nothing answers ⇒ kind none', found.kind === 'none' && found.models.length === 0, JSON.stringify(found))
  check('the result row names the probed target', found.words.includes(fx.root) && found.words.startsWith('no local server answered'), found.words)
  check('the probe went only to the fixture (MERCURY_LOCAL_PROBE_TARGETS honoured)', fx.hits.length >= 1 && fx.hits.every(h => h.url.startsWith('/api/')), JSON.stringify(fx.hits))
  check('step 1 will-run line is the verbatim GET', setup.probeWords(io.env) === `GET ${fx.root}/api/tags`, setup.probeWords(io.env))
  check('probing off ⇒ no Ollama root', setup.ollamaRootOf({ MERCURY_LOCAL_PROBE_TARGETS: 'none' }) === undefined && setup.ollamaRootOf({}) === 'http://127.0.0.1:11434')
  const none = await setup.findOllamaInstall(io)
  check('nothing installed ⇒ found none, the looked list names PATH, the apps and brew', none.found === 'none' && none.looked.includes('ollama on PATH') && none.looked.includes('/Applications/Ollama.app') && none.looked.includes('/fixture/home/Applications/Ollama.app'), JSON.stringify(none))
  check('brew absent ⇒ brew list was not run', m.execs.length === 0, JSON.stringify(m.execs))
  m.onPath.brew = '/opt/homebrew/bin/brew'
  m.onExec = (file, args) => (file === '/opt/homebrew/bin/brew' && args[0] === 'list' ? { rc: 1, stdout: '', stderr: 'Error: No such keg: /opt/homebrew/Cellar/ollama', lastLine: 'Error: No such keg' } : undefined)
  const noneWithBrew = await setup.findOllamaInstall(io)
  check('brew present ⇒ brew list --formula ollama ran and said no', noneWithBrew.found === 'none' && m.execs.some(e => e.args.join(' ') === 'list --formula ollama'), JSON.stringify(m.execs))
  const brewPlan = await setup.planInstall('darwin', io)
  check('darwin with brew ⇒ brew install ollama, no sudo', brewPlan.via === 'brew' && brewPlan.command === 'brew install ollama' && !brewPlan.needsSudo && brewPlan.source.url.includes('formulae.brew.sh') && brewPlan.source.excerpt.includes('brew install ollama'), JSON.stringify(brewPlan))
  delete m.onPath.brew
  const dmgPlan = await setup.planInstall('darwin', io)
  check('darwin without brew ⇒ the dmg download opened for the user', dmgPlan.via === 'dmg' && dmgPlan.command === 'curl -fsSL -o ~/Downloads/Ollama.dmg https://ollama.com/download/Ollama.dmg && open ~/Downloads/Ollama.dmg' && !dmgPlan.needsSudo && dmgPlan.waitsFor === '/Applications/Ollama.app' && dmgPlan.source.excerpt.includes('drag-and-drop'), JSON.stringify(dmgPlan))
  const linuxPlan = await setup.planInstall('linux', io)
  check('linux ⇒ the install script, sudo said', linuxPlan.via === 'script' && linuxPlan.command === 'curl -fsSL https://ollama.com/install.sh | sh' && linuxPlan.needsSudo && linuxPlan.says.some(s => s.includes('sudo')) && linuxPlan.source.excerpt.includes('To install Ollama, run the following command'), JSON.stringify(linuxPlan))
  const winPlan = await setup.planInstall('win32', io)
  check('win32 ⇒ OllamaSetup.exe downloaded then started, the dialog waits for ollama app.exe', winPlan.via === 'exe' && winPlan.command.includes('https://ollama.com/download/OllamaSetup.exe') && winPlan.command.includes('start "" "%TEMP%\\OllamaSetup.exe"') && !winPlan.needsSudo && winPlan.waitsFor.endsWith('\\Programs\\Ollama\\ollama app.exe'), JSON.stringify(winPlan))
  check('every install plan cites a docs url and a verbatim excerpt', [brewPlan, dmgPlan, linuxPlan, winPlan].every(p => p.source.url.startsWith('https://') && p.source.excerpt.length > 40))
  check('the fixture never saw a pull, a load or a chat', !fx.hits.some(h => ['/api/pull', '/api/generate', '/api/chat', '/v1/chat/completions'].includes(h.url)), JSON.stringify(fx.hits.map(h => h.url)))
  await fx.close()
}

section('§3 step 2 finds the binary per form, step 3 plans the start per form and waits on /api/version')
{
  const fx = await fixtureOllama()
  const m = withBinary(bareMachine('darwin'), fx)
  const io = machineIo(m, fx)
  const onPath = await setup.findOllamaInstall(io)
  check('the binary on PATH ⇒ form path with its path', onPath.found === 'path' && onPath.where === FIXTURE_BIN, JSON.stringify(onPath))
  const pathStart = await setup.planStart(onPath, io)
  check('path ⇒ `<where> serve` detached with a log under the config home', pathStart.form === 'path' && pathStart.argv.join(' ') === `${FIXTURE_BIN} serve` && pathStart.detached && pathStart.logPath === join(proofHome, 'local-setup', 'ollama-serve.log') && pathStart.command.startsWith(`${FIXTURE_BIN} serve`) && pathStart.waitUrl === `${fx.root}/api/version` && !pathStart.needsSudo, JSON.stringify(pathStart))
  check('the plan reads /api/version and says nothing is up yet', pathStart.alreadyUp === undefined)
  const appM = bareMachine('darwin')
  appM.files.add('/Applications/Ollama.app')
  const app = await setup.findOllamaInstall(machineIo(appM, fx))
  const appStart = await setup.planStart(app, machineIo(appM, fx))
  check('the app ⇒ open -a Ollama', app.found === 'app' && app.where === '/Applications/Ollama.app' && appStart.command === 'open -a Ollama' && appStart.argv.join(' ') === 'open -a Ollama' && !appStart.detached, JSON.stringify({ app, appStart }))
  const symlinkM = bareMachine('darwin')
  symlinkM.onPath.ollama = '/usr/local/bin/ollama'
  const symlinkIo = machineIo(symlinkM, fx, { realpath: () => '/Applications/Ollama.app/Contents/Resources/ollama' })
  const viaSymlink = await setup.findOllamaInstall(symlinkIo)
  check('a PATH symlink into the app bundle is the app form', viaSymlink.found === 'app' && viaSymlink.where === '/Applications/Ollama.app', JSON.stringify(viaSymlink))
  const brewM = bareMachine('darwin')
  brewM.onPath.brew = '/opt/homebrew/bin/brew'
  brewM.onExec = (file, args) => (file === '/opt/homebrew/bin/brew' && args[0] === 'list' ? { rc: 0, stdout: '/opt/homebrew/Cellar/ollama/0.34.4/bin/ollama\n/opt/homebrew/Cellar/ollama/0.34.4/README.md\n', stderr: '', lastLine: '' } : undefined)
  const brewIo = machineIo(brewM, fx)
  const brew = await setup.findOllamaInstall(brewIo)
  const brewStart = await setup.planStart(brew, brewIo)
  check('brew list ⇒ form brew, start via brew services', brew.found === 'brew' && brew.where === '/opt/homebrew/Cellar/ollama/0.34.4/bin/ollama' && brewStart.command === 'brew services start ollama' && brewStart.argv.join(' ') === '/opt/homebrew/bin/brew services start ollama', JSON.stringify({ brew, brewStart }))
  const noBrewStart = await setup.planStart(brew, machineIo(bareMachine('darwin'), fx))
  check('brew form with brew gone from PATH ⇒ the binary serves detached', noBrewStart.detached && noBrewStart.argv.join(' ') === '/opt/homebrew/Cellar/ollama/0.34.4/bin/ollama serve', JSON.stringify(noBrewStart))
  const linuxM = bareMachine('linux')
  linuxM.onPath.systemctl = '/usr/bin/systemctl'
  linuxM.onExec = (file, args) => (file === '/usr/bin/systemctl' && args.join(' ') === 'status ollama' ? { rc: 3, stdout: '● ollama.service - Ollama Service\n   Active: inactive (dead)', stderr: '', lastLine: 'Active: inactive (dead)' } : undefined)
  const linuxIo = machineIo(linuxM, fx)
  const systemd = await setup.findOllamaInstall(linuxIo)
  const systemdStart = await setup.planStart(systemd, linuxIo)
  check('linux systemd unit ⇒ sudo systemctl start ollama, sudo said', systemd.found === 'systemd' && systemdStart.command === 'sudo systemctl start ollama' && systemdStart.needsSudo && systemdStart.says.some(s => s.includes('sudo')), JSON.stringify({ systemd, systemdStart }))
  const usrM = bareMachine('linux')
  usrM.files.add('/usr/local/bin/ollama')
  const usr = await setup.findOllamaInstall(machineIo(usrM, fx))
  check('linux /usr/local/bin/ollama with no unit ⇒ form path', usr.found === 'path' && usr.where === '/usr/local/bin/ollama', JSON.stringify(usr))
  const winM = bareMachine('win32')
  const winExe = 'C:\\Users\\owner\\AppData\\Local\\Programs\\Ollama\\ollama app.exe'
  winM.files.add(winExe)
  const winIo = machineIo(winM, fx, { env: { PATH: '', LOCALAPPDATA: 'C:\\Users\\owner\\AppData\\Local', MERCURY_LOCAL_PROBE_TARGETS: `ollama=${fx.root}` } })
  const win = await setup.findOllamaInstall(winIo)
  const winStart = await setup.planStart(win, winIo)
  check('windows ⇒ ollama app.exe under %LOCALAPPDATA%, started with start ""', win.found === 'windows' && win.where === winExe && winStart.command === `start "" "${winExe}"` && winStart.argv[0] === 'cmd.exe', JSON.stringify({ win, winStart }))
  check('nothing was run while planning (plans only read /api/version)', m.execs.length === 0 && appM.execs.length === 0 && winM.execs.length === 0 && fx.hits.every(h => h.url === '/api/version'), JSON.stringify(fx.hits.map(h => h.url)))
  const started = await setup.startServer(pathStart, io)
  check('startServer runs the detached serve through the exec seam and waits for /api/version', started.up && started.version === '0.34.4' && started.rc === 0 && m.execs.some(e => e.file === FIXTURE_BIN && e.args[0] === 'serve' && e.detached), JSON.stringify({ started, execs: m.execs }))
  fx.state.up = false
  const waited = await setup.waitForOllama(fx.root, { ...io, startWaitMs: 300 })
  check('a server that never answers ⇒ up false within the bound', !waited.up && waited.rc === 1 && waited.words.includes('no answer'), JSON.stringify(waited))
  fx.state.up = true
  const upPlan = await setup.planStart(onPath, io)
  check('a server already answering is said in the plan (s skips)', upPlan.alreadyUp === 'Ollama 0.34.4', JSON.stringify(upPlan))
  await fx.close()
}

section('§4 step 4: the pull streams three progress rows then success; s-skip when the tag is listed')
{
  const fx = await fixtureOllama()
  fx.state.up = true
  const io = machineIo(bareMachine(), fx)
  check('the tag is not listed before the pull', (await setup.modelListed(fx.root, TAG, io)) === false)
  const rows: setup.PullProgress[] = []
  const pulled = await setup.pullModel(fx.root, TAG, p => rows.push(p), io)
  const pullHit = fx.hits.find(h => h.url === '/api/pull')
  check('POST /api/pull carried {"model":"qwen3.5:9b","stream":true}', pullHit?.method === 'POST' && pullHit.body === JSON.stringify({ model: TAG, stream: true }), pullHit?.body)
  check('success with the size from the first total', pulled.success && pulled.totalBytes === WEIGHTS && pulled.rows === 7 && pulled.words === `${TAG}: success · 6.6 GB · 7 rows`, JSON.stringify(pulled))
  const digestRows = rows.filter(r => r.digest !== undefined)
  check('three digest rows with completed/total and a percent', digestRows.length === 3 && digestRows.map(r => r.percent).join(',') === '0,50,100', JSON.stringify(digestRows.map(r => r.line)))
  check('the progress line reads as one updating row', digestRows[1]!.line === 'pulling dec52a44 50% · 3.3 GB of 6.6 GB' && rows[0]!.line === 'pulling manifest' && rows[rows.length - 1]!.line === 'success', JSON.stringify(rows.map(r => r.line)))
  check('the tag is listed after the pull', (await setup.modelListed(fx.root, TAG, io)) === true)
  fx.state.pullError = 'pull model manifest: file does not exist'
  const refused = await setup.pullModel(fx.root, 'nobody:latest', () => {}, io)
  check('an error row is a typed failure, never success', !refused.success && refused.error === 'pull model manifest: file does not exist', JSON.stringify(refused))
  await fx.close()
}

section('§5 step 5: the window from this machine\'s memory — the one fit owner (localWindowFit) over the ladder, the ceiling from the truth reader')
{
  const geometry = memory.kvGeometryOf(HYBRID_INFO)!
  check('the 9B geometry as /api/show states it: 8 attention layers × 4 KV heads, 32 KiB per token at f16', geometry.kvHeads === 32 && geometry.attentionLayers === 8 && memory.kvBytesPerToken(geometry) === 32768, JSON.stringify(geometry))
  const dense = memory.kvGeometryOf(DENSE_INFO)!
  check('a dense reading of the same numbers: every layer holds KV, 256 KiB per token', dense.kvHeads === 256 && memory.kvBytesPerToken(dense) === 262144, JSON.stringify(dense))
  const usableOf = (machineBytes: number): number => fixtureTruth('darwin', machineBytes).machine.usableMemoryBytes
  const pick = (machineBytes: number, g: typeof geometry): setup.WindowChoice => setup.chooseWindowFrom({ tag: TAG, weightsBytes: WEIGHTS, geometry: g, trainedMax: 262144, machineBytes, usableBytes: usableOf(machineBytes), usableSource: fixtureTruth('darwin', machineBytes).machine.usableSource, slots: 1 })
  const hybrid = { box8: pick(8 * GB, geometry), box12: pick(12 * GB, geometry), box16: pick(16 * GB, geometry), box48: pick(51539607552, geometry), box96: pick(96 * GB, geometry) }
  check('hybrid 9B on an 8 GB box (5.6 GiB usable by the Metal rule): nothing fits, 32k is the floor and says so', hybrid.box8.window === 32768 && !hybrid.box8.fits && hybrid.box8.words === '32k · 6.1 GiB weights + 1.0 GiB cache — 7.1 GiB does not fit in 5.6 GiB usable (7.5 GiB box) · f16 · 1 slot', hybrid.box8.words)
  check('hybrid 9B on a 12 GB box (8.4 GiB usable): 64k, and the words say 128k does not fit', hybrid.box12.window === 65536 && hybrid.box12.fits && hybrid.box12.words === '64k · 6.1 GiB weights + 2.0 GiB cache of 8.4 GiB usable (11.2 GiB box) · f16 · 1 slot · 128k does not fit (10.1 GiB)', hybrid.box12.words)
  check('hybrid 9B on a 16 GB box (11.2 GiB usable): 128k', hybrid.box16.window === 131072 && hybrid.box16.fits && hybrid.box16.words.startsWith('128k · 6.1 GiB weights + 4.0 GiB cache of 11.2 GiB usable (14.9 GiB box) · f16 · 1 slot · 256k does not fit'), hybrid.box16.words)
  check("hybrid 9B on this 48 GiB box: 256k (14.1 GiB of 36.9 GiB usable — the server's own gpu memory line, not a fraction)", hybrid.box48.window === 262144 && hybrid.box48.fits && hybrid.box48.words === '256k · 6.1 GiB weights + 8.0 GiB cache of 36.9 GiB usable (48.0 GiB box) · f16 · 1 slot' && hybrid.box48.usableSource === OWNER_LOG_SOURCE, hybrid.box48.words)
  check('hybrid 9B on a 96 GB box: 256k', hybrid.box96.window === 262144 && hybrid.box96.fits, hybrid.box96.words)
  const denseLadder = { box16: pick(16 * GB, dense), box52: pick(52 * GB, dense), box96: pick(96 * GB, dense) }
  check('dense 9B on a 16 GB box: 32k (the floor; 14.1 GiB does not fit 11.2 GiB usable)', denseLadder.box16.window === 32768 && !denseLadder.box16.fits && denseLadder.box16.words.includes('14.1 GiB does not fit in 11.2 GiB usable'), denseLadder.box16.words)
  check('dense 9B on a 52 GB box (36.3 GiB usable): 64k — 128k would be 38.1 GiB', denseLadder.box52.window === 65536 && denseLadder.box52.fits && denseLadder.box52.words === '64k · 6.1 GiB weights + 16.0 GiB cache of 36.3 GiB usable (48.4 GiB box) · f16 · 1 slot · 128k does not fit (38.1 GiB)', denseLadder.box52.words)
  check('dense 9B on a 96 GB box (67.1 GiB usable): 128k — 256k would be 70.1 GiB', denseLadder.box96.window === 131072 && denseLadder.box96.fits && denseLadder.box96.words.endsWith('· 256k does not fit (70.1 GiB)'), denseLadder.box96.words)
  for (const [name, choice] of Object.entries({ ...hybrid, ...denseLadder })) {
    const next = choice.ladder.find(r => r.window > choice.window)
    const chosenFits = choice.totalBytes <= choice.usableBytes
    const nextFits = next === undefined ? false : next.totalBytes <= choice.usableBytes
    const projected = memory.projectLoad({ name: TAG, weightsBytes: WEIGHTS, geometry: choice.geometry }, choice.window, 1, 'f16').totalBytes
    check(`${name}: the chosen rung fits the ceiling and the next rung does not, by the memory module's own projectLoad (${choice.words})`, (choice.fits ? chosenFits : !chosenFits) && !nextFits && projected === choice.totalBytes)
  }
  const capped = setup.chooseWindowFrom({ tag: TAG, weightsBytes: WEIGHTS, geometry, trainedMax: 40960, machineBytes: 96 * GB, usableBytes: usableOf(96 * GB), slots: 1 })
  check('never above the trained maximum: a 40k-trained model gets 32k', capped.window === 32768 && capped.ladder.length === 1, JSON.stringify(capped.ladder))
  const slots4 = setup.chooseWindowFrom({ tag: TAG, weightsBytes: WEIGHTS, geometry, trainedMax: 262144, machineBytes: 16 * GB, usableBytes: usableOf(16 * GB), slots: 4 })
  check('slots multiply the cache: 4 slots on 16 GB ⇒ 32k', slots4.window === 32768 && slots4.fits && slots4.words.includes('· f16 · 4 slots'), slots4.words)
  const q8 = setup.chooseWindowFrom({ tag: TAG, weightsBytes: WEIGHTS, geometry, trainedMax: 262144, machineBytes: 51539607552, usableBytes: OWNER_USABLE, slots: 1, cacheType: 'q8_0' })
  check("the owner's own cache type: q8_0 halves the cache — 256k · 6.1 GiB weights + 4.3 GiB cache of 36.9 GiB usable (48.0 GiB box) · q8_0 · 1 slot", q8.window === 262144 && q8.words === '256k · 6.1 GiB weights + 4.3 GiB cache of 36.9 GiB usable (48.0 GiB box) · q8_0 · 1 slot', q8.words)
  const fx = await fixtureOllama()
  fx.state.up = true
  fx.state.listed = [TAG]
  const written: Array<[string, number]> = []
  const io = machineIo(bareMachine(), fx, { writeWindow: (tag, window) => written.push([tag, window]) })
  const chosen = await setup.chooseWindow(fx.root, TAG, io)
  check("chooseWindow reads /api/tags and /api/show, the ceiling through the truth seam, and writes through the window seam", chosen.window === 262144 && chosen.trainedMax === 262144 && chosen.weightsBytes === WEIGHTS && chosen.usableSource === OWNER_LOG_SOURCE && written.length === 1 && written[0]![0] === TAG && written[0]![1] === 262144 && fx.hits.some(h => h.url === '/api/show' && h.body === JSON.stringify({ model: TAG })), JSON.stringify({ chosen: chosen.words, written }))
  const real = await setup.chooseWindow(fx.root, TAG, { ...io, writeWindow: undefined, totalMemoryBytes: 16 * GB, readTruth: async () => fixtureTruth('darwin', 16 * GB) })
  check('with the default writer the per-model window setting reads back through localWindow.ts', real.window === 131072 && localWindowSettingOf({ id: TAG }) === 131072, String(localWindowSettingOf({ id: TAG })))
  const runner = await setup.chooseWindow(fx.root, TAG, { ...io, parallelSlots: undefined, readTruth: async () => ({ ...fixtureTruth('darwin', 51539607552), runners: [{ command: 'llama-server -np 4 --cache-type-k q8_0', slots: 4, cacheTypeK: 'q8_0' }] }) })
  check("with no slots asked through the seam the runner's -np and -ctk decide: 4 slots at q8_0 ⇒ 256k, 17.0 GiB cache", runner.window === 262144 && runner.slots === 4 && runner.cacheType === 'q8_0' && runner.words === '256k · 6.1 GiB weights + 17.0 GiB cache of 36.9 GiB usable (48.0 GiB box) · q8_0 · 4 slots', runner.words)
  const homeFiles = readdirSync(proofHome)
  const configFile = homeFiles.find(f => f.endsWith('.json') && readFileSync(join(proofHome, f), 'utf8').includes('"local/qwen3.5:9b"'))
  check('the setting lives in the scratch config home, under the local/ key', configFile !== undefined, homeFiles.join(', '))
  let failedWords = ''
  try {
    await setup.chooseWindow(fx.root, 'nobody:latest', io)
  } catch (error) {
    failedWords = error instanceof Error ? error.message : String(error)
  }
  check('an unlisted tag is a typed failure', failedWords === `nobody:latest is not listed by ${fx.root}/api/tags`, failedWords)
  check('nothing touched the server\'s environment or loaded a model', !fx.hits.some(h => h.url === '/api/generate' || h.url === '/api/chat'), JSON.stringify(fx.hits.map(h => h.url)))
  await fx.close()
}

section('§6 step 6: the model is set through /model\'s road and one bounded native turn answers ready')
{
  const fx = await fixtureOllama()
  fx.state.up = true
  fx.state.listed = [TAG]
  const slice: setup.SessionModelSlice = { mainLoopModel: null, mainLoopModelForSession: null, pendingModelSwitch: null, foregroundTurnActive: false }
  const persisted: string[] = []
  const io: setup.ProveIo = { ...machineIo(bareMachine(), fx, { setAppState: updater => Object.assign(slice, updater(slice)), persist: setting => (persisted.push(setting), { sentence: ' · saved as your default' }) }), root: fx.root, server: 'ollama' }
  const proved = await setup.pickAndProve(TAG, io)
  check('the session model is local/qwen3.5:9b, applied', proved.model === 'local/qwen3.5:9b' && proved.settled === 'applied' && slice.mainLoopModel === 'local/qwen3.5:9b' && slice.lastModelTransition?.applied === 'local/qwen3.5:9b', JSON.stringify({ proved: proved.model, settled: proved.settled, slice }))
  check('the choice is persisted the way /model persists it', persisted.join(',') === 'local/qwen3.5:9b' && proved.saved === ' · saved as your default')
  check('the fixture reply "ready" is the first line', proved.ok && proved.firstLine === 'ready', JSON.stringify(proved))
  const chat = fx.hits.find(h => h.url === '/api/chat')
  const body = JSON.parse(chat?.body ?? '{}') as { model?: string; stream?: boolean; think?: boolean; messages?: Array<{ role: string; content: string }>; options?: { num_ctx?: number; num_predict?: number } }
  check('the turn went on the native road: POST /api/chat, stream, think false, the fixed prompt, bounded', chat?.method === 'POST' && body.model === TAG && body.stream === true && body.think === false && body.messages?.[0]?.content === setup.SETUP_PROVE_PROMPT && body.options?.num_predict === setup.SETUP_PROVE_MAX_TOKENS, chat?.body)
  check('num_ctx is the window setting step 5 wrote (128k in this home)', body.options?.num_ctx === 131072 && proved.window === 131072, JSON.stringify(body.options))
  const willRun = setup.proveWillRun(setup.proveRecordFor(TAG, fx.root, 'ollama')!)
  check('the will-run line IS the body that was sent, byte for byte', willRun === `/model local/qwen3.5:9b · POST ${fx.root}/api/chat ${chat?.body ?? ''}`, `${willRun}\n${chat?.body}`)
  check('the timings come from the done row: load 5.2 s, 14 prompt tokens in 0.3 s, 2 reply tokens', proved.timings.loadMs === 5200 && proved.timings.promptTokens === 14 && proved.timings.promptMs === 300 && proved.timings.evalTokens === 2 && proved.timings.evalMs === 200 && proved.timings.totalMs >= 0, JSON.stringify(proved.timings))
  check('the ready row', /^ready · local\/qwen3\.5:9b · 128k window · reply in [\d.]+ s$/.test(proved.words), proved.words)
  check('no /api/generate load and no /v1 road', !fx.hits.some(h => h.url === '/api/generate' || h.url === '/v1/chat/completions'), JSON.stringify(fx.hits.map(h => h.url)))
  const busy: setup.SessionModelSlice = { mainLoopModel: 'claude-fixture', mainLoopModelForSession: null, pendingModelSwitch: null, foregroundTurnActive: true }
  const queued = await setup.pickAndProve(TAG, { ...io, setAppState: updater => Object.assign(busy, updater(busy)) })
  check('a running turn queues the switch, as /model does', queued.settled === 'queued' && busy.pendingModelSwitch?.setting === 'local/qwen3.5:9b' && busy.mainLoopModel === 'claude-fixture', JSON.stringify(busy))
  const headless = await setup.pickAndProve(TAG, { ...io, setAppState: undefined })
  check('with no store the settle is unavailable and the setting is still saved', headless.settled === 'unavailable' && headless.settledBy === 'none' && headless.ok && persisted.length === 3)
  check('the in-process legs above went through the state setter, never a door', proved.settledBy === 'in-process' && queued.settledBy === 'in-process')
  await fx.close()
}

section('§6b the session door: a daemon-carried session switches through its connector\'s setModel, as /model does — never the screen\'s state')
{
  const fx = await fixtureOllama()
  fx.state.up = true
  fx.state.listed = [TAG]
  const untouched: setup.SessionModelSlice = { mainLoopModel: 'claude-fixture', mainLoopModelForSession: null, pendingModelSwitch: null, foregroundTurnActive: false }
  let stateSets = 0
  const persisted: string[] = []
  const door = daemonDoor()
  const io: setup.ProveIo = {
    ...machineIo(bareMachine(), fx, {
      focusedConnector: () => door,
      setAppState: updater => {
        stateSets++
        Object.assign(untouched, updater(untouched))
      },
      persist: setting => (persisted.push(setting), { sentence: ' · saved as your default' }),
    }),
    root: fx.root,
    server: 'ollama',
  }
  const applied = await setup.pickAndProve(TAG, io)
  check('the daemon door was asked to set local/qwen3.5:9b, once', door.asked.join(',') === 'local/qwen3.5:9b', JSON.stringify(door.asked))
  check('the receipt is the daemon\'s word: applied, by the daemon', applied.settled === 'applied' && applied.settledBy === 'daemon' && applied.settledDetail === undefined, JSON.stringify({ settled: applied.settled, by: applied.settledBy }))
  check('the screen\'s state was never settled (the session owns the model)', stateSets === 0 && untouched.mainLoopModel === 'claude-fixture' && untouched.pendingModelSwitch === null, JSON.stringify(untouched))
  check('the choice is persisted after an applied receipt, as /model persists it', persisted.join(',') === 'local/qwen3.5:9b' && applied.saved === ' · saved as your default')
  check('the turn still ran and answered ready', applied.ok && applied.firstLine === 'ready' && fx.hits.filter(h => h.url === '/api/chat').length === 1)
  door.answer = { state: 'queued' }
  const queued = await setup.pickAndProve(TAG, io)
  check('a busy session answers queued, and the choice is still saved', queued.settled === 'queued' && queued.settledBy === 'daemon' && persisted.length === 2)
  door.answer = { state: 'applied', note: 'runner had exited — restarted on local/qwen3.5:9b' }
  const noted = await setup.pickAndProve(TAG, io)
  check('an applied receipt with a note carries the note as the settle detail', noted.settled === 'applied' && noted.settledDetail === 'runner had exited — restarted on local/qwen3.5:9b')
  door.answer = { state: 'no-op' }
  const same = await setup.pickAndProve(TAG, io)
  check('already on the model answers no-op', same.settled === 'no-op' && same.settledBy === 'daemon')
  door.answer = { state: 'refused', detail: 'no chat is open' }
  const refused = await setup.pickAndProve(TAG, io)
  check('a refusal is the receipt\'s word and nothing is persisted (the /model law)', refused.settled === 'refused' && refused.settledBy === 'daemon' && refused.settledDetail === 'no chat is open' && refused.saved === '' && persisted.length === 4, JSON.stringify({ refused: refused.settled, detail: refused.settledDetail, persisted }))
  check('a refused switch still proves the model (the reply is the server\'s fact, the switch is the session\'s)', refused.ok && refused.firstLine === 'ready')
  const throwing: setup.SessionModelDoor = {
    carrier: 'daemon',
    setModel: async () => {
      throw new Error('the daemon is not answering')
    },
  }
  const thrown = await setup.pickAndProve(TAG, { ...io, focusedConnector: () => throwing })
  check('a door that throws is a refusal in its own words, never a crash', thrown.settled === 'refused' && thrown.settledDetail === 'the daemon is not answering' && thrown.saved === '')
  const noDoor = await setup.pickAndProve(TAG, {
    ...io,
    focusedConnector: () => {
      throw new Error('no connector here')
    },
  })
  check('a seam that cannot resolve a door refuses too', noDoor.settled === 'refused' && noDoor.settledBy === 'none' && (noDoor.settledDetail ?? '').startsWith('no session door'))
  const bare = await setup.switchSessionModel('local/qwen3.5:9b', { focusedConnector: () => door })
  check('switchSessionModel alone: the daemon arm needs no state setter', bare.settled === 'refused' && door.asked.length === 6, JSON.stringify(bare))
  await fx.close()
}

section('§7 the road: a skip at step 4 skips the pull and continues; every consent is asked before anything runs')
{
  const fx = await fixtureOllama()
  fx.state.listed = [TAG]
  const m = withBinary(bareMachine('darwin'), fx)
  const slice: setup.SessionModelSlice = { mainLoopModel: null, mainLoopModelForSession: null, pendingModelSwitch: null, foregroundTurnActive: false }
  const asked: string[] = []
  const io = machineIo(m, fx, { setAppState: updater => Object.assign(slice, updater(slice)), persist: () => ({ sentence: '' }) })
  const { events, summary } = await walk(plan => {
    asked.push(plan.label)
    return plan.label === '4' ? 'skip' : 'run'
  }, io)
  const shape = stepEvents(events)
  check('the walk: 1 (nothing) · 2 (binary found) · 3 (started) · 4 skipped · 5 · 6', shape.filter(s => !s.startsWith('progress')).join(' | ') === 'step 1 | result 1 ran | step 2 | result 2 ran | step 3 | result 3 ran | step 4 | result 4 skipped | step 5 | result 5 ran | step 6 | result 6 ran | done finished', shape.join(' | '))
  check('every step asked before it ran', asked.join(',') === '1,2,3,4,5,6')
  check('step 4 said the tag is already listed (s skips)', events.some(e => e.type === 'step' && e.plan.label === '4' && e.plan.found.includes('already listed') && e.plan.willRun === `POST ${fx.root}/api/pull {"model":"qwen3.5:9b","stream":true}`))
  check('no pull was sent', !fx.hits.some(h => h.url === '/api/pull'))
  check('the summary: done 1, 2, 3, 5, 6 · skipped 4 · ready', summary.ran.join(',') === '1,2,3,5,6' && summary.skipped.join(',') === '4' && summary.notDone.length === 0 && summary.reason === 'finished' && summary.ready?.ok === true && summary.model === 'local/qwen3.5:9b' && summary.words.startsWith('done: 1, 2, 3, 5, 6 · skipped: 4 · ready · local/qwen3.5:9b · 256k window · reply in '), summary.words)
  const plans = events.filter((e): e is Extract<setup.SetupEvent, { type: 'step' }> => e.type === 'step').map(e => e.plan)
  check('every step carries the three lines: found, willRun, keys', plans.every(p => p.found.length > 0 && p.willRun.length > 0 && p.keys === setup.SETUP_KEYS_LINE) && plans.length === 6)
  check('step 3 will-run is the detached serve; step 5 names the show and the setting key; step 6 names /model and /api/chat with num_ctx', plans[2]!.willRun.startsWith(`${FIXTURE_BIN} serve (detached, log `) && plans[4]!.willRun.includes(`POST ${fx.root}/api/show {"model":"qwen3.5:9b"}`) && plans[4]!.willRun.includes('localModelWindows["local/qwen3.5:9b"]') && plans[5]!.willRun.startsWith('/model local/qwen3.5:9b · POST ') && plans[5]!.willRun.includes('"num_ctx":262144'), plans.map(p => p.willRun).join('\n'))
  check('the session model was set by step 6', slice.mainLoopModel === 'local/qwen3.5:9b')
  await fx.close()
}

section('§8 the road: stop at step 3 ends with steps 1–2 done, 3–6 not; nothing started')
{
  const fx = await fixtureOllama()
  const m = withBinary(bareMachine('darwin'), fx)
  const io = machineIo(m, fx)
  const { events, summary } = await walk(plan => (plan.label === '3' ? 'stop' : 'run'), io)
  check('the events end at step 3 with done', stepEvents(events).join(' | ') === 'step 1 | result 1 ran | step 2 | result 2 ran | step 3 | done stopped', stepEvents(events).join(' | '))
  check('the summary names 1–2 done and 3–6 not', summary.reason === 'stopped' && summary.stoppedAt === '3' && summary.ran.join(',') === '1,2' && summary.notDone.join(',') === '3,4,5,6' && summary.words === 'stopped at step 3 · done: 1, 2 · not done: 3, 4, 5, 6', summary.words)
  check('nothing was started or pulled', m.execs.length === 0 && !fx.state.up && !fx.hits.some(h => h.url === '/api/pull'), JSON.stringify(m.execs))
  await fx.close()
}

section('§9 the road end to end: install offered, run through the seam, then start, pull, window, prove')
{
  const fx = await fixtureOllama()
  const m = bareMachine('darwin')
  m.onPath.brew = '/opt/homebrew/bin/brew'
  const cellar = '/opt/homebrew/Cellar/ollama/0.34.4/bin/ollama'
  let installed = false
  m.onExec = (file, args) => {
    if (file === '/opt/homebrew/bin/brew' && args[0] === 'list') return installed ? { rc: 0, stdout: `${cellar}\n`, stderr: '', lastLine: '' } : { rc: 1, stdout: '', stderr: 'Error: No such keg', lastLine: 'Error: No such keg' }
    if (file === '/bin/sh' && args[0] === '-c' && args[1] === 'brew install ollama') {
      installed = true
      m.onPath.ollama = cellar
      return { rc: 0, stdout: '==> Pouring ollama--0.34.4.arm64_sequoia.bottle.tar.gz\n🍺  /opt/homebrew/Cellar/ollama/0.34.4: 8 files, 42MB', stderr: '', lastLine: '🍺  /opt/homebrew/Cellar/ollama/0.34.4: 8 files, 42MB' }
    }
    if (file === '/opt/homebrew/bin/brew' && args.join(' ') === 'services start ollama') {
      fx.state.up = true
      return { rc: 0, stdout: '==> Successfully started `ollama` (label: homebrew.mxcl.ollama)', stderr: '', lastLine: '==> Successfully started `ollama` (label: homebrew.mxcl.ollama)' }
    }
    return undefined
  }
  const slice: setup.SessionModelSlice = { mainLoopModel: 'claude-fixture', mainLoopModelForSession: null, pendingModelSwitch: null, foregroundTurnActive: false }
  const door = daemonDoor()
  const io = machineIo(m, fx, { focusedConnector: () => door, setAppState: updater => Object.assign(slice, updater(slice)), persist: () => ({ sentence: '' }), realpath: p => p })
  const { events, summary } = await walk(() => 'run', io)
  const shape = stepEvents(events)
  check('the walk: 1 · 2 (none) · 2b (brew install) · 3 (brew services start) · 4 (pull) · 5 · 6', shape.filter(s => !s.startsWith('progress')).join(' | ') === 'step 1 | result 1 ran | step 2 | result 2 ran | step 2b | result 2b ran | step 3 | result 3 ran | step 4 | result 4 ran | step 5 | result 5 ran | step 6 | result 6 ran | done finished', shape.join(' | '))
  check('on a daemon-carried session the road switches through the session door, not the screen state', door.asked.join(',') === 'local/qwen3.5:9b' && slice.mainLoopModel === 'claude-fixture', JSON.stringify({ asked: door.asked, slice }))
  const step2b = events.find((e): e is Extract<setup.SetupEvent, { type: 'step' }> => e.type === 'step' && e.plan.label === '2b')!
  check('step 2b shows the documented command verbatim and no sudo on darwin', step2b.plan.willRun === 'brew install ollama' && !step2b.plan.needsSudo && step2b.plan.found.includes('ollama not found'), JSON.stringify(step2b.plan))
  check('the install ran through the exec seam as sh -c', m.execs.some(e => e.file === '/bin/sh' && e.args[1] === 'brew install ollama'))
  const progressRows = events.filter((e): e is Extract<setup.SetupEvent, { type: 'progress' }> => e.type === 'progress' && e.label === '4')
  const resultAt = shape.indexOf('result 4 ran')
  const firstProgressAt = shape.indexOf('progress 4')
  check('the pull\'s rows streamed as progress events before its result (7 rows, in place)', progressRows.length === 7 && firstProgressAt >= 0 && firstProgressAt < resultAt && progressRows[3]!.line === 'pulling dec52a44 100% · 6.6 GB of 6.6 GB' && progressRows[6]!.line === 'success', progressRows.map(r => r.line).join(' | '))
  const result4 = events.find((e): e is Extract<setup.SetupEvent, { type: 'result' }> => e.type === 'result' && e.result.label === '4')!
  check('the pull result row says success and the size', result4.result.lastLine === 'qwen3.5:9b: success · 6.6 GB · 7 rows', result4.result.lastLine)
  const result5 = events.find((e): e is Extract<setup.SetupEvent, { type: 'result' }> => e.type === 'result' && e.result.label === '5')!
  check("the window row says the figures on the one rule: 256k · 6.1 GiB weights + 8.0 GiB cache of 36.9 GiB usable (48.0 GiB box) · f16 · 1 slot", result5.result.lastLine === '256k · 6.1 GiB weights + 8.0 GiB cache of 36.9 GiB usable (48.0 GiB box) · f16 · 1 slot', result5.result.lastLine)
  const step5 = events.find((e): e is Extract<setup.SetupEvent, { type: 'step' }> => e.type === 'step' && e.plan.label === '5')!
  check("step 5's plan names the one rule: the usable ceiling (the server's own gpu memory line), the cache type and slots, the same rule auto uses", step5.plan.found.includes("fits the memory usable for models (the server's own gpu memory line when it states one)") && step5.plan.found.includes('the same rule auto uses at every send') && !step5.plan.found.includes('0.9'), step5.plan.found)
  const result6 = events.find((e): e is Extract<setup.SetupEvent, { type: 'result' }> => e.type === 'result' && e.result.label === '6')!
  check('the prove row carries the timings', result6.result.lastLine.startsWith('load 5.2 s · ingest 14 tokens in 0.3 s (47 tok/s) · reply 2 tokens in 0.2 s · total '), result6.result.lastLine)
  const detail6 = result6.result.detail as setup.ProveResult | undefined
  check('step 6\'s result detail carries the daemon\'s settle word for the dialog\'s row', detail6 !== undefined && 'settled' in detail6 && detail6.settled === 'applied' && detail6.settledBy === 'daemon', JSON.stringify(detail6 === undefined ? undefined : { settled: detail6.settled, settledBy: detail6.settledBy }))
  check('the summary is the ready row', summary.reason === 'finished' && summary.ran.join(',') === '1,2,2b,3,4,5,6' && summary.ready?.words.startsWith('ready · local/qwen3.5:9b · 256k window · reply in ') === true, summary.words)
  check('the order of the server calls: probe, version wait, pull, tags+show, chat — never a load', fx.hits.filter(h => h.url === '/api/pull').length === 1 && fx.hits.filter(h => h.url === '/api/chat').length === 1 && !fx.hits.some(h => h.url === '/api/generate'), JSON.stringify(fx.hits.map(h => h.url)))
  await fx.close()
}

section('§10 LM Studio answering ⇒ the road ends at step 6 on that server\'s model; no install, no start')
{
  const lm = await fixtureLmStudio()
  const m = bareMachine('darwin')
  const slice: setup.SessionModelSlice = { mainLoopModel: null, mainLoopModelForSession: null, pendingModelSwitch: null, foregroundTurnActive: false }
  const io = machineIo(m, undefined, { env: { PATH: '/nowhere', MERCURY_LOCAL_PROBE_TARGETS: `lmstudio=${lm.root}` }, setAppState: updater => Object.assign(slice, updater(slice)), persist: () => ({ sentence: '' }) })
  const found = await setup.detectLocalServers(io)
  check('LM Studio is detected with its loaded model first', found.kind === 'lmstudio' && found.models[0] === 'google/gemma-4-26b-a4b' && found.words.includes('keeps working'), JSON.stringify(found))
  const { events, summary } = await walk(() => 'run', io)
  check('the walk: 1 then 6', stepEvents(events).join(' | ') === 'step 1 | result 1 ran | step 6 | result 6 ran | done finished', stepEvents(events).join(' | '))
  const step6 = events.find((e): e is Extract<setup.SetupEvent, { type: 'step' }> => e.type === 'step' && e.plan.label === '6')!
  check('step 6 names that server\'s model and its /v1 road', step6.plan.willRun.startsWith('/model local/google/gemma-4-26b-a4b · POST ') && step6.plan.willRun.includes(`${lm.root}/v1/chat/completions`) && step6.plan.found.includes('nothing is installed or started'), step6.plan.willRun)
  const lmChat = lm.hits.find(h => h.url === '/v1/chat/completions')
  check('the will-run line IS the compat body that was sent', step6.plan.willRun === `/model local/google/gemma-4-26b-a4b · POST ${lm.root}/v1/chat/completions ${lmChat?.body ?? ''}`, `${step6.plan.willRun}\n${lmChat?.body}`)
  check('the model set is the LM Studio model and the reply is ready', slice.mainLoopModel === 'local/google/gemma-4-26b-a4b' && summary.ready?.ok === true && summary.ready.firstLine === 'ready' && summary.ready.server === 'lmstudio', JSON.stringify(summary.ready))
  check('the ready row names the served window', summary.ready?.words.startsWith('ready · local/google/gemma-4-26b-a4b · 8k window (served) · reply in ') === true, summary.ready?.words)
  check('no install or start was attempted', m.execs.length === 0 && summary.ran.join(',') === '1,6' && summary.notDone.length === 0)
  check('LM Studio saw only its listing and one chat', lm.hits.map(h => h.url).every(u => u === '/api/v1/models' || u === '/v1/chat/completions') && lm.hits.filter(h => h.url === '/v1/chat/completions').length === 1, JSON.stringify(lm.hits.map(h => h.url)))
  await lm.close()
}

section('§11 Ollama already answering: with the tag ⇒ step 5 next; without ⇒ step 4; a failed step ends the road')
{
  const fx = await fixtureOllama()
  fx.state.up = true
  fx.state.listed = [TAG]
  const io = machineIo(bareMachine(), fx, { persist: () => ({ sentence: '' }) })
  const withTag = await walk(plan => (plan.label === '5' ? 'stop' : 'run'), io)
  check('the tag listed ⇒ 1 then 5', stepEvents(withTag.events).join(' | ') === 'step 1 | result 1 ran | step 5 | done stopped' && withTag.summary.words === 'stopped at step 5 · done: 1 · not done: 5, 6', stepEvents(withTag.events).join(' | '))
  fx.state.listed = []
  const withoutTag = await walk(plan => (plan.label === '4' ? 'stop' : 'run'), io)
  check('no tag ⇒ 1 then 4, the found line says about 6.6 GB', stepEvents(withoutTag.events).join(' | ') === 'step 1 | result 1 ran | step 4 | done stopped' && withoutTag.events.some(e => e.type === 'step' && e.plan.label === '4' && e.plan.found.includes('about 6.6 GB')), stepEvents(withoutTag.events).join(' | '))
  fx.state.pullError = 'pull model manifest: file does not exist'
  const failed = await walk(() => 'run', io)
  check('a failed pull ends the road with the reason and 5–6 not done', failed.summary.reason === 'ended' && failed.summary.failed.join(',') === '4' && failed.summary.notDone.join(',') === '5,6' && failed.summary.words.startsWith('step 4 failed · done: 1 · not done: 5, 6'), failed.summary.words)
  const off = await walk(() => 'run', { ...io, env: { PATH: '/nowhere', MERCURY_LOCAL_PROBE_TARGETS: 'none' } })
  check('probing off ⇒ step 1 says so and the road ends naming the reason', off.summary.reason === 'ended' && off.summary.words.includes('MERCURY_LOCAL_PROBE_TARGETS'), off.summary.words)
  await fx.close()
}

section('§12 the seams never reach the machine: the scratch home holds the only writes')
{
  check('the serve log path is under the scratch home', !existsSync('/fixture') && join(proofHome, 'local-setup', 'ollama-serve.log').startsWith(proofHome))
  check('shellArgv: sh -c on posix, cmd /c on windows', setup.shellArgv('darwin', 'x').join(' ') === '/bin/sh -c x' && setup.shellArgv('win32', 'x').join(' ') === 'cmd.exe /d /s /c x')
}

console.log(`\n${failures === 0 ? 'SETUP ROAD PROOF GREEN' : `SETUP ROAD PROOF RED — ${failures} failure(s)`}`)
process.exit(failures === 0 ? 0 : 1)
