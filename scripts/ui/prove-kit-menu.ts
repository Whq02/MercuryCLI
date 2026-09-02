#!/usr/bin/env bun
// ============================================================================
//  scripts/ui/prove-kit-menu.ts — the MCPs & Skills row + manager (the
//  operator's L24(5) + L24(6-SUPERSEDED)).
//
//    §1 THE ROW, BOTH HOSTS, EVERY WORLD — assembleCardRows (the ONE row
//       owner) composes "MCPs & Skills" directly after "Boot Menu" on the
//       same fit fact in the full world AND the --chat world; POISON 1: a
//       row present on one host only (the hero-shift class) — neither host
//       passes a kit fact, both pass the fit fact, and the lines above the
//       card are byte-identical across the two hosts' fact shapes; POISON
//       2: a world check anywhere in the row's composition (the row's push
//       sits inside the fit guard alone, and no world token lives there).
//    §2 THE HANDOVER — `kit` admits on this runtime (applied, nothing to
//       chdir or splice, the deep-link armed once); an unknown action
//       still boots plain; the face consumes the deep-link at mount.
//    §3 THE COMPOSER STAYS ONE — composeBootMenu's new host fields are
//       optional and absent ⇒ the boot menu's exact bytes; an empty
//       catalogue and an inert line compose without a throw at both tiers.
//    §4 THE SCREEN'S ENTRIES — every state is a WORD; the master row says
//       plainly that off turns off everything the extension contributes;
//       both sections always exist in the ruled order.
//    §5 THE STILLS — the face WITH the row in both worlds (100x34 · 120x40)
//       and the manager at 100 and 120 columns byte-match the written
//       fixtures (scripts/ui/kit-menu-stills.ts --write regenerates them).
//  cpu-pure: composes through the shared core; never a PTY, a daemon or a
//  boot.
// ============================================================================

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { checker } from '../engine-durability/harness.ts'
import { assembleCardRows, createSplashCore } from '../../assets/splash/splash-core.mjs'
import { consumeKitManagerDeepLink, decideSplashReceipt } from '../../src/substrate/splashHandover.js'
import { KIT_LEGEND, KIT_LEGEND_PRESET, KIT_LEGEND_PRESETS, KIT_LEGEND_PROMPT, KIT_LEGEND_SAVED, kitEntryOf, kitStatusLine, kitSummaryRows, kitValueLabel, presetPromptLines } from '../../src/components/KitMenuScreen.js'
import { EMPTY_KIT_CATALOGUE, KIT_SECTION_TITLE, cycleState, kitCounts, kitRowId, kitRowView, kitStateKey, sectionRows, type KitRow, type KitRowState } from '../../src/services/kitMenu/kitTypes.js'
import { SAMPLE_CATALOGUE, SAMPLE_STATES, STILLS, composeManager, faceFacts, readStill, renderStill, stillPath } from './kit-menu-stills.ts'

const t = checker()
const REPO = join(import.meta.dir, '..', '..')
const read = (rel: string): string => readFileSync(join(REPO, rel), 'utf8')

const coreSrc = read('assets/splash/splash-core.mjs')
const driverSrc = read('assets/splash/mercury-splash.mjs')
const faceSrc = read('src/components/BootSplashScreen.tsx')

type Row = { key: string; icon: string; label: string; ctx: string }
const rowsOf = (facts: Record<string, unknown>): Row[] => assembleCardRows(facts) as Row[]
const keysOf = (facts: Record<string, unknown>): string[] => rowsOf(facts).map(r => r.key)
const BASE = { cwdBase: 'proj', continueTarget: null, menuAvailable: true, projects: [] as unknown[] }
const FULL = { ...BASE, concourse: { ctx: 'the live board' } }
const CHAT = { ...BASE, concourse: null }

t.section('§1 — THE ROW, BOTH HOSTS, EVERY WORLD (one owner, no world check)')
{
  const full = keysOf(FULL)
  const chat = keysOf(CHAT)
  t.check('the full world carries the kit row directly after the Boot Menu row', full.indexOf('kit') === full.indexOf('menu') + 1 && full.includes('menu'), full.join(' · '))
  t.check('the --chat world carries the SAME kit row at the SAME place (identical worlds — no row-null, no chatBoot mark for it)', chat.indexOf('kit') === chat.indexOf('menu') + 1 && chat.includes('menu'), chat.join(' · '))
  t.check('the --chat card is the full card minus exactly the concourse row (nothing else differs)', JSON.stringify(full.filter(k => k !== 'concourse')) === JSON.stringify(chat))
  const kit = rowsOf(FULL).find(r => r.key === 'kit')
  t.check("the row's bytes: ⊛ · 'MCPs & Skills' · 'what the next session loads'", kit?.icon === '⊛' && kit?.label === 'MCPs & Skills' && kit?.ctx === 'what the next session loads', JSON.stringify(kit))
  t.check('the row rides the SAME fit law as the menu row (no menu ⇒ no kit; the manager needs the menu floor)', !keysOf({ ...FULL, menuAvailable: false }).includes('kit') && !keysOf({ ...FULL, menuAvailable: false }).includes('menu') && !keysOf({ ...CHAT, menuAvailable: false }).includes('kit'))
  // AMENDED: the ruled Saturn Scheduler row
  // joined the card after Doctor — the untouched-bytes needle filters it
  // beside the kit row; the law (existing rows' bytes never move under an
  // addition) stands. AMENDED AGAIN (the operator's two
  // rulings): the Logins row joined the run (filtered beside the other
  // additions) and the Projects + Resume rows FOLDED into the merged
  // 'Sessions · Projects' door — the merged row's own bytes are the recut's
  // (prove-splash pins them); every OTHER pre-existing row is byte-frozen
  // here exactly as before.
  // AMENDED AGAIN: the ruled Agents row joined the card
  // directly under kit — filtered beside the other additions; the law
  // (existing rows' bytes never move under an addition) stands untouched.
  t.check('the existing rows stay EXACTLY as they are (their bytes are untouched by the additions)', JSON.stringify(rowsOf(FULL).filter(r => !['kit', 'agents', 'saturn', 'logins', 'sessions'].includes(r.key))) === JSON.stringify([
    { key: 'new', icon: '✶', label: 'New Session in proj', ctx: 'start fresh here' },
    { key: 'menu', icon: '⊞', label: 'Boot Menu', ctx: 'configure boot env' },
    { key: 'doctor', icon: '✓', label: 'Doctor / Health Check', ctx: 'system diagnostics' },
    { key: 'concourse', icon: '⊞', label: 'Session Concourse', ctx: 'the live board' },
  ]))
  t.check('the merged door stays LAST (proof-leg stability — the resume slot)', full[full.length - 1] === 'sessions' && chat[chat.length - 1] === 'sessions')

  // POISON 2 — a world check in the row's composition. The kit push must sit
  // inside the fit guard and nothing else: the guarded block carries no
  // world token of any spelling.
  const asm = coreSrc.slice(coreSrc.indexOf('export function assembleCardRows'), coreSrc.indexOf('// ── PO-7: the ONE placement law'))
  const guardAt = asm.indexOf('if (facts.menuAvailable) {')
  const guardEnd = asm.indexOf('\n  }', guardAt)
  const guarded = guardAt >= 0 && guardEnd > guardAt ? asm.slice(guardAt, guardEnd) : ''
  t.check("the kit push lives inside the menu's fit guard alone", guarded.includes("key: 'kit'") && guarded.includes("key: 'menu'"), guarded.slice(0, 80))
  const WORLD_TOKENS = ['concourse', 'chatBoot', 'MERCURY_SPLASH_CHAT', 'world', 'chatOnly', 'plain']
  const worldHits = WORLD_TOKENS.filter(tok => guarded.replace(/\/\/[^\n]*/g, '').includes(tok))
  t.check('POISON absent: no world token in the guarded block (comments excluded)', worldHits.length === 0, worldHits.join(','))
  // AMENDED (the needle, not the law): the bare
  // 'facts.kit' token over-matched the RULED armed-wear fact
  // (facts.kitArmedPreset — the lead's visibility ruling: the row's ctx
  // names the armed one-shot preset). The kit-record blindness law stands
  // precisely: the ONLY facts.kit* spelling the guarded block may read is
  // the armed-preset display fact — never the kit record itself.
  const kitReads = guarded.replace(/\/\/[^\n]*/g, '').match(/facts\.kit\w*/g) ?? []
  t.check('POISON absent: the guarded block reads no kit-record fact (the armed-wear display fact is the one lawful facts.kit* spelling)', kitReads.every(m => m === 'facts.kitArmedPreset'), kitReads.join(','))
  t.check('the row assembly has ONE owner — no second kit row on either host', !driverSrc.includes("key: 'kit'") && !faceSrc.includes("key: 'kit'") && (coreSrc.match(/key: 'kit'/g) ?? []).length === 1)

  // POISON 1 — a row present on one host only (the hero-shift class): neither
  // host hands a kit fact; both hand the fit fact; and the composed lines
  // ABOVE the card (the launcher's frame-0 slice) are byte-identical across
  // the two hosts' fact shapes.
  const driverCall = driverSrc.slice(driverSrc.indexOf('function cardRows() {'), driverSrc.indexOf('// ── the PROJECTS picker view'))
  const faceCall = faceSrc.slice(faceSrc.indexOf('assembleCardRows({'), faceSrc.indexOf('}) as BootRow[]'))
  t.check("neither host passes a kit fact (the row is the core's, from the fit fact both already pass)", !/\bkit\b/.test(driverCall.replace(/\/\/[^\n]*/g, '')) && !/\bkit\b/.test(faceCall.replace(/\/\/[^\n]*/g, '')) && driverCall.includes('menuAvailable,') && faceCall.includes('menuAvailable,'))
  t.check("the runtime face activates the row (runRow case 'kit' opens the manager layer)", faceSrc.includes("case 'kit':") && faceSrc.includes('setKitOpen(true)'))
  t.check("the launcher activates the row with the `kit` receipt action", driverSrc.includes("else if (r2.key === 'kit') writeSplashAction('kit')"))
  const core = createSplashCore({ nocolor: false, truecolor: true })
  const chips = { model: 'Opus 5', critter: 'Crab', critterHue: '#DD4444', dir: 'proj', acct: { state: 'none' as const }, health: null }
  // The populated presence set (every row shape — the stills' own facts):
  // eight rows in the full world, seven in --chat.
  const lockup = (concourseCtx: string | null, cols: number, rows: number) =>
    core.composeLockup(cols, rows, {
      cardRows: assembleCardRows({ ...faceFacts('full'), concourse: concourseCtx === null ? null : { ctx: concourseCtx } }),
      cardSel: 0,
      hintSegments: [{ key: '↵ ', label: 'start', tone: 'ivory' as const }, { key: 'm', label: ' menu', tone: 'faint' as const }],
      tinyHint: '↵ start',
      stripLines: (w: number) => core.composeStrip(chips, w),
    }) as { lines: string[]; actionLines: number[] }
  for (const [cols, rows] of [[120, 40], [100, 34], [80, 24]] as const) {
    const launcher = lockup('the multi-session board, once', cols, rows) // the launcher's ctx
    const face = lockup('the live board', cols, rows) // the face's ctx
    const aboveCard = (r: { lines: string[]; actionLines: number[] }) => r.lines.slice(0, Math.min(...r.actionLines) - 1).join('\n')
    // AMENDED: the Saturn row joined both
    // hosts' cards — nine action rows in the full world; the hero-shift
    // law itself is untouched.
    // RE-DERIVED: the Agents row joined both hosts — ten rows.
    t.check(`${cols}x${rows}: the lines above the card are byte-identical across the two hosts' fact shapes (no hero shift)`, launcher.actionLines.length === 10 && face.actionLines.length === 10 && aboveCard(launcher) === aboveCard(face))
    const kitLine = (r: { lines: string[] }) => r.lines.findIndex(l => l.includes('MCPs & Skills'))
    t.check(`${cols}x${rows}: the kit row sits on the same line on both hosts, directly under the Boot Menu row`, kitLine(launcher) === kitLine(face) && kitLine(face) > r0(face) && kitLine(face) - r0(face) === launcher.actionLines[1]! - launcher.actionLines[0]!)
    const chatFace = lockup(null, cols, rows)
    t.check(`${cols}x${rows}: the --chat composition carries the kit row and nine action rows (no concourse; the Saturn and Agents rows ride both worlds)`, chatFace.actionLines.length === 9 && chatFace.lines.some(l => l.includes('MCPs & Skills')) && !chatFace.lines.some(l => l.includes('Session Concourse')))
  }
  function r0(r: { lines: string[] }): number {
    return r.lines.findIndex(l => l.includes('Boot Menu'))
  }
}

t.section('§2 — THE HANDOVER: `kit` admits here, unknown still boots plain, the face consumes the deep-link at mount')
{
  const NOW = 1_700_000_000_000
  const fresh = (o: Record<string, unknown>): string => JSON.stringify({ version: 1, ts: NOW, ...o })
  const d = (raw: string) => decideSplashReceipt(raw, NOW, () => false)
  void consumeKitManagerDeepLink() // drain any prior arm
  const kit = d(fresh({ action: 'kit' }))
  t.check('kit ⇒ applied, nothing to chdir or splice (the Boot face is the landing)', kit.reason === 'applied' && kit.apply === null)
  t.check('kit arms the manager deep-link exactly once', consumeKitManagerDeepLink() === true && consumeKitManagerDeepLink() === false)
  t.check("an unknown action reads 'unknown-action' and arms nothing (an older runtime's plain boot, the protocol's law)", d(fresh({ action: 'kit-manager' })).reason === 'unknown-action' && consumeKitManagerDeepLink() === false)
  const handover = read('src/substrate/splashHandover.ts')
  t.check("the closed vocabulary names `kit`", /const ACTIONS = new Set\(\[[^\]]*'kit'[^\]]*\]\)/.test(handover))
  // Import needle re-pinned: the face's handover import
  // grew the face-door sibling (consumeFaceDoorDeepLink) — the law (the
  // kit one-shot is consumed once, at mount) is unchanged.
  t.check('the face consumes the deep-link at mount (the CB-09 one-shot grammar)', faceSrc.includes('useState(() => consumeKitManagerDeepLink())') && faceSrc.includes("import { consumeFaceDoorDeepLink, consumeKitManagerDeepLink } from '../substrate/splashHandover.js'"))
  // Needle re-pinned: the card list's gate grew the two
  // face-door layers (!healthOpen && !resumeOpen) — the law (the manager
  // layer parks the card list) is unchanged.
  // AMENDED: the scheduler layer joined the
  // face's layer set — the parked-card needle re-pins with its gate.
  // Re-pinned: the sign-in layer joined the gate and
  // the projects VIEW retired with the merge — ONE list, the same law.
  t.check('the manager layer replaces the composition like the settings layer and esc closes it to the face', faceSrc.includes('if (kitOpen) {') && faceSrc.includes('onClose={() => setKitOpen(false)}') && faceSrc.includes('active: !settingsOpen && !kitOpen && !healthOpen && !resumeOpen && !saturnOpen && !agentsOpen && !loginsOpen,'))
}

t.section("§3 — THE COMPOSER STAYS ONE: composeBootMenu's host fields are optional and absent ⇒ the boot menu's exact bytes")
{
  const core = createSplashCore({ nocolor: false, truecolor: true })
  const legacyEntries = [
    { label: 'Content-rule wards', group: 'trust combo', summary: 'wards stop bad calls', valueLabel: 'default', valueIsDefault: true, pinnedVal: null, detail: { controls: 'the wards', on: ['stops bad calls'], off: ['no wards'] }, detailExtra: ['this session  default (default)'] },
    { label: 'Debugger', group: 'trust combo', summary: 'earns evidence', valueLabel: 'on', valueIsDefault: false, pinnedVal: null, detail: null },
    { label: 'Scale', group: 'scale & spend', summary: 'spend', valueLabel: 'default', valueIsDefault: true, pinnedVal: '1', detail: null },
  ]
  const legacy = {
    entries: legacyEntries,
    selIdx: 0,
    summary: { profile: 'r3 · custom · 1 set', harness: 'helm · console', integrity: 'enforce', integritySet: false },
    environment: { model: 'Opus 5', critter: 'Crab', critterHue: '#DD4444', dirBase: 'proj', dirTail: '  ⌥main · clean' },
    statusRight: 'no blocking issues detected — changes reach new sessions',
    legend: '↑↓ move · ↵ change (saved) · ⌫ default · a apply receipts · esc back',
  }
  // The explicit arm spells the CURRENT defaults (the
  // default moreHint stopped naming a repo doc — the honest trail sentence).
  const explicit = { ...legacy, title: 'boot menu', summaryTitle: 'LAUNCH SUMMARY', moreHint: '… (the trail continues — a taller terminal shows it whole)', entries: legacyEntries.map(e => ({ ...e, inert: false })) }
  for (const [cols, rows] of [[120, 40], [142, 44], [100, 30], [80, 24]] as const) {
    const a = (core.composeBootMenu(cols, rows, legacy) as { lines: string[] }).lines.join('\n')
    const b = (core.composeBootMenu(cols, rows, explicit) as { lines: string[] }).lines.join('\n')
    t.check(`${cols}x${rows}: absent host fields ≡ their explicit defaults (byte-identical)`, a === b)
    t.check(`${cols}x${rows}: the boot menu keeps its caption and panels`, a.includes(cols >= 110 ? '⌁ boot menu' : '· boot menu') && (cols < 110 || (a.includes('LAUNCH SUMMARY') && a.includes('Profile') && a.includes('ENVIRONMENT'))))
  }
  // An empty catalogue (selIdx -1 + a detail override) and an inert line
  // compose without a throw at both tiers; the inert line never wears ❯.
  const inertM = {
    entries: [
      { label: 'no MCP servers configured — add one with /mcp add', group: 'MCPs', groupTitle: 'MCPs', summary: '', valueLabel: '—', valueIsDefault: true, pinnedVal: null, detail: null, inert: true },
      { label: 'no skills found — create one under .mercury/skills/', group: 'Skills', groupTitle: 'Skills', summary: '', valueLabel: '—', valueIsDefault: true, pinnedVal: null, detail: null, inert: true },
    ],
    selIdx: -1,
    title: 'mcps & skills',
    summaryTitle: 'NEXT SESSION',
    summaryRows: [{ key: 'MCPs', value: '0 on' }, { key: 'Skills', value: '0 on' }, { key: 'Applies', value: '● the next session', tone: 'teal' }],
    environment: { model: 'Opus 5', critter: 'Crab', critterHue: '#DD4444', dirBase: 'proj', dirTail: '' },
    statusRight: 'the next session starts with what is on',
    legend: '↑↓ move · esc back',
    detailOverride: ['nothing to toggle yet for this project'],
  }
  for (const [cols, rows] of [[120, 40], [100, 30]] as const) {
    let lines: string[] = []
    let threw = false
    try {
      lines = (core.composeBootMenu(cols, rows, inertM) as { lines: string[] }).lines
    } catch {
      threw = true
    }
    const plain = lines.map(l => l.replace(/\x1b\[[0-9;]*m/g, ''))
    t.check(`${cols}x${rows}: the empty manager composes (no throw) with both section titles verbatim and no ❯ on an inert line`, !threw && plain.some(l => l.includes('MCPs')) && plain.some(l => l.includes('Skills')) && !plain.some(l => l.includes('❯ no ')), threw ? 'threw' : plain.filter(l => /MCPs|Skills|❯/.test(l)).join(' | ').slice(0, 160))
    t.check(`${cols}x${rows}: the manager wears its own caption and (wide) its NEXT SESSION panel — never the boot menu's Profile rows`, plain.some(l => l.includes(cols >= 110 ? '⌁ mcps & skills' : '· mcps & skills')) && !plain.some(l => l.includes('Profile')) && (cols < 110 || plain.some(l => l.includes('NEXT SESSION'))))
    t.check(`${cols}x${rows}: the empty catalogue composes with ZERO entries too (no undefined-row read)`, (() => { try { core.composeBootMenu(cols, rows, { ...inertM, entries: [] }); return true } catch { return false } })())
  }
  t.check('the wide tier titles a section verbatim (groupTitle) — never an upper-cased MCPS', (core.composeBootMenu(120, 40, inertM) as { lines: string[] }).lines.some(l => l.includes('MCPs')) && !(core.composeBootMenu(120, 40, inertM) as { lines: string[] }).lines.some(l => l.includes('MCPS')))
}

t.section("§4 — THE SCREEN'S ENTRIES: words for every state, the master row's plain sentence, both sections always")
{
  const empty = sectionRows(EMPTY_KIT_CATALOGUE)
  t.check('an empty catalogue yields both sections in the ruled order, one inert line each', empty.length === 2 && empty[0]?.kind === 'empty' && empty[0]?.section === 'mcp' && empty[1]?.kind === 'empty' && empty[1]?.section === 'skill')
  // AMENDED (the byte, not the law): an empty section leads
  // with its DOOR (the OS-1 empty-state precedent) — what is not there, then
  // the way to make one.
  t.check("the empty lines say what is not there AND the door (no nag): '… — add one with /mcp add' · '… — create one under .mercury/skills/'", empty[0]?.kind === 'empty' && empty[0].text === 'no MCP servers configured — add one with /mcp add' && empty[1]?.kind === 'empty' && empty[1].text === 'no skills found — create one under .mercury/skills/')
  const master: KitRow = { kind: 'extension', section: 'skill', name: 'orchard-tools', contributes: '2 skills · 1 server · 1 command · hooks' }
  const e = kitEntryOf(master)
  t.check("the master row names the extension and says plainly that off turns off EVERYTHING it contributes", e.label === 'orchard-tools (extension)' && e.summary.includes('off turns off EVERYTHING it contributes') && e.summary.includes('2 skills · 1 server · 1 command · hooks'))
  const skill = kitEntryOf({ kind: 'skill', section: 'skill', name: 'deploy', source: 'project settings', extension: null })
  t.check("a skill's summary explains the tri-state in words (on ambient · invocable loads only on /name · off absent)", skill.summary.includes('invocable') && skill.summary.includes('/deploy') && skill.summary.includes('never') === false && skill.summary.includes('off is absent'))
  const mcp = kitEntryOf({ kind: 'mcp', section: 'mcp', name: 'ext:orchard-tools:db', scope: 'dynamic', extension: 'orchard-tools' })
  t.check("an extension server's label IS its resolved spelling (ext:<extension>:<server>) and names its extension", mcp.label === 'ext:orchard-tools:db' && mcp.summary.includes('from the orchard-tools extension'))
  t.check('every entry title is the section word verbatim (MCPs · Skills)', e.groupTitle === KIT_SECTION_TITLE.skill && mcp.groupTitle === KIT_SECTION_TITLE.mcp && KIT_SECTION_TITLE.mcp === 'MCPs' && KIT_SECTION_TITLE.skill === 'Skills')
  t.check('row ids are stable and data-derived (the list identity law)', kitRowId(master) === 'extension:skill:orchard-tools' && kitRowId(empty[0]!) === 'empty:mcp' && kitRowId({ kind: 'mcp', section: 'mcp', name: 'github', scope: 'user', extension: null }) === 'mcp:github')
  t.check('a state is a WORD, never colour alone: the default reads on; an empty line reads —', skill.valueLabel === 'on' && mcp.valueLabel === 'on' && kitEntryOf(empty[0]!).valueLabel === '—' && kitEntryOf(empty[0]!).inert === true)
}

t.section('§5 — THE STILLS: the face with the row (both worlds) and the manager (100 · 120 cols) match the written fixtures')
{
  for (const still of STILLS) {
    const want = readStill(still.id)
    const got = renderStill(still.compose())
    if (want === null) {
      t.check(`${still.id}: fixture present (bun scripts/ui/kit-menu-stills.ts --write)`, false, stillPath(still.id))
      continue
    }
    const firstDiff = (() => {
      const a = want.split('\n')
      const b = got.split('\n')
      for (let i = 0; i < Math.max(a.length, b.length); i++) if (a[i] !== b[i]) return `line ${i + 1}: ${JSON.stringify(a[i] ?? '')} → ${JSON.stringify(b[i] ?? '')}`
      return ''
    })()
    t.check(`${still.id}: byte-identical to the fixture`, want === got, firstDiff.slice(0, 200))
  }
  const fullFace = readStill('face-full-120x40') ?? ''
  const chatFace = readStill('face-chat-120x40') ?? ''
  t.check('the full-world still carries MCPs & Skills under Boot Menu and above Doctor', fullFace.includes('Boot Menu') && fullFace.indexOf('Boot Menu') < fullFace.indexOf('MCPs & Skills') && fullFace.indexOf('MCPs & Skills') < fullFace.indexOf('Doctor / Health Check'))
  t.check('the --chat still carries the row too and no Session Concourse', chatFace.includes('MCPs & Skills') && !chatFace.includes('Session Concourse'))
  const manager = readStill('manager-120x40') ?? ''
  t.check('the manager still: two titled sections, the master row above its items in each, every state a word', manager.includes('MCPs') && manager.indexOf('MCPs') < manager.indexOf('Skills') && manager.includes('orchard-tools (extension)') && manager.indexOf('orchard-tools (extension)') < manager.indexOf('ext:orchard-tools:db') && manager.includes(' on') && manager.includes('NEXT SESSION'))
  const mid = readStill('manager-120x40-midcycle') ?? ''
  // github on · postgres off · ext:orchard-tools:db follows its OFF master ⇒
  // 1 on · 2 off; deploy invocable · review on · notes off · the two
  // extension skills follow the master ⇒ 1 on · 1 invocable · 3 off.
  t.check('the mid-cycle still speaks the tri-state in words (invocable · off · off (extension)) and the counts follow the EFFECTIVE states', mid.includes('invocable') && mid.includes('off (extension)') && mid.includes('1 on · 2 off') && mid.includes('1 on · 1 invocable · 3 off'))
}

t.section('§6 — THE CONTAINER: cycling, the tri-state words, the master row, key truth (C2)')
{
  const rows = sectionRows(SAMPLE_CATALOGUE)
  const mcp = rows.find(r => r.kind === 'mcp' && r.name === 'github')!
  const skill = rows.find(r => r.kind === 'skill' && r.name === 'deploy')!
  const master = rows.find(r => r.kind === 'extension')!
  const extSkill = rows.find(r => r.kind === 'skill' && r.name === 'orchard-tools:prune')!
  const extServer = rows.find(r => r.kind === 'mcp' && r.name === 'ext:orchard-tools:db')!
  // The rings.
  t.check('an MCP server cycles on → off → on (↵/space/→)', cycleState(mcp, 'on', 1) === 'off' && cycleState(mcp, 'off', 1) === 'on')
  t.check('a skill cycles on → invocable → off → on', cycleState(skill, 'on', 1) === 'invocable' && cycleState(skill, 'invocable', 1) === 'off' && cycleState(skill, 'off', 1) === 'on')
  t.check('← walks the ring back (on ← invocable ← off)', cycleState(skill, 'on', -1) === 'off' && cycleState(skill, 'off', -1) === 'invocable' && cycleState(skill, 'invocable', -1) === 'on' && cycleState(mcp, 'on', -1) === 'off')
  t.check('a master row cycles on ⇄ off (never invocable)', cycleState(master, 'on', 1) === 'off' && cycleState(master, 'off', 1) === 'on' && cycleState(master, 'on', -1) === 'off')
  // The state keys: deviations only, one key per extension across sections.
  const masterInSkills = rows.find(r => r.kind === 'extension' && r.section === 'skill')!
  const masterInMcps = rows.find(r => r.kind === 'extension' && r.section === 'mcp')!
  t.check("an extension's two master rows share ONE state key (the section is not part of it)", kitStateKey(masterInSkills) === kitStateKey(masterInMcps) && kitStateKey(masterInMcps) === 'extension:orchard-tools')
  t.check('items key by their resolved spelling; an empty line has no key', kitStateKey(extServer) === 'mcp:ext:orchard-tools:db' && kitStateKey(extSkill) === 'skill:orchard-tools:prune' && kitStateKey({ kind: 'empty', section: 'mcp', text: 'x' }) === null)
  // Default all-on by construction: an EMPTY state map reads on everywhere.
  const none = new Map<string, KitRowState>()
  t.check('default all-on: with no recorded deviation every row reads on and nothing is master-off', rows.filter(r => r.kind !== 'empty').every(r => { const v = kitRowView(r, none); return v.own === 'on' && v.effective === 'on' && !v.masterOff }))
  const c0 = kitCounts(rows, none)
  t.check('the fresh counts: 3 MCPs on · 0 off; 5 skills on · 0 invocable · 0 off', c0.mcp.on === 3 && c0.mcp.off === 0 && c0.skill.on === 5 && c0.skill.invocable === 0 && c0.skill.off === 0)
  // The mid-cycle set: Option 2's master-off follows.
  const vExtSkill = kitRowView(extSkill, SAMPLE_STATES)
  const vExtServer = kitRowView(extServer, SAMPLE_STATES)
  t.check('master OFF ⇒ its items are EFFECTIVELY off whatever their own state (own kept for the return)', vExtSkill.masterOff && vExtSkill.effective === 'off' && vExtSkill.own === 'on' && vExtServer.masterOff && vExtServer.effective === 'off')
  t.check("the item's word says so: 'off (extension)'; a plain row's word is its own state", kitValueLabel(extSkill, vExtSkill) === 'off (extension)' && kitValueLabel(skill, kitRowView(skill, SAMPLE_STATES)) === 'invocable' && kitValueLabel(mcp, kitRowView(mcp, SAMPLE_STATES)) === 'on')
  const c1 = kitCounts(rows, SAMPLE_STATES)
  t.check('the counts follow the EFFECTIVE states (postgres off + the extension server follows its master: 2 on · 1 off... and skills 1 on · 1 invocable · 3 off)', c1.mcp.on === 1 && c1.mcp.off === 2 && c1.skill.on === 1 && c1.skill.invocable === 1 && c1.skill.off === 3)
  t.check('the NEXT SESSION rows are the counts in words', JSON.stringify(kitSummaryRows(c1).map(r => r.value)) === JSON.stringify(['1 on · 2 off', '1 on · 1 invocable · 3 off', '● the next session']))
  // Every value label is one of the ruled words; never a colour-only state
  // (a note carries no value — its sentence is the row).
  const WORDS = new Set(['on', 'invocable', 'off', 'off (extension)', '—', ''])
  t.check('every value label is one of the ruled words', rows.every(r => WORDS.has(kitValueLabel(r, kitRowView(r, SAMPLE_STATES)))) && rows.every(r => WORDS.has(kitValueLabel(r, kitRowView(r, none)))))
  t.check("valueIsDefault is exactly 'own on and not master-off' (the faint/cream tone follows the word, never replaces it)", kitEntryOf(skill, kitRowView(skill, SAMPLE_STATES)).valueIsDefault === false && kitEntryOf(mcp, kitRowView(mcp, SAMPLE_STATES)).valueIsDefault === true && kitEntryOf(extSkill, vExtSkill).valueIsDefault === false)
  t.check("a master-off item's detail names the extension that holds it off", kitEntryOf(extSkill, vExtSkill).detailExtra?.some(l => l.includes('orchard-tools (extension) is off')) === true)
  // Key truth: the legend names only bound keys.
  const screen = read('src/components/KitMenuScreen.tsx')
  const bound = { return: screen.includes("key: 'return'"), space: screen.includes("key: ' '"), backspace: screen.includes("key: 'backspace'"), arrows: screen.includes('key.leftArrow') && screen.includes('key.rightArrow'), esc: screen.includes('onClose: () =>') }
  // AMENDED (the byte, not the law): '← back' left the
  // legends — ← cycles the value backward on this screen (never leaves), so
  // the label was false beside 'esc back'. The arrows stay BOUND (the
  // settings-sibling shape: cycle synonyms unadvertised, ↵ the named cycle).
  t.check('the legend names ↵ · ⌫ · esc · ↑↓, every named key is bound, and the ←→ cycle stays bound unadvertised', KIT_LEGEND === '↑↓ move · ↵ change · ⌫ default · esc back' && KIT_LEGEND_SAVED === '↑↓ move · ↵ change (saved) · ⌫ default · esc back' && Object.values(bound).every(Boolean))
  t.check("the store-bound screen wears the '(saved)' legend (with the preset key) and its status line says a running session is never touched", screen.includes('legend: preset.open ? KIT_LEGEND_PROMPT : KIT_LEGEND_PRESET') && KIT_LEGEND_PRESET.startsWith(KIT_LEGEND_SAVED.replace(' · esc back', '')) && KIT_LEGEND_PRESET.includes('p save as preset…') && screen.includes("key: 'p'") && kitStatusLine(0).includes('never a running one'))
  t.check('a click activates through the same toggle body as ↵ (onActivate rides the primary action)', screen.includes('onActivate={props.onActivate}') && screen.includes("{ key: 'return', hint: 'change', run: row => ({ pending: 'saving…', result: Promise.resolve().then(() => cycleRow(row, 1)) }) }"))
  {
    // The record keeps deviations only — the own updaters delete
    // the key on 'on' (the store door rides their pens, never a re-spelling).
    const { withSkillState, withExtensionState } = await import('../../src/services/mcp/kitStore.js')
    const slice = { allowedTools: [], mcpContextUris: [], projectOnboardingSeenCount: 0, skillStates: { deploy: 'invocable' as const }, extensionStates: { 'orchard-tools': 'off' as const } } as never
    const onSkill = withSkillState(slice, 'deploy', 'on') as { skillStates?: unknown }
    const onExt = withExtensionState(slice, 'orchard-tools', true) as { extensionStates?: unknown }
    t.check("the record keeps deviations only: the record's withSkillState/withExtensionState DELETE the key on 'on', and the store door rides exactly those pens", onSkill.skillStates === undefined && onExt.extensionStates === undefined && read('src/services/kitMenu/menuStore.ts').includes("from '../mcp/kitStore.js'"))
  }
  t.check('cycling a master-off item answers in words instead of moving a hidden value', screen.includes('turn the extension on first'))
  // Both tiers compose the words at the mid-cycle set.
  for (const [cols, rowsN] of [[120, 40], [100, 30]] as const) {
    const plain = composeManager(cols, rowsN, SAMPLE_CATALOGUE, 4, SAMPLE_STATES).join('\n')
    t.check(`${cols}x${rowsN}: the composed manager speaks invocable · off · off (extension) and titles both sections`, plain.includes('invocable') && plain.includes('off (extension)') && plain.includes('MCPs') && plain.includes('Skills'))
  }
}

t.section("§7 — THE ENUMERATION: the rows are the doors' own spellings (C3)")
{
  const { IDE_CLIENT_NAME, MCP_SKILLS_NOTE, contributesWords, enumerateKitCatalogue } = await import('../../src/services/kitMenu/kitCatalogue.js')
  // The doors' OWN output shapes (getAllMcpConfigs · getSkillDirCommands ·
  // getExtensionSkills · getActiveSet().active), fed cpu-pure.
  const manifest = (name: string, contributes: Record<string, unknown>) => ({ name, version: '1.0.0', description: 'x', contributes }) as never
  const orchard = manifest('orchard-tools', { skills: ['prune', 'graft'], servers: { db: { command: 'x' } }, commands: ['tidy'], hooks: { PreToolUse: [{ hooks: [{ type: 'command', command: 'x' }] }] } })
  const quiet = manifest('quiet-hooks', { commands: ['lint'], hooks: { PreToolUse: [{ hooks: [{ type: 'command', command: 'x' }] }] } })
  const prompt = (name: string, extra: Record<string, unknown>) => ({ type: 'prompt', name, description: 'd', ...extra }) as never
  const doors = {
    mcpConfigs: async () => ({
      servers: {
        github: { type: 'stdio', command: 'gh', scope: 'user' },
        postgres: { type: 'stdio', command: 'pg', scope: 'project' },
        [IDE_CLIENT_NAME]: { type: 'stdio', command: 'ide', scope: 'local' },
        'ext:orchard-tools:db': { type: 'stdio', command: 'db', scope: 'dynamic', extensionSource: 'orchard-tools@local' },
      } as never,
    }),
    dirSkills: async () => [
      prompt('deploy', { source: 'projectSettings', loadedFrom: 'skills' }),
      prompt('notes', { source: 'userSettings', loadedFrom: 'legacy-commands' }),
      prompt('extension-maker', { source: 'bundled', loadedFrom: 'bundled' }), // an organ — never listed
      prompt('mcp-derived', { source: 'mcp', loadedFrom: 'mcp' }), // derived from a server — never a face row
    ],
    extensionSkills: () => [
      prompt('orchard-tools:prune', { source: 'extension', loadedFrom: 'extension', extensionInfo: { manifest: orchard, id: 'orchard-tools@local' } }),
      prompt('orchard-tools:graft', { source: 'extension', loadedFrom: 'extension', extensionInfo: { manifest: orchard, id: 'orchard-tools@local' } }),
    ],
    activeExtensions: () => [{ manifest: orchard }, { manifest: quiet }],
  }
  const cat = await enumerateKitCatalogue('/proof/cwd', doors as never)
  const names = (section: 'mcp' | 'skill') => cat.rows.filter(r => r.section === section).map(r => (r.kind === 'note' || r.kind === 'empty' ? `(${r.kind})` : r.kind === 'extension' ? `[${r.name}]` : r.name))
  t.check("MCPs: the doors' keys verbatim, the ide client excluded (the /mcp exemption), the extension's server under its master row", JSON.stringify(names('mcp')) === JSON.stringify(['github', 'postgres', '[orchard-tools]', 'ext:orchard-tools:db']), names('mcp').join(' · '))
  t.check("Skills: loader skills verbatim (SKILL.md + legacy commands), NO bundled organ, NO mcp-derived row, the extension's skills under its master, the commands/hooks-only extension's master in Skills, the ruled note LAST", JSON.stringify(names('skill')) === JSON.stringify(['deploy', 'notes', '[orchard-tools]', 'orchard-tools:prune', 'orchard-tools:graft', '[quiet-hooks]', '(note)']), names('skill').join(' · '))
  const note = cat.rows.find(r => r.kind === 'note')
  t.check('the note is the ruled sentence', note?.kind === 'note' && note.text === MCP_SKILLS_NOTE && MCP_SKILLS_NOTE === 'skills from MCP servers appear once a session connects them')
  t.check('the note composes WHOLE at the wide tier (no clipped ellipsis — it carries no value word)', kitValueLabel(note!) === '' && composeManager(120, 40).some(l => l.includes('skills from MCP servers appear once a session connects them') && !l.includes('them…')))
  const master = cat.rows.find(r => r.kind === 'extension' && r.name === 'orchard-tools')
  t.check("the master row's words count what its off turns off: skills · servers · commands · hooks", master?.kind === 'extension' && master.contributes === '2 skills · 1 server · 1 command · hooks', master?.kind === 'extension' ? master.contributes : '')
  t.check('contributesWords: singular/plural and the switch-only kinds', contributesWords(quiet) === '1 command · hooks' && contributesWords(manifest('bare', {})) === 'nothing yet')
  const extServer = cat.rows.find(r => r.kind === 'mcp' && r.name === 'ext:orchard-tools:db')
  t.check('an extension server carries its extension (parsed from the runtime name) and the dynamic scope', extServer?.kind === 'mcp' && extServer.extension === 'orchard-tools' && extServer.scope === 'dynamic')
  const deploy = cat.rows.find(r => r.kind === 'skill' && r.name === 'deploy')
  t.check("a loader skill names its settings home in words ('project settings')", deploy?.kind === 'skill' && deploy.source === 'project settings' && deploy.extension === null)
  // POISON: a menu name no door resolves — every member name must be a key
  // or a command name the doors answered with, byte for byte.
  const doorNames = new Set(['github', 'postgres', 'ext:orchard-tools:db', 'deploy', 'notes', 'orchard-tools:prune', 'orchard-tools:graft'])
  t.check('POISON absent: every server/skill row name is a door spelling verbatim (no prettified or re-cased name)', cat.rows.filter(r => r.kind === 'mcp' || r.kind === 'skill').every(r => doorNames.has(r.name)))
  // The section list composes the note last and the loading catalogue says so.
  const listed = sectionRows(cat)
  t.check('sectionRows keeps members first and the note last, both sections titled', listed[listed.length - 1]?.kind === 'note' && listed[0]?.section === 'mcp' && listed.some(r => r.section === 'skill'))
  const { LOADING_KIT_CATALOGUE } = await import('../../src/services/kitMenu/kitTypes.js')
  t.check('the loading catalogue paints "reading…" lines, never the none-configured words', sectionRows(LOADING_KIT_CATALOGUE).every(r => r.kind === 'empty' && r.text.startsWith('reading')))
  // A REAL-door smoke under a scratch config home + scratch cwd: no throw,
  // no server, no skill, the note present (never a spawn: the doors read
  // files; the connector fetch is opt-in and unarmed here).
  {
    const { mkdtempSync, rmSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const scratch = mkdtempSync(join(tmpdir(), 'kit-menu-doors-'))
    const savedHome = process.env.MERCURY_CONFIG_DIR
    process.env.MERCURY_CONFIG_DIR = join(scratch, 'home')
    delete process.env.MERCURY_CLAUDEAI_MCP
    // The estate's config gate: a proof reads config only after it says so
    // (the home is pinned to scratch above, before the first read).
    const { enableConfigs } = await import('../../src/utils/config/globalConfig.js')
    enableConfigs()
    try {
      const real = await enumerateKitCatalogue(join(scratch, 'cwd'))
      const kinds = real.rows.map(r => r.kind)
      t.check('the real doors answer under a scratch home: no throw, the ruled note present, every row a member or the note', real.rows.some(r => r.kind === 'note') && kinds.every(k => k === 'mcp' || k === 'skill' || k === 'extension' || k === 'note'))
      t.check('a scratch cwd with no skills homes lists no loader skill and no bundled organ', !real.rows.some(r => r.kind === 'skill' && r.extension === null) && !real.rows.some(r => r.kind === 'skill' && r.name === 'extension-maker'))
    } finally {
      if (savedHome === undefined) delete process.env.MERCURY_CONFIG_DIR
      else process.env.MERCURY_CONFIG_DIR = savedHome
      rmSync(scratch, { recursive: true, force: true })
    }
  }
}

t.section("§8 — THE STORE WRITE: write-through per toggle onto the REAL record (the record's kitStore), a live session untouched (C4 · C6)")
{
  const { RecordKitMenuStore, receiptFor, statesFromDeltas, deltasFromStates } = await import('../../src/services/kitMenu/menuStore.js')
  const { kitDeltasForWorkspace, kitDeltasOf, emptyKitDeltas } = await import('../../src/services/mcp/kitStore.js')
  const { getProjectConfigForWorkspace } = await import('../../src/utils/config.js')
  const rows = sectionRows(SAMPLE_CATALOGUE)
  const postgres = rows.find(r => r.kind === 'mcp' && r.name === 'postgres')!
  const deploy = rows.find(r => r.kind === 'skill' && r.name === 'deploy')!
  const master = rows.find(r => r.kind === 'extension' && r.section === 'skill')!
  const prune = rows.find(r => r.kind === 'skill' && r.name === 'orchard-tools:prune')!
  // The REAL record under a scratch config home (the estate's config gate
  // enabled after the home is pinned — never the operator's home).
  const { mkdirSync, mkdtempSync, rmSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const scratch = mkdtempSync(join(tmpdir(), 'kit-menu-record-'))
  const savedHome = process.env.MERCURY_CONFIG_DIR
  process.env.MERCURY_CONFIG_DIR = join(scratch, 'home')
  mkdirSync(join(scratch, 'home'), { recursive: true })
  const WS = join(scratch, 'repo')
  const OTHER = join(scratch, 'other')
  mkdirSync(WS, { recursive: true })
  mkdirSync(OTHER, { recursive: true })
  const { enableConfigs } = await import('../../src/utils/config/globalConfig.js')
  enableConfigs()
  try {
    const store = new RecordKitMenuStore()
    // Default all-on on a fresh record; the screen paints no nag.
    t.check('a fresh record reads EMPTY (every row on — default all-on by construction)', store.read(WS).size === 0 && rows.filter(isMember).every(r => kitRowView(r, store.read(WS)).effective === 'on'))
    const fresh = kitStatusLine(0)
    t.check("the fresh status line is the all-on truth and never a nag (no 'configure' / 'set up' / 'choose' words)", fresh === 'everything on — changes apply to the next session, never a running one' && !/configure|set up|choose|please/i.test(fresh))
    t.check('the standing line counts the saved choices once any stand', kitStatusLine(1) === '1 choice saved — applies to the next session' && kitStatusLine(3).startsWith('3 choices saved'))
    // Tri-state round-trips through the RECORD (re-open = read again; the
    // read rides the own kitDeltasForWorkspace).
    t.check("write deploy → invocable, re-read: invocable (receipt 'deploy → invocable')", JSON.stringify(store.write(WS, deploy, 'invocable')) === JSON.stringify({ ok: true, receipt: 'deploy → invocable' }) && store.read(WS).get('skill:deploy') === 'invocable' && kitDeltasForWorkspace(WS).skillStates['deploy'] === 'invocable')
    t.check('write deploy → off, re-read: off', store.write(WS, deploy, 'off').ok && store.read(WS).get('skill:deploy') === 'off')
    t.check('write deploy → on, re-read: the deviation is GONE (absent = on; the record carries no skillStates key)', store.write(WS, deploy, 'on').ok && !store.read(WS).has('skill:deploy') && getProjectConfigForWorkspace(WS).skillStates === undefined)
    t.check("an unchanged write writes nothing and says so ('deploy already on')", JSON.stringify(store.write(WS, deploy, 'on')) === JSON.stringify({ ok: true, receipt: 'deploy already on' }))
    t.check("an MCP server off/on round-trips through the landed disabled record ('postgres → off' ⇒ disabledMcpServers carries it; on ⇒ gone)", store.write(WS, postgres, 'off').ok && store.read(WS).get('mcp:postgres') === 'off' && (getProjectConfigForWorkspace(WS).disabledMcpServers ?? []).includes('postgres') && store.write(WS, postgres, 'on').ok && !store.read(WS).has('mcp:postgres') && !(getProjectConfigForWorkspace(WS).disabledMcpServers ?? []).includes('postgres'))
    // The master row round-trips and its items follow (Option 2).
    t.check("master off round-trips: 'orchard-tools (extension) → off' (extensionStates carries it); its skill reads effectively off; master on ⇒ gone", store.write(WS, master, 'off').ok && getProjectConfigForWorkspace(WS).extensionStates?.['orchard-tools'] === 'off' && kitRowView(prune, store.read(WS)).effective === 'off' && kitRowView(prune, store.read(WS)).masterOff && store.write(WS, master, 'on').ok && !store.read(WS).has('extension:orchard-tools') && kitRowView(prune, store.read(WS)).effective === 'on')
    // Per repo (O-2): a write under one workspace never shows under another.
    store.write(WS, postgres, 'off')
    t.check('KEYED BY WORKSPACE: the write under one repo is invisible under another', store.read(OTHER).size === 0 && store.read(WS).get('mcp:postgres') === 'off')
    // THE ONE SHAPE: the screen's rendering rides the own reader
    // (disabledRecord semantics included) — no local re-spelling survives.
    store.write(WS, deploy, 'invocable')
    store.write(WS, master, 'off')
    const deltas = kitDeltasForWorkspace(WS)
    t.check("the record's deltas after three writes are the record's exact shape", JSON.stringify(deltas) === JSON.stringify({ mcpOff: ['postgres'], skillStates: { deploy: 'invocable' }, extensionsOff: ['orchard-tools'] }), JSON.stringify(deltas))
    t.check("statesFromDeltas renders the record's deltas to the screen's keys; deltasFromStates renders them back; the empty record is their emptyKitDeltas", JSON.stringify([...statesFromDeltas(deltas)]) === JSON.stringify([['mcp:postgres', 'off'], ['skill:deploy', 'invocable'], ['extension:orchard-tools', 'off']]) && JSON.stringify(deltasFromStates(statesFromDeltas(deltas))) === JSON.stringify(deltas) && JSON.stringify(kitDeltasOf({ allowedTools: [], mcpContextUris: [], projectOnboardingSeenCount: 0 } as never)) === JSON.stringify(emptyKitDeltas))
    t.check('receipts name the row and its word; a master row names itself as an extension', receiptFor(master, 'off', true) === 'orchard-tools (extension) → off' && receiptFor(postgres, 'off', false) === 'postgres already off')
  } finally {
    if (savedHome === undefined) delete process.env.MERCURY_CONFIG_DIR
    else process.env.MERCURY_CONFIG_DIR = savedHome
    rmSync(scratch, { recursive: true, force: true })
  }
  // POISON: a live-record mutation from the screen — structural: the screen
  // and the store door reach no daemon/session writer. (The L18 carrier —
  // setNextSessionFacts — is the NEXT-session record, never a running
  // session: bootBirthFacts' own law; it is not a live door.)
  const screenSrc = read('src/components/KitMenuScreen.tsx')
  const storeSrc = read('src/services/kitMenu/menuStore.ts')
  const LIVE_DOORS = ['sessionControl', 'daemonConnector', 'set-kit', 'stampSessionKit', 'restampSessionKit', 'dispatchSlash', 'hopIntoSession', 'bornSession']
  t.check('POISON absent: the screen touches no live-session door (its only supervisor read is the established-session COUNT)', LIVE_DOORS.every(tok => !screenSrc.includes(tok)) && (screenSrc.match(/sup\.\w+/g) ?? []).every(m => m === 'sup.countLiveConcourseWorkers'))
  t.check("POISON absent: the store door imports nothing from the daemon and writes only through the record's workspace-keyed pens", !storeSrc.includes("from '../../daemon") && LIVE_DOORS.every(tok => !storeSrc.includes(tok)) && storeSrc.includes("from '../mcp/kitStore.js'") && storeSrc.includes('setMcpServerEnabledForWorkspace(workspaceDir, row.name, next !== \'off\')') && storeSrc.includes('setSkillStateForWorkspace(workspaceDir, row.name, next)') && storeSrc.includes('setExtensionStateForWorkspace(workspaceDir, row.name, next !== \'off\')'))
  t.check('the fixture is retired: the store the screen binds by default IS the record store', storeSrc.includes('export const kitMenuStore: KitMenuStore = new RecordKitMenuStore()') && !storeSrc.includes('Fixture'))
  t.check('the record write runs through the event loop, never inside the keypress handler (the boot menu\'s law)', (screenSrc.match(/pending: 'saving…', result: Promise\.resolve\(\)\.then\(/g) ?? []).length === 3 && screenSrc.includes('void Promise.resolve().then(() => cycleRow(selectedRow'))
  t.check('the screen re-reads the record after every write (the visible state IS the saved state) and surfaces the receipt', screenSrc.includes('setStates(store.read(workspaceDir));') && screenSrc.includes('setLastReceipt(res.receipt);') && screenSrc.includes('list.note ?? lastReceipt ?? kitStatusLine(states.size)'))
  t.check('the screen keys the record by the face\'s ground at mount (per repo)', screenSrc.includes('useState(() => givenWorkspace ?? process.cwd())'))
  function isMember(r: KitRow): boolean {
    return r.kind === 'mcp' || r.kind === 'skill' || r.kind === 'extension'
  }
}

t.section('§9 — "SAVE AS PRESET…": the action hook, its prompt, the typed refusal, the vocabulary (C5)')
{
  const { STORE_PRESET_HOOK, _resetKitPresetHookForTesting, bindKitPresetHook, kitPresetHook, presetNameProblem, PRESET_NAME_MAX } = await import('../../src/services/kitMenu/presetHook.js')
  const { deltasFromStates, statesFromDeltas } = await import('../../src/services/kitMenu/menuStore.js')
  // The name's problems, in words.
  t.check("an empty name refuses in words ('type a name first'); whitespace is empty", presetNameProblem('') === 'type a name first' && presetNameProblem('   ') === 'type a name first')
  t.check('a bad name refuses in words; a plain name passes; the cap is 40', presetNameProblem('review/kit') !== null && presetNameProblem('review kit') === null && presetNameProblem('a'.repeat(40)) === null && presetNameProblem('a'.repeat(41)) !== null && PRESET_NAME_MAX === 40)
  // AMENDED (the earlier pin held the typed
  // refusal 'presets are not wired in this build'; that placeholder is DEAD
  // — the default hook IS the store door now): a save through the default
  // hook LANDS in the global preset store under the scratch home the §7
  // block pinned, and answers the store's own counted receipt. The store's
  // own laws (round-trip, refusals, caps, isolation) are prove-kit-presets'.
  _resetKitPresetHookForTesting()
  const presetStore = await import('../../src/services/mcp/presetStore.ts')
  const storeSaved = kitPresetHook().save('menu door', { workspaceDir: '/proof/repo', deltas: { mcpOff: ['postgres'], skillStates: {}, extensionsOff: [] }, members: { mcp: ['postgres'], skills: [], extensions: [] } })
  const storeBack = presetStore.kitPresetDeltas('menu door')
  t.check("the DEFAULT hook is the store door: the save lands in the preset store with the counted receipt (the typed-refusal placeholder is dead)", storeSaved.ok && storeSaved.receipt === "preset 'menu door' saved (1 delta)" && storeBack.ok && storeBack.deltas.mcpOff[0] === 'postgres' && kitPresetHook() === STORE_PRESET_HOOK)
  presetStore.deleteKitPreset('menu door')
  // A bound hook receives the SNAPSHOT: the record's deltas + the roster.
  const calls: Array<{ name: string; snapshot: unknown }> = []
  bindKitPresetHook({ save: (name, snapshot) => { calls.push({ name, snapshot }); return { ok: true, receipt: `saved preset ${name}` } } })
  const res = kitPresetHook().save('review kit', { workspaceDir: '/proof/repo', deltas: { mcpOff: ['postgres'], skillStates: { deploy: 'invocable' }, extensionsOff: ['orchard-tools'] }, members: { mcp: ['github', 'postgres'], skills: ['deploy'], extensions: ['orchard-tools'] } })
  t.check('a bound hook is what the screen reaches (the store door re-binds the seam) and answers its own receipt', res.ok && res.receipt === 'saved preset review kit' && calls.length === 1 && calls[0]?.name === 'review kit')
  _resetKitPresetHookForTesting()
  // The snapshot's deltas are the record's own shape: the inverse rendering round-trips.
  const deltas = { mcpOff: ['postgres'], skillStates: { deploy: 'invocable' as const }, extensionsOff: ['orchard-tools'] }
  t.check('deltasFromStates ∘ statesFromDeltas is the identity on the record (a preset snapshots the record exactly)', JSON.stringify(deltasFromStates(statesFromDeltas(deltas))) === JSON.stringify(deltas) && JSON.stringify(deltasFromStates(new Map())) === JSON.stringify({ mcpOff: [], skillStates: {}, extensionsOff: [] }))
  // The prompt's body and its keys.
  const lines = presetPromptLines('review k', null)
  t.check("the prompt paints the name with the live caret and its keys ('↵ save · esc cancel')", lines[0] === 'save as preset' && lines.includes('name: review k▌') && lines[lines.length - 1] === '↵ save · esc cancel')
  t.check('a note (the receipt or the refusal) replaces the keys line', presetPromptLines('x', 'type a name first')[lines.length - 1] === 'type a name first')
  // AMENDED (the byte, not the law): the legend gains the
  // `w` presets door beside `p` — save and wear are sibling ACTION keys.
  // AMENDED (the byte, not the law): '← back' left this
  // legend with its siblings — see the §4 legend-truth note.
  t.check("the legends: the screen names 'p save as preset…' and 'w presets…' beside the row keys; the open prompt names only its own keys; the layer its own", KIT_LEGEND_PRESET === '↑↓ move · ↵ change (saved) · ⌫ default · p save as preset… · w presets… · esc back' && KIT_LEGEND_PROMPT === 'type a name · ↵ save · esc cancel' && KIT_LEGEND_PRESETS === '↑↓ move · ↵ wear next session · ⌫ delete · esc back')
  // The screen: p opens; the list is inert while the prompt owns input; esc closes the prompt FIRST (never the screen); ↵ reaches the hook with the snapshot.
  const screenSrc = read('src/components/KitMenuScreen.tsx')
  // AMENDED (the needle, not the law): the manager list
  // now yields to TWO layers — the save prompt and the presets sub-list —
  // so the inert gate names both owners.
  t.check("p opens the prompt and the list goes inert while a layer owns input ('active: !preset.open && !presetsLayer.open')", screenSrc.includes("key: 'p'") && screenSrc.includes('setPreset({ open: true, name: \'\', note: null })') && screenSrc.includes('active: !preset.open && !presetsLayer.open') && screenSrc.includes('{ isActive: !preset.open && !presetsLayer.open }'))
  t.check('the prompt owns esc (closes the prompt, not the screen), ↵ (validates, then the hook with the snapshot) and ⌫; every key is consumed', screenSrc.includes('if (key.escape) {') && screenSrc.includes("setPreset({ open: false, name: '', note: null })") && screenSrc.includes('kitPresetHook().save(preset.name.trim(), snapshotOf())') && screenSrc.includes('presetNameProblem(preset.name)') && screenSrc.includes('{ isActive: preset.open }'))
  t.check("the snapshot is the record's deltas + the roster's resolved names", screenSrc.includes('deltas: deltasFromStates(states)') && screenSrc.includes("mcp: listRows.filter(r => r.kind === 'mcp').map(r => r.name)"))
  t.check("no third titled section: the preset door is a KEY + the detail body (no 'preset' row kind, no 'Presets' group)", !screenSrc.includes("kind: 'preset'") && !screenSrc.includes("group: 'Presets'") && !read('src/services/kitMenu/kitTypes.ts').includes("'preset'"))
  // THE VOCABULARY LAW: "pack" is the extensions estate's word — never this lane's.
  // Roster EXTENDED: the kit store and wear modules
  // join the sweep (their own prover sweeps the daemon/coordinator files).
  const laneSrc = ['src/components/KitMenuScreen.tsx', 'src/services/kitMenu/kitTypes.ts', 'src/services/kitMenu/kitCatalogue.ts', 'src/services/kitMenu/menuStore.ts', 'src/services/kitMenu/presetHook.ts', 'src/services/kitMenu/presetWear.ts', 'src/services/mcp/presetStore.ts']
  const packHits = laneSrc.filter(f => /\bpacks?\b/i.test(read(f).replace(/"pack" is reserved for extensions|"pack" is the extensions estate's word|"pack" is RESERVED for extensions/g, '')))
  t.check("the vocabulary law: the word 'pack' appears nowhere in the lane's sources (the law's own sentence excepted)", packHits.length === 0, packHits.join(','))
  // Both tiers compose the prompt.
  for (const [cols, rowsN] of [[120, 40], [100, 30]] as const) {
    const plain = composeManager(cols, rowsN, SAMPLE_CATALOGUE, 4, SAMPLE_STATES, { name: 'review kit', note: null }).join('\n')
    t.check(`${cols}x${rowsN}: the composed manager carries the prompt's legend${cols >= 110 ? ' and the name with its caret' : ''}`, plain.includes(KIT_LEGEND_PROMPT) && (cols < 110 || plain.includes('name: review kit▌')))
  }
}

t.section('§10 — THE L18 CARRY: the write seam hands the RESOLVED snapshot to the next birth (the PRIMARY road; the derivation is the fallback) (C7)')
{
  const { carryNextSessionKit, resolvedKitOf } = await import('../../src/services/kitMenu/resolvedKit.js')
  const { _resetBootBirthFactsForTesting, bootBirthFacts, carriedKitOf } = await import('../../src/services/switchboard/bootBirthFacts.js')
  const { validateSessionKit } = await import('../../src/daemon/sessionKit.js')
  const rows = sectionRows(SAMPLE_CATALOGUE)
  const kit = resolvedKitOf(rows, SAMPLE_STATES)
  t.check('the RESOLVED snapshot is closed membership over EFFECTIVE states: mcp [github] (postgres off; the extension server follows its off master) · skills [review] · invocable [deploy] · extensions {orchard-tools: off}; no `resolved` field', JSON.stringify(kit) === JSON.stringify({ schema: 1, mcp: ['github'], skills: ['review'], invocable: ['deploy'], extensions: { 'orchard-tools': 'off' } }), JSON.stringify(kit))
  const all = resolvedKitOf(rows, new Map())
  t.check('a fresh record resolves to EVERY member listed (the closed membership of all-on) with the master on', JSON.stringify(all.mcp) === JSON.stringify(['github', 'postgres', 'ext:orchard-tools:db']) && JSON.stringify(all.skills) === JSON.stringify(['deploy', 'review', 'notes', 'orchard-tools:prune', 'orchard-tools:graft']) && all.invocable.length === 0 && all.extensions?.['orchard-tools'] === 'on' && all.resolved === undefined)
  t.check("the wire's own narrowing (validateSessionKit) accepts the screen's snapshots", validateSessionKit(kit).ok && validateSessionKit(all).ok)
  const plainRows: KitRow[] = [{ kind: 'mcp', section: 'mcp', name: 'github', scope: 'user', extension: null }, { kind: 'skill', section: 'skill', name: 'deploy', source: 'project settings', extension: null }]
  t.check('a roster naming no extension carries no `extensions` field (absent, never {})', resolvedKitOf(plainRows, new Map()).extensions === undefined)
  _resetBootBirthFactsForTesting()
  const carried = carryNextSessionKit(rows, SAMPLE_STATES)
  t.check('the carry sets the next-session record (bootBirthFacts.kit) to the snapshot; carriedKitOf spreads exactly it for the admit', carried.carried && JSON.stringify(bootBirthFacts().kit) === JSON.stringify(kit) && JSON.stringify(carriedKitOf(bootBirthFacts())) === JSON.stringify({ kit }))
  _resetBootBirthFactsForTesting()
  const bad: KitRow[] = [{ kind: 'mcp', section: 'mcp', name: 'bad name!', scope: 'user', extension: null }]
  const refused = carryNextSessionKit(bad, new Map())
  t.check('a snapshot the wire would refuse is NOT carried (the record stays null — the daemon derives) and the reason is typed', !refused.carried && refused.reason.length > 0 && bootBirthFacts().kit === null && JSON.stringify(carriedKitOf(bootBirthFacts())) === '{}', refused.carried ? '' : refused.reason)
  const screenSrc = read('src/components/KitMenuScreen.tsx')
  t.check('the screen carries at the WRITE seam — after the re-read, once per write, never at mount (a closed snapshot is sticky for the boot; an untouched record leaves the derivation to answer)', (screenSrc.match(/carryNextSessionKit\(/g) ?? []).length === 1 && screenSrc.includes('const carry = carryNextSessionKit(listRows, store.read(workspaceDir));') && screenSrc.includes('setStates(store.read(workspaceDir));') && screenSrc.indexOf('carryNextSessionKit(listRows') > screenSrc.indexOf('setStates(store.read(workspaceDir));'))
  t.check("a refused carry is said on the receipt ('not carried … the birth derives from the record')", screenSrc.includes('not carried (${carry.reason}) — the birth derives from the record'))
  const carrierSrc = read('src/services/kitMenu/resolvedKit.ts')
  t.check("the carrier reaches the record through setNextSessionFacts and the wire's validator only — never a daemon writer", carrierSrc.includes("import { setNextSessionFacts } from '../switchboard/bootBirthFacts.js'") && carrierSrc.includes('validateSessionKit(') && !/stampSessionKit|restampSessionKit|sessionControl|applyConcourseKitOp/.test(carrierSrc))
}

t.section('§11 — THE PRESETS LAYER (`w`) + the armed wear on the face')
{
  const { KIT_LEGEND_PRESETS: LAYER_LEGEND, PRESET_LAYER_EMPTY, presetLayerEntryOf, presetLayerSummaryRows } = await import('../../src/components/KitMenuScreen.js')
  const { SAMPLE_PRESET_FACTS, composePresetsLayer, composeFace } = await import('./kit-menu-stills.ts')
  // The entry words: the armed row wears the WORD, a damaged entry says so,
  // counts read in deltas.
  const armedEntry = presetLayerEntryOf({ name: 'writing', count: 2 }, 'writing')
  const plainEntry = presetLayerEntryOf({ name: 'review kit', count: 4 }, 'writing')
  const damagedEntry = presetLayerEntryOf({ name: 'broken', count: null }, null)
  t.check("the armed preset wears the word 'armed'; an unarmed one the em dash; a damaged one says so and offers the re-save", armedEntry.valueLabel === 'armed' && plainEntry.valueLabel === '—' && damagedEntry.summary.includes('damaged in the config') && damagedEntry.summary.includes('save it again'))
  t.check("the entry states the ONE-SHOT law in its own words ('one-shot: the menu's default resumes after')", plainEntry.summary.includes("one-shot: the menu's default resumes after"))
  t.check('the layer panel: Saved count · Armed truth (the teal marker only when armed) · the next-session applies row', JSON.stringify(presetLayerSummaryRows(3, 'writing')) === JSON.stringify([{ key: 'Saved', value: '3 presets' }, { key: 'Armed', value: "● 'writing' — one session", tone: 'teal' }, { key: 'Applies', value: '● the next session', tone: 'teal' }]) && presetLayerSummaryRows(0, null)[1]?.value === '— the menu’s default')
  // The composition at both tiers carries the legend, the title and the rows.
  for (const [cols, rowsN] of [[120, 40], [100, 30]] as const) {
    const plain = composePresetsLayer(cols, rowsN, SAMPLE_PRESET_FACTS, 0, 'writing').join('\n')
    // The classic tier (<110 cols) paints no status bar — the armed truth
    // rides the row's own word there; the wide tier says it in the bar too.
    t.check(`${cols}x${rowsN}: the composed presets layer carries its legend, the saved rows and the armed word${cols >= 110 ? ' + the armed status line' : ''}`, plain.includes(LAYER_LEGEND) && plain.includes('review kit') && plain.includes('broken') && plain.includes('armed') && (cols < 110 || plain.includes("preset 'writing' armed")))
  }
  // THE ARMED WEAR ON THE FACE (the lead's visibility ruling): the kit
  // row's ctx names the armed preset; unarmed composes the standing bytes.
  const armedFace = composeFace('full', 120, 40, 'writing').join('\n')
  const plainFace = composeFace('full', 120, 40).join('\n')
  t.check("the face's kit row says \"next: preset 'writing'\" while armed and the standing ctx otherwise", armedFace.includes("next: preset 'writing'") && !plainFace.includes('next: preset') && plainFace.includes('what the next session loads'))
  // The screen's gating needles: w opens the layer; the layer owns input
  // exclusively; wear/disarm and delete ride the sub-list's own actions.
  const screenSrc = read('src/components/KitMenuScreen.tsx')
  t.check("w opens the layer and the sub-list owns the screen while open ('active: presetsLayer.open')", screenSrc.includes("key: 'w'") && screenSrc.includes('setPresetsLayer({ open: true, facts: readPresetFacts() })') && screenSrc.includes('active: presetsLayer.open'))
  t.check('↵ wears (the armed row disarms — the one-keystroke undo) and ⌫ deletes, both through the event loop', screenSrc.includes('wearOrDisarm') && screenSrc.includes('disarmWornPreset') && screenSrc.includes('deletePresetRow') && screenSrc.includes("pending: 'wearing…'") && screenSrc.includes("pending: 'deleting…'"))
  t.check('the empty layer answers the honest line, inert (never a nag)', screenSrc.includes('PRESET_LAYER_EMPTY') && PRESET_LAYER_EMPTY.startsWith('no presets saved'))
  t.check('the wear resolves over THIS screen’s live rows (the doesn’t-bite census is presetWear’s, driven in prove-kit-presets)', screenSrc.includes('wearPresetForNextSession(name, listRows)'))
}

t.finish('prove-kit-menu')
