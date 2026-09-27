import type { LocalServerKind } from '../providers/local/localDiscovery.js'
import type { ModelTransitionReceipt } from '../../utils/model/modelTransition.js'

export const SETUP_MODEL_TAG = 'qwen3.5:9b'
export const SETUP_MODEL_ID = 'local/qwen3.5:9b'
export const SETUP_MODEL_LIBRARY_SIZE_WORDS = '6.6 GB'
export const SETUP_PROVE_PROMPT = 'reply with the single word ready'
export const SETUP_PROVE_MAX_TOKENS = 64
export const SETUP_KEYS_LINE = '↵ run · s skip · esc stop'
export const SETUP_WINDOW_LADDER: readonly number[] = [32_768, 65_536, 131_072, 262_144]
export const SETUP_USABLE_FRACTION = 0.9
export const SETUP_START_WAIT_MS = 60_000
export const SETUP_START_POLL_MS = 500
export const SETUP_INSTALL_WAIT_MS = 600_000
export const SETUP_INSTALL_POLL_MS = 1_000
export const SETUP_READ_TIMEOUT_MS = 900
export const SETUP_PULL_IDLE_MS = 120_000
export const SETUP_EXEC_TIMEOUT_MS = 30 * 60_000
export const SETUP_SERVE_LOG = 'local-setup/ollama-serve.log'

export type SetupPlatform = 'darwin' | 'linux' | 'win32'
export type SetupServerKind = LocalServerKind | 'none'
export type OllamaInstallForm = 'path' | 'app' | 'brew' | 'systemd' | 'windows' | 'none'
export type InstallVia = 'brew' | 'dmg' | 'script' | 'exe'
export type SetupStepNumber = 1 | 2 | 3 | 4 | 5 | 6
export type SetupStepLabel = '1' | '2' | '2b' | '3' | '4' | '5' | '6'
export type SetupStepKind = 'find-server' | 'find-ollama' | 'install' | 'start' | 'pull' | 'window' | 'prove'
export type SetupConsent = 'run' | 'skip' | 'stop'

export interface ExecResult {
  rc: number
  stdout: string
  stderr: string
  lastLine: string
  pid?: number
  detached?: boolean
}

export interface ExecOptions {
  detached?: boolean
  logPath?: string
  timeoutMs?: number
  cwd?: string
  env?: NodeJS.ProcessEnv
}

export interface SessionModelSlice {
  mainLoopModel: string | null
  mainLoopModelForSession: string | null
  pendingModelSwitch: { setting: string | null } | null
  lastModelTransition?: ModelTransitionReceipt | null
  foregroundTurnActive: boolean
}

export type SessionModelUpdater = <S extends SessionModelSlice>(prev: S) => S
export type SessionModelSetter = (updater: SessionModelUpdater) => void

export type SessionSwitchReceipt = { state: 'applied'; note?: string } | { state: 'queued' } | { state: 'no-op' } | { state: 'refused'; detail: string }

export interface SessionModelDoor {
  readonly carrier: 'in-process' | 'daemon'
  setModel(setting: string | null): Promise<SessionSwitchReceipt>
}

export interface SetupIo {
  env?: NodeJS.ProcessEnv
  platform?: NodeJS.Platform
  home?: string
  configHome?: string
  now?: () => number
  sleep?: (ms: number) => Promise<void>
  signal?: AbortSignal
  fetchImpl?: typeof fetch
  timeoutMs?: number
  startWaitMs?: number
  installWaitMs?: number
  pullIdleMs?: number
  which?: (name: string) => Promise<string | undefined>
  exists?: (path: string) => boolean
  realpath?: (path: string) => string | undefined
  exec?: (file: string, args: string[], opts?: ExecOptions) => Promise<ExecResult>
  totalMemoryBytes?: number
  parallelSlots?: number
  cacheType?: string
  writeWindow?: (tag: string, window: number) => void
  focusedConnector?: () => SessionModelDoor
  setAppState?: SessionModelSetter
  persist?: (setting: string) => { sentence: string }
}

export interface DetectedServer {
  kind: SetupServerKind
  models: string[]
  root: string
  label: string
  hasTestedModel: boolean
  probed: Array<{ kind: LocalServerKind; root: string }>
  words: string
}

export interface OllamaInstallFound {
  found: OllamaInstallForm
  where: string
  looked: string[]
  words: string
}

export interface InstallPlan {
  platform: SetupPlatform
  via: InstallVia
  command: string
  says: string[]
  needsSudo: boolean
  waitsFor: string
  source: { url: string; excerpt: string }
}

export interface StartPlan {
  form: OllamaInstallForm
  command: string
  argv: string[]
  says: string[]
  needsSudo: boolean
  detached: boolean
  logPath?: string
  root: string
  waitUrl: string
  alreadyUp?: string
}

export interface StartResult {
  rc: number
  lastLine: string
  up: boolean
  version?: string
  waitedMs: number
  words: string
}

export interface PullProgress {
  status: string
  digest?: string
  completed?: number
  total?: number
  percent?: number
  line: string
}

export interface PullResult {
  skipped: boolean
  success: boolean
  lastStatus: string
  totalBytes?: number
  rows: number
  error?: string
  words: string
}

export interface WindowChoice {
  tag: string
  window: number
  fits: boolean
  weightsBytes: number
  cacheBytes: number
  totalBytes: number
  usableBytes: number
  machineBytes: number
  trainedMax?: number
  slots: number
  ladder: Array<{ window: number; totalBytes: number; fits: boolean }>
  words: string
}

export interface ProveTimings {
  totalMs: number
  firstByteMs?: number
  loadMs?: number
  promptTokens?: number
  promptMs?: number
  evalTokens?: number
  evalMs?: number
}

export interface ProveResult {
  model: string
  wireId: string
  server: LocalServerKind
  settled: 'applied' | 'queued' | 'no-op' | 'cancelled-pending' | 'refused' | 'unavailable'
  settledBy: 'daemon' | 'in-process' | 'none'
  settledDetail?: string
  saved: string
  ok: boolean
  firstLine: string
  fault?: string
  window?: number
  timings: ProveTimings
  words: string
}

export interface SetupStepPlan {
  step: SetupStepNumber
  label: SetupStepLabel
  kind: SetupStepKind
  title: string
  found: string
  willRun: string
  needsSudo: boolean
  keys: string
  skippable: boolean
}

export interface SetupStepResult {
  step: SetupStepNumber
  label: SetupStepLabel
  kind: SetupStepKind
  outcome: 'ran' | 'skipped' | 'failed'
  rc?: number
  lastLine: string
  detail?: DetectedServer | OllamaInstallFound | ExecResult | StartResult | PullResult | WindowChoice | ProveResult
}

export interface SetupSummary {
  ran: SetupStepLabel[]
  skipped: SetupStepLabel[]
  failed: SetupStepLabel[]
  notDone: SetupStepLabel[]
  stoppedAt?: SetupStepLabel
  reason: 'stopped' | 'finished' | 'ended'
  model?: string
  ready?: ProveResult
  words: string
}

export type SetupEvent =
  | { type: 'step'; plan: SetupStepPlan }
  | { type: 'progress'; step: SetupStepNumber; label: SetupStepLabel; line: string; progress?: PullProgress }
  | { type: 'result'; result: SetupStepResult }
  | { type: 'done'; summary: SetupSummary }

export type SetupConsentFn = (plan: SetupStepPlan) => Promise<SetupConsent> | SetupConsent
