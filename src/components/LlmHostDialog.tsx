import * as React from 'react'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Box, Text, useInput, wrapText } from '../ink.js'
import { useRegisterOverlay } from '../context/overlayContext.js'
import TextInput from './TextInput.js'
import { HuggingfaceConnect } from './HuggingfaceConnect.js'
import { useMercuryTokens } from './mercury-ui/useMercuryTokens.js'
import { useOpenEventGate } from './mercury-ui/useOpenEventGate.js'
import { fitMeasuredWindow, paneWindow } from './mercury-ui/geometry.js'
import { wrapPlain } from './BootHealthScreen.js'
import { truncateToWidth } from './mercury-ui/glyphs.js'
import { POPUP_PAGE_HINT, PopupListViewport, popupListMotion } from './CustomSelect/popup-list.js'
import { MenuFilterLine } from './mercury-ui/menuFold.js'
import { LLM_HOST_SEARCH_MIN_CHARS, LLM_HOST_SEARCH_SETTLE_MS, LLM_HOST_WORDS as words } from '../commands/llmhost/words.js'
import { isSearchCharacter } from '../utils/model/modelPickerGroups.js'
import { runLlmHost, type LlmHostEvent, type LlmHostQuestion, type LlmHostResult, type LlmHostRoad } from '../services/llmHost/index.js'

type QuestionRow = NonNullable<LlmHostQuestion['rows']>[number]
const rowMatches = (row: QuestionRow, query: string): boolean => row.label.replace(/^─+\n/, '').split(' · ')[0]!.toLowerCase().includes(query.toLowerCase())
const visibleRowsOf = (plan: LlmHostQuestion | null, query: string): QuestionRow[] => !plan?.rows ? [] : plan.search && query ? plan.rows.filter(row => rowMatches(row, query)) : [...plan.rows]

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
  useRegisterOverlay('select', true, { ownsPageKeys: true })
  const pastOpenEvent = useOpenEventGate()
  const [question, setQuestion] = useState<LlmHostQuestion | null>(null)
  const [history, setHistory] = useState<LlmHostEvent[]>([])
  const [result, setResult] = useState<LlmHostResult | null>(null)
  const [value, setValue] = useState('')
  const [offset, setOffset] = useState(0)
  const [cursor, setCursor] = useState<number | null>(null)
  const [query, setQuery] = useState('')
  const queryRef = useRef('')
  const selectedRef = useRef<string | null>(null)
  const searchingRef = useRef(false)
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
      const nextQuery = !plan.search ? '' : searchingRef.current ? queryRef.current : plan.search.query
      const visible = visibleRowsOf(plan, nextQuery)
      const kept = plan.search && searchingRef.current ? visible.findIndex(row => row.value === selectedRef.current) : -1
      const initialRow = plan.initial !== undefined ? visible.findIndex(row => row.value === plan.initial) : -1
      setQuery(nextQuery)
      setCursor(kept >= 0 ? kept : initialRow >= 0 ? initialRow : plan.search && nextQuery && visible.length ? 0 : null)
      setQuestion(plan)
      return new Promise(resolve => { answerRef.current = resolve })
    }, event => {
      if (!live) return
      setHistory(rows => event.host && rows.at(-1)?.host?.id === event.host.id ? [...rows.slice(0, -1), event] : [...rows, event])
      if (event.host) {
        setHost(event.host)
        setQuestion(current => {
          if (current?.step !== 'pod-controls') return current
          const rows = [...(event.host?.canTune ? [{ value: 'tune', label: 'Tune · quality, conversations × context, thinking' }] : []), ...(event.host?.canResume ? [{ value: 'resume', label: event.host.managed ? 'Resume endpoint' : 'Resume setup' }] : []), ...(current.rows ?? []).filter(row => row.value !== 'resume' && row.value !== 'tune')]
          setCursor(selected => {
            if (selected === null) return null
            const value = current.rows?.[selected]?.value
            const index = rows.findIndex(row => row.value === value)
            return index < 0 ? null : index
          })
          return { ...current, rows }
        })
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
  const retarget = (nextQuery: string): void => {
    queryRef.current = nextQuery
    setQuery(nextQuery)
    const visible = visibleRowsOf(question, nextQuery)
    const at = visible.findIndex(row => row.value === selectedRef.current)
    setCursor(at >= 0 ? at : visible.length ? 0 : null)
  }
  useEffect(() => {
    if (!question?.search) return
    const typed = query.trim()
    const target = typed.length >= LLM_HOST_SEARCH_MIN_CHARS ? typed : ''
    if (target === question.search.query) return
    const timer = setTimeout(() => {
      const resolve = answerRef.current
      if (!resolve) return
      answerRef.current = null
      resolve('search:' + target)
    }, target ? LLM_HOST_SEARCH_SETTLE_MS : 0)
    return () => clearTimeout(timer)
  }, [query, question])
  const stop = (): void => {
    controllerRef.current?.abort()
    answer(null)
    onClose?.()
  }
  const budget = Math.max(1, rowBudget)
  const compact = budget < 10 && !question?.fullDetails
  const rows = visibleRowsOf(question, query)
  queryRef.current = query
  searchingRef.current = Boolean(question?.search)
  selectedRef.current = cursor !== null ? rows[cursor]?.value ?? null : null
  const searchLines = question?.search ? 1 + (question.search.note ? 1 : 0) : 0
  const titleLines = onLine || !question ? [] : wrapPlain(question.title, width)
  const modelDoor = question?.step.startsWith('door-') === true
  const wrapRow = (text: string, columns: number): string[] => modelDoor ? wrapText(text, Math.max(1, columns), 'wrap').split('\n') : wrapPlain(text, columns)
  const baseDetails = !question ? [] : [...wrapRow(question.found, width), ...wrapRow(question.willRun, width)].filter(Boolean)
  const disclosure = question?.step !== 'rent-confirm' ? [] : (question.lines ?? []).flatMap(text => wrapPlain(text, width))
  const choiceHint = question?.rows ? cursor !== null && rows[cursor] ? words.suggested : words.choose : words.input
  const hours = host ? Math.max(0, now - Date.parse(host.startedAt)) / 3600_000 : 0
  const meter = !host ? '' : host.managed ? host.status === 'TERMINATED' ? 'HF endpoint terminated' : host.status === 'EXITED' ? 'HF endpoint · paused · no compute bills' : 'HF endpoint · $' + host.price.toFixed(2) + '/hr until Pause or Terminate' : host.status === 'TERMINATED' ? words.terminatedPod : host.status === 'EXITED' ? words.stoppedDisk : host.status === 'WATCHING' ? 'Watching ≤ $' + host.price.toFixed(2) + '/hr · $0.00 while watching' : '$' + host.price.toFixed(2) + '/hr · ' + (Number.isFinite(hours) ? '~$' + (host.price * hours).toFixed(2) + ' so far + storage' : 'elapsed time unknown')
  const hostLines = compact || result && host?.status === 'TERMINATED' ? [] : [...wrapPlain(meter, width), ...(host?.step && host.status !== 'TERMINATED' ? wrapPlain(host.step, width) : [])].filter(Boolean)
  const labelDividers = rows.map(row => modelDoor && row.label.startsWith('─') ? row.label.split('\n')[0]! : undefined)
  const sectioned = Boolean(question?.search && query)
  const rowDividers = rows.map((row, index) => sectioned && row.section && (index === 0 || rows[index - 1]!.section !== row.section) ? row.section : labelDividers[index])
  const rowLabels = rows.map((row, index) => labelDividers[index] && rowDividers[index] === labelDividers[index] ? row.label.slice(labelDividers[index]!.length + 1) : row.label)
  const rowLines = rowLabels.map((label, index) => [...(rowDividers[index] ? [rowDividers[index]!] : []), ...(compact ? [truncateToWidth(label, Math.max(1, width - 3))] : wrapRow(label, Math.max(1, width - 3)))])
  const rowsHeight = rowLines.reduce((sum, lines) => sum + lines.length, 0)
  const minimumChoices = question?.rows ? Math.min(8, rowsHeight, Math.max(1, budget - titleLines.length - hostLines.length - searchLines - (compact ? 1 : 3))) : question ? 1 : 3
  const allDetails = question?.step === 'rent-confirm' ? [...wrapRow(question.found, width), ...disclosure, ...wrapRow(question.willRun, width)].filter(Boolean) : baseDetails
  const detailRoom = Math.max(0, budget - titleLines.length - hostLines.length - searchLines - (question && !compact ? 1 : 0) - minimumChoices - (compact ? 0 : 2))
  const scrollDetails = !question?.fullDetails && allDetails.length > detailRoom
  const detailMarker = scrollDetails && detailRoom > 1
  const detailPage = scrollDetails ? Math.max(0, detailRoom - (detailMarker ? 1 : 0)) : allDetails.length
  const maxDetailOffset = scrollDetails ? Math.max(0, allDetails.length - detailPage) : 0
  const detailOffset = Math.min(logOffset, maxDetailOffset)
  const detailLines = scrollDetails ? allDetails.slice(detailOffset, detailOffset + detailPage) : allDetails
  const fixed = titleLines.length + detailLines.length + hostLines.length + searchLines + (question && !compact ? 1 : 0) + (detailMarker ? 1 : 0)
  const detailsFit = !question?.fullDetails || !compact && budget >= fixed + rowsHeight
  const allHistory = compact || scrollDetails || question?.step === 'rent-confirm' || question?.step.startsWith('tune-') ? [] : history.filter(row => row.words !== result?.words).flatMap(row => wrapPlain(row.words, width))
  const historyBudget = Math.max(0, budget - fixed - minimumChoices - 2)
  const maxLogOffset = Math.max(0, allHistory.length - historyBudget)
  const logEnd = Math.max(historyBudget, allHistory.length - Math.min(logOffset, maxLogOffset))
  const shownHistory = historyBudget ? allHistory.slice(Math.max(0, logEnd - historyBudget), logEnd) : []
  const available = budget - fixed - shownHistory.length
  const choiceBudget = Math.max(1, available)
  const window = fitMeasuredWindow(rows.length, choiceBudget, span => paneWindow(rows.length, cursor ?? 0, span), win => rowLines.slice(win.start, win.end).reduce((sum, lines) => sum + lines.length, 0))
  const activeHost = host && !['TERMINATED', 'EXITED'].includes(host.status)
  const exit = activeHost ? host.status === 'WATCHING' ? 'esc closes · watch continues' : 'esc closes · billing continues' : 'esc closes'
  const choicesPage = Boolean(question?.rows) && detailsFit && !scrollDetails && window.end - window.start < rows.length
  const keyActions = question?.rows && !question.search && question.keys?.length ? question.keys : []
  const hint = (question?.rows ? '↑↓ choose · ' + (choicesPage ? POPUP_PAGE_HINT + ' · ' : '') + '↵ continue · ' : '') + keyActions.map(action => action.key + ' ' + (action.label ?? action.value) + ' · ').join('') + (question?.search ? 'type to search · ' : '') + (question?.search && query ? 'esc clears the search' : exit) + (scrollDetails ? ' · pgup/pgdn details' : !choicesPage && maxLogOffset > 0 && historyBudget ? ' · pgup/pgdn log' : '')
  useLayoutEffect(() => { onHint?.(hint); return () => onHint?.(null) }, [hint, onHint])
  useInput((input, key, event) => {
    if (question?.step === 'huggingface-login') return
    if (key.escape) { event.stopImmediatePropagation(); if (question?.search && query) { retarget(''); return } stop(); return }
    const action = keyActions.length && !key.ctrl && !key.meta && input.length === 1 ? keyActions.find(row => row.key === input) : undefined
    if (action) {
      event.stopImmediatePropagation()
      const target = question?.step === 'door-model' ? rows.find(row => row.value === 'bank') : cursor !== null ? rows[cursor] : undefined
      if (pastOpenEvent() && detailsFit && target) answer(action.value + ':' + target.value)
      return
    }
    if ((key.pageUp || key.pageDown) && choicesPage) {
      event.stopImmediatePropagation()
      const target = popupListMotion(input, key, cursor ?? 0, rows.length, Math.max(1, window.end - window.start))
      if (target !== null) setCursor(target)
      return
    }
    if (key.pageUp || key.pageDown) {
      event.stopImmediatePropagation()
      setLogOffset(current => scrollDetails ? Math.max(0, Math.min(maxDetailOffset, current + (key.pageDown ? 1 : -1) * detailPage)) : Math.max(0, Math.min(maxLogOffset, current + (key.pageUp ? 1 : -1) * Math.max(1, historyBudget))))
      return
    }
    if (question?.search && question.rows) {
      if (key.backspace || key.delete) { event.stopImmediatePropagation(); retarget(queryRef.current.slice(0, -1)); return }
      if (isSearchCharacter(input, key) && !key.return) { event.stopImmediatePropagation(); if (pastOpenEvent()) retarget(queryRef.current + input); return }
    }
    if (!question?.rows || !detailsFit) return
    if (key.upArrow || key.downArrow || key.wheelUp || key.wheelDown) {
      event.stopImmediatePropagation()
      const down = key.downArrow || key.wheelDown
      setCursor(current => current === null ? down ? 0 : rows.length - 1 : Math.max(0, Math.min(rows.length - 1, current + (down ? 1 : -1))))
    } else if (key.return) {
      event.stopImmediatePropagation()
      if (pastOpenEvent() && detailsFit && cursor !== null && rows[cursor]) answer(rows[cursor]!.value)
    }
  })
  if (question?.step === 'huggingface-login') return <HuggingfaceConnect onResult={outcome => { setHistory(rows => [...rows, { title: 'Hugging Face sign-in', words: outcome.receipt }]); answer(outcome.ok ? 'connected' : 'cancel') }} />
  return <Box flexDirection="column" width={width} flexShrink={0} height={rowBudget} overflow="hidden">
    {shownHistory.map((text, index) => <Text key={'log-' + index} color={tokens.textMuted}>{text}</Text>)}
    {question ? <>
      {titleLines.map((text, index) => <Text key={'title-' + index} bold color={tokens.textPrimary}>{text}</Text>)}
      {detailLines.map((text, index) => <Text key={'detail-' + index} color={tokens.textSecondary}>{text}</Text>)}
      {detailMarker ? <Text color={tokens.textMuted}>Details {detailOffset + 1}–{detailOffset + detailLines.length} of {allDetails.length} · pgup/pgdn</Text> : null}
      {!detailsFit ? <Text color={tokens.warning} wrap="wrap">Enlarge the terminal to see the full setup plan before confirming · esc closes</Text> : null}
      {question.search ? <MenuFilterLine focused text={truncateToWidth(query, Math.max(1, width - 2))} placeholder={question.search.placeholder} accent={tokens.accent} muted={tokens.textMuted} primary={tokens.textPrimary} /> : null}
      {!compact && detailsFit ? <Text color={tokens.textMuted}>{choiceHint}</Text> : null}
      {!detailsFit ? null : question.rows ? <PopupListViewport above={window.above} below={window.below} rows={rowLines.slice(window.start, window.end).reduce((sum, lines) => sum + lines.length, 0)}>
        {rowLines.slice(window.start, window.end).map((lines, index) => { const at = window.start + index; const first = rowDividers[at] ? 1 : 0; return <Box key={rows[at]!.value} flexDirection="column">{lines.map((text, part) => part < first ? <Text key={part} color={rowDividers[at] === rows[at]!.section ? tokens.textInstruction : tokens.textMuted}>{text}</Text> : <Text key={part} color={cursor === at ? tokens.textPrimary : tokens.textSecondary} bold={cursor === at}>{part === first && cursor === at ? '› ' : '  '}{text}</Text>)}</Box> })}
      </PopupListViewport> : <TextInput key={question.step} value={value} onChange={setValue} cursorOffset={offset} onChangeCursorOffset={setOffset} columns={Math.max(1, width - 2)} maxVisibleLines={1} mask={question.secret ? '*' : undefined} multiline={false} onSubmit={text => { if (pastOpenEvent()) answer(text) }} onEscape={stop} disableEscapeDoublePress />}
      {question.search?.note && detailsFit ? <Text color={tokens.textInstruction}>{truncateToWidth(question.search.note, Math.max(1, width))}</Text> : null}
    </> : result ? <>
      {wrapPlain(result.words, width).slice(0, Math.max(1, budget - shownHistory.length - hostLines.length - 1)).map((text, index) => <Text key={index} bold color={result.ok ? tokens.success : tokens.warning}>{text}</Text>)}
      {!onHint ? <Text color={tokens.textMuted}>{words.finished}</Text> : null}
    </> : <Text color={tokens.textMuted}>{words.running}</Text>}
    {hostLines.map((text, index) => <Text key={'host-' + index} color={tokens.warning}>{text}</Text>)}
  </Box>
}
