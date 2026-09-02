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
const { runPulseArena, anchoredOffset, restoreOffsets } = await import('../pulse/lib/pulseArena.ts')
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
  const BACKSPACES = String.fromCharCode(127).repeat(11)
  const sgrClick = (col: number, row: number): string =>
    `${ESC}[<0;${col};${row}M${ESC}[<0;${col};${row}m`

  const turns: ScriptedTurn[] = [
    {
      kind: 'tool_use',
      name: 'Agent',
      input: {
        description: 'poise probe',
        prompt: 'Count to three slowly.',
        subagent_type: 'general-purpose',
        run_in_background: true,
      },
      preText: 'Spawning the probe agent.',
    },
    {
      kind: 'paced',
      deltas: Array.from({ length: 30 }, (_, i) => `count ${i + 1}. `),
      gapMs: 900,
    },
    { kind: 'text', text: 'Probe launched.' },
    { kind: 'text', text: 'Acknowledged.' },
    { kind: 'text', text: 'Settled.' },
    { kind: 'text', text: 'Complete.' },
    { kind: 'text', text: 'Spare.' },
  ]

  const run = await runPulseArena({
    turns,
    sends: [
      'after:↑↓ choose:900:\\r',
      '7400:spawn the probe\\r',
      `11000:${sgrClick(10, 7)}`,
      `11700:${sgrClick(10, 7)}`,
      '14200:/frobnicate\\r',
      `16800:${BACKSPACES}`,
      `19200:${ESC}[D`,
      `21800:${ESC}`,
      `23200:x`,
      `23700:${String.fromCharCode(127)}`,
      '24600://echo hi',
      '25600:\\r',
      '27400:/cost\\r',
      `29800:${ESC}`,
      `32000:${ESC}[D`,
    ],
    seconds: 40,
    cols: 120,
    rows: 40,
    keep: true,
  })

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

    const iDrill = idxOf(0, f => has(f, 'viewing'))
    t.check('the two-click drill entered the agent view', iDrill >= 0)
    const iNotify = idxOf(iDrill + 1, f => has(f, /Unknown command: \/frobnicate/))
    t.check(
      'unknown command notifies honestly in the agent view',
      iDrill >= 0 && iNotify > iDrill,
    )
    const iDraft = idxOf(iNotify, f => composerOf(f).includes('/frobnicate'))
    t.check(
      'the unknown-command draft is PRESERVED in the composer',
      iNotify >= 0 && iDraft >= iNotify,
    )
    t.check(
      'the unknown command NEVER paints as an agent transcript row',
      frames.every(f => !f.rows.some(r => /\[[^\]]+\] ❯ .*\/frobnicate/.test(r))),
    )
    const iCleared = idxOf(iDraft + 1, f => !composerOf(f).includes('/frobnicate'))
    t.check(
      'the backspaces clear the preserved draft before the arrow',
      iDraft >= 0 && iCleared > iDraft,
    )
    const iManager = idxOf(iCleared + 1, f => has(f, 'Mercury — surfaces'))
    t.check(
      'agent-view ← opens the manager panel (not agent text)',
      iCleared >= 0 && iManager > iCleared,
    )
    const iClosed = idxOf(iManager + 1, f => !has(f, 'Mercury — surfaces'))
    t.check(
      'esc closes the agent-view manager before the literal-send',
      iManager >= 0 && iClosed > iManager,
    )
    const literalIdx = frames
      .map((f, i) => ({ f, i }))
      .filter(({ f, i }) => i > iClosed && f.rows.some(r => /\[[^\]]+\] ❯ \/echo hi(\s|$)/.test(r)))
    const literalForensics = (): string =>
      frames
        .map((f, i) => ({ f, i }))
        .filter(({ i }) => i > iClosed)
        .slice(0, 24)
        .map(
          ({ f }) =>
            `@${f.atMs} composer=${JSON.stringify(composerOf(f).slice(0, 40))}` +
            `${has(f, 'Mercury — surfaces') ? ' MGR' : ''}` +
            `${has(f, /Main ‹ @poise probe/) ? ' CRUMB' : ''}` +
            `${f.rows.some(r => /echo hi/.test(r)) ? ' ECHOROW' : ''}`,
        )
        .join(' ↵ ')
    t.check(
      "the literal-send '//echo hi' paints as a '/echo hi' agent row",
      iClosed >= 0 && literalIdx.length > 0,
      literalIdx.length ? undefined : literalForensics(),
    )
    t.check(
      'the literal row lives in the agent view (breadcrumb present in the same frame)',
      literalIdx.some(({ f }) => has(f, /Main ‹ @poise probe/)),
      literalIdx.length ? undefined : '(no literal frames — see the previous check)',
    )
    t.check(
      "no transcript row ever shows the raw '//echo hi'",
      frames.every(f => !f.rows.some(r => /\[[^\]]+\] ❯ .*\/\/echo hi/.test(r))),
    )
    t.check(
      'the session command (/cost) never paints as an agent row',
      frames.every(f => !f.rows.some(r => /\[[^\]]+\] ❯ .*\/cost/.test(r))),
    )
    const iLastLiteral = literalIdx.length ? literalIdx[literalIdx.length - 1]!.i : -1
    const iReturn = idxOf(iLastLiteral + 1, f =>
      !has(f, /Main ‹/) && f.rows.some(r => r.includes('poise pro') && r.includes('running')),
    )
    t.check(
      'esc returns to main while the agent keeps running (return ≠ stop)',
      iLastLiteral >= 0 && iReturn > iLastLiteral,
    )
    t.check(
      'main-view ← opens the manager (same classified funnel)',
      iReturn >= 0 && idxOf(iReturn + 1, f => has(f, 'Mercury — surfaces')) > iReturn,
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
    t.check('no /frobnicate in any model call', !userTextIncludes('/frobnicate'))
    t.check('no /manager in any model call', !userTextIncludes('/manager'))
    t.check('no /cost in any model call', !userTextIncludes('/cost'))

    const { mkdirSync, writeFileSync } = await import('node:fs')
    const receiptDir = join(HERE, 'receipts', '.last')
    mkdirSync(receiptDir, { recursive: true })
    const maskAmbient = (r: string): string =>
      r
        .replace(/\b\d{2}:\d{2}:\d{2}\b/g, 'HH:MM:SS')
        .replace(/pulse-arena-cwd-\w+/g, 'pulse-arena-cwd-XXXXXX')
    writeFileSync(
      join(receiptDir, 'intent-routing-journey.txt'),
      screens
        .map(
          s =>
            `════ screen @${s.atMs}ms ════\n` +
            s.rows.filter(r => r.trim() !== '').map(maskAmbient).join('\n'),
        )
        .join('\n\n'),
    )
  }
  run.cleanup()
}

t.finish('prove-command-intent-routing')
