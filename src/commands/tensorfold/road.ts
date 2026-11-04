import { setClipboardWithReceipt } from '../../ink/termio/osc.js'
import { ggufServerRoots } from '../../services/localSetup/ggufServers.js'
import { pickAndProve, type ProveIo } from '../../services/localSetup/setupProve.js'
import type { SessionModelSetter } from '../../services/localSetup/setupTypes.js'
import { DEFAULT_LOCAL_PROBE_TARGETS, cachedLocalModels } from '../../services/providers/local/localDiscovery.js'
import type { TensorFoldServed } from '../../services/tensorfold/contracts.js'
import { findTensorFoldEngine } from '../../services/tensorfold/engine.js'
import { chosenTensorFoldWindow } from '../../services/tensorfold/fit.js'
import { installTensorFold, type TensorFoldInstallPlan } from '../../services/tensorfold/install.js'
import type { TensorFoldInventoryRow } from '../../services/tensorfold/inventory.js'
import { TensorFoldPullError, pullTensorFold, readHubRepo, stopTensorFoldPull, type PullIo } from '../../services/tensorfold/pull.js'
import { rowOfCheckpoint } from '../../services/tensorfold/inventory.js'
import { cachedTensorFoldMachineTruth } from '../../services/tensorfold/engine.js'
import { TensorFoldStartError, readServedRecord, startTensorFold, stopTensorFold, tensorFoldExit, type ServeIo } from '../../services/tensorfold/serve.js'
import { readTensorFoldSupportLine, type TensorFoldSupportFocus } from '../../services/providers/local/tensorfoldSupport.js'
import { mintImmediateReceipt } from '../../utils/model/seatReceipts.js'
import { FEED, pullActOf, refusedActOf, servedAddress, type FactsState, type TensorFoldAct } from './scene.js'

export type RoadIo = {
  serve?: ServeIo
  pull?: PullIo
  prove?: ProveIo
  install?: (plan: TensorFoldInstallPlan, onLine: (line: string) => void) => ReturnType<typeof installTensorFold>
  supportLine?: (focus?: TensorFoldSupportFocus) => Promise<string | undefined>
  copy?: (text: string) => Promise<unknown>
  setAppState?: SessionModelSetter
  now?: () => number
  readHub?: typeof readHubRepo
}

type Listener = () => void

const state: { acts: Record<string, TensorFoldAct>; windows: Record<string, number>; other?: FactsState['other']; notice?: string; version: number } = { acts: {}, windows: {}, version: 0 }
const listeners = new Set<Listener>()
const abortable = new Map<string, AbortController>()

function bump(): void {
  state.version += 1
  for (const listener of [...listeners]) listener()
}

export function subscribeTensorFoldRoad(listener: Listener): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function tensorFoldRoadVersion(): number {
  return state.version
}

export function tensorFoldRoadState(): FactsState & { notice?: string } {
  return { acts: { ...state.acts }, windows: { ...state.windows }, ...(state.other !== undefined ? { other: state.other } : {}), ...(state.notice !== undefined ? { notice: state.notice } : {}) }
}

export function __resetTensorFoldRoadForTest(): void {
  state.acts = {}
  state.windows = {}
  delete state.other
  delete state.notice
  state.version = 0
  listeners.clear()
  abortable.clear()
}

function actOf(key: string): TensorFoldAct | undefined {
  return state.acts[key]
}

function setAct(key: string, act: TensorFoldAct | undefined): void {
  if (act === undefined) delete state.acts[key]
  else state.acts[key] = act
  bump()
}

export function setTensorFoldNotice(notice: string | undefined): void {
  if (notice === undefined) delete state.notice
  else state.notice = notice
  bump()
}

export function setOtherCheckpoint(other: FactsState['other'] | undefined): void {
  if (other === undefined) delete state.other
  else state.other = other
  bump()
}

export function moveTensorFoldWindow(row: TensorFoldInventoryRow, direction: -1 | 1): number {
  const ladder = row.ladder ?? []
  const windows = ladder.map(rung => rung.window)
  const current = state.windows[row.repo] ?? row.window
  const at = Math.max(0, windows.indexOf(current))
  const next = windows[Math.max(0, Math.min(windows.length - 1, at + direction))] ?? current
  state.windows[row.repo] = next
  bump()
  return next
}

export function windowOf(row: TensorFoldInventoryRow): number {
  return state.windows[row.repo] ?? row.window
}

export function stoppable(): boolean {
  return Object.values(state.acts).some(act => act.kind === 'pulling' || act.kind === 'starting')
}

export function discoveryEnvFor(root: string, env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  if (cachedLocalModels().some(record => record.baseUrl === `${root}/v1`)) return env
  const pinned = env.MERCURY_LOCAL_PROBE_TARGETS?.trim()
  const defaults = pinned === undefined || pinned === '' ? [...DEFAULT_LOCAL_PROBE_TARGETS.map(target => `${target.kind}=${target.root}`), ...ggufServerRoots().map(target => `llamacpp=${target}`)] : pinned.toLowerCase() === 'none' ? [] : pinned.split(',')
  if (defaults.some(entry => entry.trim().endsWith(`=${root}`))) return env
  return { ...env, MERCURY_LOCAL_PROBE_TARGETS: [...defaults, `llamacpp=${root}`].join(',') }
}

export function supportFocusOf(row: Pick<TensorFoldInventoryRow, 'repo' | 'drafter' | 'promptCacheGib'> | undefined, window?: number): TensorFoldSupportFocus | undefined {
  if (row === undefined) return undefined
  return { repo: row.repo, ...(row.drafter !== undefined ? { drafter: row.drafter } : {}), ...(window !== undefined ? { context: window } : {}), ...(row.promptCacheGib !== undefined ? { promptCacheGib: row.promptCacheGib } : {}) }
}

async function supportLineOf(io: RoadIo, focus?: TensorFoldSupportFocus): Promise<string | undefined> {
  try {
    return await (io.supportLine ?? readTensorFoldSupportLine)(focus)
  } catch {
    return undefined
  }
}

async function warn(io: RoadIo, text: string, focus?: TensorFoldSupportFocus): Promise<void> {
  mintImmediateReceipt(text, 'warning', await supportLineOf(io, focus))
}

export async function copyTensorFoldSupportLine(io: RoadIo = {}, focus?: TensorFoldSupportFocus): Promise<string> {
  const line = await supportLineOf(io, focus)
  if (line === undefined) return 'no support line yet · serve a model first'
  const copy = io.copy ?? setClipboardWithReceipt
  await copy(line)
  return `copied the support line`
}

export async function copyWiredLimitCommand(command: string, io: RoadIo = {}): Promise<string> {
  const copy = io.copy ?? setClipboardWithReceipt
  await copy(command)
  return `copied · run it in a terminal (it asks for your password) · then /tensorfold again`
}

export type SwitchOutcome = { ok: boolean; switched: boolean; words: string; model: string }

export async function switchToTensorFold(served: TensorFoldServed, io: RoadIo = {}): Promise<SwitchOutcome> {
  const root = `http://${servedAddress(served.port)}`
  const prove: ProveIo = { ...io.prove, root, thinkingOff: true, env: discoveryEnvFor(root, io.prove?.env), ...(io.setAppState !== undefined ? { setAppState: io.setAppState } : {}) }
  const result = await pickAndProve(served.name, prove)
  return { ok: result.ok, switched: result.settled === 'applied' || result.settled === 'queued' || result.settled === 'no-op', words: result.words, model: result.model }
}

export const SHARE_WORDS = 'restarting to share on your network · plain HTTP on your home or office network · keyed'
export const UNSHARE_WORDS = 'restarting on this Mac only'

export async function serveTensorFoldRow(row: TensorFoldInventoryRow, window: number, io: RoadIo = {}, opts: { share?: boolean } = {}): Promise<{ served: TensorFoldServed; switched: SwitchOutcome } | null> {
  const key = row.repo
  const running = actOf(key)
  if (running !== undefined && (running.kind === 'pulling' || running.kind === 'starting')) return null
  const controller = new AbortController()
  abortable.set(key, controller)
  const now = io.now ?? Date.now
  try {
    if (row.state === 'not-pulled') {
      const samples: { at: number; bytes: number }[] = []
      const total = row.downloadBytes
      setAct(key, pullActOf(key, samples, total, window))
      try {
        await pullTensorFold(
          row.repo,
          progress => {
            samples.push({ at: now(), bytes: progress.bytes })
            if (samples.length > 40) samples.splice(0, samples.length - 40)
            setAct(key, pullActOf(key, samples, total ?? progress.totalBytes, window))
          },
          { ...io.pull, signal: controller.signal },
        )
      } catch (error) {
        setAct(key, undefined)
        if (error instanceof TensorFoldPullError && error.stopped) {
          setTensorFoldNotice('the download stopped · it resumes next time')
          return null
        }
        await warn(io, FEED.pullFailed(row.label, error instanceof Error ? error.message : String(error)), supportFocusOf(row, window))
        return null
      }
      mintImmediateReceipt(FEED.pulled(row.label, total ?? row.bytesOnDisk ?? 0))
    }
    const name = row.shortName
    const focus = supportFocusOf(row, window)
    setAct(key, { kind: 'starting', name, port: 0, seconds: 0 })
    let served: TensorFoldServed
    try {
      served = await startTensorFold(
        { repo: row.repo, window, name, ...(row.port !== undefined ? { port: row.port } : {}), ...(row.drafter !== undefined ? { drafter: row.drafter } : {}), ...(row.promptCacheGib !== undefined ? { promptCacheGib: row.promptCacheGib } : {}), ...(opts.share === true ? { share: true } : {}) },
        {
          ...io.serve,
          signal: controller.signal,
          onPort: pick => setAct(key, { kind: 'starting', name, port: pick.port, seconds: 0 }),
          onLoading: seconds => {
            const act = actOf(key)
            setAct(key, { kind: 'starting', name, port: act?.kind === 'starting' ? act.port : 0, seconds })
          },
        },
      )
    } catch (error) {
      if (error instanceof TensorFoldStartError) {
        if (error.refusal !== null) {
          const refusal = error.refusal
          const before = actOf(key)
          const port = before?.kind === 'starting' ? before.port : 0
          setAct(key, refusedActOf(name, window, refusal))
          if (refusal.kind === 'port' && refusal.port !== undefined) await warn(io, FEED.portBusy(refusal.port), focus)
          else if (refusal.kind === 'gpu-limit') await warn(io, FEED.gpuLimit(name, window), focus)
          else if (refusal.kind === 'exited') await warn(io, FEED.exited(name, port), focus)
          else await warn(io, FEED.refused(name, window, refusal), focus)
          return null
        }
        if (error.tight !== null) {
          setAct(key, { kind: 'tight', needBytes: error.tight.needBytes, freeBytes: error.tight.freeBytes, offers: error.tight.offers })
          await warn(io, FEED.tight(error.tight.needBytes, error.tight.freeBytes, error.tight.offers), focus)
          return null
        }
      }
      setAct(key, undefined)
      setTensorFoldNotice(error instanceof Error ? error.message : String(error))
      return null
    }
    setAct(key, undefined)
    const switched = await switchToTensorFold(served, io)
    const busy = readServedRecord(io.serve)?.busy
    mintImmediateReceipt(busy !== undefined ? FEED.servesElsewhere(served.name, served.port, busy.port, served.window, switched.switched) : FEED.serves(served.name, served.window, served.port, switched.switched))
    setTensorFoldNotice(switched.ok ? undefined : switched.words)
    return { served, switched }
  } finally {
    abortable.delete(key)
  }
}

export async function stopTensorFoldRow(row: Pick<TensorFoldInventoryRow, 'repo' | 'shortName'>, served: readonly TensorFoldServed[], opts: { current: boolean }, io: RoadIo = {}): Promise<string> {
  const act = actOf(row.repo)
  if (act?.kind === 'pulling') {
    abortable.get(row.repo)?.abort()
    stopTensorFoldPull(row.repo)
    return 'stopping the download · it resumes next time'
  }
  if (act?.kind === 'starting') {
    abortable.get(row.repo)?.abort()
    return 'stopping the start'
  }
  const mine = served.find(candidate => candidate.repo === row.repo)
  if (mine === undefined) return 'nothing to stop · Mercury did not start it'
  if (opts.current && act?.kind !== 'stop-confirm') {
    setAct(row.repo, { kind: 'stop-confirm' })
    return 's again stops it'
  }
  setAct(row.repo, undefined)
  await stopTensorFold(mine.name, io.serve)
  mintImmediateReceipt(FEED.stopped(mine.name))
  return `stopped ${mine.name}`
}

export function keepTensorFoldRow(repo: string): void {
  if (actOf(repo)?.kind === 'stop-confirm') setAct(repo, undefined)
}

export async function installTensorFoldThen(plan: TensorFoldInstallPlan, io: RoadIo = {}): Promise<boolean> {
  setAct('install', { kind: 'installing' })
  const run = io.install ?? installTensorFold
  const outcome = await run(plan, line => setAct('install', { kind: 'installing', line }))
  setAct('install', undefined)
  if (!outcome.ok) {
    await warn(io, `▲ TensorFold did not install · ${outcome.line} · /tensorfold tries again`)
    return false
  }
  const engine = await findTensorFoldEngine({ ...io.serve })
  if (engine === null) {
    await warn(io, FEED.notInstalled())
    return false
  }
  mintImmediateReceipt(`● TensorFold ${engine.version} installed`)
  return true
}

export async function readOtherCheckpoint(input: string, io: RoadIo = {}): Promise<void> {
  const read = io.readHub ?? readHubRepo
  setOtherCheckpoint({ input })
  const engine = await findTensorFoldEngine({ ...io.serve })
  const families = new Set(engine?.families.map(family => family.id) ?? [])
  const outcome = await read(input.trim(), { families })
  if ('refused' in outcome) {
    setOtherCheckpoint({ input, refused: outcome.refused })
    return
  }
  const machine = await cachedTensorFoldMachineTruth(io.serve ?? {})
  const row = rowOfCheckpoint(outcome.checkpoint, machine, { onDisk: false, bytesOnDisk: 0, drafterOnDisk: true })
  state.windows[row.repo] = chosenTensorFoldWindow(row.ladder ?? [])
  setOtherCheckpoint({ input, read: row })
}

export function noteTensorFoldExit(io: Pick<ServeIo, 'servedFile'> = {}): TensorFoldAct | undefined {
  const exit = tensorFoldExit(io)
  if (exit === null) return undefined
  return { kind: 'exited', name: '', port: 0, line: exit.line }
}
