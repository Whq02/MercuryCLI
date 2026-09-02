#!/usr/bin/env bun
// ============================================================================
//  scripts/ui/kit-menu-stills.ts — the MCPs & Skills STILL FRAMES (the
//  operator's look, written as bytes): the Boot face WITH the row in BOTH
//  worlds (full boot · --chat) at 100x34 and 120x40, and the manager screen
//  at 100 (classic tier) and 120 (wide tier) columns — composed by the ONE
//  shared core exactly as both hosts compose them, nocolor so the stills
//  read as text. `--write` regenerates scripts/ui/fixtures/kit-menu/*.txt;
//  prove-kit-menu.ts byte-compares the live composition against them (the
//  regen-wrapper pattern: a drifted still reds the gate until re-written on
//  purpose). The real-boot look is the operator's drive (never a PTY here).
// ============================================================================
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { assembleCardRows, createSplashCore } from '../../assets/splash/splash-core.mjs'
import { KIT_LEGEND_PRESET, KIT_LEGEND_PRESETS, KIT_LEGEND_PROMPT, kitEntryOf, kitStatusLine, kitSummaryRows, presetLayerEntryOf, presetLayerSummaryRows, presetPromptLines, type PresetRowFact } from '../../src/components/KitMenuScreen.js'
import { kitCounts, kitRowView, sectionRows, type KitCatalogue, type KitStates } from '../../src/services/kitMenu/kitTypes.js'

export const STILLS_DIR = join(import.meta.dir, 'fixtures', 'kit-menu')

const core = createSplashCore({ nocolor: true, truecolor: false, accent: 'crimson' })
const chips = {
  model: 'Opus 5',
  critter: 'Octopus',
  critterHue: '#B07BE0',
  dir: 'orchard-src',
  acct: { state: 'email' as const, text: 'operator@example.com' },
  health: { verdict: 'certified', age: '2h' },
}

/** The populated presence set (every row shape) per world. */
export function faceFacts(world: 'full' | 'chat'): Record<string, unknown> {
  return {
    cwdBase: 'orchard-src',
    continueTarget: { base: 'orchard-src', ageMs: 5 * 60000, cross: false },
    menuAvailable: true,
    // The ONLY world difference: the concourse row (L15 — both hosts pass null
    // in a --chat boot). The kit row rides the same fit fact in both worlds.
    concourse: world === 'chat' ? null : { ctx: 'the live board · 2 live' },
    projects: [
      { base: 'moodle', ageMs: 60 * 60000 },
      { base: 'avs2', ageMs: 3 * 86400000 },
    ],
  }
}

export function composeFace(world: 'full' | 'chat', cols: number, rows: number, armedPreset?: string): string[] {
  const res = core.composeLockup(cols, rows, {
    cardRows: assembleCardRows({ ...faceFacts(world), ...(armedPreset !== undefined ? { kitArmedPreset: armedPreset } : {}) }),
    cardSel: 0,
    hintSegments: [
      { key: '↵ ', label: 'start', tone: 'ivory' },
      { key: 'm', label: ' menu', tone: 'faint' },
    ],
    tinyHint: '↵ start',
    stripLines: (w: number) => core.composeStrip(chips, w),
  } as never) as { lines: string[] }
  const { placed } = core.placeBlock(res.lines, rows) as { placed: string[] }
  return placed
}

/** A sample catalogue in the runner's resolved spellings: two config
 *  servers, one extension (a server + two skills, its master row above its
 *  items in each section), two project skills and a user skill. */
export const SAMPLE_CATALOGUE: KitCatalogue = {
  rows: [
    { kind: 'mcp', section: 'mcp', name: 'github', scope: 'user', extension: null },
    { kind: 'mcp', section: 'mcp', name: 'postgres', scope: 'project', extension: null },
    { kind: 'extension', section: 'mcp', name: 'orchard-tools', contributes: '2 skills · 1 server · 1 command · hooks' },
    { kind: 'mcp', section: 'mcp', name: 'ext:orchard-tools:db', scope: 'dynamic', extension: 'orchard-tools' },
    { kind: 'skill', section: 'skill', name: 'deploy', source: 'project settings', extension: null },
    { kind: 'skill', section: 'skill', name: 'review', source: 'project settings', extension: null },
    { kind: 'skill', section: 'skill', name: 'notes', source: 'user settings', extension: null },
    { kind: 'extension', section: 'skill', name: 'orchard-tools', contributes: '2 skills · 1 server · 1 command · hooks' },
    { kind: 'skill', section: 'skill', name: 'orchard-tools:prune', source: 'orchard-tools extension', extension: 'orchard-tools' },
    { kind: 'skill', section: 'skill', name: 'orchard-tools:graft', source: 'orchard-tools extension', extension: 'orchard-tools' },
    // The ruled sentence for the group no face can enumerate (the real
    // enumerator always appends it).
    { kind: 'note', section: 'skill', text: 'skills from MCP servers appear once a session connects them' },
  ],
}

/** A mid-cycle state set: one server off, one skill invocable, one skill
 *  off, and the extension master OFF (its items read `off (extension)`). */
export const SAMPLE_STATES: KitStates = new Map([
  ['mcp:postgres', 'off'],
  ['skill:deploy', 'invocable'],
  ['skill:notes', 'off'],
  ['extension:orchard-tools', 'off'],
])

/** The manager as the screen composes it (the same pure entry/panel/legend
 *  owners the screen uses — a still can never drift from the screen). */
export function composeManager(cols: number, rows: number, catalogue: KitCatalogue = SAMPLE_CATALOGUE, selIdx = 0, states: KitStates = new Map(), prompt: { name: string; note: string | null } | null = null): string[] {
  const listRows = sectionRows(catalogue)
  const m = {
    entries: listRows.map(row => kitEntryOf(row, kitRowView(row, states))),
    selIdx,
    title: 'mcps & skills',
    summaryTitle: 'NEXT SESSION',
    summaryRows: kitSummaryRows(kitCounts(listRows, states)),
    moreHint: '… (the trail continues — a taller terminal shows it whole)',
    environment: { model: 'Opus 5', critter: 'Octopus', critterHue: '#B07BE0', dirBase: 'orchard-src', dirTail: '' },
    statusRight: `${kitStatusLine(states.size)}  ·  2 established sessions unchanged`,
    legend: prompt ? KIT_LEGEND_PROMPT : KIT_LEGEND_PRESET,
    ...(prompt ? { detailOverride: presetPromptLines(prompt.name, prompt.note) } : {}),
  }
  const menu = core.composeBootMenu(cols, rows, m) as { lines: string[] }
  const { placed } = core.placeBlock(menu.lines, rows) as { placed: string[] }
  return placed
}

/** The saved presets as the layer lists them (one armed, one damaged —
 *  every word shape on one frame). */
export const SAMPLE_PRESET_FACTS: PresetRowFact[] = [
  { name: 'review kit', count: 4 },
  { name: 'writing', count: 2 },
  { name: 'broken', count: null },
]

/** The presets layer as the screen composes it (the same pure entry/panel
 *  owners — a still can never drift from the screen). */
export function composePresetsLayer(cols: number, rows: number, facts: PresetRowFact[] = SAMPLE_PRESET_FACTS, selIdx = 0, armed: string | null = 'writing'): string[] {
  const m = {
    entries: facts.map(f => presetLayerEntryOf(f, armed)),
    selIdx,
    title: 'presets',
    summaryTitle: 'NEXT SESSION',
    summaryRows: presetLayerSummaryRows(facts.length, armed),
    environment: { model: 'Opus 5', critter: 'Octopus', critterHue: '#B07BE0', dirBase: 'orchard-src', dirTail: '' },
    statusRight: armed !== null ? `preset '${armed}' armed — the next session wears it, then the menu's default resumes` : kitStatusLine(0),
    legend: KIT_LEGEND_PRESETS,
  }
  const menu = core.composeBootMenu(cols, rows, m) as { lines: string[] }
  const { placed } = core.placeBlock(menu.lines, rows) as { placed: string[] }
  return placed
}

export const STILLS: ReadonlyArray<{ id: string; compose: () => string[] }> = [
  { id: 'face-full-100x34', compose: () => composeFace('full', 100, 34) },
  { id: 'face-full-120x40', compose: () => composeFace('full', 120, 40) },
  { id: 'face-chat-100x34', compose: () => composeFace('chat', 100, 34) },
  { id: 'face-chat-120x40', compose: () => composeFace('chat', 120, 40) },
  // The armed wear on the face (the lead's visibility ruling): the kit
  // row's ctx names the one-shot preset the next session wears.
  { id: 'face-full-120x40-preset-armed', compose: () => composeFace('full', 120, 40, 'writing') },
  { id: 'manager-100x30', compose: () => composeManager(100, 30) },
  { id: 'manager-120x40', compose: () => composeManager(120, 40) },
  // Mid-cycle: the tri-state words on screen, the master row off and its
  // items following it (the cursor on the invocable skill's row).
  { id: 'manager-120x40-midcycle', compose: () => composeManager(120, 40, SAMPLE_CATALOGUE, 4, SAMPLE_STATES) },
  { id: 'manager-100x30-midcycle', compose: () => composeManager(100, 30, SAMPLE_CATALOGUE, 4, SAMPLE_STATES) },
  // The "Save as preset…" prompt open in the SETTING DETAIL body (a name
  // half-typed), and the store door's counted receipt after ↵ (the
  // pre-lane typed-refusal still died with the placeholder).
  { id: 'manager-120x40-preset', compose: () => composeManager(120, 40, SAMPLE_CATALOGUE, 4, SAMPLE_STATES, { name: 'review kit', note: null }) },
  { id: 'manager-120x40-preset-saved', compose: () => composeManager(120, 40, SAMPLE_CATALOGUE, 4, SAMPLE_STATES, { name: 'review kit', note: "preset 'review kit' saved (4 deltas)" }) },
  // The presets layer: wear · disarm · delete (one armed, one damaged).
  { id: 'manager-120x40-presets-layer', compose: () => composePresetsLayer(120, 40) },
]

export function stillPath(id: string): string {
  return join(STILLS_DIR, `${id}.txt`)
}

export function readStill(id: string): string | null {
  try {
    return readFileSync(stillPath(id), 'utf8')
  } catch {
    return null
  }
}

export function renderStill(lines: string[]): string {
  return lines.map(l => l.replace(/\s+$/, '')).join('\n') + '\n'
}

if (import.meta.main && process.argv.includes('--write')) {
  mkdirSync(STILLS_DIR, { recursive: true })
  for (const still of STILLS) {
    writeFileSync(stillPath(still.id), renderStill(still.compose()))
    console.log(`wrote ${stillPath(still.id)}`)
  }
}
