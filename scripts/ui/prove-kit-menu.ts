#!/usr/bin/env bun

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { join } from 'node:path'
import { checker } from '../engine-durability/harness.ts'
import { assembleCardRows, createSplashCore } from '../../assets/splash/splash-core.mjs'
import { consumeKitManagerDeepLink, decideSplashReceipt } from '../../src/platform/substrate/splashHandover.js'
import { KIT_LEGEND_PRESET, KIT_LEGEND_PRESETS, KIT_LEGEND_PROMPT, kitEntryOf, kitStatusLine, kitSummaryRows, kitValueLabel, presetPromptLines } from '../../src/screen/boot-face/KitMenuScreen.js'
import { EMPTY_KIT_CATALOGUE, KIT_SECTION_TITLE, cycleState, kitCounts, kitRowId, kitRowView, kitStateKey, sectionRows, type KitRow, type KitRowState } from '../../src/screen/kit-menu-model/kitTypes.js'
import { settingsEditors } from '../../src/screen/boot-face/settings/menuModel.js'
import { SAMPLE_CATALOGUE, SAMPLE_STATES, STILLS, composeManager, faceFacts, readStill, renderStill, stillPath } from './kit-menu-stills.ts'

const t = checker()

type Row = { key: string; icon: string; label: string; ctx: string }
const rowsOf = (facts: Record<string, unknown>): Row[] => assembleCardRows(facts) as Row[]
const keysOf = (facts: Record<string, unknown>): string[] => rowsOf(facts).map(r => r.key)
const BASE = { cwdBase: 'proj', continueTarget: null, menuAvailable: true, projects: [] as unknown[] }
const FULL = { ...BASE, concourse: { ctx: 'the live board' } }
const CHAT = { ...BASE, concourse: null }

t.section('§1 — THE FACE AND BOOT MENU DOOR, BOTH HOSTS, EVERY WORLD')
{
  const full = keysOf(FULL)
  const chat = keysOf(CHAT)
  t.check('the full world carries the approved four no-history rows (new · logins · concourse · menu)', JSON.stringify(full) === JSON.stringify(['new', 'logins', 'concourse', 'menu']), full.join(' · '))
  t.check('the --chat world carries the same rows minus concourse', JSON.stringify(chat) === JSON.stringify(['new', 'logins', 'menu']), chat.join(' · '))
  t.check('the --chat card is the full card minus exactly the concourse row (nothing else differs)', JSON.stringify(full.filter(k => k !== 'concourse')) === JSON.stringify(chat))
  const kitEditor = settingsEditors.find(r => r.editor === 'kit')
  t.check("MCPs & Skills opens from Boot Menu with its ruled label and summary", kitEditor?.label === 'MCPs & Skills' && kitEditor?.summary === 'what the next session loads', JSON.stringify(kitEditor))
  t.check('menuAvailable: false drops both logins and Boot Menu', !keysOf({ ...FULL, menuAvailable: false }).includes('menu') && !keysOf({ ...FULL, menuAvailable: false }).includes('logins') && !keysOf({ ...CHAT, menuAvailable: false }).includes('menu'))
  t.check('the four no-history rows keep their exact bytes', JSON.stringify(rowsOf(FULL)) === JSON.stringify([
    { key: 'new', icon: '✶', label: 'New Session', ctx: 'start fresh here' },
    { key: 'logins', icon: '⚿', label: 'Logins/Keys', ctx: 'sign in to providers' },
    { key: 'concourse', icon: '⊞', label: 'Session Manager (Concourse)', ctx: 'the live board' },
    { key: 'menu', icon: '⊞', label: 'Boot Menu', ctx: 'configure boot env' },
  ]))
  t.check('Boot Menu stays LAST in both worlds', full[full.length - 1] === 'menu' && chat[chat.length - 1] === 'menu')

  const core = createSplashCore({ nocolor: false, truecolor: true })
  const chips = { model: 'Opus 5', critter: 'Crab', critterHue: '#DD4444', dir: 'proj', acct: { state: 'none' as const }, health: null }
  const lockup = (concourseCtx: string | null, cols: number, rows: number) =>
    core.composeLockup(cols, rows, {
      cardRows: assembleCardRows({ ...faceFacts('full'), concourse: concourseCtx === null ? null : { ctx: concourseCtx } }).map(r => ({ ...r, ctx: '' })),
      cardSel: 0,
      hintSegments: [{ key: '↵', label: '', tone: 'ivory' as const }, { key: 'm', label: ' menu', tone: 'faint' as const }],
      tinyHint: '↵',
      stripLines: (w: number) => core.composeStrip(chips, w),
    }) as { lines: string[]; actionLines: number[] }
  for (const [cols, rows] of [[120, 40], [100, 34], [80, 24]] as const) {
    const launcher = lockup('the multi-session board, once', cols, rows)
    const face = lockup('the live board', cols, rows)
    const aboveCard = (r: { lines: string[]; actionLines: number[] }) => r.lines.slice(0, Math.min(...r.actionLines) - 1).join('\n')
    t.check(`${cols}x${rows}: the lines above the card are byte-identical across the two hosts' fact shapes (no hero shift)`, launcher.actionLines.length === 5 && face.actionLines.length === 5 && aboveCard(launcher) === aboveCard(face))
    const menuLine = (r: { lines: string[] }) => r.lines.findIndex(l => l.includes('Boot Menu'))
    t.check(`${cols}x${rows}: Boot Menu sits on the same line on both hosts, last in the card`, menuLine(launcher) === menuLine(face) && menuLine(face) === face.actionLines[face.actionLines.length - 1])
    const chatFace = lockup(null, cols, rows)
    t.check(`${cols}x${rows}: the --chat composition carries four action rows and no Session Manager (Concourse)`, chatFace.actionLines.length === 4 && chatFace.lines.some(l => l.includes('Boot Menu')) && !chatFace.lines.some(l => l.includes('Session Manager (Concourse)')))
  }
}

t.section('§2 — THE HANDOVER: `kit` admits here, unknown still boots plain, the face consumes the deep-link at mount')
{
  const NOW = 1_700_000_000_000
  const fresh = (o: Record<string, unknown>): string => JSON.stringify({ version: 1, ts: NOW, ...o })
  const d = (raw: string) => decideSplashReceipt(raw, NOW, () => false)
  void consumeKitManagerDeepLink()
  const kit = d(fresh({ action: 'kit' }))
  t.check('kit ⇒ applied, nothing to chdir or splice (the Boot face is the landing)', kit.reason === 'applied' && kit.apply === null)
  t.check('kit arms the manager deep-link exactly once', consumeKitManagerDeepLink() === true && consumeKitManagerDeepLink() === false)
  t.check("an unknown action reads 'unknown-action' and arms nothing (an older runtime's plain boot, the protocol's law)", d(fresh({ action: 'kit-manager' })).reason === 'unknown-action' && consumeKitManagerDeepLink() === false)
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
    summary: { profile: 'r3 · custom · 1 set', harness: 'helm', integrity: 'enforce', integritySet: false },
    environment: { model: 'Opus 5', critter: 'Crab', critterHue: '#DD4444', dirBase: 'proj', dirTail: '  ⌥main · clean' },
    statusRight: 'no blocking issues detected — changes reach new sessions',
    legend: '↑↓ move · pgup/pgdn page · ↵ change (saved) · ⌫ default · a apply receipts · esc back',
  }
  const explicit = { ...legacy, title: 'boot menu', summaryTitle: 'LAUNCH SUMMARY', moreHint: '… (the trail continues — taller terminal)', entries: legacyEntries.map(e => ({ ...e, inert: false })) }
  for (const [cols, rows] of [[120, 40], [142, 44], [100, 30], [80, 24]] as const) {
    const a = (core.composeBootMenu(cols, rows, legacy) as { lines: string[] }).lines.join('\n')
    const b = (core.composeBootMenu(cols, rows, explicit) as { lines: string[] }).lines.join('\n')
    t.check(`${cols}x${rows}: absent host fields ≡ their explicit defaults (byte-identical)`, a === b)
    t.check(`${cols}x${rows}: the boot menu keeps its caption and panels`, a.includes(cols >= 110 ? '⌁ boot menu' : '· boot menu') && (cols < 110 || (a.includes('LAUNCH SUMMARY') && a.includes('Profile') && a.includes('ENVIRONMENT'))))
  }
  const inertM = {
    entries: sectionRows(EMPTY_KIT_CATALOGUE).map(row => kitEntryOf(row)),
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
  const emptyLines = empty.filter(row => row.kind === 'empty')
  t.check('an empty catalogue keeps one inert line per section in the same order', empty.map(row => `${row.section}:${row.kind}`).join(',') === 'mcp:empty,skill:empty')
  t.check('the empty lines name added entries, the adding doors and the excluded servers', emptyLines[0]?.text === 'no added MCPs (/mcp add); mercury / ide not listed' && emptyLines[1]?.text === 'no added skills — create one under .mercury/skills/')
  const pending: KitRow[] = [{ kind: 'empty', section: 'mcp', text: 'reading the MCP configs…' }, { kind: 'empty', section: 'skill', text: 'the skills could not be read' }]
  t.check('loading and unreadable states are not rewritten as empty inventories', JSON.stringify(sectionRows({ rows: pending })) === JSON.stringify(pending))
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
  t.check('the full-world still carries the five approved rows and no removed face rows', fullFace.includes('New Session') && fullFace.includes('Continue Last Session') && fullFace.includes('Logins/Keys') && fullFace.includes('Session Manager (Concourse)') && fullFace.includes('Boot Menu') && !fullFace.includes('MCPs & Skills') && !fullFace.includes('Health Check'))
  t.check('the --chat still carries Boot Menu and no Session Manager (Concourse)', chatFace.includes('Boot Menu') && !chatFace.includes('Session Manager (Concourse)'))
  const manager = readStill('manager-120x40') ?? ''
  t.check('the manager still: two titled sections, the master row above its items in each, every state a word', manager.includes('MCPs') && manager.indexOf('MCPs') < manager.indexOf('Skills') && manager.includes('orchard-tools (extension)') && manager.indexOf('orchard-tools (extension)') < manager.indexOf('ext:orchard-tools:db') && manager.includes(' on') && manager.includes('NEXT SESSION'))
  const mid = readStill('manager-120x40-midcycle') ?? ''
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
  t.check('an MCP server cycles on → off → on (↵/space/→)', cycleState(mcp, 'on', 1) === 'off' && cycleState(mcp, 'off', 1) === 'on')
  t.check('a skill cycles on → invocable → off → on', cycleState(skill, 'on', 1) === 'invocable' && cycleState(skill, 'invocable', 1) === 'off' && cycleState(skill, 'off', 1) === 'on')
  t.check('← walks the ring back (on ← invocable ← off)', cycleState(skill, 'on', -1) === 'off' && cycleState(skill, 'off', -1) === 'invocable' && cycleState(skill, 'invocable', -1) === 'on' && cycleState(mcp, 'on', -1) === 'off')
  t.check('a master row cycles on ⇄ off (never invocable)', cycleState(master, 'on', 1) === 'off' && cycleState(master, 'off', 1) === 'on' && cycleState(master, 'on', -1) === 'off')
  const masterInSkills = rows.find(r => r.kind === 'extension' && r.section === 'skill')!
  const masterInMcps = rows.find(r => r.kind === 'extension' && r.section === 'mcp')!
  t.check("an extension's two master rows share ONE state key (the section is not part of it)", kitStateKey(masterInSkills) === kitStateKey(masterInMcps) && kitStateKey(masterInMcps) === 'extension:orchard-tools')
  t.check('items key by their resolved spelling; an empty line has no key', kitStateKey(extServer) === 'mcp:ext:orchard-tools:db' && kitStateKey(extSkill) === 'skill:orchard-tools:prune' && kitStateKey({ kind: 'empty', section: 'mcp', text: 'x' }) === null)
  const none = new Map<string, KitRowState>()
  t.check('default all-on: with no recorded deviation every row reads on and nothing is master-off', rows.filter(r => r.kind !== 'empty').every(r => { const v = kitRowView(r, none); return v.own === 'on' && v.effective === 'on' && !v.masterOff }))
  const c0 = kitCounts(rows, none)
  t.check('the fresh counts: 3 MCPs on · 0 off; 5 skills on · 0 invocable · 0 off', c0.mcp.on === 3 && c0.mcp.off === 0 && c0.skill.on === 5 && c0.skill.invocable === 0 && c0.skill.off === 0)
  const vExtSkill = kitRowView(extSkill, SAMPLE_STATES)
  const vExtServer = kitRowView(extServer, SAMPLE_STATES)
  t.check('master OFF ⇒ its items are EFFECTIVELY off whatever their own state (own kept for the return)', vExtSkill.masterOff && vExtSkill.effective === 'off' && vExtSkill.own === 'on' && vExtServer.masterOff && vExtServer.effective === 'off')
  t.check("the item's word says so: 'off (extension)'; a plain row's word is its own state", kitValueLabel(extSkill, vExtSkill) === 'off (extension)' && kitValueLabel(skill, kitRowView(skill, SAMPLE_STATES)) === 'invocable' && kitValueLabel(mcp, kitRowView(mcp, SAMPLE_STATES)) === 'on')
  const c1 = kitCounts(rows, SAMPLE_STATES)
  t.check('the counts follow the EFFECTIVE states (postgres off + the extension server follows its master: 2 on · 1 off... and skills 1 on · 1 invocable · 3 off)', c1.mcp.on === 1 && c1.mcp.off === 2 && c1.skill.on === 1 && c1.skill.invocable === 1 && c1.skill.off === 3)
  t.check('the NEXT SESSION rows are the counts in words', JSON.stringify(kitSummaryRows(c1).map(r => r.value)) === JSON.stringify(['1 on · 2 off', '1 on · 1 invocable · 3 off', '● the next session']))
  const WORDS = new Set(['on', 'invocable', 'off', 'off (extension)', '—', ''])
  t.check('every value label is one of the ruled words', rows.every(r => WORDS.has(kitValueLabel(r, kitRowView(r, SAMPLE_STATES)))) && rows.every(r => WORDS.has(kitValueLabel(r, kitRowView(r, none)))))
  t.check("valueIsDefault is exactly 'own on and not master-off' (the faint/cream tone follows the word, never replaces it)", kitEntryOf(skill, kitRowView(skill, SAMPLE_STATES)).valueIsDefault === false && kitEntryOf(mcp, kitRowView(mcp, SAMPLE_STATES)).valueIsDefault === true && kitEntryOf(extSkill, vExtSkill).valueIsDefault === false)
  t.check("a master-off item's detail names the extension that holds it off", kitEntryOf(extSkill, vExtSkill).detailExtra?.some(l => l.includes('orchard-tools (extension) is off')) === true)
  for (const [cols, rowsN] of [[120, 40], [100, 30]] as const) {
    const plain = composeManager(cols, rowsN, SAMPLE_CATALOGUE, 4, SAMPLE_STATES).join('\n')
    t.check(`${cols}x${rowsN}: the composed manager speaks invocable · off · off (extension) and titles both sections`, plain.includes('invocable') && plain.includes('off (extension)') && plain.includes('MCPs') && plain.includes('Skills'))
  }
}

t.section("§7 — THE ENUMERATION: the rows are the doors' own spellings (C3)")
{
  const { MCP_SKILLS_NOTE, contributesWords, enumerateKitCatalogue } = await import('../../src/screen/kit-menu-model/kitCatalogue.js')
  const manifest = (name: string, contributes: Record<string, unknown>) => ({ name, version: '1.0.0', description: 'x', contributes }) as never
  const orchard = manifest('orchard-tools', { skills: ['prune', 'graft'], servers: { db: { command: 'x' } }, commands: ['tidy'], hooks: { 'tool.before': [{ name: 'x', run: 'x' }] } })
  const quiet = manifest('quiet-hooks', { commands: ['lint'], hooks: { 'tool.before': [{ name: 'x', run: 'x' }] } })
  const prompt = (name: string, extra: Record<string, unknown>) => ({ type: 'prompt', name, description: 'd', ...extra }) as never
  const doors = {
    mcpConfigs: async () => ({
      servers: {
        github: { type: 'stdio', command: 'gh', scope: 'user' },
        postgres: { type: 'stdio', command: 'pg', scope: 'project' },
        'ext:orchard-tools:db': { type: 'stdio', command: 'db', scope: 'dynamic', extensionSource: 'orchard-tools@local' },
      } as never,
    }),
    dirSkills: async () => [
      prompt('deploy', { source: 'projectSettings', loadedFrom: 'skills' }),
      prompt('notes', { source: 'userSettings', loadedFrom: 'skills' }),
      prompt('extension-maker', { source: 'bundled', loadedFrom: 'bundled' }),
      prompt('mcp-derived', { source: 'mcp', loadedFrom: 'mcp' }),
    ],
    extensionSkills: () => [
      prompt('orchard-tools:prune', { source: 'extension', loadedFrom: 'extension', extensionInfo: { manifest: orchard, id: 'orchard-tools@local' } }),
      prompt('orchard-tools:graft', { source: 'extension', loadedFrom: 'extension', extensionInfo: { manifest: orchard, id: 'orchard-tools@local' } }),
    ],
    activeExtensions: () => [{ manifest: orchard }, { manifest: quiet }],
  }
  const cat = await enumerateKitCatalogue('/proof/cwd', doors as never)
  const names = (section: 'mcp' | 'skill') => cat.rows.filter(r => r.section === section).map(r => (r.kind === 'note' || r.kind === 'empty' ? `(${r.kind})` : r.kind === 'extension' ? `[${r.name}]` : r.name))
  t.check("MCPs: the doors' keys verbatim, the extension's server under its master row", JSON.stringify(names('mcp')) === JSON.stringify(['github', 'postgres', '[orchard-tools]', 'ext:orchard-tools:db']), names('mcp').join(' · '))
  t.check("Skills: loader skills verbatim (SKILL.md + legacy commands), NO bundled organ, NO mcp-derived row, the extension's skills under its master, the commands/hooks-only extension's master in Skills, the ruled note LAST", JSON.stringify(names('skill')) === JSON.stringify(['deploy', 'notes', '[orchard-tools]', 'orchard-tools:prune', 'orchard-tools:graft', '[quiet-hooks]', '(note)']), names('skill').join(' · '))
  for (const refused of [false, true]) {
    const sparse = await enumerateKitCatalogue('/proof/cwd', {
      mcpConfigs: async () => ({ servers: {} }),
      dirSkills: async () => [],
      extensionSkills: () => [],
      activeExtensions: () => [],
      skillRefusals: () => refused ? [{ path: '/proof/cwd/.mercury/skills/broken/SKILL.md', error: 'the file is empty', source: 'project' }] : [],
    })
    const sparseRows = sectionRows(sparse)
    t.check(`empty inventory${refused ? ' with a refused skill' : ''}: scope uses the existing note, never extra rows`, sparseRows.length === (refused ? 4 : 3) && sparseRows.at(-1)?.kind === 'note' && (sparseRows.at(-1) as { text: string }).text === 'bundled skills load in sessions; MCP skills on connection')
    for (const [cols, height] of [[80, 21], [80, 14], [82, 17], [120, 40]]) {
      const frame = composeManager(cols!, height!, sparse, -1).join('\n')
      t.check(`${cols}x${height}: empty inventory scope stays whole${refused ? ' beside its refusal' : ''}`, frame.includes('no added MCPs (/mcp add); mercury / ide not listed') && frame.includes('no added skills — create one under .mercury/skills/') && frame.includes('bundled skills load in sessions; MCP skills on connection') && (!refused || frame.includes('refused: .mercury/skills/broken/SKILL.md')) && !/↓ \d+ more/.test(frame))
    }
    for (const cols of [110, 111, 112, 113, 114]) {
      const frame = composeManager(cols, 40, sparse, -1).join('\n')
      t.check(`${cols}x40: the MCP scope fits the narrowest wide panel`, frame.includes('no added MCPs (/mcp add); mercury / ide not listed'))
    }
  }
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
  const doorNames = new Set(['github', 'postgres', 'ext:orchard-tools:db', 'deploy', 'notes', 'orchard-tools:prune', 'orchard-tools:graft'])
  t.check('POISON absent: every server/skill row name is a door spelling verbatim (no prettified or re-cased name)', cat.rows.filter(r => r.kind === 'mcp' || r.kind === 'skill').every(r => doorNames.has(r.name)))
  const listed = sectionRows(cat)
  t.check('sectionRows keeps members first and the note last, both sections titled', listed[listed.length - 1]?.kind === 'note' && listed[0]?.section === 'mcp' && listed.some(r => r.section === 'skill'))
  const { LOADING_KIT_CATALOGUE } = await import('../../src/screen/kit-menu-model/kitTypes.js')
  t.check('the loading catalogue paints "reading…" lines, never the none-configured words', sectionRows(LOADING_KIT_CATALOGUE).every(r => r.kind === 'empty' && r.text.startsWith('reading')))
  {
    const { refusedSkillNote, shadowedSkillNote } = await import('../../src/screen/kit-menu-model/kitCatalogue.js')
    const colliding = {
      ...doors,
      dirSkills: async () => [
        prompt('good', { source: 'userSettings', loadedFrom: 'skills' }),
        prompt('good', { source: 'projectSettings', loadedFrom: 'skills' }),
        prompt('good', { source: 'localSettings', loadedFrom: 'skills' }),
        prompt('deploy', { source: 'projectSettings', loadedFrom: 'skills' }),
      ],
      skillRefusals: () => [
        { path: '/proof/cwd/.mercury/skills/broken/SKILL.md', error: 'frontmatter did not parse: Nested mappings are not allowed in compact mappings at line 2, column 14:\n\ndescription: bad yaml\n             ^', source: 'project' },
        { path: '/elsewhere/skills/with space/SKILL.md', error: "uninvocable name: contains whitespace ('/with space' can never be one command token)", source: 'user' },
      ],
    }
    const cat2 = await enumerateKitCatalogue('/proof/cwd', colliding as never)
    const goodRows = cat2.rows.filter(r => r.kind === 'skill' && r.name === 'good')
    t.check('a name three files claim paints ONE row — the loader’s winner (user settings)', goodRows.length === 1 && goodRows[0]?.kind === 'skill' && goodRows[0].source === 'user settings', JSON.stringify(goodRows))
    const skillNotes = cat2.rows.filter(r => r.kind === 'note' && r.section === 'skill').map(r => r.text)
    t.check('the shadowed copies are ONE note naming the winner and every loser', skillNotes[0] === shadowedSkillNote('good', 'user settings skill', ['project settings skill', 'project, gitignored settings skill']) && skillNotes[0] === 'shadowed: good — the user settings skill loads; the project settings skill and the project, gitignored settings skill stay on disk unused (rename one)', skillNotes[0])
    t.check('a refused file is a note naming the file (cwd-relative) and the reason’s first line', skillNotes[1] === 'refused: .mercury/skills/broken/SKILL.md (project) — frontmatter did not parse: Nested mappings are not allowed in compact mappings at line 2, column 14:' && refusedSkillNote({ path: '/proof/cwd/.mercury/skills/broken/SKILL.md', error: 'x\ny', source: 'project' }, '/proof/cwd') === 'refused: .mercury/skills/broken/SKILL.md (project) — x', skillNotes[1])
    t.check('a refusal outside the cwd keeps its full path', skillNotes[2] === "refused: /elsewhere/skills/with space/SKILL.md (user) — uninvocable name: contains whitespace ('/with space' can never be one command token)", skillNotes[2])
    t.check('the ruled MCP note stays LAST; the section list keeps members before notes', skillNotes[skillNotes.length - 1] === MCP_SKILLS_NOTE && sectionRows(cat2).filter(r => r.section === 'skill').findIndex(r => r.kind === 'note') > sectionRows(cat2).filter(r => r.section === 'skill').findLastIndex(r => r.kind === 'skill'))
    t.check('the toggle key space has one `good` (no duplicate row ids)', new Set(sectionRows(cat2).map(kitRowId)).size === sectionRows(cat2).length)
  }
  {
    const { mkdtempSync, rmSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const scratch = mkdtempSync(join(tmpdir(), 'kit-menu-doors-'))
    const savedHome = process.env.MERCURY_CONFIG_DIR
    process.env.MERCURY_CONFIG_DIR = join(scratch, 'home')
    delete process.env.MERCURY_ANTHROPIC_CONNECTORS
    const { enableConfigs } = await import('../../src/platform/config/globalConfig.js')
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
  const { RecordKitMenuStore, receiptFor, statesFromDeltas, deltasFromStates } = await import('../../src/screen/kit-menu-model/menuStore.js')
  const { kitDeltasForWorkspace, kitDeltasOf, emptyKitDeltas } = await import('../../src/integrations/mcp/kitStore.js')
  const { getProjectConfigForWorkspace } = await import('../../src/platform/settings/config.js')
  const rows = sectionRows(SAMPLE_CATALOGUE)
  const postgres = rows.find(r => r.kind === 'mcp' && r.name === 'postgres')!
  const deploy = rows.find(r => r.kind === 'skill' && r.name === 'deploy')!
  const master = rows.find(r => r.kind === 'extension' && r.section === 'skill')!
  const prune = rows.find(r => r.kind === 'skill' && r.name === 'orchard-tools:prune')!
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
  const { enableConfigs } = await import('../../src/platform/config/globalConfig.js')
  enableConfigs()
  try {
    const store = new RecordKitMenuStore()
    t.check('a fresh record reads EMPTY (every row on — default all-on by construction)', store.read(WS).size === 0 && rows.filter(isMember).every(r => kitRowView(r, store.read(WS)).effective === 'on'))
    const fresh = kitStatusLine(0)
    t.check("the fresh status line is the all-on truth and never a nag (no 'configure' / 'set up' / 'choose' words)", fresh === 'everything on; changes apply to new sessions only' && !/configure|set up|choose|please/i.test(fresh))
    t.check('the standing line counts the saved choices once any stand', kitStatusLine(1) === '1 choice saved — applies to the next session' && kitStatusLine(3).startsWith('3 choices saved'))
    t.check("write deploy → invocable, re-read: invocable (receipt 'deploy → invocable')", JSON.stringify(store.write(WS, deploy, 'invocable')) === JSON.stringify({ ok: true, receipt: 'deploy → invocable' }) && store.read(WS).get('skill:deploy') === 'invocable' && kitDeltasForWorkspace(WS).skillStates['deploy'] === 'invocable')
    t.check('write deploy → off, re-read: off', store.write(WS, deploy, 'off').ok && store.read(WS).get('skill:deploy') === 'off')
    t.check('write deploy → on, re-read: the deviation is GONE (absent = on; the record carries no skillStates key)', store.write(WS, deploy, 'on').ok && !store.read(WS).has('skill:deploy') && getProjectConfigForWorkspace(WS).skillStates === undefined)
    t.check("an unchanged write writes nothing and says so ('deploy already on')", JSON.stringify(store.write(WS, deploy, 'on')) === JSON.stringify({ ok: true, receipt: 'deploy already on' }))
    t.check("an MCP server off/on round-trips through the landed disabled record ('postgres → off' ⇒ disabledMcpServers carries it; on ⇒ gone)", store.write(WS, postgres, 'off').ok && store.read(WS).get('mcp:postgres') === 'off' && (getProjectConfigForWorkspace(WS).disabledMcpServers ?? []).includes('postgres') && store.write(WS, postgres, 'on').ok && !store.read(WS).has('mcp:postgres') && !(getProjectConfigForWorkspace(WS).disabledMcpServers ?? []).includes('postgres'))
    t.check("master off round-trips: 'orchard-tools (extension) → off' (extensionStates carries it); its skill reads effectively off; master on ⇒ gone", store.write(WS, master, 'off').ok && getProjectConfigForWorkspace(WS).extensionStates?.['orchard-tools'] === 'off' && kitRowView(prune, store.read(WS)).effective === 'off' && kitRowView(prune, store.read(WS)).masterOff && store.write(WS, master, 'on').ok && !store.read(WS).has('extension:orchard-tools') && kitRowView(prune, store.read(WS)).effective === 'on')
    store.write(WS, postgres, 'off')
    t.check('KEYED BY WORKSPACE: the write under one repo is invisible under another', store.read(OTHER).size === 0 && store.read(WS).get('mcp:postgres') === 'off')
    store.write(WS, deploy, 'invocable')
    store.write(WS, master, 'off')
    const deltas = kitDeltasForWorkspace(WS)
    t.check("the record's deltas after three writes are the record's exact shape", JSON.stringify(deltas) === JSON.stringify({ mcpOff: ['postgres'], skillStates: { deploy: 'invocable' }, extensionsOff: ['orchard-tools'] }), JSON.stringify(deltas))
    t.check("statesFromDeltas renders the record's deltas to the screen's keys; deltasFromStates renders them back; the empty record is their emptyKitDeltas", JSON.stringify([...statesFromDeltas(deltas)]) === JSON.stringify([['mcp:postgres', 'off'], ['skill:deploy', 'invocable'], ['extension:orchard-tools', 'off']]) && JSON.stringify(deltasFromStates(statesFromDeltas(deltas))) === JSON.stringify(deltas) && JSON.stringify(kitDeltasOf({ allowedTools: [], projectOnboardingSeenCount: 0 } as never)) === JSON.stringify(emptyKitDeltas()))
    t.check('receipts name the row and its word; a master row names itself as an extension', receiptFor(master, 'off', true) === 'orchard-tools (extension) → off' && receiptFor(postgres, 'off', false) === 'postgres already off')
  } finally {
    if (savedHome === undefined) delete process.env.MERCURY_CONFIG_DIR
    else process.env.MERCURY_CONFIG_DIR = savedHome
    rmSync(scratch, { recursive: true, force: true })
  }
  function isMember(r: KitRow): boolean {
    return r.kind === 'mcp' || r.kind === 'skill' || r.kind === 'extension'
  }
}

t.section('§9 — "SAVE AS PRESET…": the action hook, its prompt, the typed refusal, the vocabulary (C5)')
{
  const { STORE_PRESET_HOOK, _resetKitPresetHookForTesting, bindKitPresetHook, kitPresetHook, presetNameProblem, PRESET_NAME_MAX } = await import('../../src/screen/kit-menu-model/presetHook.js')
  const { deltasFromStates, statesFromDeltas } = await import('../../src/screen/kit-menu-model/menuStore.js')
  t.check("an empty name refuses in words ('type a name first'); whitespace is empty", presetNameProblem('') === 'type a name first' && presetNameProblem('   ') === 'type a name first')
  t.check('a bad name refuses in words; a plain name passes; the cap is 40', presetNameProblem('review/kit') !== null && presetNameProblem('review kit') === null && presetNameProblem('a'.repeat(40)) === null && presetNameProblem('a'.repeat(41)) !== null && PRESET_NAME_MAX === 40)
  _resetKitPresetHookForTesting()
  const presetStore = await import('../../src/integrations/mcp/presetStore.ts')
  const storeSaved = kitPresetHook().save('menu door', { workspaceDir: '/proof/repo', deltas: { mcpOff: ['postgres'], skillStates: {}, extensionsOff: [] }, members: { mcp: ['postgres'], skills: [], extensions: [] } })
  const storeBack = presetStore.kitPresetDeltas('menu door')
  t.check("the DEFAULT hook is the store door: the save lands in the preset store with the counted receipt (the typed-refusal placeholder is dead)", storeSaved.ok && storeSaved.receipt === "preset 'menu door' saved (1 delta)" && storeBack.ok && storeBack.deltas.mcpOff[0] === 'postgres' && kitPresetHook() === STORE_PRESET_HOOK)
  presetStore.deleteKitPreset('menu door')
  const calls: Array<{ name: string; snapshot: unknown }> = []
  bindKitPresetHook({ save: (name, snapshot) => { calls.push({ name, snapshot }); return { ok: true, receipt: `saved preset ${name}` } } })
  const res = kitPresetHook().save('review kit', { workspaceDir: '/proof/repo', deltas: { mcpOff: ['postgres'], skillStates: { deploy: 'invocable' }, extensionsOff: ['orchard-tools'] }, members: { mcp: ['github', 'postgres'], skills: ['deploy'], extensions: ['orchard-tools'] } })
  t.check('a bound hook is what the screen reaches (the store door re-binds the seam) and answers its own receipt', res.ok && res.receipt === 'saved preset review kit' && calls.length === 1 && calls[0]?.name === 'review kit')
  _resetKitPresetHookForTesting()
  const deltas = { mcpOff: ['postgres'], skillStates: { deploy: 'invocable' as const }, extensionsOff: ['orchard-tools'] }
  t.check('deltasFromStates ∘ statesFromDeltas is the identity on the record (a preset snapshots the record exactly)', JSON.stringify(deltasFromStates(statesFromDeltas(deltas))) === JSON.stringify(deltas) && JSON.stringify(deltasFromStates(new Map())) === JSON.stringify({ mcpOff: [], skillStates: {}, extensionsOff: [] }))
  const lines = presetPromptLines('review k', null)
  t.check("the prompt paints the name with the live caret and its keys ('↵ save · esc cancel')", lines[0] === 'save as preset' && lines.includes('name: review k▌') && lines[lines.length - 1] === '↵ save · esc cancel')
  t.check('a note (the receipt or the refusal) replaces the keys line', presetPromptLines('x', 'type a name first')[lines.length - 1] === 'type a name first')
  t.check("the legends: the screen names 'p save as preset…' and 'w presets…' beside the row keys; the open prompt names only its own keys; the layer its own", KIT_LEGEND_PRESET === '↑↓ move · pgup/pgdn page · ↵ change (saved) · ⌫ default · p save as preset… · w presets… · esc back' && KIT_LEGEND_PROMPT === 'type a name · ↵ save · esc cancel' && KIT_LEGEND_PRESETS === '↑↓ move · pgup/pgdn page · ↵ wear next session · ⌫ delete · esc back')
  for (const [cols, rowsN] of [[120, 40], [100, 30]] as const) {
    const plain = composeManager(cols, rowsN, SAMPLE_CATALOGUE, 4, SAMPLE_STATES, { name: 'review kit', note: null }).join('\n')
    t.check(`${cols}x${rowsN}: the composed manager carries the prompt's legend${cols >= 110 ? ' and the name with its caret' : ''}`, plain.includes(KIT_LEGEND_PROMPT) && (cols < 110 || plain.includes('name: review kit▌')))
  }
}

t.section('§10 — THE L18 CARRY: the write seam hands the RESOLVED snapshot to the next birth (the PRIMARY road; the derivation is the fallback) (C7)')
{
  const { carryNextSessionKit, resolvedKitOf } = await import('../../src/screen/kit-menu-model/resolvedKit.js')
  const { _resetBootBirthFactsForTesting, bootBirthFacts, carriedKitOf } = await import('../../src/daemon/switchboard/bootBirthFacts.js')
  const { validateSessionKit } = await import('../../src/daemon/session-seat/sessionKit.js')
  const rows = sectionRows(SAMPLE_CATALOGUE)
  const kit = resolvedKitOf(rows, SAMPLE_STATES)
  t.check('the RESOLVED snapshot is closed membership over EFFECTIVE states: mcp [github] (postgres off; the extension server follows its off master) · skills [review] · invocable [deploy] · extensions {orchard-tools: off}; no `resolved` field', JSON.stringify(kit) === JSON.stringify({ schema: 1, mcp: ['github'], skills: ['review'], invocable: ['deploy'], mcpKnown: ['github', 'postgres', 'ext:orchard-tools:db'], extensions: { 'orchard-tools': 'off' } }), JSON.stringify(kit))
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
}

t.section('§11 — THE PRESETS LAYER (`w`) + the armed wear on the face')
{
  const { KIT_LEGEND_PRESETS: LAYER_LEGEND, PRESET_LAYER_EMPTY, presetLayerEntryOf, presetLayerSummaryRows } = await import('../../src/screen/boot-face/KitMenuScreen.js')
  const { SAMPLE_PRESET_FACTS, composePresetsLayer, composeFace } = await import('./kit-menu-stills.ts')
  const armedEntry = presetLayerEntryOf({ name: 'writing', count: 2 }, 'writing')
  const plainEntry = presetLayerEntryOf({ name: 'review kit', count: 4 }, 'writing')
  const damagedEntry = presetLayerEntryOf({ name: 'broken', count: null }, null)
  t.check("the armed preset wears the word 'armed'; an unarmed one the em dash; a damaged one says so and offers the re-save", armedEntry.valueLabel === 'armed' && plainEntry.valueLabel === '—' && damagedEntry.summary.includes('damaged in the config') && damagedEntry.summary.includes('save it again'))
  t.check("the entry states the ONE-SHOT law in its own words ('one-shot: the menu's default resumes after')", plainEntry.summary.includes("one-shot: the menu's default resumes after"))
  t.check('the layer panel: Saved count · Armed truth (the teal marker only when armed) · the next-session applies row', JSON.stringify(presetLayerSummaryRows(3, 'writing')) === JSON.stringify([{ key: 'Saved', value: '3 presets' }, { key: 'Armed', value: "● 'writing' — one session", tone: 'teal' }, { key: 'Applies', value: '● the next session', tone: 'teal' }]) && presetLayerSummaryRows(0, null)[1]?.value === '— the menu’s default')
  for (const [cols, rowsN] of [[120, 40], [100, 30]] as const) {
    const plain = composePresetsLayer(cols, rowsN, SAMPLE_PRESET_FACTS, 0, 'writing').join('\n')
    t.check(`${cols}x${rowsN}: the composed presets layer carries its legend, the saved rows and the armed word${cols >= 110 ? ' + the armed status line' : ''}`, plain.includes(LAYER_LEGEND) && plain.includes('review kit') && plain.includes('broken') && plain.includes('armed') && (cols < 110 || plain.includes("preset 'writing' armed")))
  }
  const armedFace = composeFace('full', 120, 40, 'writing').join('\n')
  const plainFace = composeFace('full', 120, 40).join('\n')
  t.check('arming a preset leaves the five-row boot face unchanged (kit lives inside Boot Menu)', armedFace === plainFace && !armedFace.includes('next: preset'))
}

t.finish('prove-kit-menu')
