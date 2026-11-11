#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '0.0.0-prover' }

import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { vshotBudgetMs } from '../lib/captureDriver.ts'
import { removeScratch } from '../lib/removeScratch.ts'

const REPO = join(import.meta.dir, '..', '..')
const argAfter = (flag: string): string | undefined => {
  const at = process.argv.indexOf(flag)
  return at >= 0 ? process.argv[at + 1] : undefined
}
const BIN = resolve(argAfter('--dist') ?? join(REPO, 'dist', 'mercury.mjs'))
const VSHOT = join(REPO, 'scripts', 'ui', 'vshot.py')
if (!existsSync(BIN)) {
  console.error(`${BIN} missing — run \`bun run build.ts\` first`)
  process.exit(1)
}
const OUT_DIR = resolve(argAfter('--frames') ?? join(tmpdir(), `mirror-header-facts-${process.pid}`))
mkdirSync(OUT_DIR, { recursive: true })

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
const j = (value: unknown): string => JSON.stringify(value)

const cells = (text: string): number => [...text].length
const { truncateToWidth } = await import('../../src/components/mercury-ui/glyphs.ts')
const header = (await import('../../src/components/concourse/mirrorHeader.ts').catch(() => null)) as null | typeof import('../../src/components/concourse/mirrorHeader.ts')

const HINT = '↵ enter session'
const FACTS = ['proj', 'Opus 4.8', 'high']
const OLD_REPLY = 'T12 close one T12 close two and more words of the old reply'
const LIVE_TOOL = 'Bash · bun test parser'
type Shape = { title: string; facts: readonly string[]; paneWidth: number; nowWords: string | null; live?: boolean }

function before(shape: Shape): { titleShown: string; factsShown: string; nowText: string | null; held: boolean } {
  const nowText = shape.nowWords === null ? null : truncateToWidth(shape.nowWords, Math.max(8, Math.floor(shape.paneWidth / 3)))
  const cluster = cells(HINT) + (nowText !== null ? cells(nowText) + 3 : 0)
  const titleBudget = Math.max(8, shape.paneWidth - Math.min(cluster, Math.max(10, Math.floor(shape.paneWidth / 2))) - 2)
  const factsText = shape.facts.length > 0 ? ` · ${shape.facts.join(' · ')}` : ''
  const titleShown = truncateToWidth(shape.title, titleBudget)
  const factsShown = factsText.length > 0 ? truncateToWidth(factsText, Math.max(0, titleBudget - cells(titleShown))) : ''
  return { titleShown, factsShown, nowText, held: factsShown === factsText && cells(titleShown) + cells(factsShown) + cluster <= shape.paneWidth - 2 }
}
const now = (shape: Shape): { titleShown: string; factsShown: string; nowText: string | null; clusterReserve: number } | null => {
  if (header === null) return null
  const was = before(shape)
  const fit = header.mirrorHeaderFit({ titleShown: was.titleShown, facts: shape.facts, paneWidth: shape.paneWidth, hintWidth: cells(HINT), noteReserve: null, nowWords: shape.nowWords, nowText: was.nowText, nowLive: shape.live === true })
  return { titleShown: was.titleShown, factsShown: fit.factsShown, nowText: fit.nowText, clusterReserve: fit.cluster }
}
const wholeFacts = (facts: readonly string[], shown: string): boolean => facts.some((_, n) => shown === facts.slice(0, n + 1).map(f => ` · ${f}`).join('')) || shown === ''

console.log("H1 the preview's header: a session's facts stand whole before a reply's words, and every other header is what it was")
{
  const titles = ['T01 ask part 1', 'Refactor parser', 'A long session title that takes most of a narrow header row by itself']
  const factSets: Array<readonly string[]> = [FACTS, ['orchard-src'], []]
  const words: Array<{ nowWords: string | null; live?: boolean }> = [{ nowWords: null }, { nowWords: 'working…' }, { nowWords: LIVE_TOOL, live: true }, { nowWords: OLD_REPLY }]
  let replies = 0
  let others = 0
  const cut: string[] = []
  const overflow: string[] = []
  const factBeforeWords: string[] = []
  const moved: string[] = []
  const restWords: string[] = []
  const changed: string[] = []
  for (let paneWidth = 44; paneWidth <= 140; paneWidth++) {
    for (const title of titles) {
      for (const facts of factSets) {
        for (const kind of words) {
          const shape = { title, facts, paneWidth, ...kind }
          const got = now(shape)
          const reply = kind.nowWords !== null && kind.live !== true
          if (reply) replies++
          else others++
          if (got === null) continue
          const was = before(shape)
          const say = `${paneWidth} "${title.slice(0, 14)}" ${facts.length} fact(s) ${kind.nowWords === null ? 'at rest' : `"${kind.nowWords.slice(0, 10)}"`} → ${j(got)}`
          if (!reply) {
            if (was.titleShown !== got.titleShown || was.factsShown !== got.factsShown || was.nowText !== got.nowText) changed.push(`${say} · was ${j(was)}`)
            if (kind.nowWords === null && (got.nowText !== null || got.clusterReserve !== cells(HINT))) restWords.push(say)
            continue
          }
          if (!wholeFacts(facts, got.factsShown)) cut.push(say)
          if (cells(got.titleShown) + cells(got.factsShown) + got.clusterReserve > paneWidth - 2) overflow.push(say)
          if (got.nowText !== null && got.factsShown !== facts.map(f => ` · ${f}`).join('')) factBeforeWords.push(say)
          if (was.held && (was.titleShown !== got.titleShown || was.factsShown !== got.factsShown || was.nowText !== got.nowText)) moved.push(`${say} · was ${j(was)}`)
        }
      }
    }
  }
  check(`${replies} headers of a session whose words are a reply's, 44 to 140 cells: no fact is ever cut inside itself`, header !== null && cut.length === 0, header === null ? 'no mirrorHeader module' : `${cut.length}: ${cut[0]}`)
  check('…the title, the facts shown and what stands at the right fit the pane with two cells between them: nothing is left for the layout to squeeze', header !== null && overflow.length === 0, `${overflow.length}: ${overflow[0]}`)
  check('…the words give way first: while any of them is shown every fact is shown', header !== null && factBeforeWords.length === 0, `${factBeforeWords.length}: ${factBeforeWords[0]}`)
  check('…and where such a header already held its facts whole and nothing was squeezed, it is to the cell what it was', header !== null && moved.length === 0, `${moved.length}: ${moved[0]}`)
  check(`${others} headers of a session at rest and of one whose words are a live tool's: each is to the cell what it was before that rule — a fact cut where its room ends, the words in the third of the pane they had (red before: a fact that did not fit left whole and its cells stood empty, and a live tool's words gave way to the facts)`, header !== null && changed.length === 0, `${changed.length}: ${changed[0]}`)
  check('a session at rest has no words there, and the way in keeps its cells', header !== null && restWords.length === 0, `${restWords.length}: ${restWords[0]}`)
  const resting = now({ title: 'Audit billing receipts', facts: ['Moodle', 'Opus 5.5', 'max'], paneWidth: 58, nowWords: null })
  check('at rest on a 110-column board the model that does not fit whole is cut where the room ends, as it was (red before: it left, and twelve cells stood empty)', resting !== null && resting.titleShown + resting.factsShown === 'Audit billing receipts · Moodle · Opus 5…', j(resting))
  const live = now({ title: 'Fix OAuth callback', facts: ['Moodle', 'GPT-5.6 Sol', 'xhigh'], paneWidth: 95, nowWords: 'editing src/auth/callback.ts', live: true })
  check("a live tool's words on a 160-column board keep their place, whole, and the effort before them is the part that is cut (red before: the words were cut for the effort)", live !== null && live.nowText === 'editing src/auth/callback.ts' && live.titleShown + live.factsShown === 'Fix OAuth callback · Moodle · GPT-5.6 Sol · xh…', j(live))
  const squeezed = now({ title: 'T01 ask part 1', facts: FACTS, paneWidth: 68, nowWords: OLD_REPLY })
  check('the header of a 120-column board, a session whose row says working: the model with its version and the effort are whole, and the words are the part that is shorter (red before: `· Opus 4` with the old reply beside it)', squeezed !== null && squeezed.titleShown + squeezed.factsShown === 'T01 ask part 1 · proj · Opus 4.8 · high' && squeezed.nowText !== null && cells(squeezed.nowText) < cells(before({ title: 'T01 ask part 1', facts: FACTS, paneWidth: 68, nowWords: OLD_REPLY }).nowText ?? ''), j(squeezed))
  const narrow = now({ title: 'T01 ask part 1', facts: FACTS, paneWidth: 48, nowWords: OLD_REPLY })
  check('on a 100-column board there is no room for both: the words go, the working mark and the way in stay', narrow !== null && narrow.nowText === null && narrow.clusterReserve === cells(HINT) + 2 && wholeFacts(FACTS, narrow.factsShown) && narrow.factsShown !== '', j(narrow))
  const mirror = readFileSync(join(REPO, 'src', 'components', 'concourse', 'SessionMirror.tsx'), 'utf8')
  check('the preview fits its facts and its words by that one rule, told whether the words are a live tool\'s, and cuts no fact itself; the title keeps the lines it had', mirror.includes('mirrorHeaderFit({') && mirror.includes('    nowLive,\n  })') && !mirror.includes('truncateToWidth(factsText') && mirror.includes('const titleShown = truncateToWidth(title, titleBudget)') && mirror.includes('{nowShown}'))
}

const scratch = join(tmpdir(), `mirror-header-facts-${process.pid}-home`)
removeScratch(scratch)
mkdirSync(scratch, { recursive: true })
const { seedFirstRun } = await import('../lib/firstRunSeed.ts')
const { referenceFixtureSnapshot } = await import('../notifications/concourseReferenceSeed.ts')
seedFirstRun(scratch, [REPO])
{
  const cfgPath = join(scratch, '.mercury.json')
  const cfg = JSON.parse(readFileSync(cfgPath, 'utf8')) as Record<string, unknown>
  cfg['switchboardCapacity'] = { askedAt: 1754000000000, allowed: true, recommendedSeats: 4 }
  cfg['concourseCoordinator'] = { mode: 'off' }
  delete cfg['coordinatorEnabled']
  cfg['customApiKeyResponses'] = { approved: ['fixture-key-000'], rejected: [] }
  writeFileSync(cfgPath, JSON.stringify(cfg))
}

const WORKING = 'T01 ask part 1'
const RESTING = 'Refactor parser'
const fixture = referenceFixtureSnapshot() as Record<string, unknown> & { counts: Record<string, number> }
{
  const row = (extra: Record<string, unknown>): Record<string, unknown> => ({ ownerLabel: null, seats: null, nowLabel: null, workspaceDir: scratch, modelLabel: 'Opus 4.8', effortLabel: 'high', ...extra })
  fixture.coordinator = { mode: 'off' }
  fixture.needsYou = []
  fixture.peek = null
  fixture.groups = [
    { id: 'working', label: 'WORKING', rows: [row({ sessionId: 's-header-working', title: WORKING, state: 'working', projectLabel: 'proj', ageLabel: '00m', nowLabel: OLD_REPLY })] },
    { id: 'ready-to-review', label: 'READY TO REVIEW', rows: [row({ sessionId: 's-header-resting', title: RESTING, state: 'ready-to-review', projectLabel: 'orchard-src', ageLabel: '18m' })] },
  ]
  fixture.counts = { ...fixture.counts, live: 2, needsYou: 0, working: 1, queued: 0 }
}
const fixturePath = join(scratch, 'mirror-header-fixture.json')
writeFileSync(fixturePath, JSON.stringify(fixture))

type Grid = { grid: { c: string }[][] }
const linesOf = (g: Grid): string[] => g.grid.map(r => r.map(c => c.c || ' ').join(''))
const DOWN = `${String.fromCharCode(27)}[B`

function capture(cols: number, rows: number): Map<string, string[]> {
  const out = join(OUT_DIR, `mirror-header-${cols}x${rows}.json`)
  const cfgPath = join(scratch, `vshot-${cols}.json`)
  writeFileSync(cfgPath, JSON.stringify({
    argv: ['node', BIN],
    cwd: REPO,
    sends: [
      { data: '', awaitText: 'SESSIONS', requireAwait: true, awaitSettleTicks: 4, mark: 'working' },
      { afterPrevTicks: 3, data: DOWN, awaitPattern: `▸ [^│\\n]*${WORKING.slice(0, 12)}` },
      { data: '', awaitText: `${RESTING} ·`, requireAwait: true, awaitSettleTicks: 4, mark: 'resting' },
    ],
    total: 120,
    cols,
    rows,
    out,
  }))
  const res = spawnSync('/usr/bin/python3', [VSHOT, cfgPath], {
    encoding: 'utf8',
    timeout: vshotBudgetMs(240_000),
    env: {
      ...(process.env as Record<string, string>),
      MERCURY_CONFIG_DIR: scratch,
      MERCURY_HOME: '',
      MERCURY_TMPDIR: join(scratch, 'temp'),
      MERCURY_SPLASH: 'off',
      MERCURY_CONCOURSE: 'always',
      MERCURY_CONCOURSE_FIXTURE: fixturePath,
      MERCURY_DAEMON_DIR: join(scratch, 'daemon'),
      MERCURY_CREW_DIR: join(scratch, 'crew'),
      MERCURY_AWAY_SUMMARY: '0',
      MERCURY_PARTY: '0',
      ANTHROPIC_API_KEY: 'fixture-key-000',
      ANTHROPIC_BASE_URL: 'http://127.0.0.1:9',
    },
  })
  const marks = new Map<string, string[]>()
  if (res.status !== 0 || !existsSync(out)) {
    console.log(`  the capture at ${cols}x${rows} ended ${res.status}: ${(res.stderr ?? '').slice(-400)}`)
    return marks
  }
  const payload = JSON.parse(readFileSync(out, 'utf8')) as Grid & { marks?: ({ label: string } & Grid)[] }
  for (const mark of payload.marks ?? []) {
    const lines = linesOf(mark)
    marks.set(mark.label, lines)
    writeFileSync(join(OUT_DIR, `mirror-header-${cols}x${rows}--${mark.label}.txt`), lines.join('\n') + '\n')
  }
  return marks
}

function headerOf(lines: string[], title: string): string | null {
  for (const line of lines) {
    const open = line.indexOf('│')
    const close = open === -1 ? -1 : line.indexOf('│', open + 1)
    if (close === -1) continue
    const inner = line.slice(open + 1, close)
    if (inner.trimStart().startsWith(title)) return inner
  }
  return null
}
const factsAfter = (title: string, facts: readonly string[]): RegExp =>
  new RegExp(`^ ${title}${facts.reduceRight((rest, fact) => `(?: · ${fact.replace('.', '\\.')}${rest})?`, '')} {2,}(?=\\S)`)

for (const [cols, rows, every] of [[100, 30, false], [120, 40, true], [160, 50, true]] as const) {
  console.log(`H2 the board at ${cols}x${rows}`)
  const marks = capture(cols, rows)
  const working = headerOf(marks.get('working') ?? [], WORKING)
  const resting = headerOf(marks.get('resting') ?? [], RESTING)
  check('working: the header of the selected session is on screen', working !== null, (marks.get('working') ?? []).slice(0, 3).join(' | ').slice(0, 300))
  check('working: after the title stand whole facts only, then two cells of air', working !== null && factsAfter(WORKING, FACTS).test(working), j(working))
  check('working: the way in is whole at the right edge, with the working mark before it', working !== null && working.trimEnd().endsWith(HINT) && /[◐◓◑◒]/.test(working), j(working))
  if (every) check('working: the project, the model with its version and the effort are all there', working !== null && working.includes(` ${WORKING} · proj · Opus 4.8 · high  `), j(working))
  const restFacts = resting === null ? null : new RegExp(`^ ${RESTING}(.*?) {2,}${HINT} *$`).exec(resting)
  const restWhole = ' · orchard-src · Opus 4.8 · high'
  check('at rest: the facts stand as they did — whole while they fit, the one the room ends in cut with an ellipsis two cells before the way in, never dropped to leave its cells empty; the way in whole, no working mark and no words of an old reply', restFacts !== null && !/[◐◓◑◒]/.test(resting!) && (restFacts[1] === restWhole || (restFacts[1]!.endsWith('…') && restWhole.startsWith(restFacts[1]!.slice(0, -1)) && new RegExp(`… {2}${HINT} *$`).test(resting!))), j(resting))
  if (every) check('at rest: the project, the model with its version and the effort are all there', resting !== null && resting.includes(` ${RESTING} · orchard-src · Opus 4.8 · high  `), j(resting))
}

removeScratch(scratch)
console.log(failures === 0 ? `\nprove-mirror-header-facts: ALL LAWS HOLD (frames under ${OUT_DIR})` : `\nprove-mirror-header-facts: ${failures} FAILURE(S) (frames under ${OUT_DIR})`)
process.exit(failures === 0 ? 0 : 1)
