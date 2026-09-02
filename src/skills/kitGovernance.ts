// ============================================================================
//  skills/kitGovernance — THE SKILLS TRI-STATE at the catalogue seam
//  (ledger L24(5)).
//
//  A session's kit speaks three states per skill — on (ambient AND /name) ·
//  invocable (/name only; excluded from every model-facing listing) · off
//  (ABSENT from the command table; the body never loads — skills lazy-load
//  at invocation, so absence is cheap and real). This module is the ONE
//  classifier + overlay the command catalogue applies AFTER the per-cwd
//  disk memo (per-session state must never key a disk cache) and BEFORE the
//  per-name dedupe (an off skill must not shadow a sibling out of the
//  table — the same law that puts the enabled-ness filter before the walk).
//
//  WHAT THE KIT GOVERNS BY NAME: loader skills (SKILL.md + legacy commands)
//  and extension SKILLS. Bundled skills are Mercury's own organs (never
//  listed on the menu, never governed); workflows and builtins are not
//  skills; extension COMMANDS ride their extension's MASTER row (the
//  activeFor switch door — the extension-AND commit), never a name list.
//
//  THE COMPOSITION LAW (forced, pinned): the kit NARROWS author
//  frontmatter, never widens — a kit-invocable mark SETS
//  disableModelInvocation on a COPY (the loader's cached object is never
//  mutated) and kit-on never clears an author's own
//  disable-model-invocation. effective-ambient = author-allows ∧ kit-on.
//
//  THE BOOT-ROSTER RULE (lane ruling, scope ACK): a RESOLVED kit's closed
//  lists govern the roster that was ENUMERABLE at boot — the same doors the
//  menu screen read. A governed skill ABSENT from the lists is OFF when the
//  boot roster knew it (the operator's screen saw the row and left it off)
//  and PASSES on the author's own frontmatter when it was born later (a
//  conditional pathFilters activation, a mid-session skill-forge creation):
//  a kit can only narrow what it could see. An UNRESOLVED kit is
//  deltas-driven (absent = on) and needs no such split.
// ============================================================================
import type { SessionKitV1 } from '../daemon/sessionKit.js'
import type { Command } from '../commands.js'

/** Is this command a skill the kit governs BY NAME? */
export function isKitGovernedSkillCommand(command: Command): boolean {
  if (command.type !== 'prompt') return false
  const loadedFrom = (command as { loadedFrom?: string }).loadedFrom
  if (loadedFrom === 'skills' || loadedFrom === 'legacy-commands') return true
  // Extension entries: a SKILL carries its base dir (skillRoot — the
  // build's own discriminator); an extension COMMAND does not and rides the
  // master row instead.
  if (loadedFrom === 'extension') return (command as { skillRoot?: string }).skillRoot !== undefined
  return false
}

// ── the boot roster (process-latched, like the kit pin) ─────────────────────

let bootRoster: ReadonlySet<string> | null = null

/** Latch the governed names enumerable at boot — first full catalogue wins. */
export function noteBootSkillRoster(governedNames: Iterable<string>): void {
  if (bootRoster !== null) return
  bootRoster = new Set(governedNames)
}

export function isBootRosterSkill(name: string): boolean {
  return bootRoster !== null && bootRoster.has(name)
}

/** Proof seam only. */
export function _resetKitGovernanceForTesting(): void {
  bootRoster = null
}

// ── the two overlay halves (drop before dedupe · mark beside it) ────────────

/** The kit's state for one governed skill name. */
function kitSkillStateOf(kit: SessionKitV1, name: string, bornLater: boolean): 'on' | 'invocable' | 'off' | 'ungoverned' {
  if (kit.resolved === false) {
    const state = kit.deltas?.skillStates[name]
    return state === undefined ? 'on' : state
  }
  // EXPLICITLY off outranks everything (the skillsOff row a
  // dial writes — durable off for born-later names too, where absence
  // alone would fall to 'ungoverned' below and the dial would lie).
  if ((kit.skillsOff ?? []).includes(name)) return 'off'
  if (kit.skills.includes(name)) return 'on'
  if (kit.invocable.includes(name)) return 'invocable'
  // Absent from a CLOSED kit: off when the boot roster knew the name;
  // ungoverned when it was born later (the kit could not have seen it).
  return bornLater ? 'ungoverned' : 'off'
}

/** DROP half: true ⇒ the command leaves the table (the body never loads). */
export function kitDropsCommand(kit: SessionKitV1 | undefined, command: Command): boolean {
  if (kit === undefined || !isKitGovernedSkillCommand(command)) return false
  return kitSkillStateOf(kit, command.name, !isBootRosterSkill(command.name)) === 'off'
}

/**
 * THE OFF ROWS for the session's roster projection: every
 * governed name this process KNOWS to be off — the boot roster's names the
 * kit dropped from the table, plus the kit's explicit off rows (skillsOff /
 * the deltas' off states — born-later names the walk never saw). The dial
 * screen lists them so the on-direction has rows; display-only (model-
 * facing filters read the table). An un-kitted process has nothing off.
 */
export function offSkillNamesOf(kit: SessionKitV1 | undefined, tableNames: readonly string[]): string[] {
  if (kit === undefined) return []
  const present = new Set(tableNames)
  const spoken =
    kit.resolved === false
      ? Object.entries(kit.deltas?.skillStates ?? {})
          .filter(([, state]) => state === 'off')
          .map(([name]) => name)
      : (kit.skillsOff ?? [])
  const out: string[] = []
  for (const name of new Set([...(bootRoster ?? []), ...spoken])) {
    if (present.has(name)) continue
    if (kitSkillStateOf(kit, name, !isBootRosterSkill(name)) !== 'off') continue
    out.push(name)
  }
  return out
}

/**
 * MARK half: a kit-invocable skill answers /name but leaves every
 * model-facing listing — returned as a COPY with disableModelInvocation set
 * (the author's own switch; every existing filter follows with zero edits)
 * and the kit provenance named. Never mutates the loader's cached object;
 * never CLEARS an author's disable (narrowing only).
 */
export function withKitSkillMark(kit: SessionKitV1 | undefined, command: Command): Command {
  if (kit === undefined || !isKitGovernedSkillCommand(command)) return command
  const state = kitSkillStateOf(kit, command.name, !isBootRosterSkill(command.name))
  if (state !== 'invocable') return command
  return { ...command, disableModelInvocation: true, kitSkillState: 'invocable' as const }
}
