import React, { useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import { homedir } from 'node:os'
import { Box, Text, useInput } from '../../ink.js'
import wrapText from '../../ink/wrap-text.js'
import { useMercuryTokens } from '../mercury-ui/useMercuryTokens.js'
import { applyLocalServerPlan, planLocalServerApply, planWords, type LocalServerApplyOutcome, type LocalServerApplyPlan } from '../../services/localServer/localServerApply.js'
import {
  CONTEXT_LENGTH_LADDER,
  KEEP_ALIVE_LADDER,
  LOCAL_SERVER_KNOBS,
  MAX_LOADED_MODELS_LADDER,
  PARALLEL_SLOTS_LADDER,
  chosenKnobs,
  fitVerdict,
  knobDetailWords,
  knobReadings,
  knobValueWords,
  memoryFactsOf,
  nextOnLadder,
  readLocalServerSettings,
  writeLocalServerSetting,
  type LocalServerKnobId,
  type LocalServerSettings,
} from '../../services/localServer/localServerKnobs.js'
import { gibWords, tokensWords } from '../../services/localServer/localServerMemory.js'
import {
  cachedLocalServerTruth,
  localServerProbingOff,
  localServerTruthStamp,
  refreshLocalServerTruth,
  subscribeLocalServerTruth,
  type LocalServerTruth,
} from '../../services/localServer/localServerTruth.js'

export const LOCAL_SERVER_APPLY_MENU = 'local-server-apply'
export const LOCAL_SERVER_SEARCH = 'local server ollama loaded models parallel slots keep alive context length launch agent plist restart'
export const LOCAL_SERVER_ROW_IDS = ['localServer', 'localServerLoaded', 'localServerRunner', 'localServerForm', 'localServerMaxLoaded', 'localServerParallel', 'localServerKeepAlive', 'localServerContext', 'localServerApply'] as const
export const LOCAL_SERVER_APPLY_HINT = '↵ writes the file and restarts the server · esc back, nothing written'
export const LOCAL_SERVER_APP_HINT = '↵ sets the variables and restarts the app · esc back, nothing set'
export const LOCAL_SERVER_BY_HAND_HINT = 'esc back'

export type LocalServerConfigItem = {
  id: string
  label: string
  searchText?: string
  kind: 'enum' | 'managed-enum' | 'info'
  value: React.ReactNode
  change?: (direction: 1 | -1) => void
  open?: typeof LOCAL_SERVER_APPLY_MENU
  warning?: string
  setByYou?: boolean
}

export function homePath(): string {
  return process.env.HOME || process.env.USERPROFILE || homedir()
}

export function tildePath(path: string, home: string = homePath()): string {
  return home !== '' && path.startsWith(home) ? `~${path.slice(home.length)}` : path
}

export function expiryWords(expiresAt: string | undefined, nowMs: number): string | undefined {
  if (!expiresAt) return undefined
  const at = Date.parse(expiresAt)
  if (!Number.isFinite(at)) return undefined
  const left = at - nowMs
  if (left > 10 * 365 * 24 * 3600 * 1000) return 'kept loaded'
  if (left <= 0) return 'unloading'
  const minutes = Math.round(left / 60_000)
  if (minutes >= 120) return `unloads in ${Math.round(minutes / 60)} h`
  return `unloads in ${Math.max(1, minutes)} min`
}

export function serverRowWords(truth: LocalServerTruth | null, probingOff: boolean): string {
  if (probingOff && !truth?.server) return 'probing off (MERCURY_LOCAL_PROBE_TARGETS=none)'
  if (truth === null) return 'reading the local server…'
  if (!truth.server) return 'no local server answering — start one or MERCURY_LOCAL_BASE_URL'
  const host = truth.server.root.replace(/^https?:\/\//, '')
  const form = truth.launchForm.kind === 'launch-agent' ? `launch agent ${truth.launchForm.label ?? ''}`.trim() : truth.launchForm.kind === 'homebrew' ? 'Homebrew service' : truth.launchForm.kind === 'app' ? 'the Ollama app' : truth.launchForm.kind === 'systemd' ? 'systemd service' : truth.launchForm.kind === 'windows' ? 'Windows' : truth.process ? `pid ${truth.process.pid}` : 'launch form unknown'
  return `${truth.server.label} · ${host} · ${form}`
}

export function loadedRowWords(truth: LocalServerTruth | null, nowMs: number): string {
  if (truth === null || !truth.server) return '—'
  if (truth.loaded.length === 0) return 'none loaded'
  return truth.loaded.map(model => [model.name, model.contextLength !== undefined ? `${tokensWords(model.contextLength)} window` : undefined, model.sizeBytes !== undefined ? gibWords(model.sizeBytes) : undefined, expiryWords(model.expiresAt, nowMs)].filter(Boolean).join(' · ')).join(' | ')
}

export function runnerRowWords(truth: LocalServerTruth | null): string {
  if (truth === null || !truth.server) return '—'
  const runner = truth.runners[0]
  if (!runner) return truth.loaded.length === 0 ? 'no runner (nothing loaded)' : truth.process ? 'runner not readable from the process list' : 'server process not readable'
  const parts = [runner.slots !== undefined ? `${runner.slots} slot${runner.slots === 1 ? '' : 's'}` : undefined, runner.context !== undefined ? `${tokensWords(runner.context)} context` : undefined, runner.cacheTypeK ? `${runner.cacheTypeK} cache` : undefined, runner.flashAttention ? `flash attention ${runner.flashAttention}` : undefined, runner.maxModelLength !== undefined ? `max model length ${tokensWords(runner.maxModelLength)}` : undefined, runner.maxSequences !== undefined ? `${runner.maxSequences} sequences` : undefined].filter(Boolean)
  return parts.length ? `${parts.join(' · ')}${truth.runners.length > 1 ? ` · +${truth.runners.length - 1} more` : ''}` : 'runner flags not readable'
}

export function formRowWords(truth: LocalServerTruth | null, home: string = homePath()): string {
  if (truth === null || !truth.server) return '—'
  const form = truth.launchForm
  const envWords = truth.process?.envReadable ? 'env read from the running server' : 'env not readable from the process'
  if (form.path) return `${tildePath(form.path, home)}${form.confirmed === false ? ' (not the running agent)' : ''} · ${envWords}`
  return `${form.note} · ${envWords}`
}

export interface LocalServerConfigState {
  truth: LocalServerTruth | null
  stamp: number
  settings: LocalServerSettings
  plan: LocalServerApplyPlan | null
  probingOff: boolean
  refresh: () => void
}

export function useLocalServerConfig(version: number): LocalServerConfigState {
  const stamp = useSyncExternalStore(subscribeLocalServerTruth, localServerTruthStamp, localServerTruthStamp)
  const probingOff = localServerProbingOff()
  useEffect(() => {
    void refreshLocalServerTruth().catch(() => undefined)
  }, [])
  const truth = cachedLocalServerTruth()
  const settings = readLocalServerSettings()
  const settingsKey = JSON.stringify(settings)
  const plan = useMemo(() => (truth && truth.server ? planLocalServerApply(truth, settings) : null), [stamp, settingsKey, version])
  return { truth, stamp, settings, plan, probingOff, refresh: () => void refreshLocalServerTruth({ force: true }).catch(() => undefined) }
}

export function localServerConfigItems(args: {
  state: LocalServerConfigState
  nowMs: number
  onSet: (id: LocalServerKnobId, value: number | string, words: string) => void
  tokens: { success: string; textSecondary: string; warning: string; failureText: string }
}): LocalServerConfigItem[] {
  const { state, nowMs, onSet, tokens } = args
  const { truth, settings, plan, probingOff } = state
  const items: LocalServerConfigItem[] = []
  const home = homePath()
  const fold = (words: string): string => (home === '' ? words : words.split(home).join('~'))
  const info = (id: string, label: string, words: string, color?: string): void => {
    items.push({ id, label, searchText: LOCAL_SERVER_SEARCH, kind: 'info', value: <Text color={color ?? tokens.textSecondary} wrap="truncate-end">{words}</Text> })
  }
  info('localServer', 'Local server', serverRowWords(truth, probingOff), truth?.server ? tokens.success : undefined)
  info('localServerLoaded', 'Loaded models', loadedRowWords(truth, nowMs))
  info('localServerRunner', 'Runner', runnerRowWords(truth))
  info('localServerForm', 'Launch form', formRowWords(truth))
  const readings = knobReadings(truth, settings)
  const facts = memoryFactsOf(truth)
  const envReadable = truth?.process?.envReadable === true
  const chosen = chosenKnobs(truth, settings)
  const fit = truth?.server ? fitVerdict(facts, chosen) : null
  const over = fit !== null && !fit.fits
  const rowIds: Record<LocalServerKnobId, string> = { maxLoadedModels: 'localServerMaxLoaded', parallelSlots: 'localServerParallel', keepAlive: 'localServerKeepAlive', contextLength: 'localServerContext' }
  const ladders: Record<LocalServerKnobId, readonly (string | number)[]> = { maxLoadedModels: MAX_LOADED_MODELS_LADDER, parallelSlots: PARALLEL_SLOTS_LADDER, keepAlive: KEEP_ALIVE_LADDER, contextLength: CONTEXT_LENGTH_LADDER }
  for (const reading of readings) {
    const knob = LOCAL_SERVER_KNOBS.find(k => k.id === reading.id)!
    const set = reading.setting !== undefined
    const counts = reading.id !== 'keepAlive'
    items.push({
      id: rowIds[reading.id],
      label: reading.label,
      searchText: `${LOCAL_SERVER_SEARCH} ${knob.envName}`,
      kind: 'enum',
      value: (
        <Text color={set ? undefined : tokens.textSecondary} wrap="truncate-end">
          {over && counts ? knobValueWords(reading, envReadable).replace(' · apply to take effect', '') : knobValueWords(reading, envReadable)}
          {over && counts ? <Text color={tokens.failureText}> · {fit.short}</Text> : null}
          <Text color={tokens.textSecondary}> · {knob.envName}</Text>
        </Text>
      ),
      setByYou: set,
      warning: fold(`${over && counts ? `${fit.words} · ` : ''}${knobDetailWords(reading.id, facts, chosen)}`),
      change: direction => {
        const running = reading.id === 'keepAlive' ? reading.running : reading.running !== undefined && Number.isFinite(Number(reading.running)) ? Number(reading.running) : undefined
        const next = nextOnLadder(ladders[reading.id], reading.setting ?? running, direction)
        const words = reading.id === 'contextLength' ? tokensWords(Number(next)) : String(next)
        onSet(reading.id, next, `set ${reading.label.toLowerCase()} to ${words}`)
      },
    })
  }
  const refused = plan !== null && plan.kind === 'refused'
  const door = plan !== null && !refused
  items.push({
    id: 'localServerApply',
    label: 'Apply to the server',
    searchText: `${LOCAL_SERVER_SEARCH} apply restart write`,
    kind: door ? 'managed-enum' : 'info',
    value: <Text color={refused ? tokens.failureText : plan && plan.kind !== 'nothing' ? tokens.warning : tokens.textSecondary} wrap="truncate-end">{plan ? planWords(plan) : probingOff ? 'probing off' : truth === null ? 'reading…' : !truth.server ? 'no server to apply to' : 'nothing to apply'}</Text>,
    ...(door ? { open: LOCAL_SERVER_APPLY_MENU } : {}),
    ...(plan
      ? {
          warning: refused
            ? fold(`refused: the chosen knobs project ${gibWords(plan.fit.projectedBytes)} against ${gibWords(plan.fit.usableBytes)} usable (${facts.usableSource}) — lower the window, the slots or the count; nothing is applied until it fits`)
            : plan.kind === 'write'
              ? `${tildePath(plan.path)} — the exact lines are shown before anything is written; a backup goes beside the file; then ${plan.restart.words}`
              : plan.kind === 'app'
                ? `launchctl setenv per changed knob, then the app quits and opens again — the exact lines are shown before anything is set; the previous values ride the plan as the revert road`
                : plan.note,
        }
      : {}),
  })
  return items
}

export function applyOutcomeWords(outcome: LocalServerApplyOutcome, after: LocalServerTruth | null, home: string = homePath()): string {
  if (outcome.outcome === 'refused') return `nothing written — ${outcome.reason}`
  if (outcome.outcome === 'stale') return `nothing written — ${outcome.reason}`
  if (outcome.outcome === 'failed') return `failed — ${outcome.reason}${outcome.backupPath ? ` · backup at ${tildePath(outcome.backupPath, home)}` : ''}${outcome.revert ? ` · revert: ${outcome.revert.join(' · ')}` : ''}`
  const server = after?.server ? `the server answers: ${after.server.label}, ${after.loaded.length} loaded` : 'the server is not answering yet — it may still be starting'
  return `applied${outcome.backupPath ? ` · backup at ${tildePath(outcome.backupPath, home)}` : ''} · ${outcome.restarted ? `restarted (${outcome.restartWords})` : outcome.restartWords} · ${server}${outcome.revert ? ` · revert: ${outcome.revert.join(' · ')}` : ''}`
}

export function planLines(plan: LocalServerApplyPlan, home: string = homePath()): string[] {
  const show = (line: string): string => line.replace(/\t/g, '  ')
  if (plan.kind === 'nothing') return [plan.note]
  if (plan.kind === 'refused') return [plan.fit.words, ...plan.fit.models.map(model => `  ${model.name}  ${gibWords(model.bytes)} projected at the chosen window and slots`), 'nothing is applied until the choice fits']
  if (plan.kind === 'by-hand') return [`Mercury cannot write this launch form (${plan.form}) — set the values by hand:`, ...plan.lines.map(line => `  ${show(line)}`), plan.note]
  if (plan.kind === 'app') return [...plan.lines.map((line, index) => `  ${line}  (was ${plan.previous[plan.changes[index]?.name ?? ''] ?? 'unset'})`), `then ${plan.restart.words}`, `revert road: ${plan.revert.join(' · ')}`, plan.note]
  const restart = home === '' ? plan.restart.words : plan.restart.words.split(home).join('~')
  if (plan.kind === 'restart') return [`${tildePath(plan.path, home)} already carries the values; the running server has:`, ...plan.changes.map(change => `  ${change.name}  ${change.before ?? '(unset)'} → ${change.after}`), `then ${restart}`, plan.note]
  const backup = plan.backupPath.startsWith(`${plan.path}.`) ? plan.backupPath.slice(plan.path.lastIndexOf('/') + 1) : tildePath(plan.backupPath, home)
  return [`${tildePath(plan.path, home)} · backup beside it: ${backup}`, ...plan.lines.map(line => `  ${show(line)}`), `then ${restart}`, plan.note]
}

export function clipRows(lines: string[], width: number, budget: number): string[] {
  const wrapped = lines.map(line => wrapText(line, Math.max(1, width), 'wrap').split('\n'))
  const total = wrapped.reduce((sum, rows) => sum + rows.length, 0)
  if (total <= budget) return lines
  const out: string[] = []
  let used = 0
  for (const [index, rows] of wrapped.entries()) {
    if (used + rows.length > budget - 1) {
      out.push(`↓ ${lines.length - index} more`)
      return out
    }
    out.push(lines[index]!)
    used += rows.length
  }
  return out
}

export function LocalServerApplyDialog({ plan, width, rows, onDone, onApplied }: { plan: LocalServerApplyPlan; width: number; rows: number; onDone: () => void; onApplied?: (outcome: LocalServerApplyOutcome) => void }): React.ReactNode {
  const tokens = useMercuryTokens()
  const [phase, setPhase] = useState<{ kind: 'review' } | { kind: 'applying' } | { kind: 'done'; words: string }>({ kind: 'review' })
  const canWrite = plan.kind === 'write' || plan.kind === 'restart' || plan.kind === 'app'
  const count = plan.changes.length
  const title = plan.kind === 'nothing' ? 'Nothing to apply' : plan.kind === 'refused' ? 'Refused: the choice does not fit this box' : plan.kind === 'by-hand' ? `${count} change${count === 1 ? '' : 's'} to set by hand` : plan.kind === 'app' ? `Apply ${count} change${count === 1 ? '' : 's'} to the Ollama app` : `Apply ${count} change${count === 1 ? '' : 's'} to the local server`
  useInput(
    (_input, key, event) => {
      if (key.escape) {
        event.stopImmediatePropagation()
        if (phase.kind !== 'applying') onDone()
        return
      }
      if (key.return) {
        event.stopImmediatePropagation()
        if (phase.kind === 'done') {
          onDone()
          return
        }
        if (phase.kind !== 'review' || !canWrite) return
        setPhase({ kind: 'applying' })
        void (async () => {
          const outcome = await applyLocalServerPlan(plan, { confirmed: true })
          let after: LocalServerTruth | null = null
          try {
            after = await refreshLocalServerTruth({ force: true })
          } catch {
            after = null
          }
          onApplied?.(outcome)
          setPhase({ kind: 'done', words: applyOutcomeWords(outcome, after) })
        })()
      }
    },
    { isActive: true },
  )
  const hint = phase.kind === 'applying' ? (plan.kind === 'app' ? 'setting the variables and restarting the app…' : 'writing the file and restarting…') : phase.kind === 'done' ? 'esc back' : plan.kind === 'app' ? LOCAL_SERVER_APP_HINT : canWrite ? LOCAL_SERVER_APPLY_HINT : LOCAL_SERVER_BY_HAND_HINT
  const budget = Math.max(1, rows - 2)
  const body = clipRows(phase.kind === 'done' ? [phase.words] : planLines(plan), width, budget)
  return (
    <Box flexDirection="column" width={width} height={rows} flexShrink={0} overflow="hidden">
      <Text bold color={tokens.textPrimary} wrap="truncate-end">{title}</Text>
      {body.map((line, index) => (
        <Text key={index} color={line.startsWith('  -') ? tokens.failureText : line.startsWith('  +') ? tokens.success : tokens.textSecondary} wrap="wrap">{line}</Text>
      ))}
      <Box flexGrow={1} />
      <Text color={phase.kind === 'applying' ? tokens.warning : tokens.textMuted} wrap="truncate-end">{hint}</Text>
    </Box>
  )
}
