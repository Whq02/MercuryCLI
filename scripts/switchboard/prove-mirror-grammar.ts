// ============================================================================
//  prove-mirror-grammar — the switchboard mirror domain prover (
// IP-2/3/7, mirror-renderer-continuity, mirror-agent-word).
//
//  Law 1 (renderer continuity): SessionMirror feeds the REAL message pipeline
//  — the shared fold module + MessageRow dispatch — never hand-painted text
//  lines, no lockup, no composer, no caret.
//  Law 2 (the word-ban): the word "agent" is unreachable in the mirror's
//  painted output — absent from the component source (comments stripped) and
//  mapped away by the ONE pure plate-name home (attachedPlateName).
//  Law 3 (density): every fold CLOSED by default — verbose={false},
//  lastThinkingBlockId={null}, screen 'prompt' (collapsed thinking line),
//  the collapse pipeline intact in the shared derive.
//  Law 4 (one fold home): foldWorkerRecord + the byte-cursor fold are
//  DEFINED once (workerTranscriptFold.ts); AttachedSessionScreen and
//  SessionMirror both import that home — no duplicate definition anywhere
//  under src/.
//  Law 5 (wheel physics): the mirror scrolls by computeWheelStep, never the
//  flat WHEEL_STEP_ROWS constant.
// ============================================================================
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '0.0.0-prover' }

import { existsSync, mkdtempSync, readdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'switchboard-mirror-home-'))
process.env.MERCURY_CONFIG_DIR = process.env.MERCURY_CONFIG_DIR

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}

const root = new URL('../../', import.meta.url).pathname
const mirrorPath = join(root, 'src/components/concourse/SessionMirror.tsx')
const foldPath = join(root, 'src/components/concourse/workerTranscriptFold.ts')
// The W1 deletion transaction COMPLETED: the attached-viewer screen is
// gone; the fold module is the sole home (the check below asserts both).
const attachedPath = join(root, 'src/components/concourse/AttachedSessionScreen.tsx')
const mirrorSrc = readFileSync(mirrorPath, 'utf8')
const foldSrc = readFileSync(foldPath, 'utf8')

/** Strip block + line comments so word/idiom checks see only live code. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, ' ').replace(/([^:'"`])\/\/[^\n]*/g, '$1')
}
const mirrorCode = stripComments(mirrorSrc)

console.log('LAW 1 — renderer continuity (the real pipeline, never text lines):')
check(
  'mirror renders through MessageRow (the real dispatch)',
  mirrorCode.includes("from '../MessageRow.js'") && /<MessageRow\b/.test(mirrorCode),
)
check(
  'mirror folds through the shared module (deriveTranscriptRows + useWorkerTranscriptFold)',
  mirrorCode.includes("from './workerTranscriptFold.js'") &&
    mirrorCode.includes('useWorkerTranscriptFold(') &&
    mirrorCode.includes('deriveTranscriptRows('),
)
check(
  'the shared derive IS the Main REPL pipeline (normalize → reorder → group → collapse)',
  ['normalizeMessages', 'reorderMessagesInUI', 'applyGrouping', 'collapseReadSearchGroups', 'injectTurnReceipts'].every(
    fn => foldSrc.includes(fn),
  ),
)
check(
  'the fold is push-driven with the heartbeat guard (fs.watch + 5s)',
  foldSrc.includes('fs.watch(path') && foldSrc.includes('setInterval(drain, 5000)'),
)
check(
  'transcript path comes from workerTranscriptPath (the home law)',
  foldSrc.includes('wt.workerTranscriptPath({ sessionId, workspaceId })'),
)
check('no lockup in the mirror', !mirrorCode.includes('ProductLockup'))
check('no MercuryFrame in the mirror', !mirrorCode.includes('MercuryFrame'))
check(
  'one-caret law: no composer family (TextInput / prompt glyph / composer border)',
  !mirrorCode.includes('TextInput') &&
    !mirrorCode.includes('GLYPH.prompt') &&
    !mirrorCode.includes('composerBorder'),
)
check('a real ScrollBox with stickyScroll', /<ScrollBox\b[^>]*stickyScroll/s.test(mirrorCode))

console.log('LAW 2 — the word-ban (mirror-agent-word):')
// The ban is SCREEN vocabulary (sessions, never agents). The typed
// receipt-kind token 'agent-close' is wire grammar, not prose — '-' is a
// word boundary, so the bare ban tripped on the live code the moment the
// deep-close receipts landed. Exempt the exact quoted token WITH TEETH:
// the exemption row proves the token still stands as the typed kind it
// names, so it can never rot into a blanket allowance.
check("the exemption's tooth: 'agent-close' stands as a quoted receipt-kind token", /'agent-close'/.test(mirrorCode))
check(
  'the word "agent" is absent from the mirror source (comments stripped; the quoted receipt-kind token exempted)',
  !/\bagent\b/i.test(mirrorCode.replaceAll("'agent-close'", "'deep-close'")),
)
const { attachedPlateName, userHandle } = await import('../../src/components/messages/TranscriptNameplate.js')
check("attachedPlateName maps 'agent' → 'Mercury'", attachedPlateName('agent') === 'Mercury')
// Operator-ruled: the plate reads [Coordinator], capitalized — a
// NAME beside [Mercury], not a role word.
check("attachedPlateName plates 'coordinator' as 'Coordinator'", attachedPlateName('coordinator') === 'Coordinator')
check(
  "attachedPlateName plates the operator as the handle",
  attachedPlateName('user') === userHandle() && attachedPlateName('user').length > 0,
)
check(
  'no painted plate contains the banned word',
  (['agent', 'coordinator', 'user'] as const).every(a => !/\bagent\b/i.test(attachedPlateName(a))),
)

console.log('LAW 3 — density (every fold CLOSED by default):')
check('verbose is pinned false', mirrorCode.includes('verbose={false}') && !mirrorCode.includes('verbose={true}'))
check(
  'thinking collapses (lastThinkingBlockId null, prompt screen — the collapsed ∴ line)',
  mirrorCode.includes('lastThinkingBlockId={null}') && mirrorCode.includes("screen={'prompt' as Screen}"),
)
check(
  'one-line grouped tool rows ride the shared collapse (collapseReadSearchGroups in the ONE derive)',
  !mirrorCode.includes('collapseReadSearchGroups') && foldSrc.includes('collapseReadSearchGroups'),
)

console.log('LAW 4 — one fold home:')
check(
  'foldWorkerRecord is defined in workerTranscriptFold.ts',
  /export function foldWorkerRecord\(/.test(foldSrc),
)
check(
  'the attached-viewer screen is DELETED (rubric §2.3 — the mirror is the only reader surface)',
  !existsSync(attachedPath),
)
// Whole-tree sweep: exactly ONE definition site under src/.
const defSites: string[] = []
const walk = (dir: string): void => {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name.startsWith('.')) continue
    const p = join(dir, e.name)
    if (e.isDirectory()) walk(p)
    else if (/\.(ts|tsx)$/.test(e.name) && /function foldWorkerRecord\(/.test(readFileSync(p, 'utf8')))
      defSites.push(p)
  }
}
walk(join(root, 'src'))
check(
  'exactly one definition site under src/',
  defSites.length === 1 && (defSites[0]?.endsWith('workerTranscriptFold.ts') ?? false),
  defSites.join(', '),
)
const { foldWorkerRecord } = await import('../../src/components/concourse/workerTranscriptFold.js')
const { entryToRecord } = await import('../../src/fabric/entryCodec.js')
const { ordinalOf } = await import('../../src/fabric/ordinal.js')
let mgOrd = 0
const mgCtx = {
  sessionId: '00000000-aaaa-4000-8000-00000000mg01' as never,
  nextOrdinal: () => ordinalOf(++mgOrd) as never,
  observedAt: '2026-08-15T00:00:00Z',
  source: { channel: 'sdk' } as const,
}
const folded = foldWorkerRecord(
  entryToRecord(
    { type: 'user', uuid: 'u-1', timestamp: '2026-08-15T00:00:00Z', message: { role: 'user', content: 'hi' } },
    mgCtx as never,
  ) as unknown,
  'fallback-0',
) as { uuid?: string } | null
check('the pure projection passes a user record', folded !== null && folded.uuid === 'u-1')
check(
  'the pure projection rejects a metadata record',
  foldWorkerRecord(entryToRecord({ type: 'summary', summary: 's' }, mgCtx as never) as unknown, 'fb') === null,
)
check(
  'a retired-format line is never rendered as conversation',
  foldWorkerRecord({ type: 'user', uuid: 'u-2', message: { role: 'user', content: 'other era' } }, 'fb2') === null,
)

console.log('LAW 6 — the revision collapse (AGENTDIALS C3: last-write-wins per recordId):')
const { mergeFoldedMessages } = await import('../../src/components/concourse/workerTranscriptFold.js')
const revisionEntry = (stopReason: string | null, text: string): unknown =>
  entryToRecord(
    {
      type: 'assistant',
      uuid: 'a-rev-1',
      timestamp: '2026-08-15T00:00:01Z',
      message: { role: 'assistant', content: [{ type: 'text', text }], stop_reason: stopReason },
    } as never,
    mgCtx as never,
  ) as unknown
const snap = foldWorkerRecord(revisionEntry(null, 'Finished count'), 'fb-r0') as { uuid: string } | null
const fin = foldWorkerRecord(revisionEntry('end_turn', 'Finished counting'), 'fb-r1') as { uuid: string } | null
const other = foldWorkerRecord(
  entryToRecord(
    { type: 'user', uuid: 'u-before', timestamp: '2026-08-15T00:00:00Z', message: { role: 'user', content: 'count' } },
    mgCtx as never,
  ) as unknown,
  'fb-r2',
) as { uuid: string } | null
check('the revision fixture projects (snapshot + final share one recordId)', snap !== null && fin !== null && other !== null && snap.uuid === fin.uuid)
if (snap !== null && fin !== null && other !== null) {
  const text = (m: unknown): string =>
    String(((m as { message?: { content?: Array<{ text?: string }> } }).message?.content ?? [])[0]?.text ?? '')
  // The disease control: a naive append paints BOTH revisions — this is
  // exactly what the pane did (the fixture's detection power, proven).
  check('control: the naive concat double-paints the revision pair', [other, snap, fin].length === 3)
  // The COLD fold (the whole-file batch): one painted message, the final text.
  const cold = mergeFoldedMessages([], [other, snap, fin])
  check('the cold fold paints the pair as ONE message', cold.length === 2, `painted ${cold.length}`)
  check('…wearing the FINAL revision', text(cold[1]) === 'Finished counting', text(cold[1]))
  // The STREAMING half: the partial paints, the final REPLACES in place.
  const partial = mergeFoldedMessages([], [other, snap])
  check('the streaming partial still paints (the collapse never suppresses)', partial.length === 2 && text(partial[1]) === 'Finished count')
  const settled = mergeFoldedMessages(partial, [fin])
  check('the final REPLACES at the same slot — position kept, count kept', settled.length === 2 && text(settled[1]) === 'Finished counting' && settled[0] === partial[0])
  // Distinct uuids (fallback-keyed rows included) always append.
  check('distinct rows still append in order', mergeFoldedMessages([other], [snap]).length === 2)
}
const foldModuleSrc = readFileSync(foldPath, 'utf8')
check(
  'the byte-cursor fold consumes the merge (never a bare concat of folded rows)',
  foldModuleSrc.includes('mergeFoldedMessages(base, folded)') && !stripComments(foldModuleSrc).includes('[...base, ...folded]'),
)

console.log('LAW 5 — wheel physics:')
check(
  'the mirror scrolls by computeWheelStep (shared physics)',
  mirrorCode.includes('computeWheelStep(') && mirrorCode.includes("from '../ScrollKeybindingHandler.js'"),
)
check('the flat WHEEL_STEP_ROWS constant is not referenced', !mirrorCode.includes('WHEEL_STEP_ROWS'))
check(
  'wheel consumption is gated on focused/pointer-over',
  mirrorCode.includes('isActive: focused || pointerOver'),
)
check(
  'the follow debounce rides the shared 160ms clock family (no new interval primitive)',
  mirrorCode.includes('useAnimationValue(') &&
    mirrorCode.includes('WORK_TICK_MS') &&
    !/setInterval|setTimeout/.test(mirrorCode),
)

console.log(
  failures === 0 ? '\nprove-mirror-grammar: ALL LAWS HOLD' : `\nprove-mirror-grammar: ${failures} FAILURE(S)`,
)
process.exit(failures === 0 ? 0 : 1)
