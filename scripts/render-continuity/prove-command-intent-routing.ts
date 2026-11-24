#!/usr/bin/env bun
import { spawnSync } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { vshotBudgetMs as S } from '../lib/captureDriver.ts'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'poise-intent-config.'))

const { builtinCommands } = await import('../../src/commands/catalogue/commands.ts')
const { enableConfigs } = await import('../../src/platform/config/globalConfig.ts')
enableConfigs()
const { classifyCrewmateViewSubmission } = await import(
  '../../src/screen/composer/promptIntent.ts'
)
const { runPulseArena, anchoredOffset, restoreOffsets } = await import('./lib/pulseArena.ts')
const { checker } = await import('../engine-durability/harness.ts')
type ScriptedTurn = import('../lib/fixtureApi.ts').ScriptedTurn

const HERE = dirname(fileURLToPath(import.meta.url))
const SCREENGRAB = join(HERE, '..', 'streaming', 'screengrab.py')
const durabilityChecker = checker()
const t = {
  ...durabilityChecker,
  check: (label: string, cond: boolean, detail?: string, fix = ''): void =>
    durabilityChecker.check(label, cond, cond || !fix ? detail : `${detail ? `${detail} | ` : ''}${fix}`),
}

t.section('§1 generated registry matrix: every command classifies to its declared scope')
{
  const { isCommandEnabled } = await import('../../src/commands/catalogue/commands.ts')
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
  const agentScoped = new Set<string>()
  let total = 0
  for (const c of all) {
    for (const name of [c.name, ...(c.aliases ?? [])]) {
      for (const fromKeybinding of [false, true]) {
        total++
        const intent = classifyCrewmateViewSubmission(`/${name}`, fromKeybinding, roster)
        const expectCommand = rosterNames.has(name)
        if (expectCommand && intent.kind === 'session-command') sessionCount++
        else if (expectCommand && intent.kind === 'agent-command') {
          agentCount++
          agentScoped.add(intent.command.name)
        } else if (!expectCommand && intent.kind === 'unknown-command') disabledHonest++
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
    'fix classifyAgentViewSubmission in src/screen/composer/promptIntent.ts for the misrouted names listed',
  )
  const CREWMATE_SCOPED = ['compact', 'context', 'effort', 'model', 'usage']
  t.check(
    `the roster's agent-scoped commands are exactly the five that act on a selected crewmate (${CREWMATE_SCOPED.join(', ')}); a new one must opt in explicitly`,
    [...agentScoped].sort().join(',') === CREWMATE_SCOPED.join(','),
    [...agentScoped].sort().join(','),
    'classifyAgentViewSubmission in src/screen/composer/promptIntent.ts decides which commands are agent-scoped; either restore the five or update CREWMATE_SCOPED in this file if a command was meant to opt in',
  )
  const aliasDrift = roster
    .filter(c => c.aliases?.length)
    .flatMap(c =>
      (c.aliases ?? []).filter(a => {
        const viaAlias = classifyCrewmateViewSubmission(`/${a}`, false, roster)
        return !((viaAlias.kind === 'session-command' || viaAlias.kind === 'agent-command') && viaAlias.command.name === c.name)
      }),
    )
  t.check('every roster alias resolves to its owner command', aliasDrift.length === 0, aliasDrift.join(','), 'the listed aliases must classify to their owner command in classifyAgentViewSubmission, src/screen/composer/promptIntent.ts')
}

t.section('§2 unknown / literal / guidance laws')
{
  const commands = [...builtinCommands()]
  const unknown = classifyCrewmateViewSubmission('/frobnicate', false, commands)
  t.check(
    'unknown slash input classifies unknown-command (never guidance)',
    unknown.kind === 'unknown-command' && unknown.bareName === 'frobnicate',
    unknown.kind,
    'classifyAgentViewSubmission in src/screen/composer/promptIntent.ts must return unknown-command with bareName for a slash name outside the roster',
  )
  const unknownArgs = classifyCrewmateViewSubmission('/frobnicate now please', false, commands)
  t.check(
    'unknown slash with args keeps the bare name',
    unknownArgs.kind === 'unknown-command' && unknownArgs.bareName === 'frobnicate',
    unknownArgs.kind,
    'classifyAgentViewSubmission in src/screen/composer/promptIntent.ts must keep bareName when an unknown slash name has arguments',
  )
  const literal = classifyCrewmateViewSubmission('//health check this', false, commands)
  t.check(
    "'//x …' is the literal-send path delivering '/x …'",
    literal.kind === 'agent-literal' && literal.text === '/health check this',
    JSON.stringify(literal),
    'classifyAgentViewSubmission in src/screen/composer/promptIntent.ts must turn a leading // into agent-literal with one slash removed',
  )
  const guidance = classifyCrewmateViewSubmission('please fix the tests', false, commands)
  t.check('plain text is agent guidance', guidance.kind === 'agent-guidance', guidance.kind, 'classifyAgentViewSubmission in src/screen/composer/promptIntent.ts must return agent-guidance for text that does not start with a slash')
}

t.section('§3 journey: agent view routes commands locally, guidance to the agent')
{
  const ESC = String.fromCharCode(27)
  const sgrClick = (col: number, row: number): string =>
    `${ESC}[<0;${col};${row}M${ESC}[<0;${col};${row}m`
  const CHILD_RAIL_ROW = 'poise probe · runni…'
  const CARD_KEYS = 'x x stop · p pause'

  const turns: ScriptedTurn[] = [
    {
      kind: 'tool_use',
      name: 'Crewmate',
      input: {
        description: 'poise probe',
        prompt: 'Count to three slowly.',
        crewmate_type: 'mercury-crew',
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
      '7400:spawn the probe\\r',
      `after:${CHILD_RAIL_ROW}:1000:${sgrClick(10, 4)}`,
      `after:${CARD_KEYS}:2000:${sgrClick(10, 3)}`,
      `after:${CARD_KEYS}:4600:/frobnicate\\r`,
      'after:/frobnicate:2400:/vim\\r',
    ],
    seconds: 40,
    cols: 120,
    rows: 40,
    keep: true,
  })
  t.check(
    'every send became due (each witness painted; the send log carries the 5 after the face ↵, which it files as the arena\'s own)',
    run.sendLog.length === 5 && !run.driverOut.includes('UNFIRED-SENDS'),
    `${run.sendLog.length}/5 · ${run.driverOut.split('\n').filter(l => l.includes('UNFIRED')).join(' ').slice(0, 300)}`,
    'a witness text the sends wait for never painted; read the forensic frames in the run drive file (run.paths.drive) to see which send stalled',
  )

  const offsets: string[] = []
  for (let ms = S(5000); ms <= S(34000); ms += S(250)) offsets.push(String(anchoredOffset(run, ms)))
  const grab = spawnSync(
    '/usr/bin/python3',
    [SCREENGRAB, run.paths.drive, '120', '40', ...offsets, '-1'],
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  )
  if (grab.status !== 0) {
    t.check('screengrab ran', false, grab.stderr, 'scripts/streaming/screengrab.py exited non-zero; run it by hand on the run drive file with /usr/bin/python3 and read its stderr above')
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
            `${has(f, /❯ message poise probe/) ? ' VIEW' : ''}`,
        )
        .join(' ↵ ')
    const crewRow = (f: Fr): boolean => f.rows.some(r => r.includes(CHILD_RAIL_ROW))
    const inView = (f: Fr): boolean => has(f, /❯ message poise probe/)
    const iCrew = idxOf(0, crewRow)
    t.check(
      `the hosted agent lists in the CREW lane (the runner's roster over the connector) — its row reads "${CHILD_RAIL_ROW}", the .34 rail keeping the name whole and cutting the verb (137a2c1214)`,
      iCrew >= 0,
      iCrew >= 0 ? undefined : forensics(frames.findIndex(f => f.rows.some(r => r.includes('poise probe')))),
      'the Crewmate tool call must list the hosted agent in the CREW lane of the rail; the frames above show what the rail painted instead',
    )
    const iView = idxOf(iCrew + 1, f => inView(f) && has(f, 'sends to poise probe'))
    t.check(
      "one click on its CREW row opens the agent in the view (its transcript lives with the runner; ↵ addresses it)",
      iCrew >= 0 && iView > iCrew,
      iView > iCrew ? undefined : forensics(iCrew),
      'a click on the agent CREW row must open the agent view with the sends to poise probe line; the frames above show what painted after the click',
    )
    const iClosed = idxOf(iView + 1, f => !inView(f) && has(f, /›\s*✶ Mercury Lead/) && crewRow(f))
    t.check(
      `Mercury Lead in the rail goes back: the lead owns the view again and the agent keeps running (return ≠ stop; its row still reads "${CHILD_RAIL_ROW}")`,
      iView >= 0 && iClosed > iView,
      iClosed > iView ? undefined : forensics(iView),
      'a click on Mercury Lead in the rail must close the agent view and keep the agent row listed; the frames above show what painted after the click',
    )
    const iNotify = idxOf(iClosed + 1, f => has(f, /Unknown command: \/frobnicate/))
    t.check(
      "an unknown /name answers the screen's own sentence (never the runner's)",
      iClosed >= 0 && iNotify > iClosed,
      iNotify > iClosed ? undefined : forensics(iClosed),
      'typing /frobnicate must paint the screen sentence Unknown command: /frobnicate (the unknown-command path of classifyAgentViewSubmission in src/screen/composer/promptIntent.ts); the frames above show what painted',
    )

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
    t.check('no /frobnicate in any model call', !userTextIncludes('/frobnicate'), undefined, 'an unknown slash command was sent to the model as user text; classifyAgentViewSubmission in src/screen/composer/promptIntent.ts must keep it local')
    t.check('no /vim in any model call', !userTextIncludes('/vim'), undefined, 'a slash command was sent to the model as user text; classifyAgentViewSubmission in src/screen/composer/promptIntent.ts must route it as a command, not as guidance')

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
