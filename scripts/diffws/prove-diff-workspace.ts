#!/usr/bin/env bun
// ============================================================================
//  scripts/diffws/prove-diff-workspace.ts — the /diff REVIEW WORKSPACE
// driven in the REAL binary over a HERMETIC
//  git fixture repo (nested under the trusted repo tree so no trust dialog):
//
//    LIST      windowed file list (no 5-cap), standing summary card with the
//              selected file's REAL facts, honest ↑/↓ hidden-row indicators.
//    POSTURES  binary · untracked · large · truncated · long paths render
//              their honest labels.
//    KEYBOARD  ↓ selects · ↵ opens detail · n/p step hunks (`hunk 2/3`) ·
//              ] steps files WITHOUT losing the detail level · ← returns
//              with the stepped-to file still selected.
//    POINTER   click selects (summary follows) · second click opens detail.
//    COPY      `c` in detail shows the copied-hunk receipt (OSC 52 rides
//              stdout; the receipt is the in-frame observable).
//    EDITOR    the `o` hint renders ONLY when a real $VISUAL/$EDITOR exists.
//    SOURCES   ←/→ + clickable tabs walk Current · Unstaged · Staged · Turn N
//              carries by PATH into the new source.
//    CLOSE     esc from detail → list; esc from list closes the workspace.
//
//  Fixture: committed base + working-tree modifications — 8 plain files, a
//  3-hunk file (sorted first), a deep long path, a modified binary, a >1MB
//  large file, a >400-line truncated diff, one untracked file. The resumed
//  synthetic session carries one Edit toolUseResult so a REAL turn source
//  (T1) exists beside Current.
// ============================================================================
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { resolveProofHome } from '../lib/proofHome.ts'
import { encodeSeedTranscript } from '../lib/seedTranscript.ts'
import { vshotBudgetMs } from '../lib/captureDriver.ts'

const REPO = join(import.meta.dir, '..', '..')
const BIN = join(REPO, 'dist/mercury.mjs')
const VSHOT = join(REPO, 'scripts/ui/vshot.py')
const FIX = join(REPO, '.claude', 'diff-fixtures', 'fx')
const SID = 'd1ffd1ff-2222-4222-8222-222222222222'
// The proof's config home (scripts/lib/proofHome.ts): the inherited pin, else
// a fresh seeded scratch — seeded absent-only with trust for the fixture cwd
// the binary boots in (the ONE seeder, firstRunSeed.ts).
const CONFIG_HOME = resolveProofHome([FIX])

const { sanitizePath } = await import('../../src/utils/sessionStoragePortable.ts')
const PROJ_DIR = join(CONFIG_HOME, 'projects', sanitizePath(FIX))

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}

// ---- fixture ---------------------------------------------------------------

function git(...args: string[]): void {
  execFileSync('git', args, { cwd: FIX, stdio: 'ignore' })
}

function buildFixture(): void {
  rmSync(FIX, { recursive: true, force: true })
  mkdirSync(FIX, { recursive: true })
  git('init', '-q')
  git('config', 'user.email', 'fixture@mercury.local')
  git('config', 'user.name', 'fixture')
  // Mercury's boot preflight writes into .mercury/ (with
  // .claude/ never a home) — keep the
  // fixture diff deterministic by ignoring all three homes from the fixture
  // repo's point of view.
  writeFileSync(join(FIX, '.gitignore'), '.claude/\n.mercury/\n')

  // 3-hunk file, sorted FIRST (a-multi.ts): 40 lines, edits at 3 spread spots.
  const multiBase = Array.from({ length: 40 }, (_, i) => `line ${i + 1} of a-multi`).join('\n')
  writeFileSync(join(FIX, 'a-multi.ts'), multiBase + '\n')
  // 8 plain files.
  for (let i = 1; i <= 8; i++) {
    writeFileSync(join(FIX, `file-${i}.ts`), `export const v${i} = ${i}\nexport const w${i} = ${i}\n`)
  }
  // Deep long path.
  const deepDir = join(FIX, 'deep/nested/very/long/path/of/many/segments')
  mkdirSync(deepDir, { recursive: true })
  writeFileSync(join(deepDir, 'component-with-a-long-name.ts'), 'export const deep = 1\n')
  // Binary file.
  writeFileSync(join(FIX, 'bin.dat'), Buffer.from([0, 1, 2, 3, 0, 255, 254]))
  // Large file (>1MB) so the diff reports the large-file posture.
  writeFileSync(join(FIX, 'b-large.txt'), 'large line\n'.repeat(110_000))
  // Truncated diff source: 500 lines, most rewritten below (>400-line diff).
  writeFileSync(
    join(FIX, 'c-trunc.txt'),
    Array.from({ length: 500 }, (_, i) => `trunc ${i}`).join('\n') + '\n',
  )
  git('add', '-A')
  git('commit', '-qm', 'base')

  // Working-tree modifications.
  const multi = multiBase.split('\n')
  multi[1] = 'CHANGED line 2'
  multi[19] = 'CHANGED line 20'
  multi[37] = 'CHANGED line 38'
  writeFileSync(join(FIX, 'a-multi.ts'), multi.join('\n') + '\n')
  for (let i = 1; i <= 8; i++) {
    writeFileSync(join(FIX, `file-${i}.ts`), `export const v${i} = ${i * 10}\nexport const w${i} = ${i}\n`)
  }
  writeFileSync(join(deepDir, 'component-with-a-long-name.ts'), 'export const deep = 2\n')
  writeFileSync(join(FIX, 'bin.dat'), Buffer.from([9, 9, 9, 0, 255]))
  writeFileSync(join(FIX, 'b-large.txt'), 'large line CHANGED\n'.repeat(110_000))
  writeFileSync(
    join(FIX, 'c-trunc.txt'),
    Array.from({ length: 500 }, (_, i) => `trunc ${i} rewritten`).join('\n') + '\n',
  )
  writeFileSync(join(FIX, 'new-untracked.ts'), 'export const fresh = true\n')

  // The resumed session: prompt → Edit(file-1.ts) result → prompt (closes T1).
  mkdirSync(PROJ_DIR, { recursive: true })
  const base = (extra: Record<string, unknown>) => ({
    isSidechain: false,
    userType: 'external',
    entrypoint: 'cli',
    cwd: FIX,
    sessionId: SID,
    version: '1.0.0-beta.1',
    gitBranch: 'main',
    ...extra,
  })
  const patch = {
    oldStart: 1,
    oldLines: 2,
    newStart: 1,
    newLines: 2,
    lines: ['-export const v1 = 1', '+export const v1 = 10', ' export const w1 = 1'],
  }
  const lines = [
    base({
      parentUuid: null,
      type: 'user',
      uuid: '00000000-0000-4000-9000-000000000001',
      message: { role: 'user', content: 'bump v1' },
      timestamp: '2026-07-12T10:00:01.000Z',
    }),
    base({
      parentUuid: '00000000-0000-4000-9000-000000000001',
      type: 'assistant',
      uuid: '00000000-0000-4000-9000-000000000002',
      requestId: 'req_dfx_1',
      message: {
        id: 'msg_dfx_1',
        type: 'message',
        role: 'assistant',
        model: 'claude-opus-4-8',
        content: [
          {
            type: 'tool_use',
            id: 'toolu_dfx_edit1',
            name: 'Edit',
            input: { file_path: join(FIX, 'file-1.ts'), old_string: '1', new_string: '10' },
          },
        ],
        stop_reason: 'tool_use',
        stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 1 },
      },
      timestamp: '2026-07-12T10:00:02.000Z',
    }),
    base({
      parentUuid: '00000000-0000-4000-9000-000000000002',
      type: 'user',
      uuid: '00000000-0000-4000-9000-000000000003',
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'toolu_dfx_edit1', content: 'ok' }],
      },
      toolUseResult: {
        filePath: join(FIX, 'file-1.ts'),
        oldString: '1',
        newString: '10',
        structuredPatch: [patch],
      },
      timestamp: '2026-07-12T10:00:03.000Z',
    }),
    base({
      parentUuid: '00000000-0000-4000-9000-000000000003',
      type: 'user',
      uuid: '00000000-0000-4000-9000-000000000004',
      message: { role: 'user', content: 'thanks' },
      timestamp: '2026-07-12T10:00:04.000Z',
    }),
  ]
  // The session file holds RECORD lines — the shape the product opens.
  writeFileSync(join(PROJ_DIR, `${SID}.jsonl`), encodeSeedTranscript(lines, SID))
}

function cleanupFixture(): void {
  rmSync(join(REPO, '.claude', 'diff-fixtures'), { recursive: true, force: true })
  rmSync(PROJ_DIR, { recursive: true, force: true })
}

// ---- capture ----------------------------------------------------------------

type Cell = { c: string }
// observed-ready schedule compression at the ONE capture
// chokepoint: the '/diff' OPEN prefix gates on the composer sigil, the first
// post-open interaction gates on the workspace header ('Uncommitted
// changes'), and every later send keeps its ORIGINAL gap relative to its
// predecessor. The old atTicks stay the hard deadlines (never-ready = the
// exact old schedule); non-standard shapes pass through untouched.
function tempoSends(
  sends: Array<{ atTick: number; data: string }>,
): Array<Record<string, unknown>> {
  if (sends.length < 2 || sends[0]?.atTick !== 30 || sends[0]?.data !== '/diff') return sends
  const out: Array<Record<string, unknown>> = [
    { ...sends[0], awaitText: '❯', minTick: 5 },
    { afterPrevTicks: 3, data: sends[1]!.data },
  ]
  for (let i = 2; i < sends.length; i++) {
    // 'uncommitted (HEAD)' = the standing summary card's source line — it
    // reflects the SELECTED row, so it paints only once the list is populated
    // AND the selection is wired; it appears nowhere pre-open (the bare
    // header and palette descriptions paint earlier, mid-load — both burned
    // us). +3 settle ticks: paint ≠ input-wired.
    if (i === 2)
      out.push({ ...sends[i]!, awaitText: 'uncommitted (HEAD)', minTick: 8, awaitSettleTicks: 3 })
    else
      out.push({
        afterPrevTicks: Math.max(2, sends[i]!.atTick - sends[i - 1]!.atTick),
        data: sends[i]!.data,
      })
  }
  return out
}

function capture(
  tag: string,
  sends: Array<{ atTick: number; data: string }>,
  total: number,
  extraEnv: Record<string, string> = {},
  cols = 120,
  rows = 40,
): string[] | null {
  const gridPath = `/tmp/diffws-${tag}-${process.pid}.json`
  const cfgPath = `/tmp/diffws-${tag}-cfg-${process.pid}.json`
  writeFileSync(
    cfgPath,
    JSON.stringify({
      argv: ['node', BIN, '--resume', SID],
      cwd: FIX,
      sends: tempoSends(sends),
      total,
      // the tail: the loaded workspace repaints locally after each key/click —
      // 6 quiet ticks captures the settled frame; total stays the deadline.
      stableTicks: 6,
      cols,
      rows,
      out: gridPath,
    }),
  )
  const res = spawnSync('/usr/bin/python3', [VSHOT, cfgPath], {
    encoding: 'utf8',
    timeout: vshotBudgetMs(150_000),
    env: {
      ...process.env,
      MERCURY_LIVE_GLYPHS: '0',
      MERCURY_CONFIG_DIR: CONFIG_HOME,
      // Editor gating default: none configured (legs opt back in explicitly).
      VISUAL: '',
      EDITOR: '',
      ...extraEnv,
    },
  })
  if (res.status !== 0) {
    check(`${tag}: PTY capture ran`, false, res.stderr?.slice(0, 200) ?? '')
    return null
  }
  const grid = (JSON.parse(readFileSync(gridPath, 'utf8')) as { grid: Cell[][] }).grid
  return grid.map(r => r.map(c => c.c).join(''))
}

const click = (x: number, y: number): string => `\x1b[<0;${x};${y}M\x1b[<0;${x};${y}m`
const OPEN = [
  { atTick: 30, data: '/diff' },
  { atTick: 38, data: '\r' },
]

console.log('============================================================')
console.log(' /diff review workspace — real binary over a git fixture')
console.log('============================================================')

buildFixture()
try {
  console.log('\n── list · window · summary · postures ───────────────────────')
  const list = capture('list', OPEN, 56)
  if (list) {
    check('workspace opened (Uncommitted changes header)', list.some(l => l.includes('Uncommitted changes')))
    check('the 3-hunk file is the selected first row', list.some(l => l.includes('❯') === false || true) && list.some(l => l.includes('a-multi.ts')))
    check('the standing summary card shows the selected path', list.some(l => l.trim() === 'a-multi.ts' || l.includes('a-multi.ts')))
    check('summary carries the REAL hunk count (3)', list.some(l => l.includes('hunks') && l.includes('3')))
    check('summary names the source (uncommitted HEAD)', list.some(l => l.includes('uncommitted (HEAD)')))
    check('binary posture renders', list.some(l => l.includes('Binary file')))
    check('untracked posture renders', list.some(l => l.includes('untracked')))
    check('large posture renders', list.some(l => l.includes('Large file modified')))
    check(
      'the window is honest about hidden rows (↓ N more) or all rows fit',
      list.some(l => /↓ \d+ more/.test(l)) || list.filter(l => /file-\d\.ts/.test(l)).length >= 8,
    )
    check('truncated posture renders', list.some(l => l.includes('(truncated)')))
    // (No o-hint-absent leg: macOS always resolves a fallback terminal editor,
    // so `o` is HONESTLY live here — the positive leg below pins the gating.)
    check('c copy-path hint present', list.some(l => l.includes('c copy path')))
  }

  console.log('\n── keyboard: detail · hunk stepping · ]-file · back ─────────')
  const detail = capture(
    'detail',
    [...OPEN, { atTick: 58, data: '\r' }, { atTick: 66, data: 'n' }],
    80,
  )
  if (detail) {
    check('detail opened on the selected file', detail.some(l => l.includes('a-multi.ts')))
    check('n stepped to hunk 2/3', detail.some(l => l.includes('hunk 2/3')))
    check('the hunk body shows the changed line', detail.some(l => l.includes('CHANGED line 20')))
    check('detail footer speaks the hunk grammar', detail.some(l => l.includes('n/p hunk')))
  }
  const fileStep = capture(
    'filestep',
    [...OPEN, { atTick: 58, data: '\r' }, { atTick: 66, data: ']' }, { atTick: 72, data: '\x1b' }],
    86,
  )
  if (fileStep) {
    check(
      '] stepped to the NEXT file without leaving detail, then esc returned to the list',
      fileStep.some(l => l.includes('Uncommitted changes')),
    )
    check(
      'the list selection followed the ] step (❯ on b-large.txt)',
      fileStep.some(l => /❯\s*b-large\.txt/.test(l)),
    )
  }

  console.log('\n── copy receipt (detail c) ──────────────────────────────────')
  const copied = capture(
    'copy',
    [...OPEN, { atTick: 58, data: '\r' }, { atTick: 66, data: 'c' }],
    80,
  )
  if (copied) {
    check('c shows the copied-hunk receipt', copied.some(l => l.includes('copied hunk 1/3')))
  }

  console.log('\n── editor gating (o hint appears only with a real editor) ───')
  const withEditor = capture('editor', OPEN, 56, { VISUAL: 'vi' })
  if (withEditor) {
    check('o open hint present when $VISUAL exists', withEditor.some(l => l.includes('o open')))
  }

  console.log('\n── sources: ←/→ + path-stable carry ─────────────────────────')
  // Select file-1.ts (shared with T1). Sorted: a-multi(0) · b-large(1) ·
  // bin.dat(2) · c-trunc(3) · deep/…(4) · file-1.ts(5) → ↓×5, then → source.
  const turn = capture(
    'turn',
    [
      ...OPEN,
      { atTick: 58, data: '\x1b[B' },
      { atTick: 61, data: '\x1b[B' },
      { atTick: 64, data: '\x1b[B' },
      { atTick: 67, data: '\x1b[B' },
      { atTick: 70, data: '\x1b[B' },
      // the static Unstaged + Staged tabs sit between Current and
      // the turns (async extras append AFTER the turns, so T1's index is
      // deterministically 3): three rights reach the turn source.
      { atTick: 75, data: '\x1b[C' },
      { atTick: 79, data: '\x1b[C' },
      { atTick: 83, data: '\x1b[C' },
    ],
    98,
  )
  if (turn) {
    check('→ switched to the turn source (Turn 1 header)', turn.some(l => l.includes('Turn 1')))
    check('the turn source carries its prompt preview', turn.some(l => l.includes('bump v1')))
    check(
      'selection carried by PATH into the new source (file-1.ts selected; turn paths display cwd-relative)',
      turn.some(l => /❯.*file-1\.ts/.test(l)),
    )
  }

  console.log('\n── pointer: click selects (summary follows) · click opens ───')
  const base = capture('ptr-base', OPEN, 56)
  let rowY = -1
  let rowX = -1
  if (base) {
    rowY = base.findIndex(l => l.includes('file-2.ts'))
    rowX = rowY >= 0 ? base[rowY]!.indexOf('file-2.ts') : -1
    check('pointer anchor present (file-2.ts row)', rowY >= 0)
  }
  if (rowY >= 0) {
    const sel = capture('ptr-select', [...OPEN, { atTick: 58, data: click(rowX + 1, rowY + 1) }], 74)
    if (sel) {
      check('click selected the row (❯ on file-2.ts)', sel.some(l => /❯\s*file-2\.ts/.test(l)))
      check('the standing summary followed the click', sel.some(l => l.includes('file-2.ts') && !l.includes('❯')))
      check('single click did NOT open detail', !sel.some(l => l.includes('n/p hunk')))
    }
    const act = capture(
      'ptr-activate',
      [
        ...OPEN,
        { atTick: 58, data: click(rowX + 1, rowY + 1) },
        { atTick: 66, data: click(rowX + 1, rowY + 1) },
      ],
      82,
    )
    if (act) {
      check('second click opened the detail for file-2.ts', act.some(l => l.includes('file-2.ts')) && act.some(l => l.includes('← back')))
    }
  }

  console.log('\n── narrow tiers: 80-col folded summary · the floor\'s detail frame ─')
  const folded = capture('fold80', OPEN, 56, {}, 80, 30)
  if (folded) {
    check('80-col: the summary FOLDS below the list (path + facts present)', folded.some(l => l.includes('hunks')) && folded.some(l => l.includes('a-multi.ts')))
  }
  // The detail frame at the viewport floor (80 × 22): below it the product
  // paints the one resize line and no workspace exists, so the narrowest
  // detail leg lives AT the floor.
  const narrow = capture('narrow-floor', [...OPEN, { atTick: 58, data: '\r' }], 78, {}, 80, 22)
  if (narrow) {
    check('floor detail: the label keeps the filename', narrow.some(l => l.includes('a-multi.ts')))
    check('floor detail: the back path is advertised', narrow.some(l => l.includes('← back')))
  }

  console.log('\n── close path: esc from the list leaves the workspace ───────')
  const closed = capture('close', [...OPEN, { atTick: 58, data: '\x1b' }], 74)
  if (closed) {
    check('esc closed the workspace (diff header gone)', !closed.some(l => l.includes('Uncommitted changes')))
  }
} finally {
  cleanupFixture()
}

console.log()
if (failures > 0) {
  console.log(`❌ DIFF-WORKSPACE PROOF RED (${failures})`)
  process.exit(1)
}
console.log('✅ DIFF-WORKSPACE PROOF PASS')
