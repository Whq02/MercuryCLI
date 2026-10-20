import * as React from 'react'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Box, Text, useInput, wrapText } from '../ink.js'
import { fitMeasuredWindow } from './mercury-ui/geometry.js'
import TextInput from './TextInput.js'
import { useMercuryTokens } from './mercury-ui/useMercuryTokens.js'
import { useOpenEventGate } from './mercury-ui/useOpenEventGate.js'
import { settingsPopupWindow } from '../utils/cockpit/settingsPopup.js'
import { LLM_HOST_WORDS as words } from '../commands/llmhost/words.js'
import { runLlmHost, type LlmHostEvent, type LlmHostQuestion, type LlmHostResult, type LlmHostRoad } from '../services/llmHost/index.js'

export function LlmHostDialog({ width, rowBudget, road = runLlmHost, onLine, onOwnsEscape, onClose }: {
  width: number
  rowBudget: number
  road?: LlmHostRoad
  onLine?: (line: string) => void
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
  useInput((_input, key, event) => {
    if (key.escape) { event.stopImmediatePropagation(); stop(); return }
    if (!question?.rows) return
    if (key.upArrow || key.downArrow || key.wheelUp || key.wheelDown) {
      event.stopImmediatePropagation()
      const down = key.downArrow || key.wheelDown
      setCursor(current => current === null ? down ? 0 : question.rows!.length - 1 : Math.max(0, Math.min(question.rows!.length - 1, current + (down ? 1 : -1))))
    } else if (key.return) {
      event.stopImmediatePropagation()
      if (pastOpenEvent() && cursor !== null && question.rows[cursor]) answer(question.rows[cursor]!.value)
    }
  })
  const budget = Math.max(1, rowBudget - (host ? 2 : 0))
  const compact = budget < 7
  const modelDoor = question?.step.startsWith('door-') === true
  const measured = (text: string, columns = width): number => wrapText(text, Math.max(1, columns), 'wrap').split('\n').length
  const detailRows = modelDoor && !compact ? measured(question.found) + (question.willRun ? measured('will run · ' + question.willRun) : 0) : 2
  const historyBudget = modelDoor ? 0 : Math.max(0, Math.min(history.length, budget - (question ? 7 + Math.min(question.rows?.length ?? 1, 8) : 3)))
  const shownHistory = history.slice(-historyBudget || history.length)
  const rows = question?.rows ?? []
  const choices = Math.max(1, budget - shownHistory.length - (compact ? Number(budget > 1) : 5 + detailRows))
  const windowFor = (span: number) => {
    const { offset } = settingsPopupWindow(cursor ?? 0, Math.max(0, (cursor ?? 0) - span + 1), rows.length, span)
    const end = Math.min(rows.length, offset + span)
    return { start: offset, end, above: offset, below: rows.length - end }
  }
  const fitted = modelDoor ? fitMeasuredWindow(rows.length, choices, windowFor, view => rows.slice(view.start, view.end).reduce((sum, row) => sum + measured(row.label, width - 2), 0)) : windowFor(choices)
  const window = { offset: fitted.start, visible: fitted.end - fitted.start }
  return <Box flexDirection="column" width={width} flexShrink={0} maxHeight={rowBudget} overflow="hidden">
    {shownHistory.map((row, index) => <Text key={index} color={tokens.textMuted} wrap="truncate-end">{row.title} · {row.words}</Text>)}
    {question ? <>
      {budget > 1 ? <Text bold color={tokens.textPrimary} wrap="truncate-end">{question.title}</Text> : null}
      {!compact ? <Text color={tokens.textSecondary} wrap={modelDoor ? "wrap" : "truncate-end"}>{question.found}</Text> : null}
      {!compact && question.willRun ? <Text color={tokens.textSecondary} wrap={modelDoor ? "wrap" : "truncate-end"}>will run · {question.willRun}</Text> : null}
      {!compact ? <Text color={tokens.textMuted}>{question.rows ? question.rows.some(row => row.value === question.initial) ? words.suggested : words.choose : words.input}</Text> : null}
      {question.rows ? <>
        {!compact && window.offset > 0 ? <Text color={tokens.textMuted}>↑ {window.offset} more</Text> : null}
        {rows.slice(window.offset, window.offset + window.visible).map((row, index) => {
          const divider = modelDoor && row.label.startsWith('─') ? row.label.split('\n')[0] : undefined
          const label = divider ? row.label.slice(divider.length + 1) : row.label
          return <Box key={row.value} flexDirection="column">
            {divider ? <Text color={tokens.textMuted}>{divider}</Text> : null}
            <Text color={cursor === window.offset + index ? tokens.textPrimary : tokens.textSecondary} bold={cursor === window.offset + index} wrap={modelDoor ? "wrap" : "truncate-end"}>{cursor === window.offset + index ? '›' : ' '} {label}</Text>
          </Box>
        })}
        {!compact && window.offset + window.visible < rows.length ? <Text color={tokens.textMuted}>↓ {rows.length - window.offset - window.visible} more</Text> : null}
      </> : <TextInput key={question.step} value={value} onChange={setValue} cursorOffset={offset} onChangeCursorOffset={setOffset} columns={Math.max(1, width - 2)} maxVisibleLines={1} mask={question.secret ? '*' : undefined} multiline={false} onSubmit={text => { if (pastOpenEvent()) answer(text) }} onEscape={stop} disableEscapeDoublePress />}
    </> : result ? <>
      <Text bold color={result.ok ? tokens.success : tokens.warning} wrap="truncate-end">{result.words}</Text>
      <Text color={tokens.textMuted}>{words.finished}</Text>
    </> : <Text color={tokens.textMuted}>{words.running}</Text>}
    {host ? <>
      <Text color={tokens.warning} wrap="truncate-end">{host.id} · {host.status === 'TERMINATED' ? words.terminatedPod : host.status === 'EXITED' ? words.stoppedDisk : host.status === 'WATCHING' ? 'watching for stock ≤ $' + host.price.toFixed(2) + '/hr · $0.00 billed while watching' : '$' + host.price.toFixed(2) + '/hr × ' + (Math.max(0, now - Date.parse(host.startedAt)) / 3600_000).toFixed(2) + 'h = $' + (host.price * Math.max(0, now - Date.parse(host.startedAt)) / 3600_000).toFixed(2) + ' so far (estimate; storage extra)'}</Text>
      <Text color={tokens.textMuted} wrap="truncate-end">{host.status === 'TERMINATED' ? '' : host.step ?? words.podKept}</Text>
    </> : null}
  </Box>
}
