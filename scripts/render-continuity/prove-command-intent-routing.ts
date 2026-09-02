#!/usr/bin/env bun
// ============================================================================
//  scripts/render-continuity/prove-command-intent-routing.ts — PO-2: intent is
//  classified before destination; typed and synthetic actions cannot cross
//  into an agent conversation.
//
//  §1 MATRIX — generated from the LIVE registry (src/commands.ts COMMANDS())
//     through the ONE production classifier (promptIntent.ts): every command
//     name and alias, typed or keybinding-manufactured, classifies to its
//     registry-declared scope ('session' default) — never to guidance, never
//     to unknown. No hand-maintained allowlist.
//  §2 LAWS — unknown slash input reports honestly; '//x' is the literal-send
//     path; plain text is guidance.
//  §3 JOURNEY — packaged dist, real PTY, the hosted world: every chat is a
//     daemon-hosted session whose runner executes the model's tools, so a
//     background agent lives in the runner's roster and reaches the screen
//     over the connector. The CREW lane lists it; the two-click drill opens
//     its work card (the roster card); esc returns without stopping it; an
//     unknown /name answers the screen's own sentence; ← opens the surface
//     index; a session command never becomes a user turn; and none of the
//     command text reaches any model call.
//     DEFERRED, named here and not asserted — the five agent-VIEW legs: an
//     unknown command notifying INSIDE the agent view, its draft preserved
//     in the composer, the backspaces clearing that draft, agent-view ←
//     opening the surface index, and the '//x' literal painting as ONE
//     agent row inside the view. They are pending a hosted agent view: the
//     runner streams an agent's transcript to the cockpit and accepts
//     guidance for it — scheduled for the post-release window. The
//     classifier laws those legs exercised stay pinned in §2.
// ============================================================================
import { spawnSync } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { vshotBudgetMs as S } from '../lib/captureDriver.ts'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

// HERMETIC config world (ambient-state law): isEnabled() gates read config,
// so the matrix pins an empty scratch MERCURY_CONFIG_DIR — never the
// operator's lived-in home — and arms config reading explicitly.
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

// ── §1 the registry×context matrix ──────────────────────────────────────────
t.section('§1 generated registry matrix: every command classifies to its declared scope')
{
  // The WORLD-AWARE enablement filter (src/commands.ts re-exports
  // commands/enablement.js) — the same one production and the classifier
  // consume. The raw types/command.ts isCommandEnabled predates the
  // retirement layer: it passed the retired multiplayer doors (/party,
  // /multiplayer, /rooms) into this roster while the classifier lawfully
  // refused them — six phantom misroutes plus a phantom alias drift on
  // run 2, none of them a product defect.
  const { isCommandEnabled } = await import('../../src/commands.ts')
  const safeEnabled = (c: { isEnabled?: () => boolean }): boolean => {
    try {
      return isCommandEnabled(c as never)
    } catch {
      return false
    }
  }
  // Production feeds PromptInput the FILTERED roster; the matrix classifies
  // against the same world.
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
  // Aliases of roster commands resolve to their owner.
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

// ── §2 classification laws ──────────────────────────────────────────────────
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

// ── §3 the packaged PTY journey ─────────────────────────────────────────────
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
      // State-transition gaps are ≥2.4s: the hosted runner renders slower
      // than the dev machine, and a keystroke fired while the previous
      // surface still owns the keyboard is swallowed (the manager-close →
      // literal-send race that went red on the first hosted dispatch).
      'after:↑↓ choose:900:\\r',
      '7400:spawn the probe\\r',
      // Row 7: the hosted agent's CREW row (row 6 is the permanent CREW
      // root). Rail rows select on the first click and activate on the
      // second (the InteractiveRow kernel): the agent's work card opens.
      `11000:${sgrClick(10, 7)}`,
      `11700:${sgrClick(10, 7)}`,
      `14200:${ESC}`, // close the card — return ≠ stop
      '16800:/frobnicate\\r', // an unknown name: the screen's own sentence
      `19200:${ESC}[D`, // main-view ← on the empty composer: the surface index
      `21800:${ESC}`, // close it
      // Primer keypress absorbs a possible first-press-after-close swallow
      // (type one char, erase it — identical composer either way).
      `23200:x`,
      `23700:${String.fromCharCode(127)}`,
      '24600:/cost\\r', // a session command routes to the session, never the agent
    ],
    seconds: 40,
    cols: 120,
    rows: 40,
    keep: true,
  })

  // Dense ladder + ORDERED content predicates: the drive clock and the send
  // schedule have different zeros (boot lag varies per machine — 0.6s dev,
  // 2-3s hosted runner), so no drive-time window can name a send reliably.
  // Every assertion below finds its fact as a SEQUENCE step instead.
  const offsets: string[] = []
  for (let ms = S(5000); ms <= S(34000); ms += S(250)) offsets.push(String(anchoredOffset(run, ms)))
  const grab = spawnSync(
    '/usr/bin/python3',
    [SCREENGRAB, run.paths.drive, '120', '40', ...offsets, '-1'],
    // 64 MiB: ~90 attributed frames overflow spawnSync's 1 MiB default and
    // kill the child with an EMPTY stderr (the r1/r2 'screengrab ran' red).
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

    // The nameplate HANDLE is ambient (os user / git identity on a dev box,
    // 'runner' hosted): every user-row predicate anchors to the row SHAPE
    // `[handle] ❯`, never the handle (the ambient-state law).
    // Failure-time forensics: a boolean-only red hides what the rail and
    // the composer HELD — dump a window of frames from a step so a red
    // names the rail's top rows, the surface owning the frame, the composer.
    const forensics = (from: number): string =>
      frames
        .slice(Math.max(0, from), Math.max(0, from) + 20)
        .map(
          f =>
            `@${f.atMs} rail=${JSON.stringify(f.rows.slice(1, 8).map(r => r.slice(0, 24).trim()).filter(Boolean).join(' | '))}` +
            ` composer=${JSON.stringify(composerOf(f).slice(0, 32))}` +
            `${has(f, 'Mercury — surfaces') ? ' MGR' : ''}` +
            `${has(f, /agent › poise probe/) ? ' CARD' : ''}`,
        )
        .join(' ↵ ')
    const crewRow = (f: Fr): boolean => f.rows.some(r => /poise probe\s+running/.test(r))
    const iCrew = idxOf(0, crewRow)
    t.check(
      "the hosted agent lists in the CREW lane (the runner's roster over the connector)",
      iCrew >= 0,
      iCrew >= 0 ? undefined : forensics(frames.findIndex(f => f.rows.some(r => r.includes('poise probe')))),
    )
    const iCard = idxOf(iCrew + 1, f => has(f, /agent › poise probe/))
    t.check(
      "the two-click drill opened the agent's work card (the roster card — its transcript lives with the runner)",
      iCrew >= 0 && iCard > iCrew,
      iCard > iCrew ? undefined : forensics(iCrew),
    )
    const iClosed = idxOf(iCard + 1, f => !has(f, /agent › poise probe/) && crewRow(f))
    t.check(
      'esc closed the card and the agent keeps running (return ≠ stop)',
      iCard >= 0 && iClosed > iCard,
      iClosed > iCard ? undefined : forensics(iCard),
    )
    const iNotify = idxOf(iClosed + 1, f => has(f, /Unknown command: \/frobnicate/))
    t.check(
      "an unknown /name answers the screen's own sentence (never the runner's)",
      iClosed >= 0 && iNotify > iClosed,
      iNotify > iClosed ? undefined : forensics(iClosed),
    )
    t.check(
      'the unknown command NEVER paints as a user transcript row',
      frames.every(f => !f.rows.some(r => /\[[^\]]+\] ❯ .*\/frobnicate/.test(r))),
    )
    const iManager = idxOf(iNotify + 1, f => has(f, 'Mercury — surfaces'))
    t.check(
      'main-view ← opens the surface index (the classified funnel, never words)',
      iNotify >= 0 && iManager > iNotify,
      iManager > iNotify ? undefined : forensics(iNotify),
    )
    const iMgrClosed = idxOf(iManager + 1, f => !has(f, 'Mercury — surfaces'))
    t.check('esc closes the surface index', iManager >= 0 && iMgrClosed > iManager)
    t.check(
      'the session command (/cost) never paints as a user row',
      frames.every(f => !f.rows.some(r => /\[[^\]]+\] ❯ .*\/cost/.test(r))),
    )

    type Msg = { role: string; content: unknown }
    const bodies = run.fixture.requests
      .map(r => r.body as { messages?: Msg[] } | null)
      .filter((b): b is { messages: Msg[] } => Boolean(b?.messages))
    // A hit counts only OUTSIDE a local-command transcript record — a
    // locally-executed command's caveated record riding later context is the
    // lawful main-view shape, not delivery-as-prompt.
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

    // Retain the journey frames beside the repro receipts (visual evidence).
    // Ambient VALUES are masked, but frame CONTENT is load-sensitive (the
    // same offset catches a different phase under pool co-load), so a
    // tracked per-run rewrite can never be byte-stable — it re-dirtied the
    // tree on every pool run and deploy-on-green refuses dirty trees. The
    // per-run copy therefore lands in the IGNORED .last/ dir; the committed
    // receipts/intent-routing-journey.txt is the frozen evidence.
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
