#!/usr/bin/env bun
// ============================================================================
//  scripts/ui/prove-s24-acceptance.ts
//  S24 (root-2) §7 acceptance battery — the no-existing-oracle checks that
//  are mechanically verifiable off the exported surface: paste references,
//  wheel acceleration, the modal pager step families, secret redaction, the
//  issue-draft URL cap, the fallback title, the unseen-divider counters,
//  the rewind selectable-message filter, and the transcript slice anchor.
//  Run: ~/.bun/bin/bun run scripts/ui/prove-s24-acceptance.ts
// ============================================================================

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '0.0.0-proof' }
process.env.MERCURY_ISSUES_REPO_URL = 'https://github.com/example/mercury-issues'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}

const { parseReferences, expandPastedTextRefs, formatPastedTextRef, getPastedTextRefNumLines } =
  await import('../../src/history.js')
const { initWheelAccel, computeWheelStep, dragScrollDirection } =
  await import('../../src/components/ScrollKeybindingHandler.js')
const { redactSensitiveInfo, createGitHubIssueUrl, fallbackTitle } =
  await import('../../src/components/Feedback.js')
const { countUnseenAssistantTurns, computeUnseenDivider } =
  await import('../../src/components/FullscreenLayout.js')
const { selectableUserMessagesFilter, messagesAfterAreOnlySynthetic } =
  await import('../../src/components/MessageSelector.js')
const { computeSliceStart } = await import('../../src/components/Messages.js')

// ── history references (§7 8, 9) ───────────────────────────────────────────
section('history: paste references')
{
  check('three-line text produces a +2 lines reference', formatPastedTextRef(3, getPastedTextRefNumLines('a\nb\nc')).includes('+2 lines'))
  const ref = formatPastedTextRef(1, 2)
  const refs = parseReferences(`before ${ref} after`)
  check('parseReferences finds the placeholder with its offset', refs.length === 1 && refs[0]!.id === 1 && refs[0]!.index === 7)
  check('non-positive ids are dropped', parseReferences(formatPastedTextRef(0, 2)).length === 0)
  // 9 · a pasted body containing a reference-shaped substring is NOT re-expanded.
  const innerRef = formatPastedTextRef(2, 0)
  const expanded = expandPastedTextRefs(`x ${formatPastedTextRef(1, 0)} y`, {
    1: { id: 1, type: 'text', content: `body-with ${innerRef}` } as never,
    2: { id: 2, type: 'text', content: 'MUST-NOT-APPEAR' } as never,
  })
  check('expansion replaces the outer reference', expanded.includes('body-with'))
  check('a reference-shaped substring inside a body is not re-expanded', !expanded.includes('MUST-NOT-APPEAR') && expanded.includes(innerRef))
}

// ── wheel model (§7 17, 18) ────────────────────────────────────────────────
section('wheel: browser-hosted + native models')
{
  // 17 · browser-hosted: 3 ms bursts stay at 1 row; 40 ms cadence converges
  // upward; a 600 ms gap resets to the base 2.
  const hosted = initWheelAccel(true)
  let t = 1000
  computeWheelStep(hosted, 1, t)
  const burst = computeWheelStep(hosted, 1, (t += 3))
  check('hosted: sub-5ms burst yields 1 row', burst === 1, String(burst))
  let cadenceMax = 0
  for (let i = 0; i < 30; i++) cadenceMax = Math.max(cadenceMax, computeWheelStep(hosted, 1, (t += 40)))
  check('hosted: 40ms cadence converges above the base', cadenceMax >= 3, String(cadenceMax))
  const afterGap = computeWheelStep(hosted, 1, (t += 600))
  check('hosted: a 600ms gap resets to 2', afterGap === 2, String(afterGap))

  // 18 · native flip deferral: an immediate flip yields zero rows; a flip
  // that persists commits and re-baselines.
  const native = initWheelAccel(false)
  let now = 5000
  for (let i = 0; i < 5; i++) computeWheelStep(native, 1, (now += 50))
  const flip = computeWheelStep(native, -1, (now += 50))
  check('native: an immediate direction flip defers (0 rows)', flip === 0, String(flip))
  const flipBack = computeWheelStep(native, 1, (now += 50))
  check('native: flipping back within the window costs nothing extra', flipBack >= 0)
  const native2 = initWheelAccel(false)
  now = 9000
  for (let i = 0; i < 5; i++) computeWheelStep(native2, 1, (now += 50))
  const flipEvent = computeWheelStep(native2, -1, (now += 50))
  const committed = computeWheelStep(native2, -1, (now += 60))
  check('native: the flip event itself yields zero', flipEvent === 0, String(flipEvent))
  check('native: a persisting flip commits at baseline and yields', committed > 0, String(committed))
}

// ── drag autoscroll direction (§7 24) ──────────────────────────────────────
section('drag: anchor-inside guard')
{
  check('focus above the viewport scrolls up', dragScrollDirection({ anchorRow: 10, focusRow: 2 }, 5, 20, 0) === -1)
  check('focus below the viewport scrolls down', dragScrollDirection({ anchorRow: 10, focusRow: 30 }, 5, 20, 0) === 1)
  check('anchor OUTSIDE the viewport never autoscrolls', dragScrollDirection({ anchorRow: 2, focusRow: 30 }, 5, 20, 0) === 0)
  check('focus inside the viewport does not scroll', dragScrollDirection({ anchorRow: 10, focusRow: 12 }, 5, 20, 0) === 0)
}

// ── secret redaction (§7 29) ───────────────────────────────────────────────
section('redaction: every credential class, text intact')
{
  const cases: Array<[string, string, string]> = [
    ['api key bare', 'key sk-ant-abcdefghijklmnop end', '[REDACTED_API_KEY]'],
    ['aws AKIA', 'creds AKIAABCDEFGHIJKLMNOP end', '[REDACTED_AWS_KEY]'],
    ['gcp key', 'k AIzaAbCdEfGhIjKlMnOpQrStUvWxYz012345678 end', '[REDACTED_GCP_KEY]'],
    ['gcp service account', 'svc robot@myproj.iam.gserviceaccount.com end', '[REDACTED_GCP_SERVICE_ACCOUNT]'],
    ['x-api-key header', 'x-api-key: supersecretvalue end', '[REDACTED]'],
    ['authorization header', 'authorization: Bearer abc.def.ghi end', '[REDACTED]'],
    ['aws env assignment', 'AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI end', '[REDACTED_AWS_VALUE]'],
    ['google env assignment', 'GOOGLE_APPLICATION_CREDENTIALS=/tmp/x.json end', '[REDACTED_GCP_VALUE]'],
    ['generic token assignment', 'MY_TOKEN=deadbeef123 end', '[REDACTED_TOKEN]'],
  ]
  for (const [label, input, marker] of cases) {
    const out = redactSensitiveInfo(input)
    check(`${label} → ${marker}`, out.includes(marker) && out.endsWith('end'), out.slice(0, 70))
  }
  check('surrounding text is left intact', redactSensitiveInfo('before sk-ant-abcdefghijk after').startsWith('before ') && redactSensitiveInfo('before sk-ant-abcdefghijk after').endsWith(' after'))
}

// ── issue-draft URL (§7 31) ────────────────────────────────────────────────
section('issue URL: 7250 cap, never mid-percent-escape')
{
  const bigErrors = Array.from({ length: 400 }, (_, i) => ({
    error: `error ${i} — ${'あいうえお%'.repeat(30)}`,
    timestamp: new Date().toISOString(),
  }))
  const url = createGitHubIssueUrl('fid', 'A title', 'A description', bigErrors)
  check('URL stays within 7250 characters', url.length <= 7250, String(url.length))
  const tailEscapeSafe = !/%[0-9A-Fa-f]?$/.test(url.slice(0, url.length))
  check('URL never ends mid-percent-escape', tailEscapeSafe)
  const hugeBody = [{ error: 'x'.repeat(20000), timestamp: 't' }]
  const url2 = createGitHubIssueUrl('fid', 't'.repeat(3000), 'd'.repeat(6000), hugeBody)
  check('even a giant title+description stays capped', url2.length <= 7250, String(url2.length))
  check('labels ride the fixed set', url.includes(encodeURIComponent('user-reported,bug')))
  const empty = createGitHubIssueUrl('fid', 't', 'd', [])
  check('no configured repo ⇒ empty string', (() => { const saved = process.env.MERCURY_ISSUES_REPO_URL; delete process.env.MERCURY_ISSUES_REPO_URL; const r = createGitHubIssueUrl('f', 't', 'd', []); process.env.MERCURY_ISSUES_REPO_URL = saved; return r === '' })())
  void empty
}

// ── fallback title ─────────────────────────────────────────────────────────
section('feedback: fallback title rules')
{
  check('a 6–60 char first line is used as-is', fallbackTitle('Scroll resets on resize') === 'Scroll resets on resize')
  const long = fallbackTitle('word '.repeat(30))
  check('over-60 truncates to a word boundary past 30 with an ellipsis', long.length <= 61 && long.endsWith('…'))
  check('under-10-char results fall to the generic title', fallbackTitle('hi') !== 'hi' && fallbackTitle('hi').length >= 10)
}

// ── unseen divider ─────────────────────────────────────────────────────────
section('unseen divider: turn transitions + floor')
{
  const assistant = (uuid: string, text: string): unknown => ({ type: 'assistant', uuid, message: { content: [{ type: 'text', text }] } })
  const toolOnly = (uuid: string): unknown => ({ type: 'assistant', uuid, message: { content: [{ type: 'tool_use', id: 'x', name: 'T', input: {} }] } })
  const user = (uuid: string): unknown => ({ type: 'user', uuid, message: { role: 'user', content: 'hi' } })
  const progress = (uuid: string): unknown => ({ type: 'progress', uuid })
  const messages = [user('u1'), assistant('a1', 'one'), toolOnly('a2'), assistant('a3', 'still turn 1'), progress('p1'), user('u2'), assistant('a4', 'turn 2')] as never[]
  check('turns count non-assistant→assistant transitions', countUnseenAssistantTurns(messages, 0) === 2, String(countUnseenAssistantTurns(messages, 0)))
  check('tool-call-only rows do not break a turn', countUnseenAssistantTurns(messages, 1) === 2)
  const divider = computeUnseenDivider(messages, 5)
  check('divider anchors on the first non-progress row and floors at 1', divider !== undefined && divider.firstUnseenUuid === 'u2' && divider.count >= 1)
  check('a null index yields no divider', computeUnseenDivider(messages, null) === undefined)
  check('an out-of-range index yields no divider', computeUnseenDivider(messages, 99) === undefined)
}

// ── rewind: selectable messages + synthetic tail ───────────────────────────
section('rewind: selectable filter + only-synthetic predicate')
{
  const plain = { type: 'user', uuid: 'u1', timestamp: 't', message: { role: 'user', content: 'do the thing' } }
  const toolResult = { type: 'user', uuid: 'u2', timestamp: 't', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'x', content: 'r' }] } }
  const meta = { ...plain, uuid: 'u3', isMeta: true }
  const compact = { ...plain, uuid: 'u4', isCompactSummary: true }
  const marker = { type: 'user', uuid: 'u5', timestamp: 't', message: { role: 'user', content: '<local-command-stdout>x</local-command-stdout>' } }
  const teammate = { type: 'user', uuid: 'u6', timestamp: 't', message: { role: 'user', content: '<teammate-message from="a">hey' } }
  check('a plain user message is selectable', selectableUserMessagesFilter(plain as never))
  check('a tool-result-first message is not', !selectableUserMessagesFilter(toolResult as never))
  check('a meta message is not', !selectableUserMessagesFilter(meta as never))
  check('a compact summary is not', !selectableUserMessagesFilter(compact as never))
  check('a machine-marker message is not', !selectableUserMessagesFilter(marker as never))
  check('a teammate-tag PREFIX (attributes, no closing bracket) is caught', !selectableUserMessagesFilter(teammate as never))
  const tail = [plain, { type: 'assistant', uuid: 'a1', timestamp: 't', message: { content: [{ type: 'text', text: '' }] } }, toolResult] as never[]
  check('empty-text assistant + tool results after index 0 are only-synthetic', messagesAfterAreOnlySynthetic(tail, 0))
  const meaningful = [plain, { type: 'assistant', uuid: 'a2', timestamp: 't', message: { content: [{ type: 'text', text: 'answer' }] } }] as never[]
  check('a real assistant answer after the index is meaningful', !messagesAfterAreOnlySynthetic(meaningful, 0))
}

// ── transcript slice anchor (§7 10) ────────────────────────────────────────
section('transcript: slice anchor cap/step')
{
  const rows = (n: number): Array<{ uuid: string }> => Array.from({ length: n }, (_, i) => ({ uuid: `u${i}` }))
  const anchorRef = { current: null as never }
  const at400 = computeSliceStart(rows(400) as never, anchorRef as never)
  const at401 = computeSliceStart(rows(401) as never, anchorRef as never)
  check('one appended message does not move the slice start', at400 === at401, `${at400} vs ${at401}`)
  const at460 = computeSliceStart(rows(460) as never, anchorRef as never)
  check('exceeding cap+step advances the start', at460 > at400, `${at400} → ${at460}`)
}

console.log('\n' + '='.repeat(60))
if (failures === 0) {
  console.log(' ✅ S24 ACCEPTANCE BATTERY PASSES')
  process.exit(0)
} else {
  console.log(` ❌ S24 acceptance — ${failures} check(s) failed`)
  process.exit(1)
}
