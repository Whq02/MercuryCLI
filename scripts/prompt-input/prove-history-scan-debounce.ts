#!/usr/bin/env bun
(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

let failures = 0
let checks = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  checks++
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
}
const section = (t: string): void => {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}
const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

const hooks = await import('../../src/screen/composer/history-search/useHistorySearch.ts')
const { armHistoryScanTimer, disarmHistoryScanTimer, historyScanTimerCensus, HISTORY_SCAN_DEBOUNCE_MS } = hooks

section('D1 · a keystroke burst coalesces to ONE scan')
{
  let runs = 0
  let timer: ReturnType<typeof setTimeout> | null = null
  for (let i = 0; i < 10; i++) {
    disarmHistoryScanTimer(timer)
    timer = armHistoryScanTimer(() => {
      timer = null
      runs++
    }, HISTORY_SCAN_DEBOUNCE_MS)
  }
  check('mid-burst: at most one timer is live', historyScanTimerCensus() === 1, `census=${historyScanTimerCensus()} — fix armHistoryScanTimer and disarmHistoryScanTimer in src/screen/composer/history-search/useHistorySearch.ts so a re-arm after a disarm leaves one live timer`)
  await sleep(HISTORY_SCAN_DEBOUNCE_MS * 3)
  check('the burst ran the scan exactly ONCE (the previous shape ran 10)', runs === 1, `runs=${runs} — fix armHistoryScanTimer in src/screen/composer/history-search/useHistorySearch.ts so a burst of arm and disarm pairs runs the callback once`)
  check('census back to zero after the window', historyScanTimerCensus() === 0, `census=${historyScanTimerCensus()} — fix armHistoryScanTimer in src/screen/composer/history-search/useHistorySearch.ts so a timer leaves the census when it fires`)
}

section('D2 · census discipline')
{
  let ran = 0
  const t = armHistoryScanTimer(() => {
    ran++
  }, HISTORY_SCAN_DEBOUNCE_MS)
  disarmHistoryScanTimer(t)
  await sleep(HISTORY_SCAN_DEBOUNCE_MS * 2)
  check('a disarmed timer never runs and leaves the census at zero', ran === 0 && historyScanTimerCensus() === 0, `ran=${ran} census=${historyScanTimerCensus()} — fix disarmHistoryScanTimer in src/screen/composer/history-search/useHistorySearch.ts so it clears the timer and removes it from the census`)
  let windows = 0
  const t2 = armHistoryScanTimer(() => {
    windows++
  }, 5)
  void t2
  await sleep(20)
  const t3 = armHistoryScanTimer(() => {
    windows++
  }, 5)
  void t3
  await sleep(20)
  check('distinct windows each run once', windows === 2 && historyScanTimerCensus() === 0, `windows=${windows} — fix armHistoryScanTimer in src/screen/composer/history-search/useHistorySearch.ts so each armed timer runs once and leaves the census`)
}

section('D3 · source pins — Enter immediate, flush-on-cycle, disarm on every exit')
{
  check('the cadence is roughly one frame (20-50ms)', HISTORY_SCAN_DEBOUNCE_MS >= 20 && HISTORY_SCAN_DEBOUNCE_MS <= 50, String(HISTORY_SCAN_DEBOUNCE_MS) + ' — set HISTORY_SCAN_DEBOUNCE_MS in src/screen/composer/history-search/useHistorySearch.ts back to a value from 20 to 50')
}

section('G · the fast-Enter arm — the identity is fixed synchronously over the loaded corpus')
{
  const { findHistoryMatchSync, resolveFixedMatch } = hooks
  type Rec = { display: string; pastedContents: Record<number, { id: number; type: 'text' | 'image'; content?: string; contentHash?: string }>; timestamp: number; project: string }
  const rec = (display: string, pastedContents: Rec['pastedContents'] = {}): Rec => ({ display, pastedContents, timestamp: 1, project: '/p' })
  const corpus = [rec('foo fighters'), rec('foobar'), rec('foob!'), rec('unrelated')] as never
  {
    const settledForFoo = findHistoryMatchSync(corpus, 'foo', new Set())
    check('G1 fixture: the settled "foo" match is the first row', settledForFoo?.display === 'foo fighters', 'fix findHistoryMatchSync in src/screen/composer/history-search/useHistorySearch.ts so it returns the first matching record of the corpus: ' + String(settledForFoo?.display))
    let timer: ReturnType<typeof setTimeout> | null = armHistoryScanTimer(() => {}, HISTORY_SCAN_DEBOUNCE_MS)
    disarmHistoryScanTimer(timer)
    timer = null
    const fixed = findHistoryMatchSync(corpus, 'foob', new Set())
    check("G1 the fixed identity is the NEW query's first match, not the stale settled one", fixed?.display === 'foobar' && fixed?.display !== settledForFoo?.display, String(fixed?.display) + ' — fix findHistoryMatchSync in src/screen/composer/history-search/useHistorySearch.ts so it searches the new query over the loaded corpus')
    check('G1 the pending timer is gone (census 0)', historyScanTimerCensus() === 0, `census=${historyScanTimerCensus()} — fix disarmHistoryScanTimer in src/screen/composer/history-search/useHistorySearch.ts`)
    await sleep(HISTORY_SCAN_DEBOUNCE_MS * 2)
    check('G1 the disarmed scan never fires', historyScanTimerCensus() === 0, 'fix disarmHistoryScanTimer in src/screen/composer/history-search/useHistorySearch.ts so a disarmed timer is cleared')
  }
  check('G2 with the seen set standing, the next not-yet-seen match is fixed', findHistoryMatchSync(corpus, 'foob', new Set(['foobar']))?.display === 'foob!', 'fix findHistoryMatchSync in src/screen/composer/history-search/useHistorySearch.ts so it skips displays in the seen set')
  check('G2 the walk keeps the reader order (newest first)', findHistoryMatchSync(corpus, 'foo', new Set())?.display === 'foo fighters', 'fix findHistoryMatchSync in src/screen/composer/history-search/useHistorySearch.ts so it walks the corpus in order and returns the first match')
  check('G3 no record matches ⇒ undefined (Enter then acts on no match, never a stale one)', findHistoryMatchSync(corpus, 'zzz', new Set()) === undefined, 'fix findHistoryMatchSync in src/screen/composer/history-search/useHistorySearch.ts so it returns undefined when nothing matches')
  check('G3 every match seen ⇒ undefined', findHistoryMatchSync(corpus, 'foob', new Set(['foobar', 'foob!'])) === undefined, 'fix findHistoryMatchSync in src/screen/composer/history-search/useHistorySearch.ts so it returns undefined when every match is in the seen set')
  {
    let plain: unknown = 'unset'
    resolveFixedMatch(rec('plain prompt') as never, entry => {
      plain = entry
    })
    const p = plain as { display?: string; pastedContents?: Record<number, unknown> } | 'unset'
    check('G4 a record without pastes settles before the call returns', p !== 'unset' && p?.display === 'plain prompt' && Object.keys(p?.pastedContents ?? { x: 1 }).length === 0, JSON.stringify(plain) + ' — fix resolveFixedMatch in src/screen/composer/history-search/useHistorySearch.ts so a record without pastes calls back before it returns')
    let pasted: unknown = 'unset'
    resolveFixedMatch(rec('with a paste [Pasted text #1 +2 lines]', { 1: { id: 1, type: 'text', content: 'a\nb\nc' } }) as never, entry => {
      pasted = entry
    })
    check('G4 a paste-bearing record does not settle synchronously (the identity is already fixed)', pasted === 'unset', 'fix resolveFixedMatch in src/screen/composer/history-search/useHistorySearch.ts so a record with pastes resolves them before it calls back')
    await sleep(30)
    const q = pasted as { display?: string; pastedContents?: Record<number, { content?: string }> } | 'unset'
    check('G4 …and settles with the paste resolved through the corpus reader', q !== 'unset' && q?.pastedContents?.[1]?.content === 'a\nb\nc', JSON.stringify(pasted) + ' — fix resolveFixedMatch in src/screen/composer/history-search/useHistorySearch.ts so the callback receives the pasted content')
  }
}

console.log('\n' + '='.repeat(60))
console.log(` ${checks} checks, ${failures} failures`)
console.log('='.repeat(60))
process.exit(failures > 0 ? 1 : 0)
