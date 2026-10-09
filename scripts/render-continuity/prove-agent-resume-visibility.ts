#!/usr/bin/env bun
import { spawnSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { vshotBudgetMs as S } from '../lib/captureDriver.ts'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

const { mergeDiskPrefix } = await import('../../src/tasks/LocalAgentTask/LocalAgentTask.tsx')
const { runPulseArena } = await import('./lib/pulseArena.ts')
const { checker } = await import('../engine-durability/harness.ts')
type ScriptedTurn = import('../lib/fixtureApi.ts').ScriptedTurn

const HERE = dirname(fileURLToPath(import.meta.url))
const SCREENGRAB = join(HERE, '..', 'streaming', 'screengrab.py')
const t = checker()
const FRAMES = ((): string | undefined => {
  const at = process.argv.indexOf('--frames')
  return at >= 0 ? process.argv[at + 1] : undefined
})()

const ESC = String.fromCharCode(27)
const sgrClick = (col: number, row: number): string =>
  `${ESC}[<0;${col};${row}M${ESC}[<0;${col};${row}m`
const LEAD_ROW = 3
const FIRST_CHILD_ROW = 4
type Frame = { atMs: number; rows: string[] }
const frameIn = (screens: Frame[], atMs: number): Frame => {
  const f = screens.find(s => s.atMs === atMs)
  if (!f) throw new Error(`no frame @${atMs}`)
  return f
}
const has = (f: Frame, needle: string | RegExp): boolean =>
  f.rows.some(r => (typeof needle === 'string' ? r.includes(needle) : needle.test(r)))
const viewOf = (f: Frame): string | undefined => {
  for (const r of f.rows) {
    const m = /↵ sends to ([a-z]+) probe/.exec(r)
    if (m) return `${m[1]} probe`
  }
  return undefined
}
const leadOwnsView = (f: Frame): boolean => f.rows.some(r => /›\s*✶ Mercury Lead/.test(r))
const composerOf = (f: Frame): string => {
  const rows = f.rows.filter(r => {
    const t2 = r.trimStart()
    return t2.startsWith('❯') || t2.startsWith('│❯')
  })
  return (rows[rows.length - 1] ?? '').replace(/[│]/g, '').trim()
}
const keepFrames = (label: string, screens: Frame[]): void => {
  if (FRAMES === undefined) return
  mkdirSync(FRAMES, { recursive: true })
  const out: string[] = []
  let prev = ''
  for (const s of screens) {
    const body = s.rows.map((r, i) => `${String(i + 1).padStart(2)}|${r}`).join('\n')
    if (body === prev) continue
    prev = body
    out.push(`━━ @${s.atMs}`, body)
  }
  writeFileSync(join(FRAMES, `${label}.txt`), out.join('\n') + '\n')
}
const sendsDue = (run: { sendLog: unknown[]; driverOut: string }, authored: number): void =>
  t.check(
    `every send became due (${authored} sends, each witness painted)`,
    run.sendLog.length === authored && !run.driverOut.includes('UNFIRED-SENDS'),
    `${run.sendLog.length}/${authored} · ${run.driverOut.split('\n').filter(l => l.includes('UNFIRED')).join(' ').slice(0, 300)}`,
  )

t.section('§1 disk↔live convergence: mergeDiskPrefix laws')
{
  const m = (...uuids: string[]): { uuid: string }[] => uuids.map(uuid => ({ uuid }))
  const ids = (arr: { uuid: string }[]): string => arr.map(x => x.uuid).join(',')

  t.check('disjoint: disk prefix precedes live', ids(mergeDiskPrefix(m('c', 'd'), m('a', 'b'))) === 'a,b,c,d')
  t.check('full overlap: live == disk ⇒ live once', ids(mergeDiskPrefix(m('a', 'b'), m('a', 'b'))) === 'a,b')
  t.check(
    'suffix overlap: disk ⊇ live ⇒ each uuid once, disk order for the prefix',
    ids(mergeDiskPrefix(m('b', 'c'), m('a', 'b', 'c'))) === 'a,b,c',
  )
  t.check(
    'interleaved overlap: disk-only rows fill the prefix, live keeps its tail',
    ids(mergeDiskPrefix(m('b', 'd'), m('a', 'b', 'c'))) === 'a,c,b,d',
  )
  t.check('empty live: disk wholesale', ids(mergeDiskPrefix([], m('a', 'b'))) === 'a,b')
  t.check('empty disk: live untouched', ids(mergeDiskPrefix(m('a'), [])) === 'a')
  {
    const merged = mergeDiskPrefix(m('x', 'y'), m('a', 'x', 'y'))
    const seen = new Set(merged.map(r => r.uuid))
    t.check('once-only: no uuid ever duplicates', seen.size === merged.length, ids(merged))
  }
}

t.section("§2 words typed at main while a crewmate runs are the session's own turn, never dropped")
{
  const turns: ScriptedTurn[] = [
    {
      kind: 'tool_use',
      name: 'Agent',
      input: {
        description: 'poise probe',
        prompt: 'Count to three slowly.',
        subagent_type: 'mercury-crew',
        run_in_background: true,
      },
      preText: 'Spawning the probe agent.',
    },
    { kind: 'paced', deltas: Array.from({ length: 12 }, (_, i) => `count ${i + 1}. `), gapMs: 800, whenSaid: 'Count to three slowly.' },
    { kind: 'text', text: 'Probe launched.', whenBody: 'spawn the probe' },
    { kind: 'text', text: 'Taking your steer into account.', whenBody: 'steer the count gently' },
    { kind: 'text', text: 'Settled.', whenBody: 'spawn the probe' },
    { kind: 'text', text: 'Complete.', whenBody: 'spawn the probe' },
    { kind: 'text', text: 'Spare.', whenBody: 'spawn the probe' },
    { kind: 'text', text: 'Spare2.', whenBody: 'spawn the probe' },
  ]

  const run = await runPulseArena({
    turns,
    sends: [
      '2000:\\r',
      '6000:spawn the probe\\r',
      `after:poise pro… · running:800:${sgrClick(10, FIRST_CHILD_ROW)}`,
      `after:x stop · p pause:1500:${sgrClick(10, LEAD_ROW)}`,
      'after:x stop · p pause:3500:steer the count gently',
      'after:x stop · p pause:5000:\\r',
    ],
    seconds: 24,
    cols: 120,
    rows: 40,
    keep: true,
  })
  sendsDue(run, 6)

  const offsets = Array.from({ length: 50 }, (_, i) => String(S(6000 + i * 300)))
  const grab = spawnSync(
    '/usr/bin/python3',
    [SCREENGRAB, run.paths.drive, '120', '40', ...offsets, '-1'],
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  )
  if (grab.status !== 0) {
    t.check('screengrab ran', false, grab.stderr)
  } else {
    const { screens } = JSON.parse(grab.stdout) as { screens: Frame[] }
    keepFrames('steer-120x40', screens)
    const timed = screens.filter(f => f.atMs !== -1)
    const childRunning = (f: Frame): boolean => f.rows.some(r => r.includes('poise pro') && r.includes('running'))
    const iView = timed.findIndex(f => viewOf(f) === 'poise probe' && has(f, 'sends to poise probe'))
    t.check(
      "one click on the running crewmate's CREW row opens it in the view (the composer addresses it, ↵ sends to it)",
      iView >= 0,
      iView >= 0 ? `frame @${timed[iView]!.atMs}` : 'no view frame in the series',
    )
    const iBack = timed.findIndex((f, i) => i > iView && viewOf(f) === undefined && leadOwnsView(f) && childRunning(f))
    t.check(
      'Mercury Lead in the rail goes back: the lead owns the view again and the crewmate keeps running (return ≠ stop)',
      iView >= 0 && iBack > iView,
      iBack >= 0 ? `frame @${timed[iBack]!.atMs}` : 'no main frame with the crewmate running after the view frame',
    )
    const sessionRows = (f: Frame): string[] => f.rows.filter(r => /\[\w+\] ❯ steer the count gently/.test(r))
    const crewmateRows = (f: Frame): string[] => f.rows.filter(r => /\[you → [^\]]+\] ❯ steer the count gently/.test(r))
    const iSteer = timed.findIndex((f, i) => i > iBack && viewOf(f) === undefined && sessionRows(f).length > 0)
    t.check(
      "back at main, the words typed while the crewmate runs are the session's own turn: one transcript row, never a message to the crewmate",
      iBack >= 0 && iSteer > iBack && sessionRows(timed[iSteer]!).length === 1 && timed.every(f => crewmateRows(f).length === 0),
      iSteer >= 0 ? `frame @${timed[iSteer]!.atMs}` : 'no steer row after the return frame',
    )

    type Msg = { role: string; content: unknown }
    const bodies = run.fixture.requests
      .map(r => r.body as { messages?: Msg[] } | null)
      .filter((b): b is { messages: Msg[] } => Boolean(b?.messages))
    const isCommandRecord = (text: string): boolean =>
      text.includes('<local-command-caveat>') || text.includes('<command-name>')
    const userTexts = (b: { messages: Msg[] }): string[] =>
      b.messages.flatMap(m => {
        if (m.role !== 'user') return []
        if (typeof m.content === 'string') return [m.content]
        return Array.isArray(m.content)
          ? m.content.flatMap((c: { type?: string; text?: string }) => (c?.type === 'text' && typeof c.text === 'string' ? [c.text] : []))
          : []
      })
    const carriesSteer = (b: { messages: Msg[] }): boolean => userTexts(b).some(text => text.includes('steer the count gently') && !isCommandRecord(text))
    const isAgentBody = (b: { messages: Msg[] }): boolean => userTexts(b).some(text => text.includes('Count to three slowly.'))
    const deliveredBodies = bodies.filter(carriesSteer)
    t.check(
      'the words reach a REAL model call of the session (never dropped)',
      deliveredBodies.length >= 1 && deliveredBodies.every(b => !isAgentBody(b)),
      `${deliveredBodies.length} session bodies carry them · ${bodies.filter(isAgentBody).length} agent bodies, ${bodies.filter(b => isAgentBody(b) && carriesSteer(b)).length} of them carry the words`,
    )
    const final = frameIn(screens, -1)
    t.check(
      'the session answered the words and the crewmate ran on to its landing',
      final.rows.some(r => r.includes('Taking your steer into account')) && final.rows.some(r => /\[Crewmate\] poise probe · completed/.test(r)),
      final.rows.filter(r => /steer into account|\[Crewmate\] poise probe/.test(r)).map(r => r.trim().slice(0, 60)).join(' | '),
    )
    t.check(
      'the words still paint exactly once on the transcript at settlement',
      sessionRows(final).length === 1 && crewmateRows(final).length === 0,
      `${sessionRows(final).length} transcript row(s); every row: ${final.rows.filter(r => r.includes('steer the count gently')).map(r => r.trim().slice(0, 50)).join(' | ')}`,
    )
  }
  run.cleanup()
}

t.section('§3 one composer, one draft: the draft rides the view swap into either child and the way back')
{
  const agentInput = (name: string): Record<string, unknown> => ({
    description: name,
    prompt: 'Work quietly.',
    subagent_type: 'mercury-crew',
    run_in_background: true,
  })
  const agentPaced: ScriptedTurn = {
    kind: 'paced',
    deltas: Array.from({ length: 26 }, (_, i) => `working segment ${i + 1}. `),
    gapMs: 900,
    whenSaid: 'Work quietly.',
  }
  const turns: ScriptedTurn[] = [
    {
      kind: 'paced_tool_use',
      preDeltas: ['Spawning both probes. '],
      gapMs: 200,
      tools: [
        { name: 'Agent', input: agentInput('alpha probe') },
        { name: 'Agent', input: agentInput('beta probe') },
      ],
    },
    agentPaced,
    agentPaced,
    { kind: 'text', text: 'Both launched.', whenBody: 'spawn both probes' },
    { kind: 'text', text: 'Spare.', whenBody: 'spawn both probes' },
    { kind: 'text', text: 'Spare2.', whenBody: 'spawn both probes' },
    { kind: 'text', text: 'Spare3.', whenBody: 'spawn both probes' },
  ]

  const ALPHA_ROW = 'alpha pro… · running'
  const BETA_ROW = 'beta probe · running'
  const LEAD_ROW_TEXT = '✶ Mercury Lead'
  const run = await runPulseArena({
    turns,
    sends: [
      '2000:\\r',
      '6000:spawn both probes\\r',
      { awaitText: [ALPHA_ROW, BETA_ROW], afterPrevMs: 1000, settleMs: 0, text: 'draft-main-text' },
      { awaitText: 'draft-main-text', afterPrevMs: 1000, settleMs: 0, targetText: ALPHA_ROW },
      { awaitText: 'sends to alpha probe', afterPrevMs: 1500, settleMs: 0, targetText: LEAD_ROW_TEXT },
      { awaitText: ['draft-main-text', BETA_ROW], awaitAbsent: 'sends to alpha probe', afterPrevMs: 1000, settleMs: 0, targetText: BETA_ROW },
      { awaitText: 'sends to beta probe', afterPrevMs: 1500, settleMs: 0, targetText: LEAD_ROW_TEXT },
    ],
    seconds: 26,
    cols: 120,
    rows: 40,
    keep: true,
  })
  sendsDue(run, 7)

  const offsets: string[] = []
  for (let ms = S(6000); ms <= S(25500); ms += S(250)) offsets.push(String(ms))
  const grab = spawnSync(
    '/usr/bin/python3',
    [SCREENGRAB, run.paths.drive, '120', '40', ...offsets, '-1'],
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  )
  if (grab.status !== 0) {
    t.check('screengrab ran', false, grab.stderr)
  } else {
    const { screens } = JSON.parse(grab.stdout) as { screens: Frame[] }
    keepFrames('drafts-120x40', screens)
    const timed = screens.filter(f => f.atMs !== -1)
    const holdsDraft = (f: Frame): boolean => composerOf(f).includes('draft-main-text')

    const iDraft = timed.findIndex(f => viewOf(f) === undefined && holdsDraft(f))
    t.check('the draft is typed and visible in a main-view frame', iDraft >= 0)
    const iFirst = timed.findIndex((f, i) => i > iDraft && viewOf(f) !== undefined)
    const n1 = iFirst >= 0 ? viewOf(timed[iFirst]!) : undefined
    t.check(
      "one click on a CREW row opens that child in the view over the same composer, the draft still in it",
      iDraft >= 0 && iFirst > iDraft && holdsDraft(timed[iFirst]!),
      `first view: ${n1 ?? 'none'} · composer ${JSON.stringify(iFirst >= 0 ? composerOf(timed[iFirst]!) : '')}`,
    )
    const iBack1 = timed.findIndex((f, i) => i > iFirst && viewOf(f) === undefined && leadOwnsView(f) && holdsDraft(f))
    t.check('Mercury Lead in the rail goes back and the composer still holds the draft (one composer, one draft)', iFirst >= 0 && iBack1 > iFirst)
    const iSecond = timed.findIndex((f, i) => i > iBack1 && viewOf(f) !== undefined && viewOf(f) !== n1)
    const n2 = iSecond >= 0 ? viewOf(timed[iSecond]!) : undefined
    t.check(
      "the second click opens the OTHER child in the view, the draft still in the composer",
      iBack1 >= 0 && iSecond > iBack1 && n1 !== undefined && n2 !== undefined && n1 !== n2 && holdsDraft(timed[iSecond]!),
      `first@${n1} second@${n2}`,
    )
    const iBack2 = timed.findIndex((f, i) => i > iSecond && viewOf(f) === undefined && leadOwnsView(f) && holdsDraft(f))
    t.check(
      'the way back from the second view keeps the draft exactly',
      iSecond >= 0 && iBack2 > iSecond && composerOf(timed[iBack2]!).replace(/^❯\s*/, '') === 'draft-main-text',
      iBack2 >= 0 ? JSON.stringify(composerOf(timed[iBack2]!)) : 'no main frame with the draft after the second view',
    )
    t.check(
      'INVARIANT: the draft never leaves the composer for any transcript (no click submits it, to the lead or to a child)',
      timed.every(f => !f.rows.some(r => /\] ❯ draft-main-text/.test(r))),
    )
  }
  run.cleanup()
}

t.finish('prove-agent-resume-visibility')
