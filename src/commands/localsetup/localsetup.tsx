import * as React from 'react'
import {
  LOCAL_SETUP_OPENING_LINE,
  LOCAL_SETUP_POPUP_HINT,
  LOCAL_SETUP_POPUP_ROWS,
  LOCAL_SETUP_POPUP_WIDTH,
  LocalSetupDialog,
  type LocalSetupAsk,
  type LocalSetupConsent,
  type LocalSetupEvent,
  type LocalSetupRoad,
  type LocalSetupSummary,
} from '../../components/LocalSetupDialog.js'
import { useSettingsPopupFrame } from '../../components/Settings/Settings.js'
import { runSetupRoad } from '../../services/localSetup/index.js'
import type { LocalCommandResult, LocalJSXCommandContext } from '../../types/command.js'
import { openSettingsPopup, type SettingsPopupGeometry, type SettingsPopupRequest } from '../../utils/cockpit/settingsPopup.js'

export type SetupRoadPlan = { label: string; title?: string; found: string; willRun: string; needsSudo?: boolean }
export type SetupRoadResult = { label: string; outcome: 'ran' | 'skipped' | 'failed'; rc?: number; lastLine: string }
export type SetupRoadReady = { model: string; ok?: boolean; window?: number; timings: { totalMs: number }; words?: string }
export type SetupRoadSummary = {
  ran: readonly string[]
  skipped: readonly string[]
  failed: readonly string[]
  notDone: readonly string[]
  reason: string
  ready?: SetupRoadReady | undefined
  words: string
}
export type SetupRoadEvent =
  | { type: 'step'; plan: SetupRoadPlan }
  | { type: 'progress'; label: string; line: string }
  | { type: 'result'; result: SetupRoadResult }
  | { type: 'done'; summary: SetupRoadSummary }
export type SetupRoadConsent = (plan: SetupRoadPlan) => Promise<LocalSetupConsent>
export type SetupRoadRunner = (consent: SetupRoadConsent) => AsyncIterable<SetupRoadEvent>

const LABEL_ORDER: readonly string[] = ['1', '2', '2b', '3', '4', '5', '6']

export function setupAskOf(plan: SetupRoadPlan): LocalSetupAsk {
  return { step: plan.label, found: plan.found, willRun: plan.willRun, needsSudo: plan.needsSudo === true, ...(plan.title !== undefined ? { title: plan.title } : {}) }
}

export function setupResultWords(result: SetupRoadResult): string {
  const line = result.lastLine.trim()
  if (result.rc === undefined) return line
  return line === '' ? `rc ${result.rc}` : `rc ${result.rc} · ${line}`
}

export function setupWindowWords(window: number | undefined): string {
  if (window === undefined) return 'auto'
  return window >= 1024 ? `${Math.round(window / 1024)}k` : String(window)
}

function inLabelOrder(labels: readonly string[]): string[] {
  const unique = [...new Set(labels)]
  return unique.sort((a, b) => LABEL_ORDER.indexOf(a) - LABEL_ORDER.indexOf(b))
}

export function setupSummaryOf(summary: SetupRoadSummary): LocalSetupSummary {
  const ready = summary.ready !== undefined && summary.ready.ok !== false ? summary.ready : undefined
  const readyWords = ready?.words?.trim() ?? ''
  const words = summary.reason === 'stopped' ? '' : summary.words.trim()
  return {
    stopped: summary.reason === 'stopped',
    done: inLabelOrder(summary.ran),
    skipped: inLabelOrder(summary.skipped),
    notDone: inLabelOrder([...summary.failed, ...summary.notDone]),
    ...(ready !== undefined
      ? { ready: { model: ready.model, window: setupWindowWords(ready.window), replySeconds: Math.max(0, Math.round(ready.timings.totalMs / 1000)), ...(readyWords !== '' ? { words: readyWords } : {}) } }
      : {}),
    ...(words !== '' ? { words } : {}),
  }
}

export function setupDialogEventOf(event: SetupRoadEvent): LocalSetupEvent {
  switch (event.type) {
    case 'step':
      return { kind: 'ask', ask: setupAskOf(event.plan) }
    case 'progress':
      return { kind: 'progress', step: event.label, words: event.line }
    case 'result':
      return { kind: 'result', step: event.result.label, outcome: event.result.outcome, words: setupResultWords(event.result) }
    case 'done':
      return { kind: 'done', summary: setupSummaryOf(event.summary) }
  }
}

export function dialogRoadFrom(run: SetupRoadRunner): LocalSetupRoad {
  return consent =>
    (async function* (): AsyncGenerator<LocalSetupEvent> {
      for await (const event of run(plan => consent(setupAskOf(plan)))) yield setupDialogEventOf(event)
    })()
}

export function LocalSetupPopupBody({ geometry, road }: { geometry: SettingsPopupGeometry; road: LocalSetupRoad }): React.ReactNode {
  const frame = useSettingsPopupFrame()
  return <LocalSetupDialog road={road} width={geometry.inner} rowBudget={geometry.rowBudget} onLine={frame.setLine} onOwnsEscape={frame.setOwnsEscape} onClose={frame.close} />
}

export function localSetupPopupRequest(road: LocalSetupRoad): SettingsPopupRequest {
  return {
    view: 'localsetup',
    width: hostColumns => Math.min(LOCAL_SETUP_POPUP_WIDTH, hostColumns),
    rows: LOCAL_SETUP_POPUP_ROWS,
    line: LOCAL_SETUP_OPENING_LINE,
    hint: LOCAL_SETUP_POPUP_HINT,
    body: geometry => <LocalSetupPopupBody geometry={geometry} road={road} />,
  }
}

export const call = async (_args: string, context: LocalJSXCommandContext): Promise<LocalCommandResult> => {
  const setAppState = context.setAppState
  openSettingsPopup(localSetupPopupRequest(dialogRoadFrom(consent => runSetupRoad(consent, setAppState === undefined ? {} : { setAppState }))))
  return { type: 'skip' }
}
