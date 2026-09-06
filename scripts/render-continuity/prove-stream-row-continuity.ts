#!/usr/bin/env bun
import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { vshotBudgetMs as S } from '../lib/captureDriver.ts'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

const { runPulseArena, anchoredOffset, restoreOffsets } = await import('../pulse/lib/pulseArena.ts')
const { checker } = await import('../engine-durability/harness.ts')
type ScriptedTurn = import('../lib/fixtureApi.ts').ScriptedTurn

const HERE = dirname(fileURLToPath(import.meta.url))
const SCREENGRAB = join(HERE, '..', 'streaming', 'screengrab.py')
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
}

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
  {
    name: 'B thinking-first',
    turns: [
      {
        kind: 'stream',
        blocks: [
          { type: 'thinking', deltas: ['weighing the anatomy request... ', 'choosing a structure... ', 'settling the plan. '] },
          { type: 'text', deltas: TOKENS.slice(0, 8).map(x => `${x} stream body. `) },
        ],
        gapMs: 350,
      },
      { kind: 'text', text: 'Spare.' },
    ],
    sends: ['after:↑↓ choose:900:\\r','6000:thinking anatomy probe\\r'],
    seconds: 15,
    grabFrom: 6200,
    grabTo: 12200,
    grabStep: 300,
    scrolls: false,
  },
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
            input: { description: 'poise piece probe', prompt: 'Reply done.', subagent_type: 'mercury-general', run_in_background: true },
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

for (const scene of scenes) {
  const run = await runPulseArena({
    turns: scene.turns,
    sends: scene.sends,
    seconds: scene.seconds,
    cols: 120,
    rows: 40,
    keep: true,
  })
  const offsets: string[] = []
  for (let ms = S(scene.grabFrom); ms <= S(scene.grabTo); ms += S(scene.grabStep)) offsets.push(String(anchoredOffset(run, ms)))
  offsets.push('-1')
  const grab = spawnSync(
    '/usr/bin/python3',
    [SCREENGRAB, run.paths.drive, '120', '40', ...offsets],
    { encoding: 'utf8' },
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
  const withText = timed.filter(f => f.rows.some(r => TOKEN_RE.test(r)))

  const identityLaw = [...withText, final].every(f => {
    const textIdx = f.rows.findIndex(r => TOKEN_RE.test(r))
    if (textIdx === -1) return true
    return f.rows.some((r, i) => i <= textIdx && r.includes('[Mercury]')) || scene.scrolls
  })
  t.check('every frame with response text carries the nameplate at-or-above it', identityLaw)

  if (!scene.scrolls) {
    const startSeq = [...withText, final]
      .filter(f => f.rows.some(r => TOKEN_RE.test(r)))
      .map(f => f.rows.findIndex(r => TOKEN_RE.test(r)))
    const neverDown = startSeq.every((v, i) => i === 0 || v <= startSeq[i - 1])
    t.check(
      'the text start row never moves DOWN (no insert-above; upward growth-scroll allowed)',
      neverDown,
      `rows ${[...new Set(startSeq)].join(',')}`,
    )
    const userSeq = [...withText, final]
      .map(f => f.rows.findIndex(r => r.includes('anatomy probe') && r.includes('❯')))
      .filter(i => i !== -1)
    const userNeverDown = userSeq.every((v, i) => i === 0 || v <= userSeq[i - 1])
    t.check('the settled user row never moves down', userNeverDown, `rows ${[...new Set(userSeq)].join(',')}`)
  }

  const dupEver = [...timed, final].some(f =>
    TOKENS.some(tok => f.rows.filter(r => r.includes(`${tok} stream body`)).length > 1),
  )
  t.check('no token is ever painted on two rows', !dupEver)
  const firstTextAt = withText.length ? withText[0].atMs : Number.MAX_SAFE_INTEGER
  const blankAfterText = timed.some(
    f => f.atMs > firstTextAt && !f.rows.some(r => TOKEN_RE.test(r)),
  )
  t.check('no blank-transcript frame between first text and settlement', !blankAfterText || Boolean(scene.interrupted) || scene.scrolls)

  let elapsedLawHolds = true
  let monotonic = true
  let prev = -1
  const spinnerFrames = timed.filter(f => f.rows.some(r => /\b\d+s\b/.test(r) && /esc|interrupt|thinking|✻|✶/i.test(r)))
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
    const elapsedRows = f.rows.filter(r => /\b\d+s\b/.test(r) && /esc|interrupt|thinking|✻|✶/i.test(r))
    if (elapsedRows.length > 1) elapsedLawHolds = false
    const row = (elapsedRows[0] ?? '').replace(/thought for \d+s/g, '')
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
    const preEsc = timed.filter(f => f.atMs <= S(8000) && f.rows.some(r => TOKEN_RE.test(r))).pop()
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
        const a = timed[i - 1].rows.find(r => r.includes(`${tok} stream body`))
        const b = timed[i].rows.find(r => r.includes(`${tok} stream body`))
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
    let slidesForward = true
    let last = -1
    for (const f of withText) {
      const v = firstVisibleIdx(f)
      if (v < last) slidesForward = false
      last = v
    }
    t.check('the scroll window slides forward only (no backward jumps mid-stream)', slidesForward)
    const lastLive = withText[withText.length - 1]
    t.check(
      'the settled window matches the last live window (no anchor jump at settlement)',
      lastLive ? firstVisibleIdx(final) === firstVisibleIdx(lastLive) : true,
    )
  }
  run.cleanup()
}

t.finish('prove-stream-row-continuity')
