#!/usr/bin/env bun
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const home = mkdtempSync(join(tmpdir(), 'companion-voice-'))
process.env.MERCURY_CONFIG_DIR = home
process.env.MERCURY_DECK_COMPANION = '1'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '0.0.0' }

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log(`\n── ${t} ──`)
}

const { enableConfigs } = await import('../../src/utils/config.ts')
enableConfigs()
const words = await import('../../src/utils/cockpit/companionWords.ts')
const voice = await import('../../src/utils/cockpit/companionVoice.ts')
const { DEFAULT_BINDINGS } = await import('../../src/keybindings/defaultBindings.ts')
const { builtinCommands, isCommandEnabled } = await import('../../src/commands.ts')
const { keyHintLabel } = await import('../../src/components/mercury-ui/keyHintLabel.ts')

type Area = import('../../src/utils/cockpit/companionVoice.ts').TipArea
type Stage = 1 | 2 | 3

const EXPECTED: ReadonlyArray<[string, Area, Stage, string, string | undefined]> = [
  ['keys.esc', 'keys', 1, 'Esc interrupts the turn, not its agents.', undefined],
  ['keys.mode', 'keys', 1, 'shift+tab cycles the permission mode.', undefined],
  ['context.meter', 'context', 1, 'The ctx meter is how full the window is.', undefined],
  ['context.compact', 'context', 1, '/compact folds old turns into a summary.', 'compact'],
  ['sessions.switch', 'sessions', 1, '/sessions switches sessions in place.', 'sessions'],
  ['agents.delegate', 'agents', 1, 'Delegate side work: ask for an agent.', undefined],
  ['keys.help', 'keys', 1, '/help lists every command and shortcut.', 'help'],
  ['keys.shortcuts', 'keys', 1, '? on an empty prompt shows shortcuts.', undefined],
  ['context.auto', 'context', 2, 'A full meter compacts on its own.', undefined],
  ['context.steer', 'context', 2, 'Words after /compact steer its summary.', 'compact'],
  ['context.clear', 'context', 2, '/clear starts fresh, freeing the window.', 'clear'],
  ['context.draw', 'context', 2, '/context draws what fills the window.', 'context'],
  ['models.switch', 'models', 2, '/model switches the model mid-session.', 'model'],
  ['models.effort', 'models', 2, '/effort sets how hard the model thinks.', 'effort'],
  ['models.range', 'models', 2, 'Low effort is fastest; high is thorough.', undefined],
  ['models.logins', 'models', 2, '/logins signs in another provider.', 'logins'],
  ['models.usage', 'models', 2, '/usage shows what each account has left.', 'usage'],
  ['sessions.resume', 'sessions', 2, '/resume reopens any earlier session.', 'resume'],
  ['sessions.flip', 'sessions', 2, `Empty prompt: ${keyHintLabel('⌥←→')} flips sessions.`, undefined],
  ['sessions.switcher', 'sessions', 2, 'ctrl+x s opens the session switcher.', undefined],
  ['sessions.rename', 'sessions', 2, '/rename names this session for later.', 'rename'],
  ['sessions.rewind', 'sessions', 2, '/rewind goes back to a saved point.', 'rewind'],
  ['sessions.recap', 'sessions', 2, 'Resumed sessions greet you with a recap.', undefined],
  ['look.appearance', 'sessions', 2, '/appearance picks theme, accent, motion.', 'appearance'],
  ['keys.palette', 'keys', 2, 'ctrl+x p opens the command palette.', undefined],
  ['keys.history', 'keys', 2, 'ctrl+r searches your prompt history.', undefined],
  ['keys.pager', 'keys', 2, 'ctrl+o opens the transcript pager.', undefined],
  ['keys.file', 'keys', 2, 'ctrl+x f opens a file by path.', undefined],
  ['keys.grep', 'keys', 2, 'ctrl+x g searches file contents.', undefined],
  ['keys.background', 'keys', 2, 'ctrl+b backgrounds a running task.', undefined],
  ['keys.surfaces', 'keys', 2, 'ctrl+x m lists every surface, grouped.', undefined],
  ['keys.keys', 'keys', 2, '/keys shows every key in effect.', 'keys'],
  ['mcp.permissions', 'mcp', 2, '/permissions: what runs free, what asks.', 'permissions'],
  ['mcp.list', 'mcp', 2, '/mcp lists servers and toggles each.', 'mcp'],
  ['mcp.kill', 'mcp', 2, '/kill turns a tool off for this session.', 'kill'],
  ['minerva.note', 'minerva', 2, 'Type /note to keep a thought for later.', 'note'],
  ['context.window', 'context', 3, '/auto-compact-window sets the fold size.', 'auto-compact-window'],
  ['models.cap', 'models', 3, 'Unserved effort runs the nearest level.', undefined],
  ['models.submodels', 'models', 3, '/submodels seats Minerva and Console.', 'submodels'],
  ['mcp.extensions', 'mcp', 3, '/extensions installs from added sources.', 'extensions'],
  ['agents.workflows', 'agents', 3, '/workflows shows runs, live and past.', 'workflows'],
  ['agents.teammates', 'agents', 3, '/teammates shows the crew, live.', 'teammates'],
  ['agents.build', 'agents', 3, '/agents lets you build your own agents.', 'agents'],
  ['agents.fleet', 'agents', 3, '/fleet is the command-center for agents.', 'fleet'],
  ['agents.run', 'agents', 3, "/run inspects the live run's evidence.", 'run'],
  ['worktrees.ask', 'worktrees', 3, 'Ask for a worktree to keep main clean.', undefined],
  ['worktrees.done', 'worktrees', 3, 'Done in a worktree? Keep it or drop it.', undefined],
  ['worktrees.realms', 'worktrees', 3, '/realms lists the folders you trust.', 'realms'],
  ['worktrees.orient', 'worktrees', 3, '/orient maps a new repo in one read.', 'orient'],
  ['worktrees.branch', 'worktrees', 3, '/branch asks a side question, no derail.', 'branch'],
  ['minerva.tabula', 'minerva', 3, '/tabula asks Minerva to refine a prompt.', 'tabula'],
  ['minerva.tidy', 'minerva', 3, '/minerva turns your words into notes.', 'minerva'],
  ['minerva.free', 'minerva', 3, 'Minerva bills one call per line sent.', undefined],
  ['minerva.outlive', 'minerva', 3, 'Notes outlive /clear: they live on disk.', 'note'],
]

function chordsSpelled(line: string): string[] {
  const out: string[] = []
  for (const m of line.matchAll(/\b((?:ctrl|shift|alt|meta|opt|cmd|super)\+[a-z0-9_]+(?: (?=[a-z]\b)[a-z])?)/gi)) {
    out.push(m[1]!.toLowerCase().replace(/^opt\+/, 'meta+'))
  }
  if (/\besc\b/i.test(line)) out.push('escape')
  if (line.includes('⌥←→') || line.includes('alt+←→')) out.push('meta+left', 'meta+right')
  return out
}

section('§1 the words — the curriculum bank')
{
  const bank = words.tipBank()
  const all = words.everyCompanionLine()
  const wide = all.filter(l => Bun.stringWidth(l) > words.MAX_LINE_CELLS)
  check(`every line is ≤ ${words.MAX_LINE_CELLS} cells (${all.length} lines)`, wide.length === 0, wide.join(' | '))
  const everyPlatform = ['macos', 'windows', 'wsl', 'linux', 'unknown'] as const
  const wideAnywhere = all.flatMap(l =>
    everyPlatform.map(p => ({ l, p, w: Bun.stringWidth(keyHintLabel(l, p)) })).filter(x => x.w > words.MAX_LINE_CELLS),
  )
  check(
    `every line fits the cap in EVERY host spelling (${all.length} lines × ${everyPlatform.length} platforms)`,
    wideAnywhere.length === 0,
    wideAnywhere.map(x => `${x.p}:${x.w}:${x.l}`).join(' | '),
  )
  check('no exclamation marks', all.every(l => !l.includes('!')))
  check('no ellipsis flourish', all.every(l => !l.includes('…') && !l.includes('...')))
  const emojiRe = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}]/u
  check('no emoji', all.every(l => !emojiRe.test(l)))
  const rhetorical = bank.map(t => t.text).filter(l => l.includes('?') && !(l.startsWith('?') || / or /.test(l.slice(l.indexOf('?')))))
  check('no rhetorical questions among the tips', rhetorical.length === 0, rhetorical.join(' | '))

  check(`the bank holds ${EXPECTED.length} tips`, bank.length === EXPECTED.length, String(bank.length))
  for (const [i, [id, area, stage, text, surface]] of EXPECTED.entries()) {
    const tip = bank[i]
    const same = tip !== undefined && tip.id === id && tip.area === area && tip.stage === stage && tip.text === text && tip.surface === surface
    check(`#${i + 1} ${id} — ${text}`, same, tip === undefined ? 'absent' : `${tip.id} · ${tip.area} · ${tip.stage} · ${tip.text} · ${String(tip.surface)}`)
  }
  check(
    'each moment has 8 lines',
    (['settled-long', 'holding', 'failure', 'silence'] as const).every(m => words.MOMENT_LINES[m].length === 8),
  )
  const ids = new Set(bank.map(t => t.id))
  check('every tip id is unique', ids.size === bank.length)
  const areas = new Set(bank.map(t => t.area))
  check(
    'every area of the ruling has tips (minerva · context · models · mcp · sessions · keys · agents · worktrees)',
    ['minerva', 'context', 'models', 'mcp', 'sessions', 'keys', 'agents', 'worktrees'].every(a => areas.has(a as never)),
  )
  check(
    "the operator's two lines stand verbatim",
    all.includes('Done in a worktree? Keep it or drop it.') && all.includes('/branch asks a side question, no derail.'),
  )

  check('every stage of the curriculum has tips', ([1, 2, 3] as const).every(s => bank.some(t => t.stage === s)))
  check(
    'the file reads in stage order (the bank IS the curriculum)',
    bank.every((t, i) => i === 0 || t.stage >= bank[i - 1]!.stage),
  )
  const firstSession = ['keys.esc', 'keys.mode', 'context.meter', 'sessions.switch', 'agents.delegate']
  check(
    "stage 1 carries the first session's facts (stop a turn · the mode · the meter · switch a session · delegate)",
    firstSession.every(id => bank.find(t => t.id === id)?.stage === 1),
  )
  check(
    'no tip repeats another surface-and-teaching pair (one /clear, one /submodels, one /mcp)',
    ['clear', 'submodels', 'mcp'].every(s => bank.filter(t => t.surface === s).length === 1),
  )

  const roster = new Set<string>()
  type Listed = ReturnType<typeof builtinCommands>[number]
  const byName = new Map<string, Listed[]>()
  for (const cmd of builtinCommands()) {
    if (cmd.isHidden === true || cmd.retired !== undefined) continue
    roster.add(cmd.name)
    byName.set(cmd.name, [...(byName.get(cmd.name) ?? []), cmd])
    for (const alias of cmd.aliases ?? []) roster.add(alias)
  }
  check(`the roster read is real (${roster.size} listed names)`, roster.size >= 80, String(roster.size))
  const named = new Set<string>()
  for (const l of all) for (const m of l.matchAll(/\/([a-z][a-z0-9-]*)/g)) named.add(m[1]!)
  const unknown = [...named].filter(n => !roster.has(n))
  check(`every /command the bank names is a listed command (${named.size} named)`, unknown.length === 0, unknown.join(', '))
  const surfaces = bank.map(t => t.surface).filter((s): s is string => s !== undefined)
  const unknownSurfaces = surfaces.filter(s => !roster.has(s))
  check('every tip surface is a listed command', unknownSurfaces.length === 0, unknownSurfaces.join(', '))
  const offUngated = bank.filter(t => {
    if (t.surface === undefined || t.when !== undefined) return false
    const members = byName.get(t.surface)
    if (members === undefined) return true
    try {
      return !members.some(cmd => isCommandEnabled(cmd))
    } catch {
      return false
    }
  })
  check('every ungated tip surface is enabled in the default world', offUngated.length === 0, offUngated.map(t => t.id).join(', '))
  check(
    'the gated tips carry the gate their surface reads (the notepad, the fleet, the repo map)',
    ['minerva.note', 'minerva.tabula', 'minerva.tidy', 'minerva.free', 'minerva.outlive', 'agents.fleet', 'agents.workflows', 'agents.teammates', 'worktrees.orient'].every(
      id => typeof bank.find(t => t.id === id)?.when === 'function',
    ),
  )

  const bound = new Set<string>()
  for (const block of DEFAULT_BINDINGS) for (const key of Object.keys(block.bindings)) bound.add(key.toLowerCase())
  const spelled = bank.flatMap(t => chordsSpelled(t.text).map(c => ({ id: t.id, c })))
  check(`the bank spells chords (${spelled.length} spelled)`, spelled.length >= 10, String(spelled.length))
  const unbound = spelled.filter(x => !bound.has(x.c))
  check('every chord a tip spells is a binding in the shipped table', unbound.length === 0, unbound.map(x => `${x.id}:${x.c}`).join(', '))
  check('the chord parser reads the ctrl+x family whole and never eats the next word', chordsSpelled('ctrl+x s opens it; ctrl+r searches').join(',') === 'ctrl+x s,ctrl+r')
}

section('§2 the voice law')
{
  const T0 = 1_800_000_000_000
  const s = voice.freshVoiceState()
  check('a fresh voice may speak a long settle', voice.maySpeak(s, 'settled-long', T0))
  voice.noteSpoken(s, 'settled-long', 'a', T0)
  voice.noteSettle(s, true)
  check('a settle right after a spoken settle is silent (consecutive rule)', !voice.maySpeak(s, 'settled-long', T0 + voice.VOICE_COOLDOWN_MS + 1))
  voice.noteSettle(s, false)
  check('after a silent settle the next long settle may speak once the cooldown passed', voice.maySpeak(s, 'settled-long', T0 + voice.VOICE_COOLDOWN_MS + 1))
  check('inside the cooldown a silence line waits', !voice.maySpeak(s, 'silence', T0 + 30_000))
  check('inside the cooldown a hold may interrupt', voice.maySpeak(s, 'holding', T0 + 30_000))
  voice.noteSpoken(s, 'holding', 'h', T0 + 30_000)
  check('a failure cannot stack on a hold within the interrupt gap', !voice.maySpeak(s, 'failure', T0 + 30_000 + 10_000))
  check('a failure may follow a hold after the interrupt gap', voice.maySpeak(s, 'failure', T0 + 30_000 + voice.INTERRUPT_GAP_MS + 1))

  const pool = ['one', 'two', 'three', 'four']
  const d1 = voice.createDeck('seed-A')
  const d2 = voice.createDeck('seed-A')
  const seq1 = Array.from({ length: 12 }, () => d1.draw(pool, []))
  const seq2 = Array.from({ length: 12 }, () => d2.draw(pool, []))
  check('the same seed draws the same sequence', seq1.join(',') === seq2.join(','))
  check('every card of the pool is drawn in the first pass', new Set(seq1.slice(0, 4)).size === 4)
  check('no card repeats back-to-back across a reshuffle', seq1.every((c, i) => i === 0 || c !== seq1[i - 1]))
  const d3 = voice.createDeck('seed-B')
  const seq3 = Array.from({ length: 12 }, () => d3.draw(pool, []))
  check('a different seed draws a different order', seq1.join(',') !== seq3.join(','))
  check('an avoided card is never drawn', Array.from({ length: 20 }, () => d3.draw(pool, ['one'])).every(c => c !== 'one'))
  check('a pool whose every card is avoided draws nothing (honest silence)', d3.draw(['only'], ['only']) === null)
  const v = voice.freshVoiceState()
  const lineA = voice.chooseLine(voice.createDeck('x'), v, 'holding', words.MOMENT_LINES.holding)
  check('chooseLine draws from the moment pool', lineA !== null && words.MOMENT_LINES.holding.includes(lineA))

  const boot = T0
  const tv = voice.freshVoiceState()
  check('no tip inside the boot quiet', !voice.mayTip(tv, boot + voice.TIP_BOOT_QUIET_MS - 1, boot))
  check('a tip after the boot quiet', voice.mayTip(tv, boot + voice.TIP_BOOT_QUIET_MS, boot))
  voice.noteTip(tv, 'tip', boot + voice.TIP_BOOT_QUIET_MS)
  check('no second tip inside the tip cooldown', !voice.mayTip(tv, boot + voice.TIP_BOOT_QUIET_MS + voice.TIP_COOLDOWN_MS - 1, boot))
  check('a tip again after the tip cooldown', voice.mayTip(tv, boot + voice.TIP_BOOT_QUIET_MS + voice.TIP_COOLDOWN_MS, boot))
  const bank = words.tipBank()
  const tipDeck = voice.createDeck('tips')
  const none = new Set<string>()
  const pick = (seen: Record<string, number>, opened: ReadonlySet<string>, contextPct = 10, allowSeen = false) =>
    voice.pickTip(tipDeck, voice.freshVoiceState(), bank, seen, { contextPct, openedSurfaces: opened }, T0, allowSeen)
  const ctxTip = pick({}, none, 75)
  check('a full context meter prefers a context tip, whatever its stage', ctxTip?.area === 'context', ctxTip?.id)

  const first = pick({}, none)
  check('a fresh profile is taught a stage-1 tip first', first?.stage === 1, first?.id)
  const seenStage1: Record<string, number> = {}
  for (const t of bank) if (t.stage === 1) seenStage1[t.id] = T0 - 1_000
  const second = pick(seenStage1, none)
  check('once every stage-1 tip is seen, the lesson moves to stage 2', second?.stage === 2, second?.id)
  const seenTo2: Record<string, number> = { ...seenStage1 }
  for (const t of bank) if (t.stage === 2) seenTo2[t.id] = T0 - 1_000
  const third = pick(seenTo2, none)
  check('once stages 1 and 2 are seen, the lesson is the depth', third?.stage === 3, third?.id)
  const allButSessions = new Set(bank.map(t => t.surface).filter((s): s is string => s !== undefined && s !== 'sessions'))
  const lessonUnopened = pick({}, allButSessions)
  check("within the lesson a never-opened surface's tip ranks first", lessonUnopened?.id === 'sessions.switch', lessonUnopened?.id)
  const allButRewind = new Set(bank.map(t => t.surface).filter((s): s is string => s !== undefined && s !== 'rewind'))
  const jumper = pick({}, allButRewind)
  check("a later stage's never-opened surface waits for its lesson", jumper?.stage === 1 && jumper?.id !== 'sessions.rewind', jumper?.id)
  const itsTurn = pick(seenStage1, allButRewind)
  check('…and ranks first once its lesson is reached', itsTurn?.id === 'sessions.rewind', itsTurn?.id)
  const seen: Record<string, number> = {}
  for (const t of bank) seen[t.id] = T0 - 1_000
  check('every tip seen recently ⇒ nothing to say', pick(seen, none, 10) === null)
  check('an explicit ask relaxes the seen filter', pick(seen, none, 10, true) !== null)
  const aged = voice.pickTip(tipDeck, voice.freshVoiceState(), bank, seen, { contextPct: null, openedSurfaces: none }, T0 + voice.TIP_SEEN_TTL_MS)
  check('a seen tip returns after its memory ages out', aged !== null)
  const gated = voice.pickTip(
    tipDeck,
    voice.freshVoiceState(),
    [{ id: 'g', area: 'keys', stage: 1, text: 'gated', when: () => false }, { id: 'o', area: 'keys', stage: 2, text: 'open' }],
    {},
    { contextPct: null, openedSurfaces: none },
    T0,
  )
  check("a gated tip never speaks; the lesson is the earliest stage among the tips this boot HAS", gated?.id === 'o', gated?.id)
}

section('§3 the engine speaks on quiet moments and remembers')
{
  const { publishCompanionTurnAt, resetCompanionSignals } = await import('../../src/utils/cockpit/companionSignals.ts')
  const engine = await import('../../src/utils/cockpit/companionEngine.ts')
  const profile = await import('../../src/utils/cockpit/critterProfile.ts')
  const { switchSession } = await import('../../src/bootstrap/state.ts')
  const bank = words.tipBank()
  const tipTexts = new Set(bank.map(t => t.text))
  let now = 1_800_000_000_000
  engine.setCompanionClockForProofs(() => now)
  switchSession('dddddddd-0000-4000-8000-000000000001' as never)
  engine.resetCompanionEngineForTests()
  resetCompanionSignals()
  const unsub = engine.subscribeCompanionEngine(() => {})
  check('at boot the companion is silent', engine.companionEngineSnapshot().quip === null)
  now += voice.TIP_BOOT_QUIET_MS + 1_000
  engine.recomputeCompanionForProofs()
  const bootTip = engine.companionEngineSnapshot().quip
  check('after the boot quiet a session-start tip shows (from the bank)', bootTip?.kind === 'tip' && tipTexts.has(bootTip.text), bootTip?.text)
  const shown = bank.find(t => t.text === bootTip?.text)
  check('the first tip a fresh profile hears is a stage-1 lesson', shown?.stage === 1, shown?.id)
  check('the shown tip is marked seen in the profile', shown !== undefined && profile.seenTipStamps()[shown.id] === now)
  now += engine.TIP_MS + 2_000
  engine.recomputeCompanionForProofs()
  check('the tip expires', engine.companionEngineSnapshot().quip === null)

  now += voice.RETURN_AFTER_MS + 60_000
  publishCompanionTurnAt({ turnLive: true, streaming: false, awaitingPermission: false }, now)
  engine.recomputeCompanionForProofs()
  const back = engine.companionEngineSnapshot().quip
  check('a turn after ten quiet minutes speaks a silence line', back?.kind === 'moment' && words.MOMENT_LINES.silence.includes(back.text), back?.text)
  publishCompanionTurnAt({ turnLive: false, streaming: false, awaitingPermission: false }, now + 2_000)
  now += 2_000
  engine.recomputeCompanionForProofs()

  const onDemand = engine.requestCompanionTip()
  check('/companion tip returns a bank tip', onDemand !== null && tipTexts.has(onDemand), onDemand ?? 'null')
  check('the on-demand tip shows on the row', engine.companionEngineSnapshot().quip?.text === onDemand)
  unsub()
  engine.setCompanionClockForProofs(null)
}

rmSync(home, { recursive: true, force: true })
console.log(failures === 0 ? '\n ✅ COMPANION VOICE GREEN' : `\n ❌ ${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
