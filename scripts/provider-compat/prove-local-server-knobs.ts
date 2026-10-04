#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const HOME = mkdtempSync(join(tmpdir(), 'local-server-page-knobs.'))
process.env.MERCURY_CONFIG_DIR = HOME
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
delete process.env.MERCURY_LOCAL_BASE_URL
delete process.env.MERCURY_LOCAL_API_KEY

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t)
}
function finish(): never {
  console.log(`\n${failures === 0 ? 'ALL GREEN' : `${failures} FAILURE(S)`}`)
  process.exit(failures === 0 ? 0 : 1)
}

section('0 · the module exists (red on the base: the folder is absent)')
const modules = await (async () => {
  try {
    const truth = await import('../../src/services/localServer/localServerTruth.ts')
    const memory = await import('../../src/services/localServer/localServerMemory.ts')
    const knobs = await import('../../src/services/localServer/localServerKnobs.ts')
    const apply = await import('../../src/services/localServer/localServerApply.ts')
    return { truth, memory, knobs, apply }
  } catch (error) {
    check('src/services/localServer/{localServerTruth,localServerMemory,localServerKnobs,localServerApply}.ts import', false, error instanceof Error ? error.message.split('\n')[0] ?? '' : String(error))
    return undefined
  }
})()
if (!modules) finish()
check('the four files import', true)
const { readLocalServerTruth, parseRunnerCommand, parseOllamaEnvLine, parseProcessTable, findServerProcess, parsePlist, parseSystemdOverride, parseEnvironBlock, HOMEBREW_OLLAMA_PLIST, SYSTEMD_OLLAMA_OVERRIDE, refreshLocalServerTruth, cachedLocalServerTruth, __resetLocalServerTruthForTest } = modules.truth
const { kvGeometryOf, kvBytesPerToken, kvCacheBytes, loadEstimateBytes, projectLoad, gibWords, gbWords, fitWords, tokensWords } = modules.memory
const { LOCAL_SERVER_KNOBS, localServerSettingsOf, parseKeepAlive, keepAliveWords, nextOnLadder, settingsAsEnv, knobReadings, knobValueWords, memoryFactsOf, knobDetailWords, MAX_LOADED_MODELS_LADDER, KEEP_ALIVE_LADDER, CONTEXT_LENGTH_LADDER, readLocalServerSettings, writeLocalServerSetting } = modules.knobs
const { planLocalServerApply, applyLocalServerPlan, rewritePlistEnvironment, rewriteSystemdOverride, byHandLines, planWords } = modules.apply
type Truth = import('../../src/services/localServer/localServerTruth.ts').LocalServerTruth
type Io = import('../../src/services/localServer/localServerTruth.ts').LocalServerIo

type Route = (req: IncomingMessage, body: string, res: ServerResponse) => boolean
function serve(route: Route): Promise<{ server: Server; root: string }> {
  return new Promise(resolve => {
    const server = createServer((req, res) => {
      let body = ''
      req.on('data', chunk => {
        body += String(chunk)
      })
      req.on('end', () => {
        if (!route(req, body, res)) {
          res.writeHead(404, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ error: 'not found' }))
        }
      })
    })
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      resolve({ server, root: `http://127.0.0.1:${typeof address === 'object' && address !== null ? address.port : 0}` })
    })
  })
}
function json(res: ServerResponse, status: number, body: unknown): true {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
  return true
}

const GIB = 1024 ** 3
const WEIGHTS_27B = 17420432728
const WEIGHTS_9B = 6594474711
const LOADED_27B = Math.round(24.7 * GIB)
const LOADED_9B = 12227507649
const kvHeads = (blocks: number): number[] => Array.from({ length: blocks }, (_, i) => ((i + 1) % 4 === 0 ? 4 : 0))
const details27 = { parent_model: '', format: 'gguf', family: 'qwen35', families: ['qwen35'], parameter_size: '27.8B', quantization_level: 'Q4_K_M', context_length: 262144, embedding_length: 5120 }
const details9 = { parent_model: '', format: 'gguf', family: 'qwen35', families: ['qwen35'], parameter_size: '9.7B', quantization_level: 'Q4_K_M', context_length: 262144, embedding_length: 4096 }
const TAGS = { models: [{ name: 'qwen3.5:27b', model: 'qwen3.5:27b', size: WEIGHTS_27B, digest: '7653', details: details27, capabilities: ['completion', 'vision', 'tools', 'thinking'] }, { name: 'qwen3.5:9b-q4_K_M', model: 'qwen3.5:9b-q4_K_M', size: WEIGHTS_9B, digest: '6488', details: details9, capabilities: ['completion', 'vision', 'tools', 'thinking'] }] }
const PS = { models: [{ name: 'qwen3.5:27b', model: 'qwen3.5:27b', size: LOADED_27B, digest: '7653', details: details27, expires_at: '2100-01-01T00:00:00Z', size_vram: LOADED_27B, context_length: 262144 }, { name: 'qwen3.5:9b-q4_K_M', model: 'qwen3.5:9b-q4_K_M', size: LOADED_9B, digest: '6488', details: details9, expires_at: '2026-01-01T00:30:00Z', size_vram: LOADED_9B, context_length: 262144 }] }
const SHOW: Record<string, unknown> = {
  'qwen3.5:27b': { details: details27, capabilities: ['completion', 'vision', 'tools', 'thinking'], parameters: 'top_k 20', model_info: { 'general.architecture': 'qwen35', 'general.parameter_count': 27781427952, 'qwen35.attention.head_count': 24, 'qwen35.attention.head_count_kv': kvHeads(64), 'qwen35.attention.key_length': 256, 'qwen35.attention.value_length': 256, 'qwen35.block_count': 64, 'qwen35.context_length': 262144, 'qwen35.embedding_length': 5120 } },
  'qwen3.5:9b-q4_K_M': { details: details9, capabilities: ['completion', 'vision', 'tools', 'thinking'], parameters: '', model_info: { 'general.architecture': 'qwen35', 'general.parameter_count': 9653104368, 'qwen35.attention.head_count': 16, 'qwen35.attention.head_count_kv': kvHeads(32), 'qwen35.attention.key_length': 256, 'qwen35.attention.value_length': 256, 'qwen35.block_count': 32, 'qwen35.context_length': 262144, 'qwen35.embedding_length': 4096 } },
}
const hits: string[] = []
const ollama = await serve((req, body, res) => {
  hits.push(`${req.method} ${req.url}`)
  if (req.url === '/api/version') return json(res, 200, { version: '0.34.4' })
  if (req.url === '/api/tags') return json(res, 200, TAGS)
  if (req.url === '/api/ps') return json(res, 200, PS)
  if (req.url === '/api/show' && req.method === 'POST') {
    const model = String((JSON.parse(body || '{}') as { model?: string }).model ?? '')
    return model in SHOW ? json(res, 200, SHOW[model]) : json(res, 404, { error: `model '${model}' not found` })
  }
  return false
})
const dead = await serve(() => false)
const deadRoot = dead.root
await new Promise<void>(resolve => dead.server.close(() => resolve()))

const AGENTS = join(HOME, 'Library', 'LaunchAgents')
mkdirSync(AGENTS, { recursive: true })
const PLIST_PATH = join(AGENTS, 'com.example.ollama-ssd.plist')
const PLIST = [
  '<?xml version="1.0" encoding="UTF-8"?>',
  '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
  '<plist version="1.0">',
  '<dict>',
  '\t<key>EnvironmentVariables</key>',
  '\t<dict>',
  '\t\t<key>OLLAMA_CONTEXT_LENGTH</key>',
  '\t\t<string>262144</string>',
  '\t\t<key>OLLAMA_FLASH_ATTENTION</key>',
  '\t\t<string>1</string>',
  '\t\t<key>OLLAMA_HOST</key>',
  '\t\t<string>127.0.0.1:11434</string>',
  '\t\t<key>OLLAMA_KEEP_ALIVE</key>',
  '\t\t<string>30m</string>',
  '\t\t<key>OLLAMA_KV_CACHE_TYPE</key>',
  '\t\t<string>q8_0</string>',
  '\t\t<key>OLLAMA_MAX_LOADED_MODELS</key>',
  '\t\t<string>1</string>',
  '\t\t<key>OLLAMA_MODELS</key>',
  '\t\t<string>/Volumes/SSD/ollama</string>',
  '\t</dict>',
  '\t<key>KeepAlive</key>',
  '\t<true/>',
  '\t<key>Label</key>',
  '\t<string>com.example.ollama-ssd</string>',
  '\t<key>ProgramArguments</key>',
  '\t<array>',
  '\t\t<string>/bin/sh</string>',
  `\t\t<string>${join(HOME, 'Library', 'Application Support', 'OllamaSSD', 'serve.sh')}</string>`,
  '\t</array>',
  '\t<key>RunAtLoad</key>',
  '\t<true/>',
  '\t<key>StandardOutPath</key>',
  `\t<string>${join(HOME, 'Library', 'Logs', 'ollama.log')}</string>`,
  '</dict>',
  '</plist>',
  '',
].join('\n')
writeFileSync(PLIST_PATH, PLIST)
mkdirSync(join(HOME, 'Library', 'Logs'), { recursive: true })
const LOG_PATH = join(HOME, 'Library', 'Logs', 'ollama.log')
writeFileSync(LOG_PATH, ['time=T level=INFO source=sched.go:618 msg="system memory" total="48.0 GiB" free="25.6 GiB" free_swap="0 B"', 'time=T level=INFO source=sched.go:625 msg="gpu memory" id=0 library=Metal available="36.9 GiB" free="37.4 GiB" minimum="512.0 MiB" overhead="0 B"', ''].join('\n'))

const SERVE_CMD = '/opt/homebrew/opt/ollama/bin/ollama serve'
const RUNNER_CMD = '/opt/homebrew/Cellar/ollama/0.34.4/libexec/lib/ollama/llama-server --model /Volumes/SSD/ollama/blobs/sha256-dec5 --port 49934 --host 127.0.0.1 --no-webui --offline -c 32768 -np 4 --log-verbosity 4 --cache-type-k q8_0 --cache-type-v q8_0 --flash-attn on -b 2048'
const PS_TABLE = ['    1     0 /sbin/launchd', `16812     1 ${SERVE_CMD}`, `42323 16812 ${RUNNER_CMD}`, ' 9999     1 /Applications/Other.app/Contents/MacOS/Other', '10001     1 /usr/local/bin/ollama run qwen3.5:9b', ''].join('\n')
const ENV_LINE = `${SERVE_CMD} OLLAMA_MAX_LOADED_MODELS=1 OLLAMA_CONTEXT_LENGTH=262144 OLLAMA_KEEP_ALIVE=30m OLLAMA_KV_CACHE_TYPE=q8_0 OLLAMA_FLASH_ATTENTION=1 OLLAMA_MODELS=/Volumes/SSD/ollama OLLAMA_HOST=127.0.0.1:11434 PATH=/usr/bin:/bin XPC_SERVICE_NAME=com.example.ollama-ssd\n`
const runs: string[] = []
const fixtureRun = async (file: string, args: string[]): Promise<string | undefined> => {
  runs.push([file, ...args].join(' '))
  if (file === 'ps' && args[0] === '-axo') return PS_TABLE
  if (file === 'ps' && args[0] === '-Eo') return args[3] === '16812' ? ENV_LINE : `${SERVE_CMD}\n`
  if (file === 'launchctl' && args[0] === 'print') return args[1] === 'gui/501/com.example.ollama-ssd' ? 'gui/501/com.example.ollama-ssd = {\n\tactive count = 1\n\tstate = running\n\tpid = 16812\n}\n' : undefined
  if (file === 'launchctl' && args[0] === 'getenv') return args[1] === 'OLLAMA_MAX_LOADED_MODELS' ? '1\n' : '\n'
  if (file === 'launchctl') return ''
  if (file === 'sysctl') return '0\n'
  if (file === 'osascript' || file === 'open') return ''
  return undefined
}
const baseIo = (env: Record<string, string> = {}): Io => ({
  env: { ...process.env, MERCURY_LOCAL_PROBE_TARGETS: `ollama=${ollama.root}`, ...env },
  platform: 'darwin',
  home: HOME,
  uid: 501,
  totalMemoryBytes: 48 * GIB,
  now: () => 1_800_000_000_000,
  run: fixtureRun,
})

section('1 · the reader over fixtures yields the typed truth')
const truth = await readLocalServerTruth(baseIo())
{
  check('the server: Ollama 0.34.4 at the fixture root', truth.server?.kind === 'ollama' && truth.server.version === '0.34.4' && truth.server.label === 'Ollama 0.34.4' && truth.server.root === ollama.root, JSON.stringify(truth.server))
  check('/api/ps: two loaded models with their windows, sizes and expiry', truth.loaded.length === 2 && truth.loaded[0]?.name === 'qwen3.5:27b' && truth.loaded[0].contextLength === 262144 && truth.loaded[0].sizeBytes === LOADED_27B && truth.loaded[0].sizeVramBytes === LOADED_27B && truth.loaded[1]?.sizeBytes === LOADED_9B && truth.loaded[1].expiresAt === '2026-01-01T00:30:00Z', JSON.stringify(truth.loaded))
  check('/api/tags: the listed models carry weights, trained window and the geometry from /api/show', truth.listed.length === 2 && truth.listed[0]?.sizeBytes === WEIGHTS_27B && truth.listed[0].trainedContext === 262144 && truth.listed[0].geometry?.kvHeads === 64 && truth.listed[0].geometry.attentionLayers === 16 && truth.listed[1]?.geometry?.kvHeads === 32, JSON.stringify(truth.listed.map(m => [m.name, m.sizeBytes, m.trainedContext, m.geometry])))
  check('the runner from the process list: -np 4 -c 32768, q8_0 cache, flash attention on, the child of the server', truth.runners.length === 1 && truth.runners[0]?.slots === 4 && truth.runners[0].context === 32768 && truth.runners[0].cacheTypeK === 'q8_0' && truth.runners[0].flashAttention === 'on' && truth.runners[0].pid === 42323, JSON.stringify(truth.runners))
  check('the server process and its OLLAMA_* environment (7 names, the client and PATH left out)', truth.process?.pid === 16812 && truth.process.envReadable && Object.keys(truth.process.env).length === 7 && truth.process.env['OLLAMA_KEEP_ALIVE'] === '30m' && truth.process.env['OLLAMA_MODELS'] === '/Volumes/SSD/ollama' && !('PATH' in truth.process.env), JSON.stringify(truth.process))
  check('the launch form: the launch agent plist, its label, its env, writable, confirmed by launchctl', truth.launchForm.kind === 'launch-agent' && truth.launchForm.path === PLIST_PATH && truth.launchForm.label === 'com.example.ollama-ssd' && truth.launchForm.env?.['OLLAMA_MAX_LOADED_MODELS'] === '1' && truth.launchForm.writable === true && truth.launchForm.confirmed === true, JSON.stringify(truth.launchForm))
  check('the machine: 48 GiB, darwin, the injected clock', truth.machine.totalMemoryBytes === 48 * GIB && truth.machine.platform === 'darwin' && truth.readAtMs === 1_800_000_000_000)
  check("the usable ceiling is the server's own gpu memory line from the plist's StandardOutPath log: 36.9 GiB (Metal)", gibWords(truth.machine.usableMemoryBytes) === '36.9 GiB' && truth.machine.usableSource === `the server's own gpu memory line in ${LOG_PATH} (Metal)` && truth.launchForm.logPath === LOG_PATH, `${truth.machine.usableMemoryBytes} · ${truth.machine.usableSource}`)
  check('the reads were GET version/tags/ps and POST show only — never a generation, a load or a delete', hits.every(hit => /^GET \/api\/(version|tags|ps)$|^POST \/api\/show$/.test(hit)), hits.join(', '))
}

section('2 · absence is absent, never a throw')
{
  const gone = await readLocalServerTruth(baseIo({ MERCURY_LOCAL_PROBE_TARGETS: `ollama=${deadRoot}` }))
  check('a dead port: no server, no models; the process list and the launch form still read', gone.server === undefined && gone.loaded.length === 0 && gone.process?.pid === 16812 && gone.launchForm.kind === 'launch-agent', JSON.stringify([gone.server, gone.launchForm.kind]))
  const before = hits.length
  const none = await readLocalServerTruth(baseIo({ MERCURY_LOCAL_PROBE_TARGETS: 'none' }))
  check("'none' probes nothing (no request reached the fixture)", none.server === undefined && hits.length === before)
  const noProcess = await readLocalServerTruth({ ...baseIo(), run: async (file, args) => (file === 'ps' && args[0] === '-axo' ? '    1     0 /sbin/launchd\n' : undefined) })
  check('no ollama serve in the process list: process and runners absent, the plist still found (unconfirmed)', noProcess.process === undefined && noProcess.runners.length === 0 && noProcess.launchForm.kind === 'launch-agent' && noProcess.launchForm.confirmed === undefined, JSON.stringify(noProcess.launchForm))
  const throwing = await readLocalServerTruth({ ...baseIo(), fetchImpl: (() => { throw new Error('boom') }) as unknown as typeof fetch, run: async () => { throw new Error('boom') }, readText: () => { throw new Error('boom') }, listDir: () => { throw new Error('boom') } })
  check('a fetch, a process read and a file read that all throw still yield a truth', throwing.server === undefined && throwing.runners.length === 0 && throwing.launchForm.kind === 'unknown')
  const appRun = async (file: string, args: string[]): Promise<string | undefined> => (file === 'ps' && args[0] === '-axo' ? '  777     1 /Applications/Ollama.app/Contents/Resources/ollama serve\n' : file === 'ps' ? '/Applications/Ollama.app/Contents/Resources/ollama serve OLLAMA_HOST=127.0.0.1:11434 OLLAMA_MAX_LOADED_MODELS=1\n' : fixtureRun(file, args))
  const app = await readLocalServerTruth({ ...baseIo(), run: appRun })
  check('the Ollama app: the form is app, its env from launchctl getenv (the set one only), the app log path, the FAQ words', app.launchForm.kind === 'app' && app.launchForm.note.includes('launchctl setenv') && JSON.stringify(app.launchForm.env) === JSON.stringify({ OLLAMA_MAX_LOADED_MODELS: '1' }) && app.launchForm.logPath === join(HOME, '.ollama', 'logs', 'server.log') && app.process?.env['OLLAMA_HOST'] === '127.0.0.1:11434', JSON.stringify(app.launchForm))
  check('no readable log and iogpu.wired_limit_mb 0: the ceiling is the Metal default, three quarters of 48 GiB, and says so', gibWords(app.machine.usableMemoryBytes) === '36.0 GiB' && app.machine.usableSource.startsWith('about three quarters of unified memory'), app.machine.usableSource)
  const limited = await readLocalServerTruth({ ...baseIo(), run: async (file, args) => (file === 'sysctl' ? '40960\n' : appRun(file, args)) })
  check('iogpu.wired_limit_mb set: the ceiling is that many MiB, named', gibWords(limited.machine.usableMemoryBytes) === '40.0 GiB' && limited.machine.usableSource === 'iogpu.wired_limit_mb', limited.machine.usableSource)
  const brewHome = mkdtempSync(join(tmpdir(), 'local-server-page-brew.'))
  mkdirSync(join(brewHome, 'Library', 'LaunchAgents'), { recursive: true })
  const brewPlist = join(brewHome, 'Library', 'LaunchAgents', HOMEBREW_OLLAMA_PLIST)
  writeFileSync(brewPlist, '<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0">\n<dict>\n\t<key>Label</key>\n\t<string>homebrew.mxcl.ollama</string>\n\t<key>ProgramArguments</key>\n\t<array>\n\t\t<string>/opt/homebrew/opt/ollama/bin/ollama</string>\n\t\t<string>serve</string>\n\t</array>\n\t<key>RunAtLoad</key>\n\t<true/>\n</dict>\n</plist>\n')
  const brew = await readLocalServerTruth({ ...baseIo(), home: brewHome })
  check('Homebrew services: the form is homebrew with its plist and an empty env', brew.launchForm.kind === 'homebrew' && brew.launchForm.path === brewPlist && Object.keys(brew.launchForm.env ?? {}).length === 0 && brew.launchForm.note.includes('brew services restart'), JSON.stringify(brew.launchForm))
  rmSync(brewHome, { recursive: true, force: true })
  const linux = await readLocalServerTruth({
    ...baseIo(),
    platform: 'linux',
    pathExists: path => path === '/etc/systemd/system/ollama.service',
    readText: path => (path === SYSTEMD_OLLAMA_OVERRIDE ? '[Service]\nEnvironment="OLLAMA_HOST=0.0.0.0"\nEnvironment="OLLAMA_MAX_LOADED_MODELS=2"\n' : path === '/proc/16812/environ' ? 'PATH=/usr/bin\0OLLAMA_HOST=0.0.0.0\0OLLAMA_MAX_LOADED_MODELS=2\0' : undefined),
    writable: () => false,
    run: async (file, args) => (file === 'ps' && args[0] === '-axo' ? `16812     1 /usr/local/bin/ollama serve\n42323 16812 /usr/local/lib/ollama/runners/cuda_v12/ollama_llama_server --model x --ctx-size 8192 --parallel 2\n` : undefined),
  })
  check('Linux systemd: the override with its Environment= lines, root needed, the env from /proc, the runner from --ctx-size/--parallel', linux.launchForm.kind === 'systemd' && linux.launchForm.path === SYSTEMD_OLLAMA_OVERRIDE && linux.launchForm.env?.['OLLAMA_MAX_LOADED_MODELS'] === '2' && linux.launchForm.writable === false && linux.process?.env['OLLAMA_HOST'] === '0.0.0.0' && linux.runners[0]?.context === 8192 && linux.runners[0].slots === 2, JSON.stringify([linux.launchForm, linux.process, linux.runners]))
  check('Linux: the ceiling is total memory, named as no GPU reading', linux.machine.usableMemoryBytes === 48 * GIB && linux.machine.usableSource === 'total memory (no GPU reading)')
  const windows = await readLocalServerTruth({ ...baseIo(), platform: 'win32' })
  check('Windows: the form names the user environment variables; no process read', windows.launchForm.kind === 'windows' && windows.process === undefined)
  const { parseServerLogMemory, parseMemoryWords } = modules.truth
  check('the log parser: the last gpu memory line wins; MiB and GiB words parse; junk is absent', parseServerLogMemory('msg="gpu memory" library=Metal available="30.0 GiB"\nmsg="gpu memory" library=Metal available="36.9 GiB"\nmsg="system memory" total="48.0 GiB"\n').availableBytes === Math.round(36.9 * GIB) && parseMemoryWords('512.0 MiB') === 512 * 1024 * 1024 && parseMemoryWords('lots') === undefined)
  const other = await readLocalServerTruth({ ...baseIo(), env: { ...process.env, MERCURY_LOCAL_PROBE_TARGETS: `llamacpp=${ollama.root}` } })
  check('a non-Ollama kind that does not answer its own routes is absent', other.server === undefined)
}

section('3 · pure parsers')
{
  check('parseRunnerCommand: -np/-c, --parallel/--ctx-size, vLLM flags; a client command is not a runner', parseRunnerCommand(RUNNER_CMD)?.slots === 4 && parseRunnerCommand('/x/ollama runner --model m --ctx-size 4096 --parallel 3')?.context === 4096 && parseRunnerCommand('/x/ollama runner --model m --ctx-size 4096 --parallel 3')?.slots === 3 && parseRunnerCommand('/x/ollama run qwen') === undefined && parseRunnerCommand('/x/ollama serve') === undefined && parseRunnerCommand('python -m vllm.entrypoints.openai.api_server --max-model-len 40960 --max-num-seqs 8') === undefined)
  check('parseOllamaEnvLine keeps OLLAMA_* only, a value with a space intact', JSON.stringify(parseOllamaEnvLine('ollama serve OLLAMA_MODELS=/Volumes/My Disk/ollama OLLAMA_HOST=127.0.0.1:11434 PATH=/bin')) === JSON.stringify({ OLLAMA_MODELS: '/Volumes/My Disk/ollama', OLLAMA_HOST: '127.0.0.1:11434' }))
  check('parseEnvironBlock reads a NUL-separated block', parseEnvironBlock('A=1\0OLLAMA_KEEP_ALIVE=-1\0')['OLLAMA_KEEP_ALIVE'] === '-1')
  const rows = parseProcessTable(PS_TABLE)
  const found = findServerProcess(rows, 'ollama')
  check('the process table: the server row and its one runner child', rows.length === 5 && found.server?.pid === 16812 && found.runners.length === 1 && found.runners[0]?.pid === 42323)
  const facts = parsePlist(PLIST)
  check('parsePlist: label, program arguments, the env dict', facts.label === 'com.example.ollama-ssd' && facts.programArguments[0] === '/bin/sh' && facts.env['OLLAMA_KV_CACHE_TYPE'] === 'q8_0' && Object.keys(facts.env).length === 7)
  check('parseSystemdOverride: quoted and bare forms', JSON.stringify(parseSystemdOverride('[Service]\nEnvironment="OLLAMA_HOST=0.0.0.0" OLLAMA_NUM_PARALLEL=4\nEnvironment=OLLAMA_KEEP_ALIVE=24h\n')) === JSON.stringify({ OLLAMA_HOST: '0.0.0.0', OLLAMA_NUM_PARALLEL: '4', OLLAMA_KEEP_ALIVE: '24h' }))
}

section('4 · the memory arithmetic: the three examples')
{
  const g27 = kvGeometryOf(SHOW['qwen3.5:27b']!['model_info' as never] as Record<string, unknown>)!
  const g9 = kvGeometryOf(SHOW['qwen3.5:9b-q4_K_M']!['model_info' as never] as Record<string, unknown>)!
  check('geometry: 16 full-attention layers of 64 with 4 KV heads and 256-wide keys on the 27B; 8 of 32 on the 9B', g27.kvHeads === 64 && g27.attentionLayers === 16 && g27.keyLength === 256 && g27.valueLength === 256 && g9.kvHeads === 32 && g9.attentionLayers === 8, JSON.stringify([g27, g9]))
  check('q8_0 cache: 34816 bytes per token on the 27B (64 heads × 512 × 34/32), 17408 on the 9B; f16 doubles it near enough', kvBytesPerToken(g27, 'q8_0') === 34816 && kvBytesPerToken(g9, 'q8_0') === 17408 && kvBytesPerToken(g27, 'f16') === 65536 && kvBytesPerToken(g27, undefined) === 65536)
  const slot256 = kvCacheBytes(g27, 262144, 1, 'q8_0')
  const slot32 = kvCacheBytes(g27, 32768, 1, 'q8_0')
  check('a 256k slot on the 27B ≈ 9.1 GB (8.5 GiB) of cache; a 32k slot ≈ 1.1 GB', gbWords(slot256) === '9.1 GB' && gibWords(slot256) === '8.5 GiB' && gbWords(slot32) === '1.1 GB', `${gbWords(slot256)} · ${gbWords(slot32)}`)
  const load27 = loadEstimateBytes(WEIGHTS_27B, g27, 262144, 1, 'q8_0')
  check('the 27B at a 256k window loads as 24.7 GiB (16.2 GiB of weights + 8.5 GiB of cache)', gibWords(load27) === '24.7 GiB' && gibWords(WEIGHTS_27B) === '16.2 GiB', gibWords(load27))
  const load9 = loadEstimateBytes(WEIGHTS_9B, g9, 262144, 1, 'q8_0')
  check('the 9B at 256k projects 10.4 GiB before the runner buffers; /api/ps reports 11.4 GiB and that figure is the truth shown', gibWords(load9) === '10.4 GiB' && gibWords(LOADED_9B) === '11.4 GiB', `${gibWords(load9)} · ${gibWords(LOADED_9B)}`)
  check('two loaded models on 48 GiB: 24.7 + 11.4 = 36.1 GiB fits', gibWords(LOADED_27B + LOADED_9B) === '36.1 GiB' && fitWords(LOADED_27B + LOADED_9B, 48 * GIB) === 'fits in 48.0 GiB')
  const crew32 = projectLoad({ name: 'qwen3.5:27b', weightsBytes: WEIGHTS_27B, geometry: g27 }, 32768, 7, 'q8_0')
  const crew256 = projectLoad({ name: 'qwen3.5:27b', weightsBytes: WEIGHTS_27B, geometry: g27 }, 262144, 7, 'q8_0')
  check('seven slots at 32k on the 27B: one copy, 23.7 GiB, fits; seven 256k slots: 75.7 GiB, does not', gibWords(crew32.totalBytes) === '23.7 GiB' && fitWords(crew32.totalBytes, 48 * GIB).startsWith('fits') && gibWords(crew256.totalBytes) === '75.7 GiB' && fitWords(crew256.totalBytes, 48 * GIB) === 'does not fit in 48.0 GiB', `${gibWords(crew32.totalBytes)} · ${gibWords(crew256.totalBytes)}`)
  check('a per-layer number (no array) multiplies by the block count; a missing architecture is undefined', kvGeometryOf({ 'general.architecture': 'llama', 'llama.block_count': 32, 'llama.attention.head_count': 32, 'llama.attention.head_count_kv': 8, 'llama.embedding_length': 4096 })?.kvHeads === 256 && kvGeometryOf({})?.kvHeads === undefined)
  check('tokensWords: 262144 → 256k, 32768 → 32k, 4096 → 4k, 5000 → 5000', tokensWords(262144) === '256k' && tokensWords(32768) === '32k' && tokensWords(4096) === '4k' && tokensWords(5000) === '5000')
}

section('5 · the four knobs as settings: names, grammar, ladders, words, persistence')
{
  check('four knobs with their OLLAMA_* names and the documented defaults (docs.ollama.com/faq: 3 per GPU · 1 · 5m · 4096)', LOCAL_SERVER_KNOBS.map(k => k.envName).join(',') === 'OLLAMA_MAX_LOADED_MODELS,OLLAMA_NUM_PARALLEL,OLLAMA_KEEP_ALIVE,OLLAMA_CONTEXT_LENGTH' && LOCAL_SERVER_KNOBS.map(k => k.documentedDefault).join('|') === '3 per GPU (3 on CPU)|1|5m|4096')
  const parsed = localServerSettingsOf({ local: { server: { maxLoadedModels: 2, parallelSlots: 4, keepAlive: '30m', contextLength: 32768 } } } as never)
  check('a valid object parses whole', JSON.stringify(parsed) === JSON.stringify({ maxLoadedModels: 2, parallelSlots: 4, keepAlive: '30m', contextLength: 32768 }))
  const junk = localServerSettingsOf({ local: { server: { maxLoadedModels: 0, parallelSlots: 2.5, keepAlive: 'soon', contextLength: 100 } } } as never)
  check('junk values degrade to absent, each on its own', JSON.stringify(junk) === '{}')
  check('keep-alive grammar: 30m · 24h · 3600 · 1h30m · -1 · 0; "soon" refused', parseKeepAlive('30m')?.kind === 'seconds' && (parseKeepAlive('30m') as { seconds: number }).seconds === 1800 && (parseKeepAlive('1h30m') as { seconds: number }).seconds === 5400 && (parseKeepAlive('3600') as { seconds: number }).seconds === 3600 && parseKeepAlive('24h')?.kind === 'seconds' && parseKeepAlive('-1')?.kind === 'forever' && parseKeepAlive('-1m')?.kind === 'forever' && parseKeepAlive('0')?.kind === 'unload' && parseKeepAlive('soon') === undefined)
  check('keep-alive words', keepAliveWords('30m') === '30 min idle' && keepAliveWords('24h') === '24 h idle' && keepAliveWords('-1') === '-1 · never unloads' && keepAliveWords('0') === '0 · unloads after each reply' && keepAliveWords(undefined) === 'unset')
  check('ladders step and clamp; an off-ladder number steps to the nearest rung', nextOnLadder(MAX_LOADED_MODELS_LADDER, 1, 1) === 2 && nextOnLadder(MAX_LOADED_MODELS_LADDER, 8, 1) === 8 && nextOnLadder(MAX_LOADED_MODELS_LADDER, 1, -1) === 1 && nextOnLadder(MAX_LOADED_MODELS_LADDER, 7, 1) === 8 && nextOnLadder(MAX_LOADED_MODELS_LADDER, 7, -1) === 6 && nextOnLadder(KEEP_ALIVE_LADDER, '30m', 1) === '1h' && nextOnLadder(KEEP_ALIVE_LADDER, undefined, 1) === '5m' && nextOnLadder(CONTEXT_LENGTH_LADDER, 262144, 1) === 262144)
  check('settingsAsEnv writes only the knobs that are set', JSON.stringify(settingsAsEnv({ maxLoadedModels: 2, keepAlive: '-1' })) === JSON.stringify({ OLLAMA_MAX_LOADED_MODELS: '2', OLLAMA_KEEP_ALIVE: '-1' }))
  const readings = knobReadings(truth, { maxLoadedModels: 2 })
  const words = readings.map(r => knobValueWords(r, true))
  check('the value words: a set knob beside the running value; a running-only knob; an unset knob with the runner fact and the documented default', words[0] === '2 · running 1 · apply to take effect' && words[2] === '30 min idle · running' && words[1] === 'unset · server default 1 · 4 slots on the runner' && words[3] === '256k · running · 32k on the runner', JSON.stringify(words))
  const facts = memoryFactsOf(truth)
  check('memory facts: q8_0 from the runner, two models with geometry, the loaded sizes beside, the usable ceiling and its source', facts.cacheType === 'q8_0' && facts.models.length === 2 && facts.models[0]?.loadedBytes === LOADED_27B && facts.machineBytes === 48 * GIB && gibWords(facts.usableBytes) === '36.9 GiB' && facts.usableSource.startsWith("the server's own gpu memory line"))
  const detail = knobDetailWords('maxLoadedModels', facts, { window: 262144, slots: 1, maxLoaded: 2 })
  check('the loaded-models words carry the box and its usable ceiling, both loads at their windows and the sum (36.1 GiB fit in 36.9 GiB)', detail.includes('the box has 48.0 GiB, 36.9 GiB usable for models (the server\'s own gpu memory line') && detail.includes('qwen3.5:27b 24.7 GiB at 256k') && detail.includes('qwen3.5:9b-q4_K_M 11.4 GiB at 256k') && detail.includes('all 2 together 36.1 GiB — fit in 36.9 GiB') && detail.includes('seven slots, not seven copies'), detail)
  const slots = knobDetailWords('parallelSlots', facts, { window: 262144, slots: 4, maxLoaded: 1 })
  check('the slots words: 8.5 GiB per slot at 256k, 1.1 GiB at 32k on the 27B, one slot for a single session, 2–4 at 32k for a crew', slots.includes('qwen3.5:27b: 8.5 GiB per slot at 256k, 1.1 GiB at 32k') && slots.includes('one slot for a single session; 2–4 slots with a 32k window for a crew') && slots.includes('4 slots at 32k load qwen3.5:27b as 20.5 GiB of 36.9 GiB usable'), slots)
  const ctx = knobDetailWords('contextLength', facts, { window: 32768, slots: 1, maxLoaded: 1 })
  check('the context words project every model at the chosen window', ctx.includes('at 32k with 1 slot: qwen3.5:27b 17.3 GiB, qwen3.5:9b-q4_K_M 6.7 GiB') && ctx.includes('of 36.9 GiB usable'), ctx)
  check("the context words name the one fit owner's answer per model — the biggest window that fits each alone, auto's rule: 256k and 256k on this box at q8_0", ctx.includes("the biggest window that fits each alone (auto's rule): qwen3.5:27b 256k, qwen3.5:9b-q4_K_M 256k"), ctx)
  const fourSlots = knobDetailWords('contextLength', facts, { window: 32768, slots: 4, maxLoaded: 1 })
  check('with four slots the same owner answers 128k for the 27B and 256k for the 9B', fourSlots.includes("(auto's rule): qwen3.5:27b 128k, qwen3.5:9b-q4_K_M 256k"), fourSlots)
  check('the memory facts carry each model\'s trained max for the owner', facts.models.every(model => model.trainedMax === 262144))
  const { chosenKnobs, fitVerdict } = modules.knobs
  const chosen = chosenKnobs(truth, { maxLoadedModels: 2, parallelSlots: 4, contextLength: 262144 })
  check('the chosen knobs: the settings first, the runner and the running env when unset', chosen.window === 262144 && chosen.slots === 4 && chosen.maxLoaded === 2 && chosenKnobs(truth, {}).window === 32768 && chosenKnobs(truth, {}).slots === 4 && chosenKnobs(truth, {}).maxLoaded === 1, JSON.stringify([chosen, chosenKnobs(truth, {})]))
  const over = fitVerdict(facts, chosen)
  check('two loaded models with four 256k slots each: 50.2 + 23.1 = 73.4 GiB against 36.9 GiB usable — does not fit, the figures and the models named', !over.fits && over.words === 'does not fit · 73.4 of 36.9 GiB usable with qwen3.5:27b and qwen3.5:9b-q4_K_M loaded — lower the window or the count' && over.short === 'does not fit · 73.4 of 36.9 GiB usable' && gibWords(over.models[0]!.bytes) === '50.2 GiB', over.words)
  const one = fitVerdict(facts, { window: 262144, slots: 1, maxLoaded: 1 })
  check('one 256k slot on the largest model: 24.7 of 36.9 GiB — fits', one.fits && one.words === 'fits · 24.7 of 36.9 GiB usable with qwen3.5:27b loaded', one.words)
  const crewFit = fitVerdict(facts, { window: 32768, slots: 7, maxLoaded: 1 })
  check('seven 32k slots on one copy of the 27B: 23.7 GiB — fits', crewFit.fits && crewFit.words.startsWith('fits · 23.7 of 36.9 GiB usable'), crewFit.words)
  const twoSlots = fitVerdict(facts, { window: 262144, slots: 2, maxLoaded: 1 })
  check('two 256k slots on the 27B: 33.2 GiB — fits; three: 41.7 GiB — does not', twoSlots.fits && gibWords(twoSlots.projectedBytes) === '33.2 GiB' && !fitVerdict(facts, { window: 262144, slots: 3, maxLoaded: 1 }).fits)
  check('no geometry: nothing to project, never a refusal', fitVerdict({ ...facts, models: [] }, chosen).fits && fitVerdict({ ...facts, models: [] }, chosen).words === 'no model geometry read — nothing to project')
  const { SettingsSchema } = await import('../../src/utils/settings/types.ts')
  const ok = SettingsSchema().safeParse({ local: { server: { maxLoadedModels: 4, parallelSlots: 2, keepAlive: '24h', contextLength: 65536 } } })
  const bad = SettingsSchema().safeParse({ local: { server: { keepAlive: 'soon' } } })
  const tooMany = SettingsSchema().safeParse({ local: { server: { maxLoadedModels: 65 } } })
  check('the settings registry carries local.server: a valid object passes, a bad duration and 65 models are refused', ok.success && !bad.success && !tooMany.success)
  const schema = JSON.parse(readFileSync(join(import.meta.dir, '..', 'settings', 'settings-schema.json'), 'utf8')) as { properties: Record<string, { properties?: Record<string, { properties?: Record<string, unknown> }> }> }
  check('the committed schema snapshot lists the four keys under local.server', Object.keys(schema.properties['local']?.properties?.['server']?.properties ?? {}).join(',') === 'maxLoadedModels,parallelSlots,keepAlive,contextLength')
  const { enableConfigs } = await import('../../src/utils/config.ts')
  enableConfigs()
  const wrote = writeLocalServerSetting('maxLoadedModels', 2)
  const wrote2 = writeLocalServerSetting('keepAlive', '-1')
  const back = readLocalServerSettings()
  check('the knobs persist to the user settings file in the scratch home and read back merged', wrote.error === null && wrote2.error === null && back.maxLoadedModels === 2 && back.keepAlive === '-1', JSON.stringify(back))
  writeLocalServerSetting('keepAlive', undefined)
  check('an undefined write deletes one knob and keeps the other', readLocalServerSettings().keepAlive === undefined && readLocalServerSettings().maxLoadedModels === 2)
  const written = readFileSync(join(HOME, 'settings.json'), 'utf8')
  check('the file carries the local.server object, nothing named after another lane', written.includes('"local"') && written.includes('"server"') && written.includes('"maxLoadedModels": 2'))
}

section('6 · the apply road: exact bytes to a scratch copy, nothing without the confirmation seam')
{
  const settings = { maxLoadedModels: 2, parallelSlots: 4 }
  const plan = planLocalServerApply(truth, settings, baseIo())
  check('the plan writes the plist found, with a backup beside it', plan.kind === 'write' && plan.path === PLIST_PATH && plan.backupPath === `${PLIST_PATH}.bak` && plan.form === 'launch-agent', JSON.stringify(plan.kind === 'write' ? [plan.path, plan.backupPath] : plan))
  if (plan.kind !== 'write') finish()
  const EXPECTED = PLIST.replace('\t\t<key>OLLAMA_MAX_LOADED_MODELS</key>\n\t\t<string>1</string>', '\t\t<key>OLLAMA_MAX_LOADED_MODELS</key>\n\t\t<string>2</string>').replace('\t\t<string>/Volumes/SSD/ollama</string>\n\t</dict>', '\t\t<string>/Volumes/SSD/ollama</string>\n\t\t<key>OLLAMA_NUM_PARALLEL</key>\n\t\t<string>4</string>\n\t</dict>')
  check('the new bytes are exactly the plist with the one value changed and the new key inserted in sorted place', plan.after === EXPECTED, plan.after)
  check('the exact lines shown: the changed value and the two inserted lines, nothing else', JSON.stringify(plan.lines) === JSON.stringify([' \t\t<key>OLLAMA_MAX_LOADED_MODELS</key>', '-\t\t<string>1</string>', '+\t\t<string>2</string>', '+\t\t<key>OLLAMA_NUM_PARALLEL</key>', '+\t\t<string>4</string>']), JSON.stringify(plan.lines))
  check('the changes name before and after; the restart is bootout then bootstrap of the agent', JSON.stringify(plan.changes) === JSON.stringify([{ name: 'OLLAMA_MAX_LOADED_MODELS', before: '1', after: '2' }, { name: 'OLLAMA_NUM_PARALLEL', after: '4' }]) && plan.restart.words === `launchctl bootout gui/501/com.example.ollama-ssd && launchctl bootstrap gui/501 ${PLIST_PATH}` && plan.restart.argv.length === 2, JSON.stringify([plan.changes, plan.restart]))
  check('planWords names the count, the restart and the review door', planWords(plan) === '2 changes + a restart · → reviews the file before anything is written', planWords(plan))
  runs.length = 0
  const refused = await applyLocalServerPlan(plan, { confirmed: false }, { run: fixtureRun })
  check('without the confirmation nothing is written, nothing backed up, nothing run', refused.outcome === 'refused' && readFileSync(PLIST_PATH, 'utf8') === PLIST && !existsSync(`${PLIST_PATH}.bak`) && runs.length === 0, JSON.stringify(refused))
  const applied = await applyLocalServerPlan(plan, { confirmed: true }, { run: fixtureRun })
  check('with the confirmation: the backup holds the old bytes, the plist holds the new, the two launchctl commands ran in order', applied.outcome === 'applied' && applied.restarted && applied.backupPath === `${PLIST_PATH}.bak` && readFileSync(`${PLIST_PATH}.bak`, 'utf8') === PLIST && readFileSync(PLIST_PATH, 'utf8') === EXPECTED && runs.join(' | ') === `launchctl bootout gui/501/com.example.ollama-ssd | launchctl bootstrap gui/501 ${PLIST_PATH}`, JSON.stringify([applied, runs]))
  const stale = await applyLocalServerPlan(plan, { confirmed: true }, { run: fixtureRun })
  check('the same plan again is stale (the file moved on): refused, no second write', stale.outcome === 'stale' && readFileSync(PLIST_PATH, 'utf8') === EXPECTED, JSON.stringify(stale))
  const truthAfter = await readLocalServerTruth(baseIo())
  const again = planLocalServerApply(truthAfter, settings, baseIo())
  check('after the write the file carries the values but the running server does not: the plan is a restart', again.kind === 'restart' && again.changes.length === 2, JSON.stringify(again))
  const satisfied = planLocalServerApply({ ...truthAfter, process: { pid: 1, command: 'ollama serve', envReadable: true, env: { OLLAMA_MAX_LOADED_MODELS: '2', OLLAMA_NUM_PARALLEL: '4' } } }, settings, baseIo())
  check('file and server both carrying the values: nothing to apply', satisfied.kind === 'nothing')
  check('no knob set: nothing to apply, the words point at the rows', planLocalServerApply(truth, {}, baseIo()).kind === 'nothing')
  runs.length = 0
  const failedRestart = await applyLocalServerPlan(planLocalServerApply(truthAfter, { ...settings, keepAlive: '-1' }, baseIo()), { confirmed: true }, { run: async (file, args) => { runs.push([file, ...args].join(' ')); return file === 'launchctl' && args[0] === 'bootstrap' ? undefined : '' }, sleep: async () => {} })
  check('a restart that fails is reported with the by-hand words; the bootstrap is retried four times', failedRestart.outcome === 'applied' && !failedRestart.restarted && failedRestart.restartWords.startsWith('restart did not complete; run by hand: launchctl bootout') && runs.filter(r => r.includes('bootstrap')).length === 4, JSON.stringify([failedRestart, runs]))
  check('the second backup does not clobber the first', existsSync(`${PLIST_PATH}.bak.1`) && readFileSync(`${PLIST_PATH}.bak.1`, 'utf8') === EXPECTED)
  const unwritable = planLocalServerApply({ ...truth, launchForm: { ...truth.launchForm, writable: false } }, settings, baseIo())
  check('an unwritable plist becomes by-hand with the exact key/string pairs', unwritable.kind === 'by-hand' && unwritable.lines.join(' ') === '<key>OLLAMA_MAX_LOADED_MODELS</key> <string>2</string> <key>OLLAMA_NUM_PARALLEL</key> <string>4</string>', JSON.stringify(unwritable))
  const appPlan = planLocalServerApply({ ...truth, launchForm: { kind: 'app', note: 'app' } }, { ...settings, keepAlive: '24h' }, baseIo())
  check('the Ollama app: an app plan with one launchctl setenv line per knob, every previous value unset', appPlan.kind === 'app' && appPlan.lines.join(' | ') === 'launchctl setenv OLLAMA_MAX_LOADED_MODELS 2 | launchctl setenv OLLAMA_NUM_PARALLEL 4 | launchctl setenv OLLAMA_KEEP_ALIVE 24h' && appPlan.revert.join(' | ') === 'launchctl unsetenv OLLAMA_KEEP_ALIVE | launchctl unsetenv OLLAMA_MAX_LOADED_MODELS | launchctl unsetenv OLLAMA_NUM_PARALLEL', JSON.stringify(appPlan))
  const winPlan = planLocalServerApply({ ...truth, machine: { platform: 'win32', totalMemoryBytes: 0 }, launchForm: { kind: 'windows', note: 'w' } }, settings, baseIo())
  check('Windows: by hand, setx per variable then restart from the tray', winPlan.kind === 'by-hand' && winPlan.lines[0] === 'setx OLLAMA_MAX_LOADED_MODELS "2"' && winPlan.lines.at(-1)?.includes('tray') === true)
  const otherPlan = planLocalServerApply({ ...truth, server: { kind: 'llamacpp', root: 'http://127.0.0.1:8080', label: 'llama.cpp b1' } }, settings, baseIo())
  check('a non-Ollama server: by hand, the flags where it is started', otherPlan.kind === 'by-hand' && otherPlan.note.startsWith('llama.cpp b1 takes these as start-up flags'))
  const brewText = '<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0">\n<dict>\n\t<key>Label</key>\n\t<string>homebrew.mxcl.ollama</string>\n\t<key>RunAtLoad</key>\n\t<true/>\n</dict>\n</plist>\n'
  const brewRewrite = rewritePlistEnvironment(brewText, { OLLAMA_NUM_PARALLEL: '4', OLLAMA_KEEP_ALIVE: '30m' })
  check('a plist without EnvironmentVariables gets the dict inserted under the top dict, keys sorted, values escaped', brewRewrite.text === '<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0">\n<dict>\n\t<key>EnvironmentVariables</key>\n\t<dict>\n\t\t<key>OLLAMA_KEEP_ALIVE</key>\n\t\t<string>30m</string>\n\t\t<key>OLLAMA_NUM_PARALLEL</key>\n\t\t<string>4</string>\n\t</dict>\n\t<key>Label</key>\n\t<string>homebrew.mxcl.ollama</string>\n\t<key>RunAtLoad</key>\n\t<true/>\n</dict>\n</plist>\n' && brewRewrite.lines.length === 7 && rewritePlistEnvironment(brewText, { OLLAMA_MODELS: '/a&b' }).text.includes('<string>/a&amp;b</string>'), brewRewrite.text)
  const sysd = rewriteSystemdOverride('[Service]\nEnvironment="OLLAMA_HOST=0.0.0.0"\nEnvironment="OLLAMA_MAX_LOADED_MODELS=1"\n', { OLLAMA_MAX_LOADED_MODELS: '3', OLLAMA_CONTEXT_LENGTH: '32768' })
  check('a systemd override: the existing Environment= line is replaced, the new one appended inside [Service]', sysd.text === '[Service]\nEnvironment="OLLAMA_HOST=0.0.0.0"\nEnvironment="OLLAMA_MAX_LOADED_MODELS=3"\nEnvironment="OLLAMA_CONTEXT_LENGTH=32768"\n' && JSON.stringify(sysd.lines) === JSON.stringify(['+Environment="OLLAMA_CONTEXT_LENGTH=32768"', '-Environment="OLLAMA_MAX_LOADED_MODELS=1"', '+Environment="OLLAMA_MAX_LOADED_MODELS=3"']), JSON.stringify(sysd))
  check('an empty override starts with [Service]', rewriteSystemdOverride('', { OLLAMA_NUM_PARALLEL: '2' }).text === '[Service]\nEnvironment="OLLAMA_NUM_PARALLEL=2"\n')
  check('systemd by-hand lines name systemctl edit, the lines and the restart', byHandLines('systemd', { OLLAMA_NUM_PARALLEL: '2' }).join(' | ') === 'sudo systemctl edit ollama.service | [Service] | Environment="OLLAMA_NUM_PARALLEL=2" | sudo systemctl daemon-reload && sudo systemctl restart ollama.service')
  const realHome = process.env.HOME ?? ''
  check('every path the plans touched lies under the scratch home, never the real launch agents folder', plan.path.startsWith(HOME) && plan.backupPath.startsWith(HOME) && (realHome === '' || !plan.path.startsWith(join(realHome, 'Library'))))
}

section("8 · the Ollama app road: launchctl setenv per knob, quit, wait for the port to close, open, wait for /api/version — nothing without the confirmation")
{
  const { APP_QUIT_ARGV, APP_OPEN_ARGV, appRevertLines } = modules.apply
  const appTruth: Truth = { ...truth, launchForm: { kind: 'app', env: { OLLAMA_MAX_LOADED_MODELS: '1' }, writable: true, note: 'app' } }
  const appPlan = planLocalServerApply(appTruth, { maxLoadedModels: 2, parallelSlots: 4 }, baseIo())
  check('the plan is the app kind with the exact launchctl setenv lines and the previous values recorded (the revert road)', appPlan.kind === 'app' && JSON.stringify(appPlan.lines) === JSON.stringify(['launchctl setenv OLLAMA_MAX_LOADED_MODELS 2', 'launchctl setenv OLLAMA_NUM_PARALLEL 4']) && JSON.stringify(appPlan.previous) === JSON.stringify({ OLLAMA_MAX_LOADED_MODELS: '1', OLLAMA_NUM_PARALLEL: undefined }) && JSON.stringify(appPlan.revert) === JSON.stringify(['launchctl setenv OLLAMA_MAX_LOADED_MODELS 1', 'launchctl unsetenv OLLAMA_NUM_PARALLEL']), JSON.stringify(appPlan))
  if (appPlan.kind !== 'app') finish()
  check('the steps shown: the two lines, the quit, the wait for the port to close, the open, the wait for /api/version', JSON.stringify(appPlan.steps) === JSON.stringify(['launchctl setenv OLLAMA_MAX_LOADED_MODELS 2', 'launchctl setenv OLLAMA_NUM_PARALLEL 4', 'osascript -e tell application "Ollama" to quit', `wait for ${ollama.root.replace(/^https?:\/\//, '')} to close`, 'open -a Ollama', 'wait for /api/version to answer']) && appPlan.restart.argv.length === 2 && appPlan.restart.argv[0] === APP_QUIT_ARGV && appPlan.restart.argv[1] === APP_OPEN_ARGV, JSON.stringify(appPlan.steps))
  check('planWords names the app restart and the review door', planWords(appPlan) === '2 changes + the app restarts · → reviews the lines first')
  runs.length = 0
  const probes: string[] = []
  const refusedApp = await applyLocalServerPlan(appPlan, { confirmed: false }, { run: fixtureRun, probe: async url => { probes.push(url); return true }, sleep: async () => {} })
  check('without the confirmation nothing is set, nothing quit, nothing opened, nothing probed', refusedApp.outcome === 'refused' && runs.length === 0 && probes.length === 0, JSON.stringify(refusedApp))
  let answers = [true, true, false, false, false, true]
  let clock = 0
  const appliedApp = await applyLocalServerPlan(appPlan, { confirmed: true }, { run: fixtureRun, probe: async url => { probes.push(url); return answers.shift() ?? true }, sleep: async ms => { clock += ms }, now: () => clock })
  check('with the confirmation: setenv ×2, then the quit, the port polled until closed, the open, the port polled until up — in that order', runs.join(' | ') === 'launchctl setenv OLLAMA_MAX_LOADED_MODELS 2 | launchctl setenv OLLAMA_NUM_PARALLEL 4 | osascript -e tell application "Ollama" to quit | open -a Ollama' && probes.length === 6 && probes.every(url => url === `${ollama.root}/api/version`), JSON.stringify([runs, probes]))
  check('the outcome: applied, restarted, the revert road carried', appliedApp.outcome === 'applied' && appliedApp.restarted && appliedApp.restartWords === appPlan.restart.words && JSON.stringify(appliedApp.revert) === JSON.stringify(appPlan.revert), JSON.stringify(appliedApp))
  runs.length = 0
  answers = []
  clock = 0
  const neverClosed = await applyLocalServerPlan(appPlan, { confirmed: true }, { run: fixtureRun, probe: async () => true, sleep: async ms => { clock += ms }, now: () => clock })
  check('an app that never closes: the variables stay set, the wait gives up within its budget, the words say quit and open by hand, the open never runs', neverClosed.outcome === 'applied' && !neverClosed.restarted && neverClosed.restartWords.includes('did not close within 20 s') && !runs.some(r => r.startsWith('open')) && clock <= 21_000, JSON.stringify([neverClosed, runs, clock]))
  const setenvFails = await applyLocalServerPlan(appPlan, { confirmed: true }, { run: async (file, args) => (file === 'launchctl' && args[0] === 'setenv' && args[1] === 'OLLAMA_NUM_PARALLEL' ? undefined : fixtureRun(file, args)), probe: async () => true, sleep: async () => {} })
  check('a failing setenv stops before any restart and names the knob', setenvFails.outcome === 'failed' && setenvFails.reason.startsWith('launchctl setenv OLLAMA_NUM_PARALLEL failed'))
  const appSatisfied = planLocalServerApply({ ...appTruth, launchForm: { ...appTruth.launchForm, env: { OLLAMA_MAX_LOADED_MODELS: '2', OLLAMA_NUM_PARALLEL: '4' } }, process: { ...appTruth.process!, env: { ...appTruth.process!.env, OLLAMA_MAX_LOADED_MODELS: '1' } } }, { maxLoadedModels: 2, parallelSlots: 4 }, baseIo())
  check('launchctl already carrying the values while the running app lacks them: a restart-only plan for the app', appSatisfied.kind === 'restart' && appSatisfied.form === 'app' && appSatisfied.root === ollama.root, JSON.stringify(appSatisfied))
  check('appRevertLines: unset before → unsetenv; a value before → setenv back', JSON.stringify(appRevertLines({ B: undefined, A: '3' })) === JSON.stringify(['launchctl setenv A 3', 'launchctl unsetenv B']))
}

section('9 · an over-memory choice refuses the apply with the figures; a fitting choice passes')
{
  const tooMuch = planLocalServerApply(truth, { maxLoadedModels: 2, parallelSlots: 4, contextLength: 262144 }, baseIo())
  check('the plan is refused with the figures and the models named', tooMuch.kind === 'refused' && tooMuch.fit.words === 'does not fit · 73.4 of 36.9 GiB usable with qwen3.5:27b and qwen3.5:9b-q4_K_M loaded — lower the window or the count' && planWords(tooMuch) === 'does not fit · 73.4 of 36.9 GiB usable — lower the window or the count', JSON.stringify(tooMuch))
  runs.length = 0
  const forced = await applyLocalServerPlan(tooMuch, { confirmed: true }, { run: fixtureRun })
  check('even a confirmed apply of a refused plan writes nothing, runs nothing, and repeats the figures', forced.outcome === 'refused' && forced.reason.startsWith('does not fit · 73.4 of 36.9 GiB usable') && runs.length === 0 && readFileSync(PLIST_PATH, 'utf8').includes('<string>4</string>'), JSON.stringify(forced))
  const fitting = planLocalServerApply(truth, { maxLoadedModels: 1, parallelSlots: 1, contextLength: 262144 }, baseIo())
  check('one model, one 256k slot: 24.7 of 36.9 GiB fits and the plan writes', fitting.kind === 'write' && fitting.changes.map(c => `${c.name}=${c.after}`).join(',') === 'OLLAMA_NUM_PARALLEL=1', JSON.stringify(fitting.kind === 'write' ? fitting.changes : fitting))
  const appOver = planLocalServerApply({ ...truth, launchForm: { kind: 'app', env: {}, writable: true, note: 'app' } }, { maxLoadedModels: 2, parallelSlots: 4, contextLength: 262144 }, baseIo())
  check('the app form refuses the same choice the same way', appOver.kind === 'refused')
}

section('10 · the bounded cache: one snapshot, a TTL, subscribers')
{
  __resetLocalServerTruthForTest()
  let ticks = 0
  const { subscribeLocalServerTruth } = modules.truth
  const off = subscribeLocalServerTruth(() => { ticks++ })
  let clock = 1_800_000_000_000
  const io = { ...baseIo(), now: () => clock }
  const first = await refreshLocalServerTruth(io)
  const second = await refreshLocalServerTruth(io)
  clock += 20_000
  const third = await refreshLocalServerTruth(io)
  off()
  check('inside the TTL the same snapshot serves; past it a fresh read lands and the subscriber hears each landing', first === second && third !== first && cachedLocalServerTruth() === third && ticks === 2, `${ticks} ticks`)
}

ollama.server.close()
rmSync(HOME, { recursive: true, force: true })
finish()
