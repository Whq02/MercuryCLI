#!/usr/bin/env bun
import { spawnSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { vshotBudgetMs as S } from '../lib/captureDriver.ts'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

const { runPulseArena, anchoredOffset, restoreOffsets } = await import('./lib/pulseArena.ts')
const { downOnlyWithCard } = await import('./lib/rowLaw.ts')
const { checker } = await import('../engine-durability/harness.ts')
type ScriptedTurn = import('../lib/fixtureApi.ts').ScriptedTurn

const HERE = dirname(fileURLToPath(import.meta.url))
const SCREENGRAB = join(HERE, 'lib', 'framegrab.py')
const framesFlag = process.argv.indexOf('--frames')
const FRAMES_DIR = framesFlag >= 0 && process.argv[framesFlag + 1] ? resolve(process.argv[framesFlag + 1]!) : null
const onlyFlag = process.argv.indexOf('--only')
const ONLY = onlyFlag >= 0 && process.argv[onlyFlag + 1] ? process.argv[onlyFlag + 1]! : null
const t = checker()

const TOKENS = [
  'alpha', 'bravo', 'charlie', 'delta', 'echo',
  'foxtrot', 'golf', 'hotel', 'india', 'juliet',
  'kilo', 'lima', 'mike', 'november', 'oscar',
  'papa', 'quebec', 'romeo', 'sierra', 'tango',
  'uniform', 'victor', 'whiskey', 'xray',
]
const ESC = String.fromCharCode(27)

type Scene = {
  name: string
  turns: ScriptedTurn[]
  sends: string[]
  seconds: number
  grabFrom: number
  grabTo: number
  grabStep: number
  scrolls: boolean
  interrupted?: boolean
  markdown?: boolean
  cols?: number
  rows?: number
  flips?: number
}

const THINKING_DELTAS = ['weighing the anatomy request... ', 'choosing a structure... ', 'settling the plan. ']
const flipRequest = (n: number, tool: boolean): ScriptedTurn => ({
  kind: 'stream',
  headerDelayMs: 1500,
  blocks: [
    { type: 'thinking', deltas: THINKING_DELTAS },
    { type: 'text', deltas: TOKENS.slice(n * 3, n * 3 + 3).map(x => `${x} stream body. `) },
  ],
  gapMs: 350,
  ...(tool ? { tools: [{ name: 'Bash', input: { command: `sleep 2; echo flip-${n}`, description: `flip probe ${n}` } }] } : {}),
})
const flipScene = (cols: number, rows: number): Scene => ({
  name: `B thinking-first · ten phase flips · ${cols}x${rows}`,
  turns: [flipRequest(0, true), flipRequest(1, true), flipRequest(2, false), { kind: 'text', text: 'Spare.' }],
  sends: ['after:↑↓ choose:900:\\r', '6000:thinking anatomy probe\\r'],
  seconds: 38,
  grabFrom: 6200,
  grabTo: 34400,
  grabStep: 300,
  scrolls: false,
  cols,
  rows,
  flips: 10,
})

const scenes: Scene[] = [
  {
    name: 'A short-paced + held settle',
    turns: [
      { kind: 'paced', deltas: TOKENS.slice(0, 10).map(x => `${x} stream body. `), gapMs: 400, settleDelayMs: 1800 },
      { kind: 'text', text: 'Spare.' },
    ],
    sends: ['after:↑↓ choose:900:\\r','6000:stream anatomy probe\\r'],
    seconds: 15,
    grabFrom: 6200,
    grabTo: 12600,
    grabStep: 300,
    scrolls: false,
  },
  flipScene(80, 21),
  flipScene(120, 40),
  flipScene(178, 51),
  {
    name: 'C long-scroll pressure',
    turns: [
      { kind: 'paced', deltas: TOKENS.map(x => `${x} stream body paragraph.\n\n`), gapMs: 250 },
      { kind: 'text', text: 'Spare.' },
    ],
    sends: ['after:↑↓ choose:900:\\r','6000:long anatomy probe\\r'],
    seconds: 16,
    grabFrom: 6200,
    grabTo: 13400,
    grabStep: 300,
    scrolls: true,
  },
  {
    name: 'D interrupt mid-stream',
    turns: [
      { kind: 'paced', deltas: TOKENS.slice(0, 10).map(x => `${x} stream body. `), gapMs: 400 },
      { kind: 'text', text: 'Spare.' },
    ],
    sends: ['after:↑↓ choose:900:\\r','6000:interrupt anatomy probe\\r', `after:alpha stream body:600:${ESC}`],
    seconds: 15,
    grabFrom: 6200,
    grabTo: 11000,
    grabStep: 300,
    scrolls: false,
    interrupted: true,
  },
  {
    name: 'E tool-interleaved pieces',
    turns: [
      {
        kind: 'paced_tool_use',
        preDeltas: ['alpha stream body before the tool. ', 'bravo stream body still before. '],
        gapMs: 350,
        tools: [
          {
            name: 'Agent',
            input: { description: 'poise piece probe', prompt: 'Reply done.', subagent_type: 'mercury-crew', run_in_background: true },
          },
        ],
      },
      { kind: 'text', text: 'done' },
      { kind: 'paced', deltas: ['charlie stream body after the tool. ', 'delta stream body closing. '], gapMs: 350 },
      { kind: 'text', text: 'Spare.' },
      { kind: 'text', text: 'Spare2.' },
    ],
    sends: ['after:↑↓ choose:900:\\r','6000:pieces anatomy probe\\r'],
    seconds: 16,
    grabFrom: 6200,
    grabTo: 13400,
    grabStep: 300,
    scrolls: false,
  },
  {
    name: 'F markdown restyle',
    turns: [
      {
        kind: 'paced',
        deltas: [
          '## alpha stream body heading\n\n',
          'bravo stream body **bold opens ',
          'and charlie stream body closes** then\n\n',
          '```\ndelta stream body in a fence\n',
          'echo stream body second fence row\n```\n\n',
          'foxtrot stream body tail prose. ',
        ],
        gapMs: 500,
      },
      { kind: 'text', text: 'Spare.' },
    ],
    sends: ['after:↑↓ choose:900:\\r','6000:markdown anatomy probe\\r'],
    seconds: 14,
    grabFrom: 6200,
    grabTo: 11600,
    grabStep: 200,
    scrolls: false,
    markdown: true,
  },
]

type Frame = { atMs: number; rows: string[] }
const TOKEN_RE = /(alpha|bravo|charlie|delta|echo|foxtrot|golf|hotel|india|juliet|kilo|lima|mike|november|oscar|papa|quebec|romeo|sierra|tango|uniform|victor|whiskey|xray) stream body/

const READING_RE = /reading the prompt/
const THINKING_RE = /\(thinking\)|· thinking\)|thinking \(max\)|· thinking ·/
const WRITING_RE = /◐ \d+(?:m \d+)?s|· writing ·/
const TOOL_RE = /Running sleep 2; echo flip/
const phaseOf = (f: Frame): string | null => {
  if (f.rows.some(r => READING_RE.test(r))) return 'reading'
  if (f.rows.some(r => TOOL_RE.test(r))) return 'tool'
  if (f.rows.some(r => THINKING_RE.test(r))) return 'thinking'
  if (f.rows.some(r => WRITING_RE.test(r))) return 'writing'
  return null
}
const CARD_TOP_RE = /╭─{40,}╮/
const CARD_BOTTOM_RE = /[▀▄]{9}.*╰─{40,}╯/
const cardSpanOf = (f: Frame): { top: number; bottom: number } | null => {
  const bottom = f.rows.findIndex(r => CARD_BOTTOM_RE.test(r))
  if (bottom === -1) return null
  let top = bottom - 1
  while (top >= 0 && !CARD_TOP_RE.test(f.rows[top]!)) top--
  return top < 0 ? null : { top, bottom }
}
const cardRowsOf = (f: Frame): number | null => {
  const span = cardSpanOf(f)
  return span === null ? null : span.bottom - span.top - 1
}
const cardLinesOf = (f: Frame): string[] => {
  const span = cardSpanOf(f)
  if (span === null) return []
  const topRow = f.rows[span.top]!
  const left = topRow.search(CARD_TOP_RE)
  const right = topRow.indexOf('╮', left)
  return f.rows.slice(span.top + 1, span.bottom).map(r => r.slice(left + 1, right).trim())
}
const COMPACT_STRIP_RE = /^(✶|✸|✹|✺|✷) \S.* · /
const compactStripRowOf = (f: Frame): number => f.rows.findIndex(r => COMPACT_STRIP_RE.test(r))
const composerRowOf = (f: Frame): number => f.rows.findIndex(r => /^╭─+╮$/.test(r))
const userRowOf = (f: Frame): number => f.rows.findIndex(r => r.includes('anatomy probe') && r.includes('❯'))
const paneStart = (f: Frame): number => Math.max(0, (f.rows.find(r => r.includes('✶ VIEW')) ?? '').indexOf('│'))
const paneRows = (f: Frame): string[] => {
  const start = paneStart(f)
  return start === 0 ? f.rows : f.rows.map(r => r.slice(start))
}
const hasToken = (f: Frame): boolean => paneRows(f).some(r => TOKEN_RE.test(r))
const textRowOf = (f: Frame): number => paneRows(f).findIndex(r => TOKEN_RE.test(r))
const stripWordsOf = (f: Frame): string => {
  const lines = cardLinesOf(f)
  if (lines.length > 0) return lines.join(' ↵ ')
  const compact = compactStripRowOf(f)
  return compact === -1 ? '' : f.rows[compact]!.trim()
}
const slugOf = (name: string): string => name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
const movesOf = (seq: number[]): { down: number; up: number } => {
  let down = 0
  let up = 0
  for (let i = 1; i < seq.length; i++) {
    if (seq[i]! > seq[i - 1]!) down++
    else if (seq[i]! < seq[i - 1]!) up++
  }
  return { down, up }
}

t.section('the row law\'s teeth (synthetic frames, order-proof)')
{
  const f = (atMs: number, row: number, cardRows: number | null): import('./lib/rowLaw.ts').RowFrame => ({ atMs, row, cardRows })
  t.check('a row that moves down by exactly the card\'s growth is lawful, and the settle\'s return up with it', downOnlyWithCard([f(1, 11, 1), f(2, 12, 2), f(3, 12, 2), f(4, 11, null)]).ok)
  t.check('the same two states sampled in the other order are lawful too (the sampling order cannot flip the verdict)', downOnlyWithCard([f(1, 12, 2), f(2, 11, null)]).ok && downOnlyWithCard([f(1, 11, 1), f(2, 12, 2)]).ok)
  const insert = downOnlyWithCard([f(1, 11, 1), f(2, 12, 1)])
  t.check('a row that moves down while the card holds its lines is an insert-above', !insert.ok && /row 11→12 while the card went 1→1/.test(insert.detail), insert.detail)
  const mismatch = downOnlyWithCard([f(1, 11, 1), f(2, 13, 2)])
  t.check('a row that moves down by more than the card grew is an insert-above', !mismatch.ok, mismatch.detail)
  const twice = downOnlyWithCard([f(1, 11, 1), f(2, 12, 2), f(3, 11, 1), f(4, 12, 2)])
  t.check('two growths in one turn are refused (the card grows once)', !twice.ok && /2 downward moves/.test(twice.detail), twice.detail)
  t.check('frames without the row are skipped, never a move', downOnlyWithCard([f(1, 11, 1), f(2, -1, 2), f(3, 11, 1)]).ok)
}

for (const scene of scenes) {
  if (ONLY !== null && !scene.name.includes(ONLY)) continue
  const cols = scene.cols ?? 120
  const rows = scene.rows ?? 40
  const run = await runPulseArena({
    turns: scene.turns,
    sends: scene.sends,
    seconds: scene.seconds,
    cols,
    rows,
    keep: true,
  })
  const offsets: string[] = []
  for (let ms = S(scene.grabFrom); ms <= S(scene.grabTo); ms += S(scene.grabStep)) offsets.push(String(anchoredOffset(run, ms)))
  offsets.push('-1')
  const grab = spawnSync(
    '/usr/bin/python3',
    [SCREENGRAB, run.paths.drive, String(cols), String(rows), ...offsets],
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  )
  t.section(scene.name)
  if (grab.status !== 0) {
    t.check('screengrab ran', false, grab.stderr)
    run.cleanup()
    continue
  }
  const { screens } = JSON.parse(grab.stdout) as { screens: Frame[] }
  restoreOffsets(run, screens)
  const final = screens[screens.length - 1]
  const timed = screens.filter(f => f.atMs !== -1)
  const withText = timed.filter(hasToken)

  if (FRAMES_DIR !== null) {
    mkdirSync(FRAMES_DIR, { recursive: true })
    const edges: string[] = []
    let lastSig = ''
    for (const f of screens) {
      const sig = `${cardRowsOf(f)}|${userRowOf(f)}|${textRowOf(f)}|${phaseOf(f)}|${compactStripRowOf(f)}`
      if (sig === lastSig && f.atMs !== -1) continue
      lastSig = sig
      const card = cardRowsOf(f)
      const where = card === null ? `strip row ${compactStripRowOf(f)} · composer row ${composerRowOf(f)}` : `card ${card} line${card === 1 ? '' : 's'} · user row ${userRowOf(f)} · text row ${textRowOf(f)}`
      edges.push(`━━ @${f.atMs}  ${where} · ${phaseOf(f) ?? '-'} · ${stripWordsOf(f)}`)
      edges.push(...f.rows.map((r, i) => `${String(i).padStart(2)}|${r}`))
    }
    writeFileSync(join(FRAMES_DIR, `${slugOf(scene.name)}.txt`), `${scene.name}\n${edges.join('\n')}\n`)
  }

  const compactLayout = scene.flips !== undefined && timed.every(f => cardRowsOf(f) === null)
  if (scene.flips !== undefined) {
    const phases = timed.map(phaseOf).filter((p): p is string => p !== null)
    const runs = phases.filter((p, i) => i === 0 || p !== phases[i - 1])
    const seen = new Set(runs)
    t.check(
      `the strip painted every phase of the flip cycle (reading, thinking, writing, tool)`,
      ['reading', 'thinking', 'writing', 'tool'].every(p => seen.has(p)),
      `saw ${[...seen].join(',') || 'nothing'}`,
    )
    t.check(
      `the strip flipped phase at least ${Math.floor(scene.flips * 0.7)} times on screen (${scene.flips} scripted)`,
      runs.length - 1 >= Math.floor(scene.flips * 0.7),
      `${runs.length - 1} flips: ${runs.join(' → ')}`,
    )
    if (compactLayout) {
      const stripRows = timed.map(compactStripRowOf).filter(i => i !== -1)
      const composerRows = timed.map(composerRowOf).filter(i => i !== -1)
      t.check(
        `the compact strip is one line whose row never moves across the flips (row ${[...new Set(stripRows)].join(',')})`,
        stripRows.length > 0 && new Set(stripRows).size === 1,
      )
      t.check(
        `the composer never moves across the flips (row ${[...new Set(composerRows)].join(',')})`,
        composerRows.length > 0 && new Set(composerRows).size === 1,
      )
    } else {
      const turnFrames = timed.filter(f => phaseOf(f) !== null)
      const cardSeq = turnFrames.map(cardRowsOf).filter((n): n is number => n !== null)
      const cardMoves = movesOf(cardSeq)
      t.check(
        `the working card never loses a line within the turn (${cardSeq.length ? `${Math.min(...cardSeq)}..${Math.max(...cardSeq)} lines` : 'no card found'})`,
        cardSeq.length > 0 && cardMoves.up === 0,
        `card lines ${cardSeq.join(',')}`,
      )
      t.check('the working card grows at most once within the turn', cardMoves.down <= 1, `${cardMoves.down} growths`)
      const userSeq = turnFrames.map(userRowOf).filter(i => i !== -1)
      const userMoves = movesOf(userSeq)
      t.check(
        `the user row never moves up mid-turn and moves down at most once, with the card (rows ${[...new Set(userSeq)].join(',')})`,
        userMoves.up === 0 && userMoves.down <= 1 && userMoves.down <= cardMoves.down,
        `${userMoves.down} down, ${userMoves.up} up`,
      )
      const textSeq = turnFrames.filter(f => textRowOf(f) !== -1).map(textRowOf)
      const textMoves = movesOf(textSeq)
      t.check(
        `the text start row never moves up mid-turn and moves down at most once, with the card (rows ${[...new Set(textSeq)].join(',')})`,
        textMoves.up === 0 && textMoves.down <= 1 && textMoves.down <= cardMoves.down,
        `${textMoves.down} down, ${textMoves.up} up`,
      )
      const finalUser = userRowOf(final)
      t.check(
        'the settled frame stands at or above the turn\'s rows (the card may return to one line between turns)',
        finalUser !== -1 && userSeq.length > 0 && finalUser <= userSeq[userSeq.length - 1]!,
        `final ${finalUser}, last live ${userSeq[userSeq.length - 1]}`,
      )
    }
  }

  const identityLaw = [...withText, final].every(f => {
    const textIdx = textRowOf(f)
    if (textIdx === -1) return true
    return f.rows.some((r, i) => i <= textIdx && r.includes('[Mercury]')) || scene.scrolls
  })
  t.check('every frame with response text carries the nameplate at-or-above it', identityLaw)

  if (!scene.scrolls && scene.flips === undefined) {
    const rowLaw = (label: string, rowOf: (f: Frame) => number): void => {
      const verdict = downOnlyWithCard([...withText, final].map(f => ({ atMs: f.atMs, row: rowOf(f), cardRows: cardRowsOf(f) })))
      t.check(`${label} moves down only with the working card's own growth, once at most (no insert-above; upward growth-scroll allowed)`, verdict.ok, verdict.detail)
    }
    rowLaw('the text start row', textRowOf)
    rowLaw('the settled user row', f => f.rows.findIndex(r => r.includes('anatomy probe') && r.includes('❯')))
  }

  const dupEver = [...timed, final].some(f =>
    TOKENS.some(tok => paneRows(f).filter(r => r.includes(`${tok} stream body`)).length > 1),
  )
  t.check('no token is ever painted on two rows', !dupEver)
  const firstTextAt = withText.length ? withText[0].atMs : Number.MAX_SAFE_INTEGER
  const blankFrames = timed.filter(f => f.atMs > firstTextAt && !hasToken(f))
  t.check('no blank-transcript frame between first text and settlement', blankFrames.length === 0 || Boolean(scene.interrupted) || scene.scrolls, blankFrames.map(f => `@${f.atMs} (fed to ${(f as Frame & { fedToMs?: number }).fedToMs ?? '?'}; rows with ink ${f.rows.filter(r => r.trim() !== '').length})`).join(', '))

  let elapsedLawHolds = true
  let monotonic = true
  let prev = -1
  const withoutPostscript = (r: string): string => r.replace(/\w+ thought for \d+[smhd]\b/g, '').replace(/first byte expected within [\dsmh ]+|past the [\dsmh ]+ first-byte budget/g, '')
  const carriesElapsed = (r: string): boolean => /\b\d+s\b/.test(withoutPostscript(r)) && /esc|interrupt|thinking|✻|✶/i.test(r)
  const spinnerFrames = timed.filter(f => f.rows.some(carriesElapsed))
  const turnFrames: typeof timed = []
  let seenGap = false
  for (const f of timed) {
    const hasSpinner = spinnerFrames.includes(f)
    if (turnFrames.length === 0) {
      if (hasSpinner) turnFrames.push(f)
      continue
    }
    if (hasSpinner && !seenGap) turnFrames.push(f)
    else if (!hasSpinner) seenGap = true
  }
  for (const f of turnFrames) {
    const elapsedRows = f.rows.filter(carriesElapsed)
    if (elapsedRows.length > 1) elapsedLawHolds = false
    const row = withoutPostscript(elapsedRows[0] ?? '')
    const ints = [...row.matchAll(/(?:^|[^.\d])(\d+)s\b/g)].map(m => Number(m[1]))
    if (ints.length) {
      const v = ints[ints.length - 1]
      if (v < prev) monotonic = false
      prev = v
    }
  }
  t.check('at most ONE elapsed indicator per frame', elapsedLawHolds)
  t.check('the elapsed value never resets within the turn', monotonic)

  if (scene.interrupted) {
    const preEsc = timed.filter(f => f.atMs <= S(8000) && hasToken(f)).pop()
    const keptAll = preEsc
      ? TOKENS.filter(tok => preEsc.rows.some(r => r.includes(`${tok} stream body`))).every(tok =>
          final.rows.some(r => r.includes(`${tok} stream body`)),
        )
      : true
    t.check('interruption keeps all received text', keptAll)
    t.check('a truthful interrupted marker is present at settlement', final.rows.some(r => /interrupt/i.test(r)))
  }

  if (scene.markdown) {
    let restyles = 0
    for (let i = 1; i < timed.length; i++) {
      for (const tok of TOKENS.slice(0, 6)) {
        const a = timed[i - 1].rows.find(r => r.includes(`${tok} stream body`))?.slice(paneStart(timed[i - 1]))
        const b = timed[i].rows.find(r => r.includes(`${tok} stream body`))?.slice(paneStart(timed[i]))
        if (
          a !== undefined &&
          b !== undefined &&
          a.trim() !== b.trim() &&
          !b.trim().startsWith(a.trim().slice(0, Math.max(8, a.trim().length - 4)))
        ) {
          restyles++
        }
      }
    }
    t.check('markdown restyle under stream stays bounded (<= 4 non-tail row edits, hosted-margined)', restyles <= Math.ceil(S(4)), `${restyles}`)
  }

  if (scene.scrolls) {
    const firstVisibleIdx = (f: Frame): number => {
      for (let i = 0; i < TOKENS.length; i++) {
        if (f.rows.some(r => r.includes(`${TOKENS[i]} stream body`))) return i
      }
      return -1
    }
    const lastToken = TOKENS[TOKENS.length - 1]!
    const streamEnd = withText.findIndex(f => f.rows.some(r => r.includes(`${lastToken} stream body`)))
    const liveFrames = streamEnd >= 0 ? withText.slice(0, streamEnd + 1) : withText
    let slidesForward = true
    let last = -1
    for (const f of liveFrames) {
      const v = firstVisibleIdx(f)
      if (v < last) slidesForward = false
      last = v
    }
    t.check('the scroll window slides forward only (no backward jumps mid-stream)', slidesForward, `${liveFrames.length} live frames`)
    const lastLive = withText[withText.length - 1]
    t.check(
      'the settled window matches the last live window (no anchor jump at settlement)',
      lastLive ? firstVisibleIdx(final) === firstVisibleIdx(lastLive) : true,
    )
  }
  run.cleanup()
}

t.finish('prove-stream-row-continuity')
