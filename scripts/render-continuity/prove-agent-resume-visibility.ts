#!/usr/bin/env bun
import { spawnSync } from 'node:child_process'
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

const ESC = String.fromCharCode(27)
const sgrClick = (col: number, row: number): string =>
  `${ESC}[<0;${col};${row}M${ESC}[<0;${col};${row}m`
type Frame = { atMs: number; rows: string[] }
const frameIn = (screens: Frame[], atMs: number): Frame => {
  const f = screens.find(s => s.atMs === atMs)
  if (!f) throw new Error(`no frame @${atMs}`)
  return f
}

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

t.section("§2 words typed while an agent runs are the session's own turn, never dropped")
{
  const turns: ScriptedTurn[] = [
    {
      kind: 'tool_use',
      name: 'Agent',
      input: {
        description: 'poise probe',
        prompt: 'Count to three slowly.',
        subagent_type: 'mercury-general',
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
      `after:poise pro:800:${sgrClick(10, 7)}`,
      `after:poise pro:1500:${sgrClick(10, 7)}`,
      `after:agent › poise probe:1500:${ESC}`,
      `after:agent › poise probe:2500:${ESC}`,
      'after:agent › poise probe:4000:steer the count gently',
      'after:agent › poise probe:5500:\\r',
    ],
    seconds: 24,
    cols: 120,
    rows: 40,
    keep: true,
  })

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
    const timed = screens.filter(f => f.atMs !== -1)
    const has = (f: Frame, needle: string | RegExp): boolean =>
      f.rows.some(r => (typeof needle === 'string' ? r.includes(needle) : needle.test(r)))
    const iCard = timed.findIndex(f => has(f, /agent › poise probe/) && has(f, /esc back/))
    t.check(
      "the drill opens the running agent's work card (its stream and controls live with the session's runner)",
      iCard >= 0,
      iCard >= 0 ? `frame @${timed[iCard]!.atMs}` : 'no card frame in the series',
    )
    const transcriptRows = (f: Frame): string[] => f.rows.filter(r => /\] ❯ steer the count gently/.test(r))
    const iSteer = timed.findIndex((f, i) => i > iCard && !has(f, /agent › poise probe/) && transcriptRows(f).length > 0)
    t.check(
      'back at main, the words typed while the agent runs are the session\'s own turn: one transcript row, never a message to the agent',
      iCard >= 0 && iSteer > iCard && transcriptRows(timed[iSteer]!).length === 1,
      iSteer >= 0 ? `frame @${timed[iSteer]!.atMs}` : 'no steer row after the card frame',
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
      'the session answered the words and the agent ran on to its landing',
      final.rows.some(r => r.includes('Taking your steer into account')) && final.rows.some(r => /Agent "poise probe" completed/.test(r)),
      final.rows.filter(r => /steer into account|poise probe" completed/.test(r)).map(r => r.trim().slice(0, 60)).join(' | '),
    )
    t.check(
      'the words still paint exactly once on the transcript at settlement',
      transcriptRows(final).length === 1,
      `${transcriptRows(final).length} transcript row(s); every row: ${final.rows.filter(r => r.includes('steer the count gently')).map(r => r.trim().slice(0, 50)).join(' | ')}`,
    )
  }
  run.cleanup()
}

t.section('§3 one composer, one draft: the draft survives the drill into either card and the way back')
{
  const agentInput = (name: string): Record<string, unknown> => ({
    description: name,
    prompt: 'Work quietly.',
    subagent_type: 'mercury-general',
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

  const run = await runPulseArena({
    turns,
    sends: [
      '2000:\\r',
      '6000:spawn both probes\\r',
      'after:beta pro:1000:draft-main-text',
      `after:beta pro:3000:${sgrClick(10, 7)}`,
      `after:beta pro:3700:${sgrClick(10, 7)}`,
      `after:agent › :1400:${ESC}`,
      `after:agent › :2400:${ESC}`,
      `after:agent › :3800:${sgrClick(10, 8)}`,
      `after:agent › :4500:${sgrClick(10, 8)}`,
      `after:agent › :6900:${ESC}`,
      `after:agent › :7900:${ESC}`,
    ],
    seconds: 26,
    cols: 120,
    rows: 40,
    keep: true,
  })

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
    const composerOf = (f: Frame): string => {
      const rows = f.rows.filter(r => {
        const t2 = r.trimStart()
        return t2.startsWith('❯') || t2.startsWith('│❯')
      })
      return (rows[rows.length - 1] ?? '').replace(/[│]/g, '').trim()
    }
    const cardOf = (f: Frame): string | undefined => {
      const row = f.rows.find(r => /agent › [a-z]+ probe/.test(r))
      return row ? /agent › ([a-z]+ probe)/.exec(row)?.[1] : undefined
    }
    const timed = screens.filter(f => f.atMs !== -1)

    const iDraft = timed.findIndex(f => !cardOf(f) && composerOf(f).includes('draft-main-text'))
    t.check('the draft is typed and visible in a main-view frame', iDraft >= 0)
    const iFirst = timed.findIndex((f, i) => i > iDraft && cardOf(f) !== undefined)
    const n1 = iFirst >= 0 ? cardOf(timed[iFirst]!) : undefined
    t.check("the drill opens a child's work card over the chat", iDraft >= 0 && iFirst > iDraft, `first card: ${n1 ?? 'none'}`)
    const iBack1 = timed.findIndex((f, i) => i > iFirst && !cardOf(f) && composerOf(f).includes('draft-main-text'))
    t.check('the way back from the card RESTORES the draft (one composer, one draft)', iFirst >= 0 && iBack1 > iFirst)
    const iSecond = timed.findIndex((f, i) => i > iBack1 && cardOf(f) !== undefined && cardOf(f) !== n1)
    const n2 = iSecond >= 0 ? cardOf(timed[iSecond]!) : undefined
    t.check('the second drill opens the OTHER child\'s card', iBack1 >= 0 && iSecond > iBack1 && n1 !== undefined && n2 !== undefined && n1 !== n2, `first@${n1} second@${n2}`)
    const iBack2 = timed.findIndex((f, i) => i > iSecond && !cardOf(f) && composerOf(f).includes('draft-main-text'))
    t.check('the way back from the second card restores the draft again, exactly', iSecond >= 0 && iBack2 > iSecond && composerOf(timed[iBack2]!).replace(/^❯\s*/, '') === 'draft-main-text')
    t.check(
      'INVARIANT: the draft never leaves the composer for the transcript (no drilled card submits it)',
      timed.every(f => !f.rows.some(r => /\[\w+\] ❯ draft-main-text/.test(r))),
    )
  }
  run.cleanup()
}

t.finish('prove-agent-resume-visibility')
