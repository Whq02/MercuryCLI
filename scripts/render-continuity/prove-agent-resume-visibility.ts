#!/usr/bin/env bun
import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { vshotBudgetMs as S } from '../lib/captureDriver.ts'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

const { mergeDiskPrefix } = await import('../../src/tasks/LocalAgentTask/LocalAgentTask.tsx')
const { runPulseArena } = await import('../pulse/lib/pulseArena.ts')
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

t.section('§2 guidance queued during a running turn drains into a real resume')
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
    { kind: 'paced', deltas: Array.from({ length: 12 }, (_, i) => `count ${i + 1}. `), gapMs: 800, whenBody: 'Count to three slowly.' },
    { kind: 'text', text: 'Probe launched.' },
    { kind: 'text', text: 'Taking your steer into account.', whenBody: 'steer the count gently' },
    { kind: 'text', text: 'Settled.' },
    { kind: 'text', text: 'Complete.' },
    { kind: 'text', text: 'Spare.' },
    { kind: 'text', text: 'Spare2.' },
  ]

  const run = await runPulseArena({
    turns,
    sends: [
      '2000:\\r',
      '6000:spawn the probe\\r',
      `after:poise pro:800:${sgrClick(10, 7)}`,
      `after:poise pro:1500:${sgrClick(10, 7)}`,
      'after:Main ‹ @poise probe:1200:steer the count gently',
      'after:Main ‹ @poise probe:2400:\\r',
    ],
    seconds: 24,
    cols: 120,
    rows: 40,
    keep: true,
  })

  const offsets = Array.from({ length: 40 }, (_, i) => String(9000 + i * 300))
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
    const queued = timed.find(f => f.rows.some(r => r.includes('steer the count gently')))
    t.check(
      'the guidance row paints once in the viewed transcript at submit time',
      queued !== undefined &&
        queued.rows.filter(r => r.includes('steer the count gently')).length === 1,
    )

    type Msg = { role: string; content: unknown }
    const bodies = run.fixture.requests
      .map(r => r.body as { messages?: Msg[] } | null)
      .filter((b): b is { messages: Msg[] } => Boolean(b?.messages))
    const isCommandRecord = (text: string): boolean =>
      text.includes('<local-command-caveat>') || text.includes('<command-name>')
    const deliveredBodies = bodies.filter(b =>
      b.messages.some(
        m =>
          m.role === 'user' &&
          (typeof m.content === 'string'
            ? m.content.includes('steer the count gently') && !isCommandRecord(m.content)
            : Array.isArray(m.content) &&
              m.content.some(
                (c: { type?: string; text?: string }) =>
                  c?.type === 'text' &&
                  typeof c.text === 'string' &&
                  c.text.includes('steer the count gently') &&
                  !isCommandRecord(c.text),
              )),
      ),
    )
    t.check(
      'the drained guidance reaches a REAL model call after the turn ends (never dropped)',
      deliveredBodies.length >= 1,
      `${deliveredBodies.length} bodies carry it`,
    )
    const final = frameIn(screens, -1)
    t.check(
      'the agent visibly continued after the drain (resume reply present)',
      final.rows.some(r => r.includes('Taking your steer into account')),
    )
    t.check(
      'the guidance row still paints exactly once at settlement',
      final.rows.filter(r => r.includes('steer the count gently')).length === 1,
    )
  }
  run.cleanup()
}

t.section('§3 per-target composer drafts across main/A/B switches')
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
    whenBody: 'Work quietly.',
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
    { kind: 'text', text: 'Both launched.' },
    { kind: 'text', text: 'Spare.' },
    { kind: 'text', text: 'Spare2.' },
    { kind: 'text', text: 'Spare3.' },
  ]

  const run = await runPulseArena({
    turns,
    sends: [
      '2000:\\r',
      '6000:spawn both probes\\r',
      'after:beta pro:1000:draft-main-text',
      `after:beta pro:3000:${sgrClick(10, 7)}`,
      `after:beta pro:3700:${sgrClick(10, 7)}`,
      'after:Main ‹ @:1400:draft-for-first',
      `after:Main ‹ @:3800:${sgrClick(10, 8)}`,
      `after:Main ‹ @:4500:${sgrClick(10, 8)}`,
      'after:Main ‹ @:6900:draft-for-second',
      `after:Main ‹ @:9300:${ESC}`,
      `after:Main ‹ @:11700:${sgrClick(10, 7)}`,
      `after:Main ‹ @:12400:${sgrClick(10, 7)}`,
    ],
    seconds: 26,
    cols: 120,
    rows: 40,
    keep: true,
  })

  const offsets: string[] = []
  for (let ms = S(10000); ms <= S(25500); ms += S(250)) offsets.push(String(ms))
  const grab = spawnSync(
    '/usr/bin/python3',
    [SCREENGRAB, run.paths.drive, '120', '40', ...offsets, '-1'],
    { encoding: 'utf8' },
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
    const crumbOf = (f: Frame): string | undefined => {
      const row = f.rows.find(r => /Main ‹ @/.test(r))
      return row ? /Main ‹ @([a-z]+ probe)/.exec(row)?.[1] : undefined
    }
    const timed = screens.filter(f => f.atMs !== -1)

    t.check(
      'the main draft is typed and visible in a main-view frame',
      timed.some(f => !crumbOf(f) && composerOf(f).includes('draft-main-text')),
    )
    t.check(
      'INVARIANT: no agent-view frame ever shows the main draft in the composer',
      timed.every(f => !crumbOf(f) || !composerOf(f).includes('draft-main-text')),
    )
    t.check(
      'INVARIANT: no main-view frame ever shows an agent draft in the composer',
      timed.every(f => crumbOf(f) !== undefined || !composerOf(f).includes('draft-for-')),
    )
    const firstFrames = timed.filter(f => composerOf(f).includes('draft-for-first') && crumbOf(f))
    const secondFrames = timed.filter(f => composerOf(f).includes('draft-for-second') && crumbOf(f))
    const n1 = firstFrames[0] ? crumbOf(firstFrames[0]) : undefined
    const n2 = secondFrames[0] ? crumbOf(secondFrames[0]) : undefined
    t.check(
      'each agent draft is typed inside ITS OWN viewed target',
      n1 !== undefined && n2 !== undefined && n1 !== n2,
      `first@${n1} second@${n2}`,
    )
    const lastSecondAt = secondFrames.length ? secondFrames[secondFrames.length - 1].atMs : -1
    t.check(
      "returning to main RESTORES the main draft (after the second agent's draft existed)",
      timed.some(
        f => f.atMs > lastSecondAt && !crumbOf(f) && composerOf(f).includes('draft-main-text'),
      ),
    )
    t.check(
      "re-drilling the first agent restores ITS draft exactly",
      n1 !== undefined &&
        timed.some(
          f =>
            f.atMs > lastSecondAt &&
            crumbOf(f) === n1 &&
            composerOf(f).includes('draft-for-first') &&
            !composerOf(f).includes('draft-main-text'),
        ),
    )
  }
  run.cleanup()
}

t.finish('prove-agent-resume-visibility')
