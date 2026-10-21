import { randomUUID } from 'node:crypto'
import { closeSync, fstatSync, mkdirSync, openSync, readSync, watch } from 'node:fs'
import { logForDebugging } from '../../utils/debug.js'
import { dirname, join } from 'node:path'
import { selfScriptPath, nodeForBuild } from '../../daemon/daemonBuild.js'
import { ownsControlPlaneSync, readDaemonState } from '../../daemon/controlSocket.js'
import { isProcessAlive } from '../../daemon/ownerWatch.js'
import { getMercuryHome } from '../../utils/envUtils.js'
import { resolveWatchRoot } from '../../utils/watchRoot.js'
import { reconcileRecord, startService, stopService } from '../projectServices/serviceManager.js'
import { hostDirectory, hostRecords, patchHostRecord, readHostRecord, writeHostRecord, type HostRecord } from './store.js'
import { hostNotice } from './notices.js'
import { currentHostRecipes } from './recipesFile.js'
import { hostRetuneLive, readTunePreferences, tunedRecipe } from './tune.js'

const serviceName = (id: string): string => 'host-' + id.toLowerCase()
const serviceHome = (): string => hostDirectory()
const active = (record: HostRecord): boolean => {
  const service = reconcileRecord(serviceHome(), serviceName(record.id))
  return Boolean(service && ['starting', 'running', 'ready'].includes(service.state))
}
const watchPollIntervalMs = 5000
const watchPollWindowMs = 12 * 3600_000
const quota = (policy: string): string => [...policy.matchAll(/"(minute|hour|day)";q=(\d+)/g)].map(([, window, allowed]) => allowed + (window === 'hour' ? ' an ' : ' a ') + window).join(', ')
export const watchRateWords = (pollMs: number, policy?: string): string => 'one catalogue read every ' + pollMs / 1000 + ' s (' + Math.round(60_000 / pollMs) + ' a minute) · ' + (policy === undefined ? 'Runpod meters each account per minute, hour and day' : quota(policy) ? 'this account’s Runpod quota: ' + quota(policy) : 'Runpod sent no rate-limit policy for this account')
export const watchModel = (record: HostRecord): string => (currentHostRecipes().find(recipe => recipe.id === record.recipe)?.label ?? record.name).split(' · ')[0]!
export const activeHostWatches = (): HostRecord[] => hostRecords().filter(row => row.jobKind === 'watch' && ['queued', 'starting', 'running'].includes(row.jobState ?? ''))

export async function requireHostJobOwner(): Promise<void> {
  const daemon = await readDaemonState()
  if (!daemon || !isProcessAlive(daemon.pid)) throw new Error('The Mercury daemon must be running before renting a pod. Reopen Mercury; no pod was created.')
}
export function queueHostSetup(record: HostRecord): HostRecord {
  if (active(record)) return readHostRecord(record.id) ?? record
  const stored = readHostRecord(record.id)
  if (stored && hostRetuneLive(stored)) throw new Error('This pod is reloading its engine; resume setup once the reload ends. Nothing was queued.')
  const recipe = currentHostRecipes().find(row => row.id === record.recipe) ?? record.recipeRow
  let tune: HostRecord['tune']
  try {
    const preference = record.tune ?? (recipe ? readTunePreferences(recipe.label.split(' · ')[0]!) : undefined)
    tune = preference?.quality === recipe?.id ? preference : undefined
    if (recipe && tune) tunedRecipe(recipe, tune)
  } catch { tune = undefined }
  record = { ...record, vendor: record.vendor ?? 'runpod', recipeRow: recipe, tune }
  const now = Date.now()
  const logs = join(hostDirectory(), 'logs'); mkdirSync(logs, { recursive: true, mode: 0o700 })
  const queued: HostRecord = { ...record, jobKind: 'setup', generation: randomUUID(), jobState: 'queued', jobStartedAt: now, advancedAt: now, step: 'waiting for SSH', error: undefined, log: join(logs, record.id + '.log'), steps: [{ step: 'waiting for SSH', at: now }] }
  writeHostRecord(queued)
  return queued
}
export function queueHostWatch(record: HostRecord): HostRecord {
  if (record.vendor && record.vendor !== 'runpod') throw new Error('Stock watches are Runpod-only. Nothing was queued or rented.')
  const watching = activeHostWatches().find(row => row.id !== record.id && watchModel(row) === watchModel(record))
  if (watching) return watching
  if (active(record)) return readHostRecord(record.id) ?? record
  const now = Date.now()
  const ceiling = record.maxPrice ?? record.price
  const pollIntervalMs = record.pollIntervalMs ?? watchPollIntervalMs
  const step = 'watching for stock ≤ $' + ceiling.toFixed(2) + '/hr'
  const logs = join(hostDirectory(), 'logs'); mkdirSync(logs, { recursive: true, mode: 0o700 })
  const queued: HostRecord = { ...record, jobKind: 'watch', maxPrice: ceiling, pollIntervalMs, pollWindowMs: record.pollWindowMs ?? watchPollWindowMs, rateLimit: watchRateWords(pollIntervalMs), generation: randomUUID(), jobState: 'queued', jobStartedAt: now, advancedAt: now, step, error: undefined, creating: undefined, log: join(logs, record.id + '.log'), steps: [{ step, at: now }] }
  writeHostRecord(queued)
  return queued
}
export function hostJobRunning(record: HostRecord): boolean { return record.jobState === 'queued' || active(record) }
export async function stopHostSetup(id: string): Promise<void> {
  patchHostRecord(id, { jobState: 'stopped' })
  if (reconcileRecord(serviceHome(), serviceName(id))) {
    const stopped = await stopService(serviceHome(), serviceName(id))
    if ('error' in stopped) throw new Error(stopped.error)
    if (stopped.note) throw new Error(stopped.note)
  }
}
export function hostLogTail(record: HostRecord): string {
  if (!record.log) return ''
  let fd: number | undefined
  try {
    fd = openSync(record.log, 'r')
    const size = fstatSync(fd).size
    const bytes = Buffer.alloc(Math.min(size, 16384))
    readSync(fd, bytes, 0, bytes.length, size - bytes.length)
    return bytes.toString('utf8').replaceAll('MERCURY_STEP ', '').split(/[\r\n]/).filter(Boolean).slice(-3).join(' · ')
  } catch { return '' } finally { if (fd !== undefined) closeSync(fd) }
}
export async function sweepHostJobs(options: { stallMs?: number; launch?: (record: HostRecord) => Promise<void>; alive?: (record: HostRecord) => boolean; records?: HostRecord[] } = {}): Promise<void> {
  for (const record of options.records ?? hostRecords()) {
    if (!record.jobState || record.jobState === 'stopped') continue
    const watch = record.jobKind === 'watch'
    const alive = options.alive?.(record) ?? active(record)
    if (record.jobState === 'queued' && !alive) {
      try {
        patchHostRecord(record.id, { jobState: 'starting' })
        if (options.launch) await options.launch(record)
        else {
          const script = selfScriptPath()
          const result = await startService({ sessionId: record.sessionId ?? 'host', spec: { name: serviceName(record.id), command: nodeForBuild(dirname(script)), args: [script, '--mercury-host-job', record.id, record.generation!], cwd: serviceHome(), env: { MERCURY_CONFIG_DIR: getMercuryHome(), ...(process.env.MERCURY_CREDENTIAL_STORE ? { MERCURY_CREDENTIAL_STORE: process.env.MERCURY_CREDENTIAL_STORE } : {}) }, lifecycle: 'project', restart: 'never', readiness: [], readinessMode: 'all' } })
          if ('error' in result) throw new Error(result.error)
        }
      } catch (error) {
        patchHostRecord(record.id, { jobState: 'failed', error: String(error) })
        hostNotice(record, 'failed', record.name + (watch ? ' · stock watch could not start · ' + String(error) + ' · no pod was created' : ' · setup stalled at ' + record.step + ' · ' + String(error) + ' · /llmhost → Pods I’m paying for → Resume or Terminate'))
      }
      continue
    }
    if (watch && ['running', 'starting'].includes(record.jobState) && !alive) {
      const current = readHostRecord(record.id)
      if (!current || current.generation !== record.generation || !['running', 'starting'].includes(current.jobState ?? '') || hostRecords().some(row => row.watchedFrom === record.id)) continue
      const words = current.creating ? current.creating + ' may exist: the stock watch stopped while creating it · /llmhost → Pods I’m paying for' : 'stock watch stopped: its process ended · no pod was created · /llmhost → Rent a GPU to watch again'
      patchHostRecord(record.id, { jobState: 'failed', error: words })
      hostNotice(current, 'failed', current.name + ' · ' + words)
      continue
    }
    if (['running', 'starting'].includes(record.jobState) && (!alive || Date.now() - (record.advancedAt ?? 0) >= (options.stallMs ?? 600_000)) || record.jobState === 'ready' && !alive) {
      if (!alive) patchHostRecord(record.id, { jobState: 'failed', error: 'The setup job process is gone.' })
      hostNotice(record, 'stalled', record.name + (watch ? ' · stock watch has not read Runpod since ' + new Date(record.advancedAt ?? 0).toISOString() + ' · /llmhost → Pods I’m paying for → Cancel' : ' · setup stalled at ' + record.step + ' · /llmhost → Pods I’m paying for → Resume or Terminate'))
    }
  }
}
export function startHostJobSweep(): () => void {
  let busy = false
  let timer: ReturnType<typeof setTimeout> | undefined
  let stopped = false
  const pods = join(hostDirectory(), 'pods')
  mkdirSync(pods, { recursive: true, mode: 0o700 })
  const schedule = (ms: number): void => { if (stopped) return; if (timer) clearTimeout(timer); timer = setTimeout(() => { void tick() }, ms); timer.unref() }
  const tick = async (): Promise<void> => {
    if (stopped || busy) return
    busy = true
    let live = false
    try {
      const records = hostRecords()
      live = records.some(record => ['queued', 'starting', 'running'].includes(record.jobState ?? ''))
      if (records.length > 0 && ownsControlPlaneSync()) await sweepHostJobs({ records })
    } catch (error) { logForDebugging('Host job sweep: ' + String(error)) } finally { busy = false }
    if (live) schedule(1000)
    else if (!watcher) schedule(15_000)
  }
  let watcher: ReturnType<typeof watch> | undefined
  try {
    watcher = watch(resolveWatchRoot(pods), () => schedule(250))
    watcher.unref?.()
    watcher.on('error', () => { watcher?.close(); watcher = undefined; schedule(15_000) })
  } catch { watcher = undefined }
  void tick()
  return () => { stopped = true; if (timer) clearTimeout(timer); watcher?.close() }
}
