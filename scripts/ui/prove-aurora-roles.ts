#!/usr/bin/env bun
// ============================================================================
//  scripts/ui/prove-aurora-roles.ts — semantic color choreography.
//
//    §1 the INFO channel exists in every theme family (info + infoShimmer +
//       promptBorderResting resolve everywhere), and the dark warm-ink overlay
//       expresses it as OASIS — informational roles (plan mode, bash mode,
//       dialog frames, help/onboarding frames, usage fill, system spinner)
//       ride info, NOT the identity accent.
//    §2 identity/focus roles KEEP the accent (brand, suggestion, permission,
//       promptBorder), and the status spine stays fixed (TEAL/AMBER/CRIMSON).
//    §3 the mode ladder has fixed, pairwise-distinct semantics on dark:
//       default(text) · strategy(info) · flow(success) · implement(warning) ·
//       bypass(error).
//    §4 ACCENT BLOOM is genuinely derived per accent: crab keeps the authored
//       BELLY byte-equal; octopus/jellyfish/clam derive from their OWN hue;
//       ansi families collapse onto the accent; non-dark families derive
//       toward their OWN primary ink and their info comes from theme.info
//       (never the warm-ink-circular theme.permission).
//    §5 consent = attention: the default consent card + title ride the fixed
//       warning role, never the identity accent.
//    §6 consumer-QoL source invariants: /help ↵ stages the command (no dead
//       Enter), the launcher is advertised in the resting footer, the ember/
//       glint blooms consume the derived accentSoft, and the resting composer
//       border is structural while composing regains the accent.
//
//  Every assertion is mutation-meaningful (reverting the change turns
//  the specific row RED). Run: ~/.bun/bin/bun run scripts/ui/prove-aurora-roles.ts
// ============================================================================
;(globalThis as Record<string, unknown>)['MACRO'] = { VERSION: '1.0.0' }
process.env.NODE_ENV = 'test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(import.meta.dir, '..', '..')
const src = (...p: string[]) => readFileSync(join(ROOT, 'src', ...p), 'utf-8')

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}

console.log('============================================================')
console.log(' AURORA — semantic color choreography invariants')
console.log('============================================================')

const themeMod = await import('../../src/utils/theme.js')
const tokensMod = await import('../../src/utils/mercuryTokens.js')
const brand = await import('../../src/components/mercuryPalette.js')
const accentMod = await import('../../src/components/mercury-ui/sessionAccent.js')
const critterData = await import('../../src/utils/cockpit/critterData.js')
const permMode = await import('../../src/utils/permissions/PermissionMode.js')

const FAMILIES = themeMod.THEME_NAMES
const dark = themeMod.getTheme('dark')
const liveAccent = accentMod.getSessionAccent().accent

section('§1 — the INFO channel exists and owns the informational roles')
{
  for (const family of FAMILIES) {
    const t = themeMod.getTheme(family)
    check(`${family}: info + infoShimmer + promptBorderResting resolve`,
      typeof t.info === 'string' && t.info.length > 0 &&
      typeof t.infoShimmer === 'string' && t.infoShimmer.length > 0 &&
      typeof t.promptBorderResting === 'string' && t.promptBorderResting.length > 0)
  }
  check('dark info = OASIS (the companion hue, spent at last)', dark.info === brand.OASIS)
  check('dark infoShimmer brightens toward ivory', dark.infoShimmer === themeMod.lerpHex(brand.OASIS, brand.IVORY, 0.4))
  for (const role of ['planMode', 'bashBorder', 'background', 'professionalBlue', 'chromeYellow', 'ide', 'merged', 'remember', 'rate_limit_fill', 'systemSpinner'] as const) {
    check(`dark ${role} rides info (OASIS), not identity`, dark[role] === brand.OASIS)
  }
  check('dark promptBorderResting is STRUCTURE (DUNE)', dark.promptBorderResting === brand.DUNE)
  check('info ≠ identity accent on dark', dark.info !== liveAccent)
}

section('§2 — identity keeps the accent; the status spine stays fixed')
{
  check('brand (the Mercury voice) = the session accent', dark.brand === liveAccent)
  check('suggestion (current focus) = the session accent', dark.suggestion === liveAccent)
  check('permission (consent/focus thread) = the session accent', dark.permission === liveAccent)
  check('promptBorder (COMPOSING) = the session accent', dark.promptBorder === liveAccent)
  check('success = TEAL (fixed)', dark.success === brand.TEAL)
  check('warning = AMBER (fixed)', dark.warning === brand.AMBER)
  check('error = CRIMSON (fixed)', dark.error === brand.CRIMSON)
  check('autoAccept = AMBER (standing caution, fixed meaning)', dark.autoAccept === brand.AMBER)
  check('identity red ≠ failure crimson', brand.TERRA !== brand.CRIMSON)
}

section('§3 — the mode ladder: fixed, pairwise-distinct semantics (dark)')
{
  const roleOf = (m: string) => permMode.getModeColor(m as never)
  const hueOf = (m: string) => dark[roleOf(m) as keyof typeof dark] as string
  check("strategy → 'planMode' role", roleOf('strategy') === 'planMode')
  check("implement → 'autoAccept' role", roleOf('implement') === 'autoAccept')
  check("sovereign → 'error' role", roleOf('sovereign') === 'error')
  check("flow → 'success' role", roleOf('flow') === 'success')
  const hues = ['strategy', 'implement', 'sovereign', 'flow'].map(hueOf)
  check('strategy(OASIS) · implement(AMBER) · sovereign(CRIMSON) · flow(TEAL) pairwise distinct',
    new Set(hues).size === 4, hues.join(' '))
  check('strategy mode resolves OASIS-info', hueOf('strategy') === brand.OASIS)
  check('implement resolves AMBER-caution', hueOf('implement') === brand.AMBER)
}

section('§4 — ACCENT BLOOM: derived per accent, per family')
{
  const t = (name: (typeof FAMILIES)[number], accent: string) => tokensMod.resolveMercuryTokens(name, accent)
  check('crab (TERRA) keeps the authored BELLY byte-equal',
    t('dark', brand.TERRA).accentSoft === brand.BELLY)
  const others: Array<[string, string]> = [
    ['octopus', critterData.OCTOPUS_HUE],
    ['jellyfish', critterData.JELLYFISH_HUE],
    ['clam', critterData.CLAM_HUE],
  ]
  for (const [name, hue] of others) {
    const soft = t('dark', hue).accentSoft
    check(`${name} blooms from its OWN hue (≠ crab coral, = derived)`,
      soft !== brand.BELLY && soft === tokensMod.deriveAccentSoft(hue, brand.IVORY), soft)
  }
  const lightTheme = themeMod.getTheme('light')
  check('light family blooms toward its OWN primary ink',
    t('light', brand.TERRA).accentSoft === tokensMod.deriveAccentSoft(brand.TERRA, lightTheme.text))
  check('ansi family collapses the bloom onto the accent (16-color reality)',
    t('dark-ansi', brand.TERRA).accentSoft === brand.TERRA)
  check('non-dark info comes from theme.info (never the accent-circular permission)',
    t('light', brand.TERRA).info === lightTheme.info)
  check('dark tokens.info = OASIS', t('dark', brand.TERRA).info === brand.OASIS)
}

section('§5 — consent = attention (never identity)')
{
  const dialog = src('components', 'permissions', 'PermissionDialog.tsx')
  check("PermissionDialog default color = 'warning'", /color = 'warning'/.test(dialog))
  const title = src('components', 'permissions', 'PermissionRequestTitle.tsx')
  check("PermissionRequestTitle default color = 'warning'", /color = 'warning'/.test(title))
}

section('§6 — consumer-QoL source invariants')
{
  const commands = src('components', 'HelpV2', 'Commands.tsx')
  check('/help commands tab: dead-Enter guard removed (no disableSelection)', !/disableSelection/.test(commands))
  check('/help commands tab: ↵ stages via onPick', /onPick\(name\)/.test(commands) || /onPick\(/.test(commands))
  const helpV2 = src('components', 'HelpV2', 'HelpV2.tsx')
  check('/help wires the composer seed (safe insertion: ↵ stages `/name ` through the close channel, never runs it)', /const stage = \(commandName: string\) =>\s*onClose\(undefined, \{ nextInput: `\/\$\{commandName\} `, display: 'skip' \}\)/.test(helpV2) && /onPick=\{stage\}/.test(helpV2))
  const seed = src('utils', 'cockpit', 'composerSeed.ts')
  check('seedComposerDirect exists and rides the ONE seeder chokepoint', /export function seedComposerDirect/.test(seed))
  const footer = src('components', 'PromptInput', 'PromptInputFooterLeftSide.tsx')
  check('the launcher is advertised in the resting footer slot', /for commands \+ files/.test(footer))
  const shortcuts = src('components', 'HelpV2', 'ShortcutsTab.tsx')
  check('shortcut help splits everyday from advanced', /head: 'everyday'/.test(shortcuts) && /head: 'advanced'/.test(shortcuts))
  const promptInput = src('components', 'PromptInput', 'PromptInput.tsx')
  // SURFACE PARITY: the base rungs live in the shared
  // mercury-ui/replFloor owner so the concourse composers ride the SAME law.
  // TWO locks: the rung mapping at the owner + PromptInput's delegation.
  const replFloor = src('components', 'mercury-ui', 'replFloor.ts')
  check('resting composer border is structural; composing regains the accent (shared replFloor owner)',
    /empty \? 'promptBorderResting' : 'promptBorder'/.test(replFloor) &&
    /composerBorderRole\(input === ''\)/.test(promptInput))
  check('the composer text tint is the CENTRAL accentSoft (no local lerp)',
    /userTextColor: composerBloom/.test(promptInput))
  const loader = src('components', 'ToolUseLoader.tsx')
  check('the ember-settle spark consumes the DERIVED accentSoft', /color=\{accentSoft\}>\{GLYPH\.spark\}/.test(loader))
  const glyphs = src('components', 'mercury-ui', 'LiveGlyphs.tsx')
  check('TwinkleSpark glints the DERIVED accentSoft (no pinned BELLY)',
    /accentSoft : color/.test(glyphs) && !/\bBELLY\b/.test(glyphs))
  const kit = src('components', 'mercury-ui', 'components.tsx')
  check('WarningBanner info tone rides t.info (never identity)', /tone === 'info' \? t\.info/.test(kit))
  check('CommandCenter shell border is STRUCTURE', /borderStyle="round" borderColor=\{t\.borderStrong\} paddingX=\{1\}>/.test(kit))
  const railPanel = src('components', 'mercury-ui', 'RailPanel.tsx')
  check('RailPanel headers ride the info channel', /const headerHue = tokens\.info/.test(railPanel))
  const spinner = src('components', 'Spinner.tsx')
  check("SUBMIT→WAITING wears info; thinking regains identity (requesting → 'info')",
    /requesting \? 'info' : 'brand'/.test(spinner))
  const md = src('utils', 'markdown.ts')
  check("inline code spans ride 'info'", /color\('info', theme\)\(token\.text\)/.test(md))
  const fsl = src('components', 'FullscreenLayout.tsx')
  // The pill rides the sanctioned RailPanel hover grammar —
  // info at rest, infoShimmer on hover (same law this suite pins for
  // RailPanel headers). Rest role unchanged.
  check('the jump-to-new pill is a NAVIGATION cue (info bg at rest, infoShimmer on hover)',
    /backgroundColor=\{hover \? 'infoShimmer' : 'info'\}/.test(fsl))
  const lanes = src('components', 'HelmLanesRail.tsx')
  // HZ2 widened the destructure (textMuted joined) — the law is unchanged:
  // lane names resolve `info` from the adaptive layer, never a fixed hue.
  check('lanes rail: lane names ride info', /const \{ info[^}]*\} = useMercuryTokens\(\)/.test(lanes))
  check('lanes rail: no standing "no recent sessions" stub', !/no recent sessions/.test(lanes))
  check('lanes rail: no stub gamedev lane', !/no missions yet/.test(lanes))
  check('lanes rail: empty CREW disappears (never engaged ⇒ no stub)', !/no crew running/.test(lanes))
  const palette = src('components', 'MercuryCommandPalette.tsx')
  check('palette rows are one line by construction (no footer bleed)',
    /wrap="truncate-end">\s*<Text color=\{here \? accent : tokens\.textMuted\}/.test(palette.replace(/\n/g, ' ').replace(/\s+/g, ' ')) || /truncate-end/.test(palette))
}

section('§7 — no new animation machinery (motion joins existing tiers only)')
{
  // The-touched chrome must not have minted a raw interval: the ONLY
  // sanctioned clocks are useAnimationValue/useAnimationFrame on the
  // lattice (proved by scripts/transcript-rows/prove-motion-hierarchy.ts) and the
  // existing two-state setTimeout latches in LiveGlyphs. setInterval is banned
  // in all-touched UI files.
  const touched = [
    ['components', 'mercury-ui', 'RailPanel.tsx'],
    ['components', 'mercury-ui', 'components.tsx'],
    ['components', 'mercury-ui', 'LiveGlyphs.tsx'],
    ['components', 'HelpV2', 'ShortcutsTab.tsx'],
    ['components', 'HelpV2', 'Commands.tsx'],
    ['components', 'permissions', 'PermissionDialog.tsx'],
    ['components', 'MercuryCommandPalette.tsx'],
  ] as string[][]
  for (const p of touched) {
    check(`${p[p.length - 1]}: no setInterval`, !/setInterval\(/.test(src(...p)))
  }
}

console.log('\n' + '═'.repeat(76))
if (failures === 0) console.log('✅ ALL AURORA ROLE PROOFS PASS')
else {
  console.log(`❌ ${failures} AURORA ROLE PROOF(S) FAILED`)
  process.exit(1)
}
