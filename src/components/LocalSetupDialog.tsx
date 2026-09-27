import * as React from 'react'
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { LOCAL_SETUP_MODEL, LOCAL_SETUP_TAG } from '../commands/localsetup/words.js'
import { Box, Text, useInput } from '../ink.js'
import { escapeFromOutsidePress } from '../ink/recessLayer.js'
import { truncateStartToWidth, truncateToWidth } from '../utils/truncate.js'
import { useMercuryTokens } from './mercury-ui/useMercuryTokens.js'
import { useOpenEventGate } from './mercury-ui/useOpenEventGate.js'

export const LOCAL_SETUP_POPUP_WIDTH = 120
export const LOCAL_SETUP_POPUP_ROWS = 33
export const LOCAL_SETUP_POPUP_HINT = '↵ run · s skip · esc stop · ←→ line tail · ↑↓ scroll · click outside closes'
export const LOCAL_SETUP_OPENING_LINE = 'local model set-up · six steps · each says what it will run and waits for ↵'
export const LOCAL_SETUP_KEYS = '↵ run · s skip · esc stop'
export const LOCAL_SETUP_WILL_RUN = 'will run'
export const LOCAL_SETUP_RUNNING = 'running…'
export const LOCAL_SETUP_STOPPED_HERE = 'not run · stopped here'
export const LOCAL_SETUP_STEP_COUNT = 6
export const LOCAL_SETUP_STEP_TITLES: Readonly<Record<string, string>> = {
  '1': 'find a server',
  '2': 'find Ollama on this machine',
  '2b': 'install Ollama',
  '3': 'start the server',
  '4': `pull ${LOCAL_SETUP_TAG}`,
  '5': "set the window from this machine's memory",
  '6': 'pick and prove',
}
const STEP_ORDER: readonly string[] = ['1', '2', '2b', '3', '4', '5', '6']
const CELL_INDENT = '  '

export type LocalSetupConsent = 'run' | 'skip' | 'stop'

export type LocalSetupAsk = {
  step: string
  found: string
  willRun: string
  title?: string
  needsSudo?: boolean
}

export type LocalSetupReady = {
  model: string
  window: string
  replySeconds: number
  words?: string
}

export type LocalSetupSummary = {
  stopped: boolean
  done: string[]
  skipped?: string[]
  notDone: string[]
  ready?: LocalSetupReady
  words?: string
}

export type LocalSetupEvent =
  | { kind: 'ask'; ask: LocalSetupAsk }
  | { kind: 'progress'; step: string; words: string }
  | { kind: 'result'; step: string; outcome: 'ran' | 'skipped' | 'failed'; words: string }
  | { kind: 'done'; summary: LocalSetupSummary }

export type LocalSetupAction =
  | LocalSetupEvent
  | { kind: 'consent'; answer: LocalSetupConsent }
  | { kind: 'ended' }
  | { kind: 'error'; words: string }

export type LocalSetupRoad = (consent: (ask: LocalSetupAsk) => Promise<LocalSetupConsent>) => AsyncIterable<LocalSetupEvent>

export type LocalSetupStepPhase = 'asking' | 'running' | 'ran' | 'skipped' | 'failed' | 'stopped'

export type LocalSetupStepState = {
  step: string
  title: string
  found: string
  willRun: string
  needsSudo: boolean
  phase: LocalSetupStepPhase
  progress?: string
  result?: string
}

export type LocalSetupState = {
  steps: LocalSetupStepState[]
  stopRequested: boolean
  ended: boolean
  summary?: LocalSetupSummary
  error?: string
}

export const LOCAL_SETUP_INITIAL: LocalSetupState = { steps: [], stopRequested: false, ended: false }

export type LocalSetupRow = {
  text: string
  tone: 'primary' | 'secondary' | 'muted' | 'success' | 'warning' | 'info'
  bold?: boolean
}

export function localSetupStepTitle(step: string, title?: string): string {
  return title ?? LOCAL_SETUP_STEP_TITLES[step] ?? `step ${step}`
}

export function localSetupStepLabel(step: string, title?: string): string {
  return `${step} · ${localSetupStepTitle(step, title)}`
}

export function localSetupReadyRow(ready: LocalSetupReady): string {
  const words = ready.words?.trim()
  return `${words ? words : `ready · ${ready.model} · ${ready.window} window · reply in ${ready.replySeconds} s`} · esc closes`
}

function stepWords(steps: string[], titles: Readonly<Record<string, string>>): string {
  return steps.length === 0 ? 'nothing' : steps.map(step => `${step} ${localSetupStepTitle(step, titles[step])}`).join(', ')
}

export function localSetupSummaryRows(summary: LocalSetupSummary, titles: Readonly<Record<string, string>> = {}): string[] {
  const head = summary.stopped ? 'stopped · nothing more runs · esc closes' : 'ended · esc closes'
  const skipped = summary.skipped ?? []
  return [
    head,
    ...(summary.words ? [summary.words] : []),
    `done: ${stepWords(summary.done, titles)}`,
    ...(skipped.length > 0 ? [`skipped: ${stepWords(skipped, titles)}`] : []),
    `not done: ${stepWords(summary.notDone, titles)}`,
  ]
}

export function localSetupSummaryWords(summary: LocalSetupSummary, titles: Readonly<Record<string, string>> = {}): string {
  if (summary.ready) return localSetupReadyRow(summary.ready).replace(/ · esc closes$/, '')
  return localSetupSummaryRows(summary, titles).map(row => row.replace(/ · esc closes$/, '')).join(' · ')
}

function stepTitles(state: LocalSetupState): Record<string, string> {
  return Object.fromEntries(state.steps.map(step => [step.step, step.title]))
}

function isDone(step: LocalSetupStepState): boolean {
  return step.phase === 'ran' || step.phase === 'skipped'
}

function inferredSummary(state: LocalSetupState, stopped: boolean): LocalSetupSummary {
  const seen = new Set(state.steps.map(step => step.step))
  return {
    stopped,
    done: state.steps.filter(step => step.phase === 'ran').map(step => step.step),
    skipped: state.steps.filter(step => step.phase === 'skipped').map(step => step.step),
    notDone: [...state.steps.filter(step => !isDone(step)).map(step => step.step), ...STEP_ORDER.filter(step => !seen.has(step) && step !== '2b')],
  }
}

export function reduceLocalSetup(state: LocalSetupState, action: LocalSetupAction): LocalSetupState {
  switch (action.kind) {
    case 'ask': {
      const { ask } = action
      if (state.steps.some(step => step.step === ask.step && step.phase === 'asking')) return state
      const next: LocalSetupStepState = {
        step: ask.step,
        title: localSetupStepTitle(ask.step, ask.title),
        found: ask.found,
        willRun: ask.willRun,
        needsSudo: ask.needsSudo === true,
        phase: 'asking',
      }
      return { ...state, steps: [...state.steps, next] }
    }
    case 'consent': {
      const stopRequested = state.stopRequested || action.answer === 'stop'
      const index = state.steps.findIndex(step => step.phase === 'asking')
      if (index < 0) return { ...state, stopRequested }
      const steps = state.steps.slice()
      const current = steps[index] as LocalSetupStepState
      steps[index] =
        action.answer === 'run'
          ? { ...current, phase: 'running' }
          : action.answer === 'skip'
            ? { ...current, phase: 'skipped' }
            : { ...current, phase: 'stopped', result: LOCAL_SETUP_STOPPED_HERE }
      return { ...state, steps, stopRequested }
    }
    case 'progress':
      return { ...state, steps: state.steps.map(step => (step.step === action.step && step.phase === 'running' ? { ...step, progress: action.words } : step)) }
    case 'result': {
      const open = (step: LocalSetupStepState): boolean => step.phase === 'asking' || step.phase === 'running' || (step.phase === 'skipped' && step.result === undefined)
      const index = state.steps.findLastIndex(step => step.step === action.step && open(step))
      const steps = state.steps.slice()
      if (index < 0) steps.push({ step: action.step, title: localSetupStepTitle(action.step), found: '', willRun: '', needsSudo: false, phase: action.outcome, result: action.words })
      else steps[index] = { ...(steps[index] as LocalSetupStepState), phase: action.outcome, result: action.words }
      return { ...state, steps }
    }
    case 'done':
      return { ...state, ended: true, summary: action.summary }
    case 'ended':
      return state.ended ? state : { ...state, ended: true, summary: inferredSummary(state, state.stopRequested) }
    case 'error':
      return { ...state, ended: true, error: action.words, summary: state.summary ?? inferredSummary(state, false) }
  }
}

export function localSetupAsking(state: LocalSetupState): LocalSetupStepState | undefined {
  return state.steps.find(step => step.phase === 'asking')
}

function outcomeRow(step: LocalSetupStepState): { text: string; tone: LocalSetupRow['tone'] } {
  switch (step.phase) {
    case 'ran':
      return { text: `✓ ${step.result ?? 'done'}`, tone: 'success' }
    case 'skipped':
      return { text: `– skipped${step.result ? ` · ${step.result}` : ''}`, tone: 'muted' }
    case 'failed':
      return { text: `✗ failed · ${step.result ?? ''}`, tone: 'warning' }
    case 'stopped':
      return { text: `– ${step.result ?? LOCAL_SETUP_STOPPED_HERE}`, tone: 'warning' }
    case 'running':
      return { text: step.progress ?? LOCAL_SETUP_RUNNING, tone: 'info' }
    case 'asking':
      return { text: LOCAL_SETUP_KEYS, tone: 'warning' }
  }
}

export function localSetupRows(state: LocalSetupState, width: number, tail = false): LocalSetupRow[] {
  const rows: LocalSetupRow[] = []
  const cell = Math.max(1, width - CELL_INDENT.length - LOCAL_SETUP_WILL_RUN.length - 2)
  for (const step of state.steps) {
    const asking = step.phase === 'asking'
    const sudo = step.needsSudo ? ' · asks for your password (sudo)' : ''
    rows.push({ text: truncateToWidth(`${localSetupStepLabel(step.step, step.title)} · ${step.found}${sudo}`, width), tone: asking ? 'primary' : 'secondary', bold: asking })
    if (step.willRun !== '') {
      const command = tail && asking ? truncateStartToWidth(step.willRun, cell) : truncateToWidth(step.willRun, cell)
      rows.push({ text: `${CELL_INDENT}${LOCAL_SETUP_WILL_RUN}  ${command}`, tone: asking ? 'info' : 'muted' })
    }
    const outcome = outcomeRow(step)
    rows.push({ text: truncateToWidth(`${CELL_INDENT}${outcome.text}`, width), tone: outcome.tone, bold: asking })
  }
  if (state.stopRequested && !state.ended && !localSetupAsking(state)) rows.push({ text: truncateToWidth('stopping after this step · nothing more runs', width), tone: 'warning' })
  if (state.error !== undefined) rows.push({ text: truncateToWidth(`failed · ${state.error}`, width), tone: 'warning', bold: true })
  if (state.summary) {
    if (state.summary.ready) rows.push({ text: truncateToWidth(localSetupReadyRow(state.summary.ready), width), tone: 'success', bold: true })
    else localSetupSummaryRows(state.summary, stepTitles(state)).forEach((text, index) => rows.push({ text: truncateToWidth(text, width), tone: state.summary?.stopped ? 'warning' : 'secondary', bold: index === 0 }))
  }
  return rows
}

export function localSetupWindow(total: number, budget: number, scroll: number | null): { start: number; end: number; above: number; below: number } {
  if (budget <= 0 || total <= budget) return { start: 0, end: total, above: 0, below: 0 }
  if (budget < 3) return { start: total - budget, end: total, above: 0, below: 0 }
  const tailStart = total - (budget - 1)
  if (scroll === null || scroll >= tailStart) return { start: tailStart, end: total, above: tailStart, below: 0 }
  const start = Math.max(0, scroll)
  if (start === 0) return { start: 0, end: budget - 1, above: 0, below: total - (budget - 1) }
  const end = start + budget - 2
  return { start, end, above: start, below: total - end }
}

export function localSetupLine(state: LocalSetupState): string {
  if (state.error !== undefined) return `failed · ${state.error}`
  if (state.summary?.ready) return `done · ${state.summary.ready.model} ready · ${state.summary.ready.window} window`
  if (state.summary) return `${state.summary.stopped ? 'stopped' : 'ended'} · ${state.summary.done.length} step${state.summary.done.length === 1 ? '' : 's'} done · ${state.summary.notDone.length} not`
  const asking = localSetupAsking(state)
  if (asking) return `step ${asking.step} of ${LOCAL_SETUP_STEP_COUNT} · ${asking.title} · nothing runs before ↵`
  const running = state.steps.find(step => step.phase === 'running')
  if (running) return `step ${running.step} of ${LOCAL_SETUP_STEP_COUNT} · ${running.title} · ${running.progress ?? 'running'}`
  return state.steps.length === 0 ? LOCAL_SETUP_OPENING_LINE : `local model set-up · ${LOCAL_SETUP_MODEL}`
}

export function LocalSetupDialog({
  road,
  width,
  rowBudget,
  onLine,
  onOwnsEscape,
  onClose,
}: {
  road: LocalSetupRoad
  width: number
  rowBudget: number
  onLine?: (line: string) => void
  onOwnsEscape?: (owns: boolean) => void
  onClose?: (summary?: string) => void
}): React.ReactNode {
  const tokens = useMercuryTokens()
  const pastOpenEvent = useOpenEventGate()
  const [state, setState] = useState<LocalSetupState>(LOCAL_SETUP_INITIAL)
  const [tail, setTail] = useState(false)
  const [scroll, setScroll] = useState<number | null>(null)
  const answerRef = useRef<((answer: LocalSetupConsent) => void) | null>(null)
  const stopRef = useRef(false)
  const dispatch = useCallback((action: LocalSetupAction): void => {
    setScroll(null)
    setState(current => reduceLocalSetup(current, action))
  }, [])
  useEffect(() => {
    let live = true
    const consent = (ask: LocalSetupAsk): Promise<LocalSetupConsent> => {
      if (stopRef.current) return Promise.resolve('stop')
      if (live) dispatch({ kind: 'ask', ask })
      return new Promise(resolve => {
        answerRef.current = resolve
      })
    }
    void (async () => {
      try {
        for await (const event of road(consent)) {
          if (!live) break
          dispatch(event)
        }
        if (live) dispatch({ kind: 'ended' })
      } catch (error) {
        if (live) dispatch({ kind: 'error', words: error instanceof Error ? error.message : String(error) })
      }
    })()
    return () => {
      live = false
      stopRef.current = true
      answerRef.current?.('stop')
      answerRef.current = null
    }
  }, [road, dispatch])
  const line = localSetupLine(state)
  useLayoutEffect(() => {
    onLine?.(line)
  }, [line, onLine])
  useEffect(() => {
    onOwnsEscape?.(true)
    return () => onOwnsEscape?.(false)
  }, [onOwnsEscape])
  const answer = (choice: LocalSetupConsent): boolean => {
    const resolve = answerRef.current
    if (resolve === null) return false
    answerRef.current = null
    setTail(false)
    dispatch({ kind: 'consent', answer: choice })
    resolve(choice)
    return true
  }
  const rows = localSetupRows(state, width, tail)
  const budget = Math.max(1, rowBudget)
  const window = localSetupWindow(rows.length, budget, scroll)
  useInput((input, key, event) => {
    if (key.escape) {
      event.stopImmediatePropagation()
      if (escapeFromOutsidePress() || state.ended) {
        stopRef.current = true
        answer('stop')
        onClose?.(state.summary ? localSetupSummaryWords(state.summary, stepTitles(state)) : undefined)
        return
      }
      if (!answer('stop')) {
        stopRef.current = true
        dispatch({ kind: 'consent', answer: 'stop' })
      }
      return
    }
    if (key.upArrow || key.downArrow) {
      event.stopImmediatePropagation()
      const start = window.start + (key.upArrow ? -1 : 1)
      setScroll(start >= rows.length - (budget - 1) ? null : Math.max(0, start))
      return
    }
    if (key.leftArrow || key.rightArrow) {
      event.stopImmediatePropagation()
      setTail(key.rightArrow)
      return
    }
    if (key.return) {
      event.stopImmediatePropagation()
      if (!pastOpenEvent()) return
      answer('run')
      return
    }
    if (input === 's') {
      event.stopImmediatePropagation()
      if (!pastOpenEvent()) return
      answer('skip')
    }
  })
  const colour = (tone: LocalSetupRow['tone']): string =>
    tone === 'primary' ? tokens.textPrimary : tone === 'secondary' ? tokens.textSecondary : tone === 'muted' ? tokens.textMuted : tone === 'success' ? tokens.success : tone === 'warning' ? tokens.warning : tokens.info
  const shown: LocalSetupRow[] = [
    ...(window.above > 0 ? [{ text: `↑ ${window.above} more`, tone: 'muted' as const }] : []),
    ...rows.slice(window.start, window.end),
    ...(window.below > 0 ? [{ text: `↓ ${window.below} more`, tone: 'muted' as const }] : []),
  ]
  return (
    <Box flexDirection="column" width={width} flexShrink={0} maxHeight={budget} overflow="hidden">
      {shown.map((row, index) => (
        <Box key={`${window.start}:${index}`} height={1} flexShrink={0}>
          <Text color={colour(row.tone)} bold={row.bold === true} wrap="truncate-end">{row.text}</Text>
        </Box>
      ))}
    </Box>
  )
}
