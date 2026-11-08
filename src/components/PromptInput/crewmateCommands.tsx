import * as React from 'react'
import { readFile } from 'node:fs/promises'
import type { Command } from '../../commands.js'
import { getCommandName } from '../../commands.js'
import { COMMON_HELP_ARGS, COMMON_INFO_ARGS } from '../../constants/xml.js'
import { ModalContext } from '../../context/modalContext.js'
import { getFocusedSessionConnector } from '../../services/engine-connector/focusedConnector.js'
import type { AppState } from '../../state/AppState.js'
import { durableAtomicPublish } from '../../substrate/durablePublish.js'
import { isLocalAgentTask, requestAgentCompaction } from '../../tasks/LocalAgentTask/LocalAgentTask.js'
import { MERCURY_CREW_AGENT_TYPE } from '../../tools/AgentTool/constants.js'
import {
  crewmateCommandUnreachableWords,
  crewmateCompactWords,
  crewmateContextWords,
  crewmateEffortClearedWords,
  crewmateEffortCurrentWords,
  crewmateEffortRefusedWords,
  crewmateEffortSwitchWords,
  crewmateModelCurrentWords,
  crewmateModelKeptWords,
  crewmateModelPickerLine,
  crewmateModelSwitchWords,
  crewmateNumbersUnreportedWords,
  crewmateUsageWords,
} from '../../utils/cockpit/crewmateWords.js'
import { closeSettingsPopup, openSettingsPopup } from '../../utils/cockpit/settingsPopup.js'
import { getContextWindowForModel } from '../../utils/context.js'
import { crewmateModelOverride } from '../../utils/crew/crewmateModelWord.js'
import { EFFORT_LEVELS, normalizeEffortLevelString, resolveStampedEffortTruth, selectableEffortLevels, type EffortLevel } from '../../utils/effort.js'
import { errorMessage } from '../../utils/errors.js'
import { formatDuration, formatTokens } from '../../utils/format.js'
import { parseUserSpecifiedModel, renderModelName } from '../../utils/model/model.js'
import type { AgentMetadata } from '../../utils/sessionStorage/paths.js'
import { formatSessionCost } from '../../utils/spendSpelling.js'
import { crewmateMetadataFile } from '../tasks/useCrewmateModel.js'
import { crewmateLive, type CrewmateInView } from '../tasks/useCrewmateView.js'

export const CREWMATE_COMMAND_RECEIPT_KEY = 'crewmate-command'
export const CREWMATE_COMPACT_INSTRUCTIONS_NOTE = 'the instructions are not carried; a crewmate compacts with the standard summary'
const EFFORT_OPTIONS = `${EFFORT_LEVELS.join('|')}|auto`
const MODEL_PICKER_ROWS = 29

export type CrewmateCommandIo = {
  setAppState: (f: (prev: AppState) => AppState) => void
  receipt: (text: string, color?: 'warning') => void
}

const word = (value: unknown): string | null => (typeof value === 'string' && value.trim() !== '' ? value.trim() : null)

function argsOf(line: string): string {
  const trimmed = line.trim()
  const spaceAt = trimmed.indexOf(' ')
  return spaceAt < 0 ? '' : trimmed.slice(spaceAt + 1).trim()
}

function crewmateRuns(crewmate: CrewmateInView): boolean {
  const local = crewmate.local
  if (local !== undefined && isLocalAgentTask(local)) return local.status === 'running'
  return crewmateLive(crewmate)
}

function runningModelOf(crewmate: CrewmateInView): string | null {
  const local = crewmate.local
  return (local !== undefined && isLocalAgentTask(local) ? word(local.model) : null) ?? crewmate.facts?.model ?? null
}

function agentTypeOf(crewmate: CrewmateInView, meta: AgentMetadata | null): string {
  const local = crewmate.local
  return meta?.agentType ?? (local !== undefined && isLocalAgentTask(local) ? local.agentType : null) ?? crewmate.facts?.agentType ?? MERCURY_CREW_AGENT_TYPE
}

async function readRecord(file: string): Promise<AgentMetadata | null> {
  try {
    return JSON.parse(await readFile(file, 'utf8')) as AgentMetadata
  } catch {
    return null
  }
}

async function writeRecord(file: string, meta: AgentMetadata): Promise<void> {
  await durableAtomicPublish(file, JSON.stringify(meta))
}

type CrewmateSeat = {
  crewmate: CrewmateInView
  name: string
  running: boolean
  file: string
  meta: AgentMetadata | null
  model: string
  io: CrewmateCommandIo
}

async function recordModel(seat: CrewmateSeat, model: string): Promise<void> {
  const label = renderModelName(model)
  const current = seat.meta?.model ?? runningModelOf(seat.crewmate)
  if (current === model) {
    seat.io.receipt(crewmateModelCurrentWords(seat.name, label, null))
    return
  }
  await writeRecord(seat.file, { ...(seat.meta ?? { agentType: agentTypeOf(seat.crewmate, null) }), model })
  seat.io.receipt(crewmateModelSwitchWords(seat.name, label, seat.running))
}

async function openCrewmateModelPicker(seat: CrewmateSeat): Promise<void> {
  const { MercuryModelChoicePicker, modelChoiceRow } = await import('../../commands/model/mercuryModel.js')
  const label = renderModelName(seat.model)
  openSettingsPopup({
    view: 'model',
    width: hostColumns => Math.min(120, hostColumns),
    rows: MODEL_PICKER_ROWS,
    line: crewmateModelPickerLine(seat.name, seat.running),
    hint: `↵ picks · esc keeps ${label}`,
    bodyOwnsEscape: true,
    body: geometry => (
      <ModalContext.Provider value={{ rows: geometry.rowBudget, columns: geometry.inner, scrollRef: null }}>
        <MercuryModelChoicePicker
          current={modelChoiceRow(seat.model)}
          onSelect={id => {
            closeSettingsPopup()
            void recordModel(seat, parseUserSpecifiedModel(id)).catch(error => seat.io.receipt(errorMessage(error), 'warning'))
          }}
          onClose={() => {
            closeSettingsPopup()
            seat.io.receipt(crewmateModelKeptWords(seat.name, label))
          }}
        />
      </ModalContext.Provider>
    ),
  })
}

async function runModel(seat: CrewmateSeat, args: string): Promise<void> {
  const lowered = args.toLowerCase()
  if (args === '') return openCrewmateModelPicker(seat)
  if (COMMON_HELP_ARGS.includes(lowered)) {
    seat.io.receipt(`/model opens ${seat.name}'s picker; /model <model> names its next model directly`)
    return
  }
  if (COMMON_INFO_ARGS.includes(lowered)) {
    const running = runningModelOf(seat.crewmate)
    const recorded = seat.meta?.model ?? null
    const switching = seat.running && recorded !== null && running !== null && recorded !== running
    seat.io.receipt(crewmateModelCurrentWords(seat.name, renderModelName(switching ? running : seat.model), switching ? renderModelName(recorded) : null))
    return
  }
  try {
    const resolved = await crewmateModelOverride(args, getFocusedSessionConnector().modelFacts().effective)
    if (resolved === undefined) throw new Error(`'${args}' names no model`)
    await recordModel(seat, resolved)
  } catch (error) {
    seat.io.receipt(errorMessage(error), 'warning')
  }
}

async function runEffort(seat: CrewmateSeat, args: string): Promise<void> {
  const token = args.toLowerCase()
  if (COMMON_HELP_ARGS.includes(token)) {
    seat.io.receipt(`/effort [${EFFORT_OPTIONS}] sets ${seat.name}'s effort for its next turn`)
    return
  }
  if (token === '' || COMMON_INFO_ARGS.includes(token)) {
    const level = word(seat.meta?.effortOverride) ?? word(seat.meta?.effort) ?? seat.crewmate.facts?.effort ?? null
    seat.io.receipt(crewmateEffortCurrentWords(seat.name, level, renderModelName(seat.model), selectableEffortLevels(seat.model)))
    return
  }
  if (token === 'auto' || token === 'unset') {
    const { effort: _effort, effortOverride: _override, ...rest } = seat.meta ?? { agentType: agentTypeOf(seat.crewmate, null) }
    await writeRecord(seat.file, rest)
    seat.io.receipt(crewmateEffortClearedWords(seat.name, seat.running))
    return
  }
  const level: EffortLevel | undefined = normalizeEffortLevelString(token)
  if (level === undefined) {
    seat.io.receipt(`Valid options: ${EFFORT_OPTIONS} — "${args}" is not an effort option.`, 'warning')
    return
  }
  const selectable = resolveStampedEffortTruth(seat.model, level, { thinkingEnabled: true }).selectable
  if (level !== 'max' && !selectable.includes(level)) {
    seat.io.receipt(crewmateEffortRefusedWords(seat.name, level, renderModelName(seat.model), selectable), 'warning')
    return
  }
  await writeRecord(seat.file, { ...(seat.meta ?? { agentType: agentTypeOf(seat.crewmate, null) }), effort: level, effortOverride: level })
  seat.io.receipt(crewmateEffortSwitchWords(seat.name, level, seat.running))
}

async function runCompact(seat: CrewmateSeat, args: string): Promise<void> {
  const note = args === '' ? '' : ` — ${CREWMATE_COMPACT_INSTRUCTIONS_NOTE}`
  const local = seat.crewmate.local
  if (local !== undefined && isLocalAgentTask(local) && local.status === 'running' && requestAgentCompaction(local.id, seat.io.setAppState)) {
    seat.io.receipt(`${crewmateCompactWords(seat.name, true)}${note}`)
    return
  }
  await writeRecord(seat.file, { ...(seat.meta ?? { agentType: agentTypeOf(seat.crewmate, null) }), compactOnResume: true })
  seat.io.receipt(`${crewmateCompactWords(seat.name, false)}${note}`)
}

function runContext(seat: CrewmateSeat): void {
  const facts = seat.crewmate.facts
  const context = facts?.tokens?.context ?? null
  if (facts === null || context === null) {
    seat.io.receipt(crewmateNumbersUnreportedWords(seat.name))
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
  seat.io.receipt(crewmateContextWords(seat.name, renderModelName(model), formatTokens(context), window !== null && window > 0 ? formatTokens(window) : null, pct))
}

function runUsage(seat: CrewmateSeat): void {
  const facts = seat.crewmate.facts
  const tokens = facts?.tokens ?? null
  if (facts === null || tokens === null) {
    seat.io.receipt(crewmateNumbersUnreportedWords(seat.name))
    return
  }
  const elapsed = (facts.endedAt ?? Date.now()) - facts.startedAt
  seat.io.receipt(crewmateUsageWords(seat.name, renderModelName(facts.model ?? seat.model), {
    input: formatTokens(tokens.input ?? tokens.total),
    output: formatTokens(tokens.output ?? 0),
    cached: tokens.cached !== null && tokens.cached !== undefined && tokens.cached > 0 ? formatTokens(tokens.cached) : null,
    cost: formatSessionCost(facts.costUSD ?? 0, facts.unpricedTurns),
    toolUses: facts.toolUses,
    elapsed: formatDuration(Math.max(0, elapsed)),
  }))
}

export async function runCrewmateCommand(command: Command, line: string, crewmate: CrewmateInView, io: CrewmateCommandIo): Promise<void> {
  const name = getCommandName(command)
  const file = crewmateMetadataFile(crewmate)
  if (file === null) {
    io.receipt(crewmateCommandUnreachableWords(crewmate.name, name), 'warning')
    return
  }
  const meta = await readRecord(file)
  const model = word(meta?.model) ?? runningModelOf(crewmate) ?? getFocusedSessionConnector().modelFacts().effective
  const seat: CrewmateSeat = { crewmate, name: crewmate.name, running: crewmateRuns(crewmate), file, meta, model, io }
  const args = argsOf(line)
  try {
    switch (command.name) {
      case 'model':
        return await runModel(seat, args)
      case 'effort':
        return await runEffort(seat, args)
      case 'compact':
        return await runCompact(seat, args)
      case 'context':
        return runContext(seat)
      case 'usage':
        return runUsage(seat)
      default:
        io.receipt(crewmateCommandUnreachableWords(crewmate.name, name), 'warning')
    }
  } catch (error) {
    io.receipt(`/${name} for ${crewmate.name} failed — ${errorMessage(error)}`, 'warning')
  }
}
