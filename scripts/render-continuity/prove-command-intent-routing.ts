#!/usr/bin/env bun
import { spawnSync } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { vshotBudgetMs as S } from '../lib/captureDriver.ts'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'poise-intent-config.'))

const { builtinCommands } = await import('../../src/commands.ts')
const { enableConfigs } = await import('../../src/utils/config/globalConfig.ts')
enableConfigs()
const { classifyAgentViewSubmission } = await import(
  '../../src/components/PromptInput/promptIntent.ts'
)
const { runPulseArena, anchoredOffset, restoreOffsets } = await import('./lib/pulseArena.ts')
const { checker } = await import('../engine-durability/harness.ts')
type ScriptedTurn = import('../lib/fixtureApi.ts').ScriptedTurn

const HERE = dirname(fileURLToPath(import.meta.url))
const SCREENGRAB = join(HERE, '..', 'streaming', 'screengrab.py')
const t = checker()

t.section('§1 generated registry matrix: every command classifies to its declared scope')
{
  const { isCommandEnabled } = await import('../../src/commands.ts')
  const safeEnabled = (c: { isEnabled?: () => boolean }): boolean => {
    try {
      return isCommandEnabled(c as never)
    } catch {
      return false
    }
  }
  const all = [...builtinCommands()]
  const roster = all.filter(safeEnabled)
  const rosterNames = new Set(roster.flatMap(c => [c.name, ...(c.aliases ?? [])]))
  let sessionCount = 0
  let agentCount = 0
  let disabledHonest = 0
  const misrouted: string[] = []
  let total = 0
  for (const c of all) {
    for (const name of [c.name, ...(c.aliases ?? [])]) {
      for (const fromKeybinding of [false, true]) {
        total++
        const intent = classifyAgentViewSubmission(`/${name}`, fromKeybinding, roster)
        const expectCommand = rosterNames.has(name)
        if (expectCommand && intent.kind === 'session-command') sessionCount++
        else if (expectCommand && intent.kind === 'agent-command') agentCount++
        else if (!expectCommand && intent.kind === 'unknown-command') disabledHonest++
        else {
          misrouted.push(`/${name} (inRoster=${expectCommand}, kb=${fromKeybinding}) -> ${intent.kind}`)
        }
      }
    }
  }
  t.check(
    `all ${total} registered names+aliases × {typed,keybinding} classify lawfully (roster -> command destination, disabled -> honest unknown)`,
    misrouted.length === 0,
    misrouted.slice(0, 6).join(' · ') ||
      `${sessionCount} session / ${agentCount} agent / ${disabledHonest} disabled-honest`,
  )
  t.check(
    'the roster declares no agent-scoped command today (new ones must opt in explicitly)',
    agentCount === 0,
    `${agentCount}`,
  )
  const aliasDrift = roster
    .filter(c => c.aliases?.length)
    .flatMap(c =>
      (c.aliases ?? []).filter(a => {
        const viaAlias = classifyAgentViewSubmission(`/${a}`, false, roster)
        return !(viaAlias.kind === 'session-command' && viaAlias.command.name === c.name)
      }),
    )
  t.check('every roster alias resolves to its owner command', aliasDrift.length === 0, aliasDrift.join(','))
}

t.section('§2 unknown / literal / guidance laws')
{
  const commands = [...builtinCommands()]
  const unknown = classifyAgentViewSubmission('/frobnicate', false, commands)
  t.check(
    'unknown slash input classifies unknown-command (never guidance)',
    unknown.kind === 'unknown-command' && unknown.bareName === 'frobnicate',
    unknown.kind,
  )
  const unknownArgs = classifyAgentViewSubmission('/frobnicate now please', false, commands)
  t.check(
    'unknown slash with args keeps the bare name',
    unknownArgs.kind === 'unknown-command' && unknownArgs.bareName === 'frobnicate',
    unknownArgs.kind,
  )
  const literal = classifyAgentViewSubmission('//health check this', false, commands)
  t.check(
    "'//x …' is the literal-send path delivering '/x …'",
    literal.kind === 'agent-literal' && literal.text === '/health check this',
    JSON.stringify(literal),
  )
  const guidance = classifyAgentViewSubmission('please fix the tests', false, commands)
  t.check('plain text is agent guidance', guidance.kind === 'agent-guidance', guidance.kind)
}

t.section('§3 journey: agent view routes commands locally, guidance to the agent')
{
  const ESC = String.fromCharCode(27)
  const sgrClick = (col: number, row: number): string =>
    `${ESC}[<0;${col};${row}M${ESC}[<0;${col};${row}m`

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
    {
      kind: 'paced',
      deltas: Array.from({ length: 30 }, (_, i) => `count ${i + 1}. `),
      gapMs: 900,
      whenSaid: 'Count to three slowly.',
    },
    { kind: 'text', text: 'Probe launched.', whenBody: 'spawn the probe' },
    { kind: 'text', text: 'Acknowledged.', whenBody: 'spawn the probe' },
    { kind: 'text', text: 'Settled.', whenBody: 'spawn the probe' },
    { kind: 'text', text: 'Complete.', whenBody: 'spawn the probe' },
    { kind: 'text', text: 'Spare.', whenBody: 'spawn the probe' },
  ]

  const run = await runPulseArena({
    turns,
    sends: [
      'after:↑↓ choose:900:\\r',
      '7400:spawn the probe\\r',
      `after:poise pro… · running:1000:${sgrClick(10, 4)}`,
      `after:poise probe · viewing:2000:${sgrClick(10, 3)}`,
      'after:poise probe · viewing:4600:/frobnicate\\r',
      `after:/frobnicate:2400:${ESC}[D`,
      `after:Mercury — surfaces:2600:${ESC}`,
      `after:Mercury — surfaces:4000:x`,
      `after:Mercury — surfaces:4500:${String.fromCharCode(127)}`,
      'after:Mercury — surfaces:5400:/cost\\r',
    ],
    seconds: 40,
    cols: 120,
    rows: 40,
    keep: true,
  })
  t.check(
    'every send became due (each witness painted; the send log carries the 9 after the face ↵, which it files as the arena\'s own)',
    run.sendLog.length === 9 && !run.driverOut.includes('UNFIRED-SENDS'),
    `${run.sendLog.length}/9 · ${run.driverOut.split('\n').filter(l => l.includes('UNFIRED')).join(' ').slice(0, 300)}`,
  )

  const offsets: string[] = []
  for (let ms = S(5000); ms <= S(34000); ms += S(250)) offsets.push(String(anchoredOffset(run, ms)))
  const grab = spawnSync(
    '/usr/bin/python3',
    [SCREENGRAB, run.paths.drive, '120', '40', ...offsets, '-1'],
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  )
  if (grab.status !== 0) {
    t.check('screengrab ran', false, grab.stderr)
  } else {
    const { screens } = JSON.parse(grab.stdout) as {
      screens: { atMs: number; rows: string[] }[]
    }
    restoreOffsets(run, screens)
    type Fr = { atMs: number; rows: string[] }
    const inWindow = (from: number, to: number): Fr[] =>
      screens.filter(s => s.atMs !== -1 && s.atMs >= from && s.atMs <= to)
    const anyFrame = (from: number, to: number, pred: (f: Fr) => boolean): boolean =>
      inWindow(from, to).some(pred)
    const everyFrame = (from: number, to: number, pred: (f: Fr) => boolean): boolean =>
      inWindow(from, to).every(pred)
    const has = (f: Fr, needle: string | RegExp): boolean =>
      f.rows.some(r => (typeof needle === 'string' ? r.includes(needle) : needle.test(r)))
    const composerOf = (f: Fr): string => {
      const rows = f.rows.filter(r => {
        const t2 = r.trimStart()
        return t2.startsWith('❯') || t2.startsWith('│❯')
      })
      return (rows[rows.length - 1] ?? '').replace(/[│]/g, '').trim()
    }

    const frames = screens.filter(s2 => s2.atMs !== -1)
    const idxOf = (start: number, pred: (f: Fr) => boolean): number => {
      for (let i = Math.max(0, start); i < frames.length; i++) if (pred(frames[i]!)) return i
      return -1
    }

    const forensics = (from: number): string =>
      frames
        .slice(Math.max(0, from), Math.max(0, from) + 20)
        .map(
          f =>
            `@${f.atMs} rail=${JSON.stringify(f.rows.slice(1, 8).map(r => r.slice(0, 24).trim()).filter(Boolean).join(' | '))}` +
            ` composer=${JSON.stringify(composerOf(f).slice(0, 32))}` +
            `${has(f, 'Mercury — surfaces') ? ' MGR' : ''}` +
            `${has(f, /VIEW · poise probe · viewing/) ? ' VIEW' : ''}`,
        )
        .join(' ↵ ')
    const crewRow = (f: Fr): boolean => f.rows.some(r => r.includes('poise pro') && r.includes('running'))
    const inView = (f: Fr): boolean => has(f, /VIEW · poise probe · viewing/)
    const iCrew = idxOf(0, crewRow)
    t.check(
      "the hosted agent lists in the CREW lane (the runner's roster over the connector)",
      iCrew >= 0,
      iCrew >= 0 ? undefined : forensics(frames.findIndex(f => f.rows.some(r => r.includes('poise probe')))),
    )
    const iView = idxOf(iCrew + 1, f => inView(f) && has(f, 'sends to poise probe'))
    t.check(
      "one click on its CREW row opens the agent in the view (its transcript lives with the runner; ↵ addresses it)",
      iCrew >= 0 && iView > iCrew,
      iView > iCrew ? undefined : forensics(iCrew),
    )
    const iClosed = idxOf(iView + 1, f => !inView(f) && has(f, /›\s*✶ Mercury Lead/) && crewRow(f))
    t.check(
      'Mercury Lead in the rail goes back: the lead owns the view again and the agent keeps running (return ≠ stop)',
      iView >= 0 && iClosed > iView,
      iClosed > iView ? undefined : forensics(iView),
    )
    const iNotify = idxOf(iClosed + 1, f => has(f, /Unknown command: \/frobnicate/))
    t.check(
      "an unknown /name answers the screen's own sentence (never the runner's)",
      iClosed >= 0 && iNotify > iClosed,
      iNotify > iClosed ? undefined : forensics(iClosed),
    )
    const iManager = idxOf(iNotify + 1, f => has(f, 'Mercury — surfaces'))
    t.check(
      'main-view ← opens the surface index (the classified funnel, never words)',
      iNotify >= 0 && iManager > iNotify,
      iManager > iNotify ? undefined : forensics(iNotify),
    )
    const iMgrClosed = idxOf(iManager + 1, f => !has(f, 'Mercury — surfaces'))
    t.check('esc closes the surface index', iManager >= 0 && iMgrClosed > iManager)

    type Msg = { role: string; content: unknown }
    const bodies = run.fixture.requests
      .map(r => r.body as { messages?: Msg[] } | null)
      .filter((b): b is { messages: Msg[] } => Boolean(b?.messages))
    const isCommandRecord = (text: string): boolean =>
      text.includes('<local-command-caveat>') || text.includes('<command-name>')
    const userTextIncludes = (needle: string): boolean =>
      bodies.some(b =>
        b.messages.some(
          m =>
            m.role === 'user' &&
            (typeof m.content === 'string'
              ? m.content.includes(needle) && !isCommandRecord(m.content)
              : Array.isArray(m.content) &&
                m.content.some(
                  (c: { type?: string; text?: string }) =>
                    c?.type === 'text' &&
                    typeof c.text === 'string' &&
                    c.text.includes(needle) &&
                    !isCommandRecord(c.text),
                )),
        ),
      )
    t.check('no /frobnicate in any model call', !userTextIncludes('/frobnicate'))
    t.check('no /manager in any model call', !userTextIncludes('/manager'))
    t.check('no /cost in any model call', !userTextIncludes('/cost'))

    const { mkdirSync, writeFileSync } = await import('node:fs')
    const framesArg = process.argv.indexOf('--frames')
    const receiptDirs = [join(HERE, 'receipts', '.last'), ...(framesArg >= 0 && process.argv[framesArg + 1] ? [process.argv[framesArg + 1]!] : [])]
    const maskAmbient = (r: string): string =>
      r
        .replace(/\b\d{2}:\d{2}:\d{2}\b/g, 'HH:MM:SS')
        .replace(/pulse-arena-cwd-\w+/g, 'pulse-arena-cwd-XXXXXX')
    const journey = screens
      .map(
        s =>
          `════ screen @${s.atMs}ms ════\n` +
          s.rows.filter(r => r.trim() !== '').map(maskAmbient).join('\n'),
      )
      .join('\n\n')
    for (const dir of receiptDirs) {
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, 'intent-routing-journey.txt'), journey)
    }
  }
  run.cleanup()
}

t.finish('prove-command-intent-routing')
