import type { ReactNode } from 'react'
import type { LocalJSXCommandOnDone } from '../../commands/catalogue/command.js'
import { useClaim } from '../effects/effects.js'
import { readFile } from 'node:fs/promises'
import type { Command } from '../../commands/catalogue/commands.js'
import { getCommandName } from '../../commands/catalogue/commands.js'
import type { Notification } from '../notifications/notifications.js'
import { getFocusedSessionConnector } from '../../engine/connector/focusedConnector.js'
import { useAppStateMaybeOutsideOfProvider, type AppState } from '../app-state/AppState.js'
import { publishAtomic } from '../../platform/substrate/fileStore.js'
import { isCrewmateTask, requestCrewmateFold } from '../../engine/tasks/local-agent/crewmateTask.js'
import { MERCURY_CREW_AGENT_TYPE } from '../../tools/kit/names/crewmate.js'
import {
  crewmateCommandUnreachableWords,
  crewmateFoldWords,
  crewmateContextWords,
  crewmateEffortClearedWords,
  crewmateEffortRefusedWords,
  crewmateEffortSwitchWords,
  crewmateModelCurrentWords,
  crewmateModelSwitchWords,
  crewmateNumbersUnreportedWords,
  crewmateUsageWords,
} from '../cockpit/crewmateWords.js'
import { getContextWindowForModel } from '../../engine/compaction-window/contextFill.js'
import { crewmateModelOverride } from '../../crew/crewmates/crewmateModelWord.js'
import { EFFORT_LEVELS, normalizeEffortLevelString, resolveStampedEffortTruth } from '../../models/effort/effort.js'
import { errorMessage, isENOENT } from '../../platform/errors/errors.js'
import { formatDuration, formatTokens } from '../../platform/text/format.js'
import { logError } from '../../platform/logs/errorLog.js'
import { renderModelName } from '../../models/catalogue/engineModel.js'
import type { CrewmateMetadata } from '../../sessions/transcripts/paths.js'
import { formatSessionCost } from '../../models/roads/spendSpelling.js'
import { crewmateMetadataFile } from '../tasks/useCrewmateModel.js'
import { crewmateInView, crewmateLive, type CrewmateInView } from '../tasks/useCrewmateView.js'
import { passedOver } from '../../platform/errors/passedOver.js'

const CREWMATE_COMMAND_RECEIPT_KEY = 'crewmate-command'
const CREWMATE_FOLD_INSTRUCTIONS_NOTE = 'the instructions are not carried; a crewmate compacts with the standard summary'
const EFFORT_OPTIONS = `${EFFORT_LEVELS.join('|')}|auto`

type CrewmateCommandIo = {
  setAppState: (f: (prev: AppState) => AppState) => void
  receipt: (text: string, color?: 'warning') => void
}

export function crewmateCommandReceipt(addNotification: (notification: Notification) => void): CrewmateCommandIo['receipt'] {
  return (text, color) =>
    addNotification({ key: CREWMATE_COMMAND_RECEIPT_KEY, text, priority: 'medium', timeoutMs: 8000, ...(color !== undefined ? { color } : {}), fold: (_accumulated, incoming) => incoming })
}

const word = (value: unknown): string | null => (typeof value === 'string' && value.trim() !== '' ? value.trim() : null)

function argsOf(line: string): string {
  const trimmed = line.trim()
  const spaceAt = trimmed.indexOf(' ')
  return spaceAt < 0 ? '' : trimmed.slice(spaceAt + 1).trim()
}

function crewmateRuns(crewmate: CrewmateInView): boolean {
  const local = crewmate.local
  if (local !== undefined && isCrewmateTask(local)) return local.status === 'running'
  return crewmateLive(crewmate)
}

function runningModelOf(crewmate: CrewmateInView): string | null {
  const local = crewmate.local
  return (local !== undefined && isCrewmateTask(local) ? word(local.model) : null) ?? crewmate.facts?.model ?? null
}

function agentTypeOf(crewmate: CrewmateInView, meta: CrewmateMetadata | null): string {
  const local = crewmate.local
  return meta?.agentType ?? (local !== undefined && isCrewmateTask(local) ? local.agentType : null) ?? crewmate.facts?.agentType ?? MERCURY_CREW_AGENT_TYPE
}

async function readRecord(file: string): Promise<CrewmateMetadata | null> {
  try {
    const parsed: unknown = JSON.parse(await readFile(file, 'utf8'))
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new SyntaxError('not a JSON object')
    }
    return parsed as CrewmateMetadata
  } catch (error) {
    if (isENOENT(error)) return null
    const wrapped = new Error(`crewmate metadata ${file} could not be read: ${error instanceof SyntaxError ? 'it is not valid JSON' : errorMessage(error)}`)
    logError(wrapped)
    throw wrapped
  }
}

async function writeRecord(file: string, meta: CrewmateMetadata): Promise<void> {
  await publishAtomic(file, JSON.stringify(meta))
}

async function latestRecord(seat: CrewmateSeat): Promise<CrewmateMetadata> {
  const latest = await readRecord(seat.file)
  seat.meta = latest ?? seat.meta
  return latest ?? seat.meta ?? { agentType: agentTypeOf(seat.crewmate, null) }
}

type CrewmateSeat = {
  crewmate: CrewmateInView
  name: string
  running: boolean
  file: string
  meta: CrewmateMetadata | null
  model: string
}

async function recordModel(seat: CrewmateSeat, model: string): Promise<string> {
  const label = renderModelName(model)
  const current = seat.meta?.model ?? runningModelOf(seat.crewmate)
  if (current === model) {
    return crewmateModelCurrentWords(seat.name, label, null)
  }
  await writeRecord(seat.file, { ...(await latestRecord(seat)), model })
  return crewmateModelSwitchWords(seat.name, label, seat.running)
}

function contextPercentOf(crewmate: CrewmateInView, model: string): number | null {
  const context = crewmate.facts?.tokens?.context ?? null
  if (context === null) return null
  try {
    const window = getContextWindowForModel(crewmate.facts?.model ?? model)
    return window > 0 ? Math.round((context / window) * 100) : null
  } catch (error) {
    passedOver(error)
    return null
  }
}

async function recordEffort(seat: CrewmateSeat, args: string): Promise<string> {
  const token = args.toLowerCase()
  if (token === 'auto' || token === 'unset') {
    const { effortOverride: _override, ...rest } = await latestRecord(seat)
    await writeRecord(seat.file, rest)
    return crewmateEffortClearedWords(seat.name, seat.running)
  }
  const level = normalizeEffortLevelString(token)
  if (level === undefined) return `Valid options: ${EFFORT_OPTIONS} — "${args}" is not an effort option.`
  const selectable = resolveStampedEffortTruth(seat.model, level, { thinkingEnabled: true }).selectable
  if (level !== 'max' && !selectable.includes(level)) return crewmateEffortRefusedWords(seat.name, level, renderModelName(seat.model), selectable)
  await writeRecord(seat.file, { ...(await latestRecord(seat)), effortOverride: level })
  return crewmateEffortSwitchWords(seat.name, level, seat.running)
}

async function runFold(seat: CrewmateSeat, args: string, io: CrewmateCommandIo): Promise<void> {
  const note = args === '' ? '' : ` — ${CREWMATE_FOLD_INSTRUCTIONS_NOTE}`
  const local = seat.crewmate.local
  if (local !== undefined && isCrewmateTask(local) && local.status === 'running' && requestCrewmateFold(local.id, io.setAppState)) {
    io.receipt(`${crewmateFoldWords(seat.name, true)}${note}`)
    return
  }
  await writeRecord(seat.file, { ...(await latestRecord(seat)), compactOnResume: true })
  io.receipt(`${crewmateFoldWords(seat.name, false)}${note}`)
}

function runContext(seat: CrewmateSeat, io: CrewmateCommandIo): void {
  const facts = seat.crewmate.facts
  const context = facts?.tokens?.context ?? null
  if (facts === null || context === null) {
    io.receipt(crewmateNumbersUnreportedWords(seat.name))
    return
  }
  const model = facts.model ?? seat.model
  let window: number | null = null
  try {
    window = getContextWindowForModel(model)
  } catch {
    window = null
  }
  const pct = window !== null && window > 0 ? Math.round((context / window) * 100) : null
  io.receipt(crewmateContextWords(seat.name, renderModelName(model), formatTokens(context), window !== null && window > 0 ? formatTokens(window) : null, pct))
}

function runUsage(seat: CrewmateSeat, io: CrewmateCommandIo): void {
  const facts = seat.crewmate.facts
  const tokens = facts?.tokens ?? null
  if (facts === null || tokens === null) {
    io.receipt(crewmateNumbersUnreportedWords(seat.name))
    return
  }
  const elapsed = (facts.endedAt ?? Date.now()) - facts.startedAt
  io.receipt(crewmateUsageWords(seat.name, renderModelName(facts.model ?? seat.model), {
    input: formatTokens(tokens.input ?? tokens.total),
    output: formatTokens(tokens.output ?? 0),
    cached: tokens.cached !== null && tokens.cached !== undefined && tokens.cached > 0 ? formatTokens(tokens.cached) : null,
    cost: formatSessionCost(facts.costUSD ?? 0, facts.unpricedTurns),
    toolUses: facts.toolUses,
    elapsed: formatDuration(Math.max(0, elapsed)),
  }))
}

async function seatOf(crewmate: CrewmateInView, command: string): Promise<CrewmateSeat> {
  const file = crewmateMetadataFile(crewmate)
  if (file === null) throw new Error(crewmateCommandUnreachableWords(crewmate.name, command))
  const meta = await readRecord(file)
  const model = word(meta?.model) ?? runningModelOf(crewmate) ?? getFocusedSessionConnector().modelFacts().effective
  return { crewmate, name: crewmate.name, running: crewmateRuns(crewmate), file, meta, model }
}

const pickerAddress = (s: AppState): string | undefined => s.viewingCrewmateTaskId ?? s.mainChatTaskId

export async function crewmatePickerSeat(state: AppState, command: 'model' | 'effort') {
  const id = pickerAddress(state)
  if (id === undefined) return undefined
  const connector = getFocusedSessionConnector()
  const crew = crewmateInView(id, state, connector.workRoster().rows, connector.sessionId(), state.crewLedger[id]?.facts)
  if (crew === null) throw new Error(crewmateCommandUnreachableWords(id, command))
  const seat = await seatOf(crew, command)
  const reported = crew.facts?.effort ?? seat.meta?.effort ?? null
  const effort = seat.meta?.effortOverride ?? seat.meta?.effort ?? reported
  const serving = runningModelOf(crew)
  const next = `${renderModelName(seat.model)} · ${effort ?? 'default effort'}`
  return {
    id, model: seat.model, effort,
    effortStatus: seat.running
      ? `Effort is ${reported ?? 'unreported'}${serving === null ? '' : ` on ${renderModelName(serving)}`}${effort !== reported || seat.model !== serving ? ` · next turn: ${next}` : ''}`
      : `Next resume: ${next}`,
    contextPercent: contextPercentOf(crew, seat.model),
    modelStatus: () => {
      const running = runningModelOf(crew)
      const switching = seat.running && running !== null && running !== seat.model
      return crewmateModelCurrentWords(crew.name, renderModelName(switching ? running : seat.model), switching ? renderModelName(seat.model) : null)
    },
    setModel: async (id: string) => {
      const model = await crewmateModelOverride(id, connector.modelFacts().effective)
      if (model === undefined) throw new Error(`'${id}' names no model`)
      return recordModel(seat, model)
    },
    setEffort: (value: string) => recordEffort(seat, value),
  }
}

export type CrewmatePickerSeat = NonNullable<Awaited<ReturnType<typeof crewmatePickerSeat>>>

export function PickerSeatScope({ seat, onDone, children }: { seat?: CrewmatePickerSeat; onDone: LocalJSXCommandOnDone; children: ReactNode }): ReactNode {
  const current = useAppStateMaybeOutsideOfProvider(pickerAddress) === seat?.id
  useClaim(() => {
    if (!current) onDone(undefined, { display: 'skip' })
  }, [current, onDone])
  return current ? children : null
}

export async function runCrewmateCommand(command: Command, line: string, crewmate: CrewmateInView, io: CrewmateCommandIo): Promise<void> {
  const name = getCommandName(command)
  const args = argsOf(line)
  try {
    const seat = await seatOf(crewmate, name)
    switch (command.name) {
      case 'compact':
        return await runFold(seat, args, io)
      case 'context':
        return runContext(seat, io)
      case 'usage':
        return runUsage(seat, io)
      default:
        io.receipt(crewmateCommandUnreachableWords(crewmate.name, name), 'warning')
    }
  } catch (error) {
    io.receipt(`/${name} for ${crewmate.name} failed — ${errorMessage(error)}`, 'warning')
  }
}
