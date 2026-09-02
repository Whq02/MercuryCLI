#!/usr/bin/env bun
// ============================================================================
//  scripts/notifications/prove-surface-strip.ts — THE STRIP counts its stops
//  from what exists (the operator: "on a
//  new session you can only go right once, to the concourse. There is no
//  main chat that exists … otherwise it's blocked — not rubber-band back,
//  not glitchy, just not there until a session starts").
//
//  §1  THE PURE TABLE: every combination of the three facts (the concourse
//      switch × a `--chat` boot × a focused session) → the present stops,
//      and every move from every position → its answer. POISON: the
//      reserved third stop — a chat stop with no session focused — never
//      appears in any row.
//  §2  the key-map grammar: a row paints ONLY the moves that exist, and the
//      absent chat to the right paints its dim hint.
//  §3  the live strip through the store: a bare boot walks menu ⇄ concourse
//      and no further (a hinted non-move commits NOTHING — no transition, no
//      generation bump: the frame is byte-still by construction); a session
//      focused makes the chat stop appear; the last chat closing makes it
//      vanish; the store re-emits on every presence change; the CB-10
//      refusal stays a refusal.
//  §4  THE PLAIN WORLD: `--chat` and the persisted switch off each drop the
//      concourse stop — menu ⇄ chat — while the explicit door (/concourse)
//      still opens the board and the strip walks from its position; off is
//      never a one-way door.
//  §5  the policy gate: a `--chat` boot under MERCURY_CONCOURSE=always still
//      lands the chat (the policy reads 'off' when no concourse stop exists).
//
// ============================================================================

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { checker } from '../engine-durability/harness.ts'

const SCRATCH = mkdtempSync(join(tmpdir(), 'surface-strip-'))
process.env.MERCURY_CONFIG_DIR = join(SCRATCH, 'home')
delete process.env.MERCURY_HOME
mkdirSync(process.env.MERCURY_CONFIG_DIR, { recursive: true })
// The strip needs the fullscreen surface (CB-10); the gate reads the env live.
process.env.MERCURY_FULLSCREEN = '1'

const t = checker()
const route = await import('../../src/context/surfaceRoute.js')
// The strip composer folds chord spellings to the host's own (identity on
// macOS, 'shift+←' words elsewhere) — the TABLE stays authored in the mac
// glyphs and every assertion folds it through the same owner, so the pins
// are byte-exact on every host.
const { keyHintLabel } = await import('../../src/components/mercury-ui/keyHintLabel.js')
type StripStop = import('../../src/context/surfaceRoute.js').StripStop
type StripFacts = import('../../src/context/surfaceRoute.js').StripFacts
type SurfaceKind = import('../../src/context/surfaceRoute.js').SurfaceKind

const F = (concourseEnabled: boolean, chatBoot: boolean, chatPresent: boolean): StripFacts => ({ concourseEnabled, chatBoot, chatPresent })
/** A move's answer: a stop, '—' (the strip's silent end), or the dim hint. */
type Answer = StripStop | '—' | 'no chat open'
type Row = {
  label: string
  facts: StripFacts
  stops: StripStop[]
  /** [left, right] from each position. */
  moves: Record<Exclude<SurfaceKind, 'session'>, [Answer, Answer]>
  hints: Record<Exclude<SurfaceKind, 'session'>, string>
}
const TWO_STOPS: Row['moves'] = {
  'boot-settings': ['—', 'concourse'],
  concourse: ['boot-settings', 'no chat open'],
  repl: ['concourse', '—'],
}
const THREE_STOPS: Row['moves'] = {
  'boot-settings': ['—', 'concourse'],
  concourse: ['boot-settings', 'repl'],
  repl: ['concourse', '—'],
}
const PLAIN_WITH_CHAT: Row['moves'] = {
  'boot-settings': ['—', 'repl'],
  concourse: ['boot-settings', 'repl'],
  repl: ['boot-settings', '—'],
}
const PLAIN_NO_CHAT: Row['moves'] = {
  'boot-settings': ['—', 'no chat open'],
  concourse: ['boot-settings', 'no chat open'],
  repl: ['boot-settings', '—'],
}
const TABLE: Row[] = [
  {
    label: 'a fresh boot — switch on · not --chat · no chat',
    facts: F(true, false, false),
    stops: ['boot-settings', 'concourse'],
    moves: TWO_STOPS,
    hints: { 'boot-settings': '⇧→ concourse', concourse: '⇧← boot face · ⇧→ no chat open', repl: '⇧← concourse' },
  },
  {
    label: 'a session focused — switch on · not --chat · chat',
    facts: F(true, false, true),
    stops: ['boot-settings', 'concourse', 'repl'],
    moves: THREE_STOPS,
    hints: { 'boot-settings': '⇧→ concourse', concourse: '⇧← boot face · ⇧→ chat', repl: '⇧← concourse' },
  },
  {
    label: '--chat born at boot — switch on · --chat · chat',
    facts: F(true, true, true),
    stops: ['boot-settings', 'repl'],
    moves: PLAIN_WITH_CHAT,
    hints: { 'boot-settings': '⇧→ chat', concourse: '⇧← boot face · ⇧→ chat', repl: '⇧← boot face' },
  },
  {
    label: '--chat whose birth was refused — switch on · --chat · no chat',
    facts: F(true, true, false),
    stops: ['boot-settings'],
    moves: PLAIN_NO_CHAT,
    hints: { 'boot-settings': '⇧→ no chat open', concourse: '⇧← boot face · ⇧→ no chat open', repl: '⇧← boot face' },
  },
  {
    label: 'the switch off — no chat',
    facts: F(false, false, false),
    stops: ['boot-settings'],
    moves: PLAIN_NO_CHAT,
    hints: { 'boot-settings': '⇧→ no chat open', concourse: '⇧← boot face · ⇧→ no chat open', repl: '⇧← boot face' },
  },
  {
    label: 'the switch off — a session focused',
    facts: F(false, false, true),
    stops: ['boot-settings', 'repl'],
    moves: PLAIN_WITH_CHAT,
    hints: { 'boot-settings': '⇧→ chat', concourse: '⇧← boot face · ⇧→ chat', repl: '⇧← boot face' },
  },
  {
    label: 'the switch off + --chat — chat',
    facts: F(false, true, true),
    stops: ['boot-settings', 'repl'],
    moves: PLAIN_WITH_CHAT,
    hints: { 'boot-settings': '⇧→ chat', concourse: '⇧← boot face · ⇧→ chat', repl: '⇧← boot face' },
  },
  {
    label: 'the switch off + --chat — no chat',
    facts: F(false, true, false),
    stops: ['boot-settings'],
    moves: PLAIN_NO_CHAT,
    hints: { 'boot-settings': '⇧→ no chat open', concourse: '⇧← boot face · ⇧→ no chat open', repl: '⇧← boot face' },
  },
]
const POSITIONS: Array<Exclude<SurfaceKind, 'session'>> = ['boot-settings', 'concourse', 'repl']
const answerOf = (m: ReturnType<typeof route.stripMove>): Answer => (m.to !== null ? m.to : m.hint === null ? '—' : 'no chat open')

t.section('§1 — the pure table: eight fact rows, every move, the poison never appears')
{
  t.check('the table is total over the three facts (2 × 2 × 2 rows)', TABLE.length === 8 && new Set(TABLE.map(r => JSON.stringify(r.facts))).size === 8)
  for (const row of TABLE) {
    const stops = route.stripStops(row.facts)
    t.check(`${row.label}: the present stops are [${row.stops.join(' · ')}]`, JSON.stringify(stops) === JSON.stringify(row.stops), JSON.stringify(stops))
    for (const at of POSITIONS) {
      const [left, right] = row.moves[at]
      const l = answerOf(route.stripMove(at, 'left', stops))
      const r = answerOf(route.stripMove(at, 'right', stops))
      t.check(`${row.label}: from ${at} ⇧← ${left} · ⇧→ ${right}`, l === left && r === right, `got ⇧← ${l} · ⇧→ ${r}`)
    }
    if (!row.facts.chatPresent) {
      t.check(`${row.label}: POISON — no chat stop is reserved while no session is focused`, !stops.includes('repl') && POSITIONS.every(at => route.stripMove(at, 'right', stops).to !== 'repl'))
    }
    t.check(`${row.label}: the plain-world fact reads ${route.chatOnlyBootOf(row.facts)}`, route.chatOnlyBootOf(row.facts) === (row.facts.chatBoot || !row.facts.concourseEnabled))
  }
  t.check('a session route walks from the concourse\'s position', route.stripMove('session', 'left', ['boot-settings', 'concourse', 'repl']).to === 'boot-settings' && route.stripMove('session', 'right', ['boot-settings', 'concourse', 'repl']).to === 'repl')
  t.check('the strip order is [boot menu · concourse · chat]', JSON.stringify(route.STRIP_ORDER) === JSON.stringify(['boot-settings', 'concourse', 'repl']))
  t.check('the hint is the one sentence', route.NO_CHAT_HINT === 'no chat open')
}

t.section('§2 — the key-map grammar paints only present moves')
{
  for (const row of TABLE) {
    const stops = route.stripStops(row.facts)
    for (const at of POSITIONS) {
      const hint = route.stripKeyMapHintOf(at, stops)
      t.check(`${row.label}: the ${at} row reads "${row.hints[at]}" (host-spelled)`, hint === keyHintLabel(row.hints[at]!), `got "${hint}"`)
    }
  }
  const chatNeedles = [`${keyHintLabel('⇧←')} chat`, `${keyHintLabel('⇧→')} chat`]
  t.check('a row never names a chat while no session is focused', TABLE.filter(r => !r.facts.chatPresent).every(r => POSITIONS.every(at => { const h = route.stripKeyMapHintOf(at, route.stripStops(r.facts)); return chatNeedles.every(n => !h.includes(n)) })))
  t.check('an empty strip (nothing registered) paints an empty row from the menu', route.stripKeyMapHintOf('boot-settings', []) === keyHintLabel('⇧→ no chat open') && route.stripKeyMapHintOf('repl', []) === '')
}

// A fake presence seam the live legs drive by hand.
function presenceSeam(): { set: (v: boolean) => void; seam: import('../../src/context/surfaceRoute.js').ChatPresenceSeam } {
  let present = false
  const listeners = new Set<() => void>()
  return {
    set: v => {
      present = v
      for (const l of listeners) l()
    },
    seam: {
      present: () => present,
      subscribe: l => {
        listeners.add(l)
        return () => {
          listeners.delete(l)
        }
      },
    },
  }
}
const registerBoth = (): void => {
  route.registerRouteSurface('boot-settings', { render: () => null })
  route.registerRouteSurface('concourse', { render: () => null })
}
const kind = (): string => route.currentSurfaceRoute().kind

t.section('§3 — the live strip: a bare boot has two stops; the chat stop appears and vanishes')
{
  route._resetSurfaceRouteForTesting()
  registerBoth()
  const presence = presenceSeam()
  route.registerChatPresence(presence.seam)
  route.initializeSurfaceRoute({ kind: 'boot-settings' })
  t.check('a fresh boot: the present stops are the menu and the concourse', JSON.stringify(route.presentStripStops()) === JSON.stringify(['boot-settings', 'concourse']))
  t.check('the face\'s key-map row names the concourse alone', route.stripKeyMapHint() === keyHintLabel('⇧→ concourse'), route.stripKeyMapHint())
  const r1 = route.cycleSurface(-1)
  t.check('⇧→ from the menu lands the concourse', r1.ok && r1.moved && kind() === 'concourse', JSON.stringify(r1))
  const gen = route.surfaceGeneration()
  const last = JSON.stringify(route.lastSurfaceTransition())
  const r2 = route.cycleSurface(-1)
  t.check('⇧→ again: NO MOVEMENT — moved false, the dim hint, the route unchanged', r2.ok && !r2.moved && r2.hint === 'no chat open' && kind() === 'concourse', JSON.stringify(r2))
  t.check('…and NOTHING committed (no generation bump, no transition record — the frame is byte-still by construction; the poison was a commit onto the empty REPL)', route.surfaceGeneration() === gen && JSON.stringify(route.lastSurfaceTransition()) === last)
  t.check('the concourse\'s key-map row says so', route.stripKeyMapHint() === '⇧← boot face · ⇧→ no chat open', route.stripKeyMapHint())
  const r3 = route.cycleSurface(1)
  t.check('⇧← from the concourse lands the menu', r3.ok && r3.moved && kind() === 'boot-settings')
  const r4 = route.cycleSurface(1)
  t.check('⇧← from the menu: the strip\'s end, silent (no hint)', r4.ok && !r4.moved && r4.hint === null && kind() === 'boot-settings', JSON.stringify(r4))

  // The command runner: the REPL fronting a resting slot (Doctor's card,
  // the resume picker) can always leave leftward, and nothing walks back in.
  route.initializeSurfaceRoute({ kind: 'repl' })
  const r5 = route.cycleSurface(1)
  t.check('from the REPL with no chat (a root command running) ⇧← reaches the concourse', r5.ok && r5.moved && kind() === 'concourse')
  const r6 = route.cycleSurface(-1)
  t.check('…and ⇧→ never walks back into the empty REPL', r6.ok && !r6.moved && kind() === 'concourse')

  // The stop appears: a session is focused (the seam flips; the store re-emits).
  let bumps = 0
  const unsubscribe = route.subscribeSurfaceRoute(() => {
    bumps += 1
  })
  presence.set(true)
  t.check('a presence change re-emits through the route store (the key-map rows repaint from one store)', bumps >= 1, String(bumps))
  unsubscribe()
  t.check('a session focused: the chat stop is present', JSON.stringify(route.presentStripStops()) === JSON.stringify(['boot-settings', 'concourse', 'repl']))
  t.check('the concourse\'s row now names the chat', route.stripKeyMapHint() === keyHintLabel('⇧← boot face · ⇧→ chat'), route.stripKeyMapHint())
  const r7 = route.cycleSurface(-1)
  t.check('⇧→ from the concourse enters the focused chat (a HOME commit)', r7.ok && r7.moved && kind() === 'repl' && route.lastSurfaceTransition().verb === 'HOME' && route.activeReturnToken() === null)
  const r8 = route.cycleSurface(-1)
  t.check('⇧→ from the chat: the strip\'s end, silent', r8.ok && !r8.moved && r8.hint === null && kind() === 'repl')
  t.check('the chat\'s row names the concourse', route.stripKeyMapHint() === keyHintLabel('⇧← concourse'))
  const r9 = route.cycleSurface(1)
  t.check('⇧← from the chat is the board', r9.ok && r9.moved && kind() === 'concourse')
  const r10 = route.cycleSurface(1)
  t.check('⇧← again is the menu; ⇧→ ⇧→ returns to the chat', r10.ok && kind() === 'boot-settings' && route.cycleSurface(-1).ok && route.cycleSurface(-1).ok && kind() === 'repl')

  // The last chat closes while the board is on screen: the stop vanishes.
  route.cycleSurface(1)
  presence.set(false)
  t.check('the last chat closed: two stops again', JSON.stringify(route.presentStripStops()) === JSON.stringify(['boot-settings', 'concourse']))
  const r11 = route.cycleSurface(-1)
  t.check('⇧→ from the concourse is no movement again (never the vanished chat)', r11.ok && !r11.moved && r11.hint === 'no chat open' && kind() === 'concourse')

  // CB-10 stays a refusal (a note), not a hinted non-move.
  process.env.MERCURY_FULLSCREEN = '0'
  const inline = route.cycleSurface(1)
  t.check('an inline boot refuses the strip with its reason (the env read is live per call)', !inline.ok && /fullscreen/.test(inline.reason), JSON.stringify(inline))
  process.env.MERCURY_FULLSCREEN = '1'

  // The seam unregisters cleanly: no chat exists without one.
  presence.set(true)
  route.registerChatPresence(presence.seam)()
  t.check('without a registered presence seam no chat exists (the strip never guesses)', !route.chatPresent() && !route.presentStripStops().includes('repl'))
}

t.section('§4 — the plain world: --chat and the switch off drop the concourse stop')
{
  route._resetSurfaceRouteForTesting()
  registerBoth()
  const presence = presenceSeam()
  route.registerChatPresence(presence.seam)
  t.check('before the mark: not a chat-only boot', route.chatOnlyBoot() === false)
  route.markChatBoot()
  t.check('--chat: the plain-world fact holds', route.chatOnlyBoot() === true)
  t.check('--chat before ↵ New Session: the menu alone (the concourse surface is registered and switched on, yet it is no stop)', JSON.stringify(route.presentStripStops()) === JSON.stringify(['boot-settings']))
  presence.set(true)
  route.initializeSurfaceRoute(route.ROOT_REPL_ROUTE)
  t.check('--chat after ↵ New Session: menu ⇄ chat', JSON.stringify(route.presentStripStops()) === JSON.stringify(['boot-settings', 'repl']))
  t.check('the chat\'s row names the boot face (nothing in between)', route.stripKeyMapHint() === keyHintLabel('⇧← boot face'), route.stripKeyMapHint())
  const p1 = route.cycleSurface(1)
  t.check('⇧← from the chat lands the menu — the concourse skipped', p1.ok && p1.moved && kind() === 'boot-settings')
  const p2 = route.cycleSurface(1)
  t.check('⇧← from the menu: silent end', p2.ok && !p2.moved && p2.hint === null)
  t.check('the menu\'s row names the chat', route.stripKeyMapHint() === keyHintLabel('⇧→ chat'))
  const p3 = route.cycleSurface(-1)
  t.check('⇧→ from the menu lands the chat — the concourse skipped', p3.ok && p3.moved && kind() === 'repl')
  // The explicit door still opens the board (it is a screen, not a stop);
  // the strip walks from its position.
  const door = route.enterConcourse()
  t.check('/concourse still opens the board in a --chat boot (an explicit door, not a stop)', door.ok && kind() === 'concourse')
  t.check('the board\'s row walks from its position: the face left, the chat right', route.stripKeyMapHint() === keyHintLabel('⇧← boot face · ⇧→ chat'), route.stripKeyMapHint())
  const p4 = route.cycleSurface(-1)
  t.check('⇧→ from the board enters the chat', p4.ok && p4.moved && kind() === 'repl')

  // The persisted switch off is the same world without the mark.
  route._resetSurfaceRouteForTesting()
  registerBoth()
  const presence2 = presenceSeam()
  route.registerChatPresence(presence2.seam)
  const { enableConfigs } = await import('../../src/utils/config.js')
  enableConfigs()
  const sw = await import('../../src/services/concourse/concourseEnabled.js')
  t.check('a fresh home boots with the switch on', sw.concourseEnabled() === true)
  sw.setConcourseEnabled(false)
  t.check('the switch off: the plain-world fact holds without --chat', route.chatOnlyBoot() === true && !route.stripFacts().chatBoot)
  t.check('the switch off, no chat: the menu alone', JSON.stringify(route.presentStripStops()) === JSON.stringify(['boot-settings']))
  presence2.set(true)
  t.check('the switch off, a session focused: menu ⇄ chat', JSON.stringify(route.presentStripStops()) === JSON.stringify(['boot-settings', 'repl']))
  sw.setConcourseEnabled(true)
  t.check('the switch back on: the concourse stop returns (read live; off is never a one-way door)', JSON.stringify(route.presentStripStops()) === JSON.stringify(['boot-settings', 'concourse', 'repl']))
}

t.section('§5 — the policy gate: no concourse stop ⇒ the policy reads off')
{
  route._resetSurfaceRouteForTesting()
  route.registerRouteSurface('concourse', { render: () => null })
  const dir = mkdtempSync(join(tmpdir(), 'surface-strip-records-'))
  try {
    const always = await route.resolveInitialSurface({ env: { MERCURY_CONCOURSE: 'always' }, recordsDir: dir })
    t.check('a policy-always boot with the concourse stop present lands the concourse', always.effective.kind === 'concourse' && always.reason === 'always', JSON.stringify(always))
    route.markChatBoot()
    const chat = await route.resolveInitialSurface({ env: { MERCURY_CONCOURSE: 'always' }, recordsDir: dir })
    t.check('a --chat boot under the same env lands the chat: the policy reads off (no concourse stop exists in that boot)', chat.effective.kind === 'repl' && chat.policy === 'off' && chat.reason === 'concourse-off', JSON.stringify(chat))
    route._resetSurfaceRouteForTesting()
    route.registerRouteSurface('concourse', { render: () => null })
    const sw = await import('../../src/services/concourse/concourseEnabled.js')
    sw.setConcourseEnabled(false)
    const off = await route.resolveInitialSurface({ env: { MERCURY_CONCOURSE: 'always' }, recordsDir: dir })
    t.check('the switch off under the same env lands the chat the same way', off.effective.kind === 'repl' && off.policy === 'off', JSON.stringify(off))
    sw.setConcourseEnabled(true)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

t.section('§6 — the bridge: the chat route is reachable only with a chat present or a root command armed')
{
  route._resetSurfaceRouteForTesting()
  registerBoth()
  const presence = presenceSeam()
  route.registerChatPresence(presence.seam)
  route.initializeSurfaceRoute({ kind: 'boot-settings' })
  const gen = route.surfaceGeneration()
  const home = route.enterRootRepl()
  t.check('home with no chat: no movement and the typed refusal (the face\'s esc never bounces off the empty REPL)', !home.ok && home.code === 'no-chat' && kind() === 'boot-settings' && route.surfaceGeneration() === gen, JSON.stringify(home))
  // The armed form RETIRED with the face's last armed row —
  // the one sessionless-REPL road left (a prompt argument on argv) mounts
  // the chat route through the resolver's explicit-journey landing, which
  // this drive now exercises; enterRootRepl itself refuses without a chat,
  // full stop (the check above).
  route.initializeSurfaceRoute(route.ROOT_REPL_ROUTE)
  t.check('the argv-prompt road seeds the chat route sessionless (initializeSurfaceRoute, never a verb)', kind() === 'repl')
  const settled = route.settleAbsentChat()
  t.check('the command ended with no session: settleAbsentChat lands the boot menu with NOTHING beneath (no return token — the poison was a token onto the empty chat the face\'s esc bounced off)', settled.ok && kind() === 'boot-settings' && route.activeReturnToken() === null && route.lastSurfaceTransition().from === 'repl')
  t.check('…and is a no-op off the REPL', !route.settleAbsentChat().ok && kind() === 'boot-settings')
  presence.set(true)
  route.initializeSurfaceRoute(route.ROOT_REPL_ROUTE)
  const menu = route.enterBootSettings()
  presence.set(false)
  const back = route.leaveCurrentSurface()
  t.check('a return token onto the chat refuses once the bridge emptied (the face stays; the token stays)', menu.ok && !back.ok && kind() === 'boot-settings' && route.activeReturnToken() !== null)
  presence.set(true)
  const back2 = route.leaveCurrentSurface()
  t.check('…and restores the chat once one is present again', back2.ok && kind() === 'repl')
  t.check('settleAbsentChat is a no-op with a chat present', !route.settleAbsentChat().ok && kind() === 'repl')
  route.enterConcourse()
  const h1 = route.enterRootRepl()
  t.check('esc-home from the concourse with a chat present enters the chat (the exact root REPL, never unmounted)', h1.ok && kind() === 'repl' && route.activeReturnToken() === null)
  route.enterConcourse()
  presence.set(false)
  const h2 = route.enterRootRepl()
  t.check('esc-home from the concourse with no chat: no movement — the board stays, ⇧← is the road to the menu (no flash of the empty REPL)', !h2.ok && h2.code === 'no-chat' && kind() === 'concourse')
}

route._resetSurfaceRouteForTesting()
rmSync(SCRATCH, { recursive: true, force: true })
// Chat mode (the operator: "effective CLI in chat mode"):
// the world says which it is and why, in one sentence with one owner, and
// the two flags never contradict — `--chat` over a saved off is the plain
// world twice, `--concourse-on` beside `--chat` persists the switch for the
// NEXT plain boot while THIS boot stays plain by the mark.
t.section('§7 — the world is honest about itself: the why, the way back, one sentence')
{
  const fleet = { concourseEnabled: true, chatBoot: false }
  const chat = { concourseEnabled: true, chatBoot: true }
  const off = { concourseEnabled: false, chatBoot: false }
  const both = { concourseEnabled: false, chatBoot: true }
  t.check('the fleet world has no why and no sentence', route.plainWorldWhyOf(fleet) === null && route.concourseOffSentenceOf(fleet) === null)
  t.check("--chat with the switch on: why = '--chat'; the way back is a plain boot (the switch is already on)", route.plainWorldWhyOf(chat) === '--chat' && route.concourseWayBackOf(chat) === 'a plain `mercury` boot has it')
  t.check("the switch off: why = 'concourse off'; the way back is --concourse-on or /config", route.plainWorldWhyOf(off) === 'concourse off' && route.concourseWayBackOf(off) === '`mercury --concourse-on` or /config turns it back')
  t.check('--chat over a saved off is no contradiction: the plain world, the why names both, the way back is the switch', route.chatOnlyBootOf(both) === true && route.plainWorldWhyOf(both) === '--chat · concourse off' && route.concourseWayBackOf(both) === '`mercury --concourse-on` or /config turns it back')
  t.check('the sentence composes the why and the way back', route.concourseOffSentenceOf(chat) === 'the Session Concourse is off in this boot (--chat) — a plain `mercury` boot has it' && route.concourseOffSentenceOf(off) === 'the Session Concourse is off in this boot (concourse off) — `mercury --concourse-on` or /config turns it back')
  // THE ARGV LAW (lane A's, verified): between --concourse-off and
  // --concourse-on the later wins, the shell's reading; --chat beside
  // --concourse-on is no contest — two independent facts.
  const main = readFileSync(new URL('../../src/main.tsx', import.meta.url), 'utf8')
  t.check("--concourse-off and --concourse-on on one line: the later wins", main.includes("const lastSwitch = [...process.argv].reverse().find(a => a === '--concourse-off' || a === '--concourse-on')") && main.includes("setConcourseEnabled(lastSwitch === '--concourse-on')"))
  t.check('--chat beside --concourse-on: this boot plain by the mark (menu ⇄ chat), the switch on for the next', route.chatOnlyBootOf(chat) === true && route.stripStops({ ...chat, chatPresent: true }).join(',') === 'boot-settings,repl')
  // The live readers say the world and why from the one owner.
  const status = readFileSync(new URL('../../src/commands/status/mercuryStatus.tsx', import.meta.url), 'utf8')
  t.check("/status carries a Concourse row from the router's why and way back", status.includes('plainWorldWhy()') && status.includes('concourseWayBack()') && status.includes("k: 'Concourse'") && status.includes('off this boot (${why})'))
  const config = readFileSync(new URL('../../src/components/Settings/Config.tsx', import.meta.url), 'utf8')
  t.check("/config's Session concourse row says a --chat boot is the plain world whatever the switch says", config.includes('off this boot (--chat)') && config.includes('the switch governs the next plain `mercury` boot'))
  t.check('the router owns the sentence and no reader spells its own', !status.includes('is off in this boot') && !config.includes('is off in this boot') && readFileSync(new URL('../../src/utils/processUserInput/processSlashCommand.tsx', import.meta.url), 'utf8').includes('concourseOffSentence()'))
}

t.finish('prove-surface-strip')
