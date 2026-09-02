// ============================================================================
// prove-kit-tristate — THE SKILLS TRI-STATE at its three seams (ledger L24(5)).
//
//  on        = in the command table AND in getSkillToolCommands' product;
//  invocable = in the command table, EXCLUDED from every model-facing
//              listing (the per-session analogue of the author's
//              disable-model-invocation — and implemented THROUGH it, on a
//              copy);
//  off       = ABSENT from the command table (the body never loads).
//
//  POISONS (armed): a kit WIDENING an author's disable-model-invocation ·
//  the loader's cached object mutated by the mark · an off skill still in
//  the table · an invocable skill in the model list · the overlay keyed
//  into the per-cwd disk memo (a second walk / stale product).
//
//  Hermetic and cpu-pure: scratch config home + scratch project cwd; the
//  REAL loader doors and the REAL catalogue seam; nothing spawns.
//  Run:  ~/.bun/bin/bun run scripts/skills/prove-kit-tristate.ts
// ============================================================================
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const SCRATCH = mkdtempSync(join(tmpdir(), 'kit-tristate-'))
process.env.MERCURY_CONFIG_DIR = join(SCRATCH, 'home')
mkdirSync(process.env.MERCURY_CONFIG_DIR, { recursive: true })
process.env.MERCURY_DAEMON_DIR = join(SCRATCH, 'daemon')
const PROJECT = join(SCRATCH, 'project')
mkdirSync(PROJECT, { recursive: true })
process.chdir(PROJECT)
if (process.env.NODE_ENV === 'test') delete process.env.NODE_ENV
delete process.env.CI
delete process.env.MERCURY_SESSION_KIT
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

let failures = 0
const t = (name: string, ok: boolean, detail = ''): void => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && detail ? ` — ${detail}` : ''}`)
  if (!ok) failures++
}
const section = (s: string): void => console.log(`\n── ${s} ──`)
const watchdog = setTimeout(() => {
  console.log('\nTIMEOUT — tri-state prover exceeded 120s')
  process.exit(1)
}, 120_000)
watchdog.unref?.()

console.log('============================================================')
console.log(' KIT tri-state — on · invocable · off, at the three seams')
console.log('============================================================')

const { enableConfigs } = await import('../../src/utils/config/globalConfig.ts')
enableConfigs()

// ── §1 the pure classifier + overlay (shape-true fixtures) ──────────────────
section('§1 the classifier and the two overlay halves, pure')
{
  const g = await import('../../src/skills/kitGovernance.ts')
  g._resetKitGovernanceForTesting()
  const loader = { type: 'prompt', name: 'ns:alpha', description: 'a', loadedFrom: 'skills', source: 'projectSettings' } as never
  const legacy = { type: 'prompt', name: 'old-cmd', description: 'l', loadedFrom: 'legacy-commands', source: 'projectSettings' } as never
  const extSkill = { type: 'prompt', name: 'orchard:prune', description: 'e', loadedFrom: 'extension', source: 'extension', skillRoot: '/x/skills/prune' } as never
  const extCommand = { type: 'prompt', name: 'orchard:sweep', description: 'c', loadedFrom: 'extension', source: 'extension' } as never
  const bundled = { type: 'prompt', name: 'debug', description: 'b', loadedFrom: 'bundled', source: 'builtin' } as never
  const builtin = { type: 'local', name: 'help', description: 'h', source: 'builtin' } as never
  t(
    'T1 governed BY NAME = loader skills + legacy commands + extension SKILLS (skillRoot, the build\'s own discriminator); extension COMMANDS, bundled organs and builtins are not',
    g.isKitGovernedSkillCommand(loader) && g.isKitGovernedSkillCommand(legacy) && g.isKitGovernedSkillCommand(extSkill) && !g.isKitGovernedSkillCommand(extCommand) && !g.isKitGovernedSkillCommand(bundled) && !g.isKitGovernedSkillCommand(builtin),
  )
  const authorDisabled = { ...(loader as object), name: 'ns:quiet', disableModelInvocation: true } as never
  g.noteBootSkillRoster(['ns:alpha', 'old-cmd', 'orchard:prune', 'ns:quiet'])
  const resolved = { schema: 1, mcp: [], skills: ['ns:alpha', 'ns:quiet'], invocable: ['old-cmd'], extensions: {} } as never
  t('T2 resolved kit: a listed-on skill keeps its author object BY IDENTITY (no copy, no mutation)', g.withKitSkillMark(resolved, loader) === loader && !g.kitDropsCommand(resolved, loader))
  const marked = g.withKitSkillMark(resolved, legacy) as { disableModelInvocation?: boolean; kitSkillState?: string }
  t('T3 resolved kit: an invocable skill is a COPY with disableModelInvocation set + the kit provenance named; the input object is untouched', marked !== (legacy as object) && marked.disableModelInvocation === true && marked.kitSkillState === 'invocable' && (legacy as { disableModelInvocation?: boolean }).disableModelInvocation === undefined)
  t('T4 resolved kit: a boot-roster skill ABSENT from the lists is OFF (dropped — the operator\'s screen saw the row)', g.kitDropsCommand(resolved, extSkill) === true)
  t("T5 POISON armed (the widening law): kit-on NEVER clears the author's own disable-model-invocation — the on arm passes the object through, switch intact", (g.withKitSkillMark(resolved, authorDisabled) as { disableModelInvocation?: boolean }).disableModelInvocation === true)
  const bornLater = { ...(loader as object), name: 'ns:newborn' } as never
  t("T6 the boot-roster rule: a governed skill born AFTER the snapshot passes on its author's frontmatter (the kit can only narrow what it could see)", !g.kitDropsCommand(resolved, bornLater) && g.withKitSkillMark(resolved, bornLater) === bornLater)
  t('T7 extension COMMANDS are never name-governed (their gate is the master row at the switch door)', !g.kitDropsCommand(resolved, extCommand) && g.withKitSkillMark(resolved, extCommand) === extCommand)
  const unresolved = { schema: 1, mcp: [], skills: [], invocable: [], resolved: false, deltas: { mcpOff: [], skillStates: { 'old-cmd': 'invocable', 'orchard:prune': 'off' }, extensionsOff: [] } } as never
  const uMarked = g.withKitSkillMark(unresolved, legacy) as { disableModelInvocation?: boolean; kitSkillState?: string }
  t('T8 the deltas arm AGREES with the resolved arm over the same roster (the completion relies on this agreement): same drop, same mark, same pass', g.kitDropsCommand(unresolved, extSkill) === true && uMarked.disableModelInvocation === true && uMarked.kitSkillState === 'invocable' && !g.kitDropsCommand(unresolved, loader) && g.withKitSkillMark(unresolved, loader) === loader)
  t('T9 no kit ⇒ both halves are identity (an un-kitted process does not move a byte)', !g.kitDropsCommand(undefined, extSkill) && g.withKitSkillMark(undefined, legacy) === legacy)
  g._resetKitGovernanceForTesting()
}

// ── §2 the REAL seams under a scratch home ──────────────────────────────────
section('§2 the real catalogue: command table · model list · roster, one law')
const skillDir = join(PROJECT, '.mercury', 'skills')
const writeSkill = (name: string, frontmatter = ''): void => {
  mkdirSync(join(skillDir, name), { recursive: true })
  writeFileSync(join(skillDir, name, 'SKILL.md'), `---\ndescription: the ${name} proof skill\n${frontmatter}---\n\nBody of ${name}.\n`)
}
{
  writeSkill('alpha')
  writeSkill('beta')
  writeSkill('gamma')
  writeSkill('delta', 'disable-model-invocation: true\n')

  const { getSkillDirCommands } = await import('../../src/skills/loadSkillsDir.ts')
  const loaderNames = (await getSkillDirCommands(PROJECT)).map(c => c.name)
  const nameOf = (base: string): string => loaderNames.find(n => n === base || n.endsWith(`:${base}`)) ?? base
  t('T10 the loader lists the four scratch skills (their own spellings drive the kit below)', ['alpha', 'beta', 'gamma', 'delta'].every(b => loaderNames.some(n => n === b || n.endsWith(`:${b}`))), loaderNames.join(','))

  // Latch the session kit through the REAL pin door: deltas — beta
  // invocable, gamma off.
  const pin = await import('../../src/services/mcp/sessionKitPin.ts')
  pin._resetSessionKitPinForTesting()
  process.env.MERCURY_SESSION_KIT = JSON.stringify({
    schema: 1,
    mcp: [],
    skills: [],
    invocable: [],
    resolved: false,
    deltas: { mcpOff: [], skillStates: { [nameOf('beta')]: 'invocable', [nameOf('gamma')]: 'off' }, extensionsOff: [] },
  })
  const receipt = pin.consumeSessionKitPin()
  t('T11 the kit latched through the consumed-once pin (the runner\'s own door)', receipt.outcome === 'pinned')

  const commands = await import('../../src/commands.ts')
  const table = await commands.getCommands(PROJECT)
  const inTable = (base: string): boolean => table.some(c => c.name === nameOf(base))
  const row = (base: string): { disableModelInvocation?: boolean; kitSkillState?: string } | undefined =>
    table.find(c => c.name === nameOf(base)) as never
  t('T12 SEAM 1, the command table: on + invocable PRESENT; off ABSENT (the body never loads)', inTable('alpha') && inTable('beta') && inTable('delta') && !inTable('gamma'))
  t("T13 the invocable row is the kit's mark (copy: disableModelInvocation + kitSkillState); the author-disabled row carries the author's switch alone", row('beta')?.disableModelInvocation === true && row('beta')?.kitSkillState === 'invocable' && row('delta')?.disableModelInvocation === true && row('delta')?.kitSkillState === undefined && row('alpha')?.disableModelInvocation !== true)
  const ambient = await commands.getSkillToolCommands(PROJECT)
  const inAmbient = (base: string): boolean => ambient.some(c => c.name === nameOf(base))
  t('T14 SEAM 2, the model list: ambient = author-allows ∧ kit-on (alpha only; beta kit-excluded; delta author-excluded; gamma absent)', inAmbient('alpha') && !inAmbient('beta') && !inAmbient('delta') && !inAmbient('gamma'))
  const { skillsRosterOf } = await import('../../src/services/engine-connector/rosterTerms.ts')
  const roster = skillsRosterOf(table)
  const rosterRow = (base: string): { state?: string } | undefined => roster.find(r => r.name === nameOf(base))
  t("T15 SEAM 3, the facts roster: the tri-state spoken — beta and delta 'invocable' (kit and author read as one law), alpha ambient (no state), gamma absent", rosterRow('beta')?.state === 'invocable' && rosterRow('delta')?.state === 'invocable' && rosterRow('alpha') !== undefined && rosterRow('alpha')?.state === undefined && rosterRow('gamma') === undefined)

  // ── §3 the memo boundary ──────────────────────────────────────────────────
  section('§3 the overlay sits AFTER the per-cwd disk memo (and never inside it)')
  writeSkill('epsilon')
  const again = await commands.getCommands(PROJECT)
  t('T16 a skill written after the first load is NOT listed without a cache clear (the disk memo still serves — the overlay forced no second walk)', !again.some(c => c.name === nameOf('epsilon')))
  const { clearSkillCaches } = await import('../../src/skills/loadSkillsDir.ts')
  clearSkillCaches()
  commands.clearCommandMemoizationCaches()
  const fresh = await commands.getCommands(PROJECT)
  const freshNames = (await getSkillDirCommands(PROJECT)).map(c => c.name)
  const epsName = freshNames.find(n => n === 'epsilon' || n.endsWith(':epsilon')) ?? 'epsilon'
  t('T17 after the real clear the newcomer appears AND the kit still governs the reloaded table (gamma stays off, beta stays invocable-marked)', fresh.some(c => c.name === epsName) && !fresh.some(c => c.name === nameOf('gamma')) && (fresh.find(c => c.name === nameOf('beta')) as { kitSkillState?: string } | undefined)?.kitSkillState === 'invocable')
  pin._resetSessionKitPinForTesting()
}

rmSync(SCRATCH, { recursive: true, force: true })
console.log(`\n${failures === 0 ? '✅ KIT TRI-STATE PINS GREEN' : `❌ ${failures} FAILURE(S)`}`)
process.exit(failures === 0 ? 0 : 1)
