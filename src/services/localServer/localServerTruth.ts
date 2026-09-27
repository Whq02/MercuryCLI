import { execFile } from 'node:child_process'
import { accessSync, constants, existsSync, readdirSync, readFileSync } from 'node:fs'
import { homedir, totalmem, userInfo } from 'node:os'
import { dirname, join } from 'node:path'
import { fetchWithProviderDeadline } from '../providers/fetchDeadline.js'
import { localProbeTargets, type LocalServerKind } from '../providers/local/localDiscovery.js'
import { getApiFetch } from '../../utils/proxy.js'
import { getUserAgent } from '../../utils/http.js'
import { kvGeometryOf, type KvGeometry } from './localServerMemory.js'

export type { LocalServerKind }

export type LaunchFormKind = 'launch-agent' | 'homebrew' | 'app' | 'systemd' | 'windows' | 'unknown'

export const LOCAL_SERVER_READ_TIMEOUT_MS = 900
export const LOCAL_SERVER_EXEC_TIMEOUT_MS = 4_000
export const LOCAL_SERVER_SHOW_BOUND = 8
export const HOMEBREW_OLLAMA_PLIST = 'homebrew.mxcl.ollama.plist'
export const SYSTEMD_OLLAMA_OVERRIDE = '/etc/systemd/system/ollama.service.d/override.conf'
export const SYSTEMD_OLLAMA_UNITS = ['/etc/systemd/system/ollama.service', '/lib/systemd/system/ollama.service', '/usr/lib/systemd/system/ollama.service']

export interface LocalServerIo {
  env?: NodeJS.ProcessEnv
  fetchImpl?: typeof fetch
  timeoutMs?: number
  now?: () => number
  platform?: NodeJS.Platform
  home?: string
  uid?: number
  totalMemoryBytes?: number
  readText?: (path: string) => string | undefined
  listDir?: (path: string) => string[]
  pathExists?: (path: string) => boolean
  writable?: (path: string) => boolean
  run?: (file: string, args: string[]) => Promise<string | undefined>
}

export interface LoadedModelTruth {
  name: string
  sizeBytes?: number
  sizeVramBytes?: number
  contextLength?: number
  expiresAt?: string
  parameterSize?: string
  quantization?: string
}

export interface ListedModelTruth {
  name: string
  sizeBytes?: number
  parameterSize?: string
  quantization?: string
  family?: string
  trainedContext?: number
  geometry?: KvGeometry
}

export interface RunnerTruth {
  pid?: number
  command: string
  slots?: number
  context?: number
  cacheTypeK?: string
  cacheTypeV?: string
  flashAttention?: string
  maxModelLength?: number
  maxSequences?: number
}

export interface ServerProcessTruth {
  pid: number
  command: string
  env: Record<string, string>
  envReadable: boolean
}

export interface LaunchFormTruth {
  kind: LaunchFormKind
  path?: string
  label?: string
  env?: Record<string, string>
  writable?: boolean
  confirmed?: boolean
  note: string
}

export interface LocalServerTruth {
  server?: { kind: LocalServerKind; root: string; version?: string; label: string }
  loaded: LoadedModelTruth[]
  listed: ListedModelTruth[]
  process?: ServerProcessTruth
  runners: RunnerTruth[]
  launchForm: LaunchFormTruth
  machine: { platform: NodeJS.Platform; totalMemoryBytes: number }
  readAtMs: number
}

const OLLAMA_ENV_NAME = /^OLLAMA_[A-Z0-9_]+$/
const ENV_TOKEN = /(OLLAMA_[A-Z0-9_]+)=(.*?)(?= [A-Za-z_][A-Za-z0-9_]*=|$)/g

function rec(v: unknown): Record<string, unknown> | undefined {
  return typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : undefined
}
function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() !== '' ? v : undefined
}
function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : undefined
}
function list(v: unknown): Record<string, unknown>[] {
  return Array.isArray(v) ? v.map(rec).filter((m): m is Record<string, unknown> => m !== undefined) : []
}

function defaultRun(file: string, args: string[]): Promise<string | undefined> {
  return new Promise(resolve => {
    try {
      execFile(file, args, { timeout: LOCAL_SERVER_EXEC_TIMEOUT_MS, maxBuffer: 1 << 22, windowsHide: true }, (error, stdout) => {
        resolve(error ? undefined : String(stdout))
      })
    } catch {
      resolve(undefined)
    }
  })
}
function defaultReadText(path: string): string | undefined {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return undefined
  }
}
function defaultListDir(path: string): string[] {
  try {
    return readdirSync(path)
  } catch {
    return []
  }
}
function defaultWritable(path: string): boolean {
  try {
    accessSync(existsSync(path) ? path : dirname(path), constants.W_OK)
    return true
  } catch {
    return false
  }
}
function defaultUid(): number | undefined {
  try {
    const uid = userInfo().uid
    return uid >= 0 ? uid : undefined
  } catch {
    return undefined
  }
}

export function resolveLocalServerIo(io: LocalServerIo): Required<Omit<LocalServerIo, 'uid'>> & { uid?: number } {
  return {
    env: io.env ?? process.env,
    fetchImpl: io.fetchImpl ?? getApiFetch(),
    timeoutMs: io.timeoutMs ?? LOCAL_SERVER_READ_TIMEOUT_MS,
    now: io.now ?? Date.now,
    platform: io.platform ?? process.platform,
    home: io.home ?? homedir(),
    uid: io.uid ?? defaultUid(),
    totalMemoryBytes: io.totalMemoryBytes ?? totalmem(),
    readText: io.readText ?? defaultReadText,
    listDir: io.listDir ?? defaultListDir,
    pathExists: io.pathExists ?? (path => existsSync(path)),
    writable: io.writable ?? defaultWritable,
    run: io.run ?? defaultRun,
  }
}

type Io = ReturnType<typeof resolveLocalServerIo>

async function readJson(io: Io, url: string, body?: unknown): Promise<unknown | undefined> {
  try {
    const response = await fetchWithProviderDeadline(io.fetchImpl, 'local', io.timeoutMs, url, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { accept: 'application/json', 'user-agent': getUserAgent(), ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    } as RequestInit)
    if (!response.ok) return undefined
    return (await response.json()) as unknown
  } catch {
    return undefined
  }
}

export function parseOllamaPs(body: unknown): LoadedModelTruth[] {
  const out: LoadedModelTruth[] = []
  for (const m of list(rec(body)?.models)) {
    const name = str(m.model) ?? str(m.name)
    if (!name) continue
    const details = rec(m.details)
    out.push({
      name,
      ...(num(m.size) !== undefined ? { sizeBytes: num(m.size)! } : {}),
      ...(typeof m.size_vram === 'number' && Number.isFinite(m.size_vram) ? { sizeVramBytes: m.size_vram } : {}),
      ...(num(m.context_length) !== undefined ? { contextLength: num(m.context_length)! } : {}),
      ...(str(m.expires_at) ? { expiresAt: str(m.expires_at)! } : {}),
      ...(str(details?.parameter_size) ? { parameterSize: str(details?.parameter_size)! } : {}),
      ...(str(details?.quantization_level) ? { quantization: str(details?.quantization_level)! } : {}),
    })
  }
  return out
}

export function parseOllamaTags(body: unknown): ListedModelTruth[] {
  const out: ListedModelTruth[] = []
  for (const m of list(rec(body)?.models)) {
    const name = str(m.model) ?? str(m.name)
    if (!name) continue
    const details = rec(m.details)
    out.push({
      name,
      ...(num(m.size) !== undefined ? { sizeBytes: num(m.size)! } : {}),
      ...(str(details?.parameter_size) ? { parameterSize: str(details?.parameter_size)! } : {}),
      ...(str(details?.quantization_level) ? { quantization: str(details?.quantization_level)! } : {}),
      ...(str(details?.family) ? { family: str(details?.family)! } : {}),
      ...(num(details?.context_length) !== undefined ? { trainedContext: num(details?.context_length)! } : {}),
    })
  }
  return out
}

function flagValue(argv: string[], names: string[]): string | undefined {
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i] ?? ''
    for (const name of names) {
      if (token === name) return argv[i + 1]
      if (token.startsWith(`${name}=`)) return token.slice(name.length + 1)
    }
  }
  return undefined
}

function flagNumber(argv: string[], names: string[]): number | undefined {
  const raw = flagValue(argv, names)
  if (raw === undefined) return undefined
  const n = Number(raw)
  return Number.isFinite(n) && n > 0 ? n : undefined
}

export function parseRunnerCommand(command: string, pid?: number): RunnerTruth | undefined {
  const argv = command.trim().split(/\s+/)
  const program = argv[0] ?? ''
  const isRunner = /llama-server|ollama_llama_server|ollama_runners/.test(program) || (/(^|[\\/])ollama(\.exe)?$/.test(program) && argv[1] === 'runner')
  if (!isRunner) return undefined
  const slots = flagNumber(argv, ['-np', '--parallel'])
  const context = flagNumber(argv, ['-c', '--ctx-size'])
  const cacheTypeK = flagValue(argv, ['--cache-type-k', '-ctk'])
  const cacheTypeV = flagValue(argv, ['--cache-type-v', '-ctv'])
  const flashAttention = flagValue(argv, ['--flash-attn', '-fa'])
  const maxModelLength = flagNumber(argv, ['--max-model-len'])
  const maxSequences = flagNumber(argv, ['--max-num-seqs'])
  return {
    ...(pid !== undefined ? { pid } : {}),
    command,
    ...(slots !== undefined ? { slots } : {}),
    ...(context !== undefined ? { context } : {}),
    ...(cacheTypeK ? { cacheTypeK } : {}),
    ...(cacheTypeV ? { cacheTypeV } : {}),
    ...(flashAttention ? { flashAttention } : {}),
    ...(maxModelLength !== undefined ? { maxModelLength } : {}),
    ...(maxSequences !== undefined ? { maxSequences } : {}),
  }
}

export function parseOllamaEnvLine(text: string): Record<string, string> {
  const env: Record<string, string> = {}
  for (const match of text.trim().matchAll(ENV_TOKEN)) {
    const name = match[1] ?? ''
    if (OLLAMA_ENV_NAME.test(name) && !(name in env)) env[name] = (match[2] ?? '').trim()
  }
  return env
}

export function parseEnvironBlock(text: string): Record<string, string> {
  const env: Record<string, string> = {}
  for (const entry of text.split('\0')) {
    const eq = entry.indexOf('=')
    if (eq <= 0) continue
    const name = entry.slice(0, eq)
    if (OLLAMA_ENV_NAME.test(name)) env[name] = entry.slice(eq + 1)
  }
  return env
}

export interface ProcessRow {
  pid: number
  ppid: number
  command: string
}

export function parseProcessTable(text: string): ProcessRow[] {
  const rows: ProcessRow[] = []
  for (const line of text.split('\n')) {
    const match = /^\s*(\d+)\s+(\d+)\s+(.+?)\s*$/.exec(line)
    if (!match) continue
    rows.push({ pid: Number(match[1]), ppid: Number(match[2]), command: match[3] ?? '' })
  }
  return rows
}

export function isServerCommand(command: string, kind: LocalServerKind | undefined): boolean {
  if (kind === 'ollama' || kind === undefined) {
    if (/(^|[\\/\s])ollama(\.exe)?(\s+|$).*\bserve\b/i.test(command) || /Ollama\.app\/Contents\/Resources\/ollama\b/.test(command)) return true
  }
  if (kind === 'llamacpp' || kind === undefined) {
    if (/llama-server/.test(command) && !/ollama/i.test(command)) return true
  }
  if (kind === 'vllm' || kind === undefined) {
    if (/vllm(\.entrypoints\.openai\.api_server| serve)/.test(command)) return true
  }
  if (kind === 'lmstudio' || kind === undefined) {
    if (/LM Studio.*(lms|llmster|server)/i.test(command)) return true
  }
  return false
}

export function findServerProcess(rows: ProcessRow[], kind: LocalServerKind | undefined): { server?: ProcessRow; runners: ProcessRow[] } {
  const server = rows.find(row => isServerCommand(row.command, kind))
  if (!server) return { runners: rows.filter(row => parseRunnerCommand(row.command) !== undefined) }
  if (kind === 'llamacpp' || (kind === undefined && /llama-server/.test(server.command) && !/ollama/i.test(server.command))) return { server, runners: [server] }
  const runners = rows.filter(row => row.ppid === server.pid && parseRunnerCommand(row.command) !== undefined)
  return { server, runners }
}

async function readProcessTruth(io: Io, kind: LocalServerKind | undefined): Promise<{ process?: ServerProcessTruth; runners: RunnerTruth[] }> {
  if (io.platform === 'win32') return { runners: [] }
  const table = await io.run('ps', ['-axo', 'pid=,ppid=,command='])
  if (table === undefined) return { runners: [] }
  const found = findServerProcess(parseProcessTable(table), kind)
  const runners = found.runners.map(row => parseRunnerCommand(row.command, row.pid)).filter((r): r is RunnerTruth => r !== undefined)
  if (!found.server) return { runners }
  let env: Record<string, string> = {}
  let envReadable = false
  if (io.platform === 'linux') {
    const environ = io.readText(`/proc/${found.server.pid}/environ`)
    if (environ !== undefined) {
      env = parseEnvironBlock(environ)
      envReadable = true
    }
  } else {
    const line = await io.run('ps', ['-Eo', 'command=', '-p', String(found.server.pid)])
    if (line !== undefined) {
      env = parseOllamaEnvLine(line)
      envReadable = Object.keys(env).length > 0 || /\s[A-Za-z_][A-Za-z0-9_]*=/.test(line.replace(found.server.command, ''))
    }
  }
  return { process: { pid: found.server.pid, command: found.server.command, env, envReadable }, runners }
}

export interface PlistFacts {
  label?: string
  programArguments: string[]
  env: Record<string, string>
}

export function parsePlist(text: string): PlistFacts {
  const facts: PlistFacts = { programArguments: [], env: {} }
  const label = /<key>Label<\/key>\s*<string>([^<]*)<\/string>/.exec(text)
  if (label?.[1]) facts.label = label[1].trim()
  const args = /<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/.exec(text)
  if (args?.[1]) facts.programArguments = [...args[1].matchAll(/<string>([^<]*)<\/string>/g)].map(m => (m[1] ?? '').trim())
  const env = /<key>EnvironmentVariables<\/key>\s*<dict>([\s\S]*?)<\/dict>/.exec(text)
  if (env?.[1]) {
    for (const pair of env[1].matchAll(/<key>([^<]+)<\/key>\s*<string>([^<]*)<\/string>/g)) facts.env[(pair[1] ?? '').trim()] = pair[2] ?? ''
  }
  return facts
}

export function parseSystemdOverride(text: string): Record<string, string> {
  const env: Record<string, string> = {}
  for (const line of text.split('\n')) {
    const match = /^\s*Environment\s*=\s*(.*?)\s*$/.exec(line)
    if (!match) continue
    for (const token of (match[1] ?? '').matchAll(/"([^"=]+)=([^"]*)"|(\S+?)=(\S*)/g)) {
      const name = token[1] ?? token[3] ?? ''
      const value = token[2] ?? token[4] ?? ''
      if (name) env[name] = value
    }
  }
  return env
}

function plistMentionsOllama(facts: PlistFacts, text: string): boolean {
  if (/ollama/i.test(facts.label ?? '')) return true
  if (facts.programArguments.some(arg => /ollama/i.test(arg))) return true
  if (Object.keys(facts.env).some(name => name === 'OLLAMA_HOST' || name === 'OLLAMA_MODELS')) return true
  return /ollama serve/i.test(text)
}

async function readLaunchForm(io: Io, kind: LocalServerKind | undefined, serverProcess: ServerProcessTruth | undefined): Promise<LaunchFormTruth> {
  if (kind !== undefined && kind !== 'ollama') {
    return { kind: 'unknown', note: 'the knobs are start-up flags on this server; set them where it is started' }
  }
  if (io.platform === 'darwin') {
    if (serverProcess && /\.app\//.test(serverProcess.command)) {
      return { kind: 'app', note: 'the Ollama app owns its server: set each variable with launchctl setenv, then quit and reopen the app' }
    }
    const agents = join(io.home, 'Library', 'LaunchAgents')
    const names = io.listDir(agents).filter(name => name.endsWith('.plist'))
    const homebrew = names.find(name => name === HOMEBREW_OLLAMA_PLIST)
    const candidates = homebrew ? [homebrew, ...names.filter(name => name !== homebrew)] : names
    for (const name of candidates) {
      const path = join(agents, name)
      const text = io.readText(path)
      if (text === undefined) continue
      const facts = parsePlist(text)
      if (!plistMentionsOllama(facts, text)) continue
      const isHomebrew = name === HOMEBREW_OLLAMA_PLIST
      let confirmed: boolean | undefined
      if (facts.label && io.uid !== undefined && serverProcess) {
        const printed = await io.run('launchctl', ['print', `gui/${io.uid}/${facts.label}`])
        if (printed !== undefined) confirmed = new RegExp(`\\bpid = ${serverProcess.pid}\\b`).test(printed)
      }
      return {
        kind: isHomebrew ? 'homebrew' : 'launch-agent',
        path,
        ...(facts.label ? { label: facts.label } : {}),
        env: facts.env,
        writable: io.writable(path),
        ...(confirmed !== undefined ? { confirmed } : {}),
        note: isHomebrew
          ? 'Homebrew service: the environment is written into its plist and the agent is restarted; brew services restart or an upgrade rewrites this file'
          : 'launch agent: the environment is written into its EnvironmentVariables and the agent is restarted',
      }
    }
    if (io.pathExists('/Applications/Ollama.app') || io.pathExists(join(io.home, 'Applications', 'Ollama.app'))) {
      return { kind: 'app', note: 'the Ollama app owns its server: set each variable with launchctl setenv, then quit and reopen the app' }
    }
    return { kind: 'unknown', note: 'no launch agent or app found: set the variables where ollama serve is started' }
  }
  if (io.platform === 'linux') {
    if (SYSTEMD_OLLAMA_UNITS.some(path => io.pathExists(path))) {
      const text = io.readText(SYSTEMD_OLLAMA_OVERRIDE)
      return {
        kind: 'systemd',
        path: SYSTEMD_OLLAMA_OVERRIDE,
        label: 'ollama.service',
        env: text === undefined ? {} : parseSystemdOverride(text),
        writable: io.writable(SYSTEMD_OLLAMA_OVERRIDE),
        note: 'systemd service: Environment= lines in the override, then daemon-reload and a restart',
      }
    }
    return { kind: 'unknown', note: 'no systemd unit found: set the variables where ollama serve is started' }
  }
  if (io.platform === 'win32') {
    return { kind: 'windows', note: 'Windows: set each variable as a user environment variable, then quit Ollama from the tray and start it again' }
  }
  return { kind: 'unknown', note: 'set the variables where ollama serve is started' }
}

async function readOllama(io: Io, root: string): Promise<Pick<LocalServerTruth, 'server' | 'loaded' | 'listed'> | undefined> {
  const [version, ps, tags] = await Promise.all([readJson(io, `${root}/api/version`), readJson(io, `${root}/api/ps`), readJson(io, `${root}/api/tags`)])
  if (version === undefined && ps === undefined && tags === undefined) return undefined
  const v = str(rec(version)?.version)
  const listed = parseOllamaTags(tags)
  const loaded = parseOllamaPs(ps)
  const loadedNames = new Set(loaded.map(m => m.name))
  const ordered = [...listed.filter(m => loadedNames.has(m.name)), ...listed.filter(m => !loadedNames.has(m.name))].slice(0, LOCAL_SERVER_SHOW_BOUND)
  await Promise.all(
    ordered.map(async model => {
      const show = rec(await readJson(io, `${root}/api/show`, { model: model.name }))
      const info = rec(show?.model_info)
      if (!info) return
      const geometry = kvGeometryOf(info)
      if (geometry) model.geometry = geometry
      const arch = str(info['general.architecture'])
      const trained = arch ? num(info[`${arch}.context_length`]) : undefined
      if (trained !== undefined && model.trainedContext === undefined) model.trainedContext = trained
    }),
  )
  return { server: { kind: 'ollama', root, ...(v ? { version: v } : {}), label: v ? `Ollama ${v}` : 'Ollama' }, loaded, listed }
}

async function readOther(io: Io, kind: LocalServerKind, root: string): Promise<Pick<LocalServerTruth, 'server' | 'loaded' | 'listed'> | undefined> {
  if (kind === 'lmstudio') {
    const body = rec(await readJson(io, `${root}/api/v1/models`))
    if (!body) return undefined
    const loaded: LoadedModelTruth[] = []
    const listed: ListedModelTruth[] = []
    for (const m of list(body.models)) {
      const name = str(m.key)
      if (!name || str(m.type) === 'embedding') continue
      listed.push({ name, ...(num(m.size_bytes) !== undefined ? { sizeBytes: num(m.size_bytes)! } : {}), ...(num(m.max_context_length) !== undefined ? { trainedContext: num(m.max_context_length)! } : {}) })
      for (const instance of list(m.loaded_instances)) {
        const ctx = num(rec(instance.config)?.context_length)
        loaded.push({ name, ...(ctx !== undefined ? { contextLength: ctx } : {}) })
      }
    }
    return { server: { kind, root, label: 'LM Studio' }, loaded, listed }
  }
  if (kind === 'vllm') {
    const body = rec(await readJson(io, `${root}/v1/models`))
    if (!body) return undefined
    const version = str(rec(await readJson(io, `${root}/version`))?.version)
    const loaded = list(body.data).flatMap(m => (str(m.id) ? [{ name: str(m.id)!, ...(num(m.max_model_len) !== undefined ? { contextLength: num(m.max_model_len)! } : {}) }] : []))
    return { server: { kind, root, ...(version ? { version } : {}), label: version ? `vLLM ${version}` : 'vLLM' }, loaded, listed: loaded.map(m => ({ name: m.name })) }
  }
  if (kind === 'llamacpp') {
    const props = rec(await readJson(io, `${root}/props`))
    if (!props) return undefined
    const build = str(props.build_info)
    const ctx = num(rec(props.default_generation_settings)?.n_ctx)
    const name = str(props.model_path)?.split('/').pop()
    const loaded = name ? [{ name, ...(ctx !== undefined ? { contextLength: ctx } : {}) }] : []
    return { server: { kind, root, ...(build ? { version: build } : {}), label: build ? `llama.cpp ${build}` : 'llama.cpp' }, loaded, listed: loaded.map(m => ({ name: m.name })) }
  }
  return undefined
}

export function localServerProbingOff(env: NodeJS.ProcessEnv = process.env): boolean {
  return localProbeTargets(env).length === 0
}

export async function readLocalServerTruth(seam: LocalServerIo = {}): Promise<LocalServerTruth> {
  const io = resolveLocalServerIo(seam)
  const targets = localProbeTargets(io.env)
  if (targets.length === 0) {
    return { loaded: [], listed: [], runners: [], launchForm: { kind: 'unknown', note: 'probing is off (MERCURY_LOCAL_PROBE_TARGETS=none): nothing read' }, machine: { platform: io.platform, totalMemoryBytes: io.totalMemoryBytes }, readAtMs: io.now() }
  }
  let facts: Pick<LocalServerTruth, 'server' | 'loaded' | 'listed'> | undefined
  for (const target of targets) {
    try {
      facts = target.kind === 'ollama' || target.kind === 'openai-compatible' ? await readOllama(io, target.root) : await readOther(io, target.kind, target.root)
    } catch {
      facts = undefined
    }
    if (facts) break
  }
  const kind = facts?.server?.kind
  let processTruth: { process?: ServerProcessTruth; runners: RunnerTruth[] } = { runners: [] }
  try {
    processTruth = await readProcessTruth(io, kind)
  } catch {
    processTruth = { runners: [] }
  }
  let launchForm: LaunchFormTruth = { kind: 'unknown', note: 'set the variables where the server is started' }
  try {
    launchForm = await readLaunchForm(io, kind, processTruth.process)
  } catch {
    launchForm = { kind: 'unknown', note: 'the launch form could not be read' }
  }
  return {
    ...(facts?.server ? { server: facts.server } : {}),
    loaded: facts?.loaded ?? [],
    listed: facts?.listed ?? [],
    ...(processTruth.process ? { process: processTruth.process } : {}),
    runners: processTruth.runners,
    launchForm,
    machine: { platform: io.platform, totalMemoryBytes: io.totalMemoryBytes },
    readAtMs: io.now(),
  }
}

export const LOCAL_SERVER_TRUTH_TTL_MS = 15_000

let cached: LocalServerTruth | null = null
let inFlight: Promise<LocalServerTruth> | null = null
let stamp = 0
const listeners = new Set<() => void>()

export function cachedLocalServerTruth(): LocalServerTruth | null {
  return cached
}

export function localServerTruthStamp(): number {
  return stamp
}

export function subscribeLocalServerTruth(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

let pinned: LocalServerTruth | null = null

export function __pinLocalServerTruthForTest(truth: LocalServerTruth | null): void {
  pinned = truth
  cached = truth
  stamp++
  for (const listener of listeners) listener()
}

export function refreshLocalServerTruth(opts?: LocalServerIo & { force?: boolean }): Promise<LocalServerTruth> {
  const now = opts?.now ?? Date.now
  if (pinned) return Promise.resolve(pinned)
  if (!opts?.force && cached && now() - cached.readAtMs < LOCAL_SERVER_TRUTH_TTL_MS) return Promise.resolve(cached)
  if (inFlight) return inFlight
  const { force: _force, ...io } = opts ?? {}
  inFlight = (async (): Promise<LocalServerTruth> => {
    try {
      const truth = await readLocalServerTruth(io)
      cached = truth
      stamp++
      for (const listener of listeners) listener()
      return truth
    } finally {
      inFlight = null
    }
  })()
  return inFlight
}

export function __resetLocalServerTruthForTest(): void {
  cached = null
  inFlight = null
  pinned = null
}
