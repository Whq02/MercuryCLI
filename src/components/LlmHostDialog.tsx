import * as React from 'react'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Box, Text, useInput } from '../ink.js'
import { escapeFromOutsidePress } from '../ink/recessLayer.js'
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
      setCursor(null)
      setQuestion(plan)
      return new Promise(resolve => { answerRef.current = resolve })
    }, event => { if (live) setHistory(rows => [...rows, event]) }, controller.signal).then(done => {
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
    if (result || escapeFromOutsidePress()) onClose?.()
    else setResult({ ok: false, words: words.stopped })
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
  const budget = Math.max(1, rowBudget)
  const compact = budget < 7
  const historyBudget = Math.max(0, Math.min(history.length, budget - (question ? 9 : 3)))
  const shownHistory = history.slice(-historyBudget || history.length)
  const rows = question?.rows ?? []
  const choices = Math.max(1, budget - shownHistory.length - (compact ? Number(budget > 1) : 7))
  const window = settingsPopupWindow(cursor ?? 0, Math.max(0, (cursor ?? 0) - choices + 1), rows.length, choices)
  return <Box flexDirection="column" width={width} flexShrink={0} maxHeight={budget} overflow="hidden">
    {shownHistory.map((row, index) => <Text key={index} color={tokens.textMuted} wrap="truncate-end">{row.title} · {row.words}</Text>)}
    {question ? <>
      {budget > 1 ? <Text bold color={tokens.textPrimary} wrap="truncate-end">{question.title}</Text> : null}
      {!compact ? <Text color={tokens.textSecondary} wrap="truncate-end">{question.found}</Text> : null}
      {!compact && question.willRun ? <Text color={tokens.textSecondary} wrap="truncate-end">will run · {question.willRun}</Text> : null}
      {!compact ? <Text color={tokens.textMuted}>{question.rows ? words.choose : words.input}</Text> : null}
      {question.rows ? <>
        {!compact && window.offset > 0 ? <Text color={tokens.textMuted}>↑ {window.offset} more</Text> : null}
        {rows.slice(window.offset, window.offset + choices).map((row, index) => <Text key={row.value} color={cursor === window.offset + index ? tokens.textPrimary : tokens.textSecondary} bold={cursor === window.offset + index} wrap="truncate-end">{cursor === window.offset + index ? '›' : ' '} {row.label}</Text>)}
        {!compact && window.offset + choices < rows.length ? <Text color={tokens.textMuted}>↓ {rows.length - window.offset - choices} more</Text> : null}
      </> : <TextInput key={question.step} value={value} onChange={setValue} cursorOffset={offset} onChangeCursorOffset={setOffset} columns={Math.max(1, width - 2)} maxVisibleLines={1} mask={question.secret ? '*' : undefined} multiline={false} onSubmit={text => { if (pastOpenEvent()) answer(text) }} onEscape={stop} disableEscapeDoublePress />}
    </> : result ? <>
      <Text bold color={result.ok ? tokens.success : tokens.warning} wrap="truncate-end">{result.words}</Text>
      <Text color={tokens.textMuted}>{words.finished}</Text>
    </> : <Text color={tokens.textMuted}>{words.running}</Text>}
  </Box>
}
