import * as React from 'react'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Box, Text, useInput } from '../ink.js'
import TextInput from './TextInput.js'
import { useMercuryTokens } from './mercury-ui/useMercuryTokens.js'
import { useOpenEventGate } from './mercury-ui/useOpenEventGate.js'
import { fitMeasuredWindow, paneWindow } from './mercury-ui/geometry.js'
import { wrapPlain } from './BootHealthScreen.js'
import { truncateToWidth } from './mercury-ui/glyphs.js'
import { LLM_HOST_WORDS as words } from '../commands/llmhost/words.js'
import { runLlmHost, type LlmHostEvent, type LlmHostQuestion, type LlmHostResult, type LlmHostRoad } from '../services/llmHost/index.js'

export function LlmHostDialog({ width, rowBudget, road = runLlmHost, onLine, onHint, onOwnsEscape, onClose }: {
  width: number
  rowBudget: number
  road?: LlmHostRoad
  onLine?: (line: string) => void
  onHint?: (hint: string | null) => void
  onOwnsEscape?: (owns: boolean) => void
  onClose?: () => void
}): React.ReactNode {
  const tokens = useMercuryTokens()
  const pastOpenEvent = useOpenEventGate()
  const [question, setQuestion] = useState<LlmHostQuestion | null>(null)
  const [history, setHistory] = useState<LlmHostEvent[]>([])
  const [result, setResult] = useState<LlmHostResult | null>(null)
  const [value, setValue] = useState('')
  const [offset, setOffset] = useState(0)
  const [cursor, setCursor] = useState<number | null>(null)
  const [logOffset, setLogOffset] = useState(0)
  const [host, setHost] = useState<LlmHostEvent['host']>()
  const [now, setNow] = useState(Date.now())
  useEffect(() => { if (!host) return; const timer = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer) }, [host])
  const answerRef = useRef<((value: string | null) => void) | null>(null)
  const controllerRef = useRef<AbortController | null>(null)
  useEffect(() => {
    let live = true
    const controller = new AbortController()
    controllerRef.current = controller
    void road(plan => {
      if (!live || controller.signal.aborted) return Promise.resolve(null)
      setValue(plan.initial ?? '')
      setOffset(plan.initial?.length ?? 0)
      setLogOffset(0)
      const initialRow = plan.rows && plan.initial !== undefined ? plan.rows.findIndex(row => row.value === plan.initial) : -1
      setCursor(initialRow >= 0 ? initialRow : null)
      setQuestion(plan)
      return new Promise(resolve => { answerRef.current = resolve })
    }, event => {
      if (!live) return
      setHistory(rows => event.host && rows.at(-1)?.host?.id === event.host.id ? [...rows.slice(0, -1), event] : [...rows, event])
      if (event.host) {
        setHost(event.host)
        setQuestion(current => current?.step === 'pod-controls' ? { ...current, rows: [...(event.host?.canResume ? [{ value: 'resume', label: 'Resume setup' }] : []), ...(current.rows ?? []).filter(row => row.value !== 'resume')] } : current)
      }
    }, controller.signal).then(done => {
      if (live) { setQuestion(null); setResult(done) }
    }, error => {
      if (live) { setQuestion(null); setResult({ ok: false, words: error instanceof Error ? error.message : String(error) }) }
    })
    return () => { live = false; controller.abort(); answerRef.current?.(null); answerRef.current = null }
  }, [road])
  const line = result ? words.ended : question?.title ?? words.running
  useLayoutEffect(() => { onLine?.(line) }, [line, onLine])
  useEffect(() => { onOwnsEscape?.(true); return () => onOwnsEscape?.(false) }, [onOwnsEscape])
  const answer = (next: string | null): void => {
    const resolve = answerRef.current
    answerRef.current = null
    setValue('')
    setQuestion(null)
    resolve?.(next)
  }
  const stop = (): void => {
    controllerRef.current?.abort()
    answer(null)
    onClose?.()
  }
  const budget = Math.max(1, rowBudget)
  const compact = budget < 10
  const rows = question?.rows ?? []
  const titleLines = onLine || !question ? [] : wrapPlain(question.title, width)
  const detailLines = compact || !question ? [] : [...wrapPlain(question.found, width), ...wrapPlain(question.willRun, width)].filter(Boolean)
  const choiceHint = question?.rows ? rows.some(row => row.value === question.initial) ? words.suggested : words.choose : words.input
  const hours = host ? Math.max(0, now - Date.parse(host.startedAt)) / 3600_000 : 0
  const meter = !host ? '' : host.status === 'TERMINATED' ? words.terminatedPod : host.status === 'EXITED' ? words.stoppedDisk : host.status === 'WATCHING' ? 'Watching for stock ≤ $' + host.price.toFixed(2) + '/hr · $0.00 billed while watching' : '$' + host.price.toFixed(2) + '/hr × ' + (Number.isFinite(hours) ? hours.toFixed(2) + 'h = $' + (host.price * hours).toFixed(2) + ' so far (estimate; storage extra)' : 'elapsed time unknown')
  const hostLines = compact ? [] : [...wrapPlain(meter, width), ...(host?.step && host.status !== 'TERMINATED' ? wrapPlain(host.step, width) : [])].filter(Boolean)
  const fixed = titleLines.length + detailLines.length + hostLines.length + (question && !compact ? 1 : 0)
  const rowLines = rows.map(row => compact ? [truncateToWidth(row.label, Math.max(1, width - 2))] : wrapPlain(row.label, Math.max(1, width - 2)))
  const minimumChoices = question?.rows ? Math.min(8, rowLines.reduce((sum, lines) => sum + lines.length, 0)) : question ? 1 : 3
  const allHistory = compact ? [] : history.flatMap(row => wrapPlain(row.words, width))
  const historyBudget = Math.max(0, budget - fixed - minimumChoices - 2)
  const maxLogOffset = Math.max(0, allHistory.length - historyBudget)
  const logEnd = Math.max(historyBudget, allHistory.length - Math.min(logOffset, maxLogOffset))
  const shownHistory = historyBudget ? allHistory.slice(Math.max(0, logEnd - historyBudget), logEnd) : []
  const choiceBudget = Math.max(1, budget - fixed - shownHistory.length - (compact ? 0 : 2))
  const window = fitMeasuredWindow(rows.length, choiceBudget, span => paneWindow(rows.length, cursor ?? 0, span), win => rowLines.slice(win.start, win.end).reduce((sum, lines) => sum + lines.length, 0))
  const activeHost = host && !['TERMINATED', 'EXITED'].includes(host.status)
  const exit = activeHost ? host.status === 'WATCHING' ? 'esc closes · the stock watch keeps running' : host.step === 'ready' ? 'esc closes · the model keeps running' : 'esc closes · the setup keeps running' : 'esc closes'
  const hint = (question?.rows ? '↑↓ choose · ↵ continue · ' : '') + exit + (maxLogOffset > 0 && historyBudget ? ' · pgup/pgdn log' : '')
  useLayoutEffect(() => { onHint?.(hint); return () => onHint?.(null) }, [hint, onHint])
  useInput((_input, key, event) => {
    if (key.escape) { event.stopImmediatePropagation(); stop(); return }
    if (key.pageUp || key.pageDown) {
      event.stopImmediatePropagation()
      setLogOffset(current => Math.max(0, Math.min(maxLogOffset, current + (key.pageUp ? 1 : -1) * Math.max(1, historyBudget))))
      return
    }
    if (!question?.rows) return
    if (key.upArrow || key.downArrow || key.wheelUp || key.wheelDown) {
      event.stopImmediatePropagation()
      const down = key.downArrow || key.wheelDown
      setCursor(current => current === null ? down ? 0 : rows.length - 1 : Math.max(0, Math.min(rows.length - 1, current + (down ? 1 : -1))))
    } else if (key.return) {
      event.stopImmediatePropagation()
      if (pastOpenEvent() && cursor !== null && rows[cursor]) answer(rows[cursor]!.value)
    }
  })
  return <Box flexDirection="column" width={width} flexShrink={0} height={rowBudget} overflow="hidden">
    {shownHistory.map((text, index) => <Text key={'log-' + index} color={tokens.textMuted}>{text}</Text>)}
    {question ? <>
      {titleLines.map((text, index) => <Text key={'title-' + index} bold color={tokens.textPrimary}>{text}</Text>)}
      {detailLines.map((text, index) => <Text key={'detail-' + index} color={tokens.textSecondary}>{text}</Text>)}
      {!compact ? <Text color={tokens.textMuted}>{choiceHint}</Text> : null}
      {question.rows ? <>
        {!compact && window.above > 0 ? <Text color={tokens.textMuted}>↑ {window.above} more</Text> : null}
        {rowLines.slice(window.start, window.end).map((lines, index) => <Box key={rows[window.start + index]!.value} flexDirection="column">{lines.map((text, part) => <Text key={part} color={cursor === window.start + index ? tokens.textPrimary : tokens.textSecondary} bold={cursor === window.start + index}>{part === 0 && cursor === window.start + index ? '› ' : '  '}{text}</Text>)}</Box>)}
        {!compact && window.below > 0 ? <Text color={tokens.textMuted}>↓ {window.below} more</Text> : null}
      </> : <TextInput key={question.step} value={value} onChange={setValue} cursorOffset={offset} onChangeCursorOffset={setOffset} columns={Math.max(1, width - 2)} maxVisibleLines={1} mask={question.secret ? '*' : undefined} multiline={false} onSubmit={text => { if (pastOpenEvent()) answer(text) }} onEscape={stop} disableEscapeDoublePress />}
    </> : result ? <>
      {wrapPlain(result.words, width).slice(0, Math.max(1, budget - shownHistory.length - hostLines.length - 1)).map((text, index) => <Text key={index} bold color={result.ok ? tokens.success : tokens.warning}>{text}</Text>)}
      <Text color={tokens.textMuted}>{words.finished}</Text>
    </> : <Text color={tokens.textMuted}>{words.running}</Text>}
    {hostLines.map((text, index) => <Text key={'host-' + index} color={tokens.warning}>{text}</Text>)}
  </Box>
}
