// ============================================================================
//  daemon/sessionKit — THE SESSION'S KIT: the born-with snapshot of the
//  MCP servers, skills and extensions THIS session runs with (ledger L24
//  (1)–(5) + L24(6-SUPERSEDED)), its validator, and the
//  record's stamp/re-stamp seams.
//
//  TWO STORES, NEVER ONE (the §0.1 law): the MENU store (services/mcp/
//  kitStore.ts — mutable, per repo, DELTAS: the NEXT session's default) and
//  THIS record (a closed snapshot, owned by the session). A live session
//  never changes because the menu changed; a dead transcript re-started is
//  RE-STAMPED from the current menu — the deliberate OPPOSITE of the
//  retained model/effort/settings (the operator's word: "reloads with the
//  new boot menu applied"), the displaced kit ledgered on the session's
//  receipt as history, never reloaded. /mcp + /skills inside a session are
//  that session's private dials, both directions, and write only here.
//
//  ABSENT ≠ EMPTY (the deadliest confusion in this estate): a record with
//  NO kit is a pre-kit record — whole-config behaviour, every configured
//  member loads (the compatibility law: no migration, no rewrite of old
//  records). A kit whose lists are EMPTY loads NOTHING. No reader may heal
//  absence into an empty kit, and a MALFORMED kit on the wire REFUSES TYPED
//  — a silently dropped kit births whole-config, a leak of scope.
//
//  RESOLVED vs UNRESOLVED: a kit the SCREEN composed (the menu enumerates
//  the roster) is a closed snapshot — its lists ARE the membership. A kit
//  the DAEMON derived for a birth its screen never saw (a coordinator
//  launch_session, another terminal) carries `resolved: false` + the menu's
//  DELTAS: its lists are PROVISIONAL (what the daemon could enumerate from
//  the config it holds); the runner completes the snapshot at its first
//  boot by applying the deltas to the roster it resolves and reports the
//  resolved kit back through session_facts. A reader of
//  an unresolved kit reads the deltas — never the lists as closed.
//
//  Extensions are CONTAINERS: their skills/servers land in the same lists
//  under the runner's resolved spellings (ext:<name>:<server>, <name>:<skill>);
//  `extensions` carries the per-extension MASTER state (off = everything it
//  contributes, commands and hooks included — the operator's option 2).
//
//  Vocabulary: a saved kit snapshot is a PRESET; "pack" is the extensions estate's word.
//
//  ONE WRITER — the daemon. The record's kit mutation sites are exactly
//  three: the admission stamp and the reactivation re-stamp (both in
//  concourseSupervisor.ts, through stampSessionKit below) and the
//  sessionControl action 'set-kit' (applyConcourseKitOp, the dials' door).
// ============================================================================
import { mkdirSync } from 'node:fs'
import { logForDebugging } from '../utils/debug.js'
import { getProjectDir } from '../utils/sessionStorage/paths.js'
import { appendSessionReceipt } from '../services/switchboard/sessionReceipts.js'
import { getGlobalConfig, getProjectConfigForWorkspace } from '../utils/config.js'
import { emptyKitDeltas, kitDeltasForWorkspace, type KitDeltasV1 } from '../services/mcp/kitStore.js'
import { kitPresetDeltas } from '../services/mcp/presetStore.js'
import type { ConcourseWorkerRecordV1 } from './concourseSupervisor.js'

/** The session's kit — RESOLVED at birth (closed membership) and owned by
 *  the session afterward; absent on a pre-kit record = whole-config. */
export interface SessionKitV1 {
  schema: 1
  /** MCP servers this session connects (two states: listed = on), in the
   *  runner's resolved spellings — a config key, or ext:<name>:<server>. */
  mcp: string[]
  /** Ambient skills (listed to the model AND the /name door). */
  skills: string[]
  /** Invocable-only skills (/name works; never ambient). L24(5). A skill
   *  has ONE state: never in both lists. */
  invocable: string[]
  /** EXPLICITLY-OFF skills (a RECORD-schema widening, the
   *  lead's Q4 ruling; additive: old readers ignore it). A resolved kit's
   *  absence means off only for names the boot roster could SEE — a skill
   *  born later (conditional activation, a mid-session skill-forge) passes
   *  on its author's frontmatter. Without this list a dial-off of such a
   *  skill was a LYING DIAL: the record could not say it, so the writer
   *  answered noop while the skill stayed ambient. Populated by dials (and
   *  the re-completion's off-carry) only; the menu still encodes off as
   *  absence. Disjoint from `skills` and `invocable`; absent when empty. */
  skillsOff?: string[]
  /** The per-extension MASTER rows, by manifest name: 'off' = nothing the
   *  extension contributes loads. Absent on a kit that names no extension. */
  extensions?: Record<string, 'on' | 'off'>
  /** Present (false) ONLY on a daemon-derived stamp. THE LAW (lead-ruled at
   *  the scope ACK): a resolved kit is the CLOSED MEMBERSHIP; an unresolved
   *  kit is DELTAS-ONLY — the lists above are PROVISIONAL (what the daemon
   *  could enumerate) and NOTHING may read them as membership; the runner's
   *  completion at its first boot, reported through session_facts, is the
   *  only road from unresolved to resolved. A resolved kit omits the field
   *  — `resolved: true` is not a spelling. */
  resolved?: false
  /** The menu's deltas the derivation stamped (present iff resolved:false). */
  deltas?: KitDeltasV1
}

// ── the grammars ────────────────────────────────────────────────────────────
// The MCP server-name charset is config.ts's addMcpConfig law (letters,
// digits, hyphen, underscore); an extension's server rides its fixed prefix
// with the manifest's NAME_PATTERN (extensions/manifest.ts — spelled here
// because that module carries zod and the LSP schema, which the daemon never
// loads; prove-session-kit pins the two spellings equal). Skills have NO
// charset in the tree — a name is `namespace:base` or `<ext>:<skill>`, any
// folder spelling — so the kit's skill grammar is shape only: non-empty,
// bounded, no whitespace, no control bytes, no path separators.
export const KIT_MCP_NAME_PATTERN = /^[a-zA-Z0-9_-]+$/
export const KIT_EXTENSION_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,39}$/
export const KIT_EXTENSION_SERVER_PATTERN = /^ext:[a-z0-9][a-z0-9-]{0,39}:[^\s\x00-\x1f\x7f]{1,128}$/
export const KIT_SKILL_NAME_PATTERN = /^[^\s/\\\x00-\x1f\x7f]{1,200}$/
/** A hostile frame must never stamp a boundless record. */
export const KIT_LIST_CAP = 2000

export type KitValidation = { ok: true; kit: SessionKitV1 } | { ok: false; reason: string }

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function validateNames(
  raw: unknown,
  field: string,
  accept: (name: string) => boolean,
  grammar: string,
): { ok: true; names: string[] } | { ok: false; reason: string } {
  if (!Array.isArray(raw)) return { ok: false, reason: `${field} must be an array of names` }
  if (raw.length > KIT_LIST_CAP) return { ok: false, reason: `${field} lists ${raw.length} names (cap ${KIT_LIST_CAP})` }
  const names: string[] = []
  for (const entry of raw) {
    if (typeof entry !== 'string') return { ok: false, reason: `${field} carries a non-string entry` }
    if (!accept(entry)) return { ok: false, reason: `${field} name ${JSON.stringify(entry.slice(0, 64))} is not ${grammar}` }
    if (names.includes(entry)) return { ok: false, reason: `${field} lists ${JSON.stringify(entry)} twice` }
    names.push(entry)
  }
  return { ok: true, names }
}

export const isKitMcpName = (name: string): boolean => KIT_MCP_NAME_PATTERN.test(name) || KIT_EXTENSION_SERVER_PATTERN.test(name)
export const isKitSkillName = (name: string): boolean => KIT_SKILL_NAME_PATTERN.test(name)
export const isKitExtensionName = (name: string): boolean => KIT_EXTENSION_NAME_PATTERN.test(name)

const MCP_GRAMMAR = 'an MCP server name (letters, digits, hyphen, underscore — or ext:<extension>:<server>)'
const SKILL_GRAMMAR = 'a skill name (1–200 chars, no whitespace, no path separators)'
const EXTENSION_GRAMMAR = 'an extension name (lowercase letters, digits and hyphens, 1–40 chars)'

/** The menu-delta shape a derived (unresolved) kit carries. */
export function validateKitDeltas(raw: unknown): { ok: true; deltas: KitDeltasV1 } | { ok: false; reason: string } {
  if (!isRecord(raw)) return { ok: false, reason: 'deltas must be an object' }
  const mcpOff = validateNames(raw.mcpOff, 'deltas.mcpOff', isKitMcpName, MCP_GRAMMAR)
  if (!mcpOff.ok) return mcpOff
  const extensionsOff = validateNames(raw.extensionsOff, 'deltas.extensionsOff', isKitExtensionName, EXTENSION_GRAMMAR)
  if (!extensionsOff.ok) return extensionsOff
  if (!isRecord(raw.skillStates)) return { ok: false, reason: 'deltas.skillStates must be an object' }
  const skillStates: Record<string, 'off' | 'invocable'> = {}
  const entries = Object.entries(raw.skillStates)
  if (entries.length > KIT_LIST_CAP) return { ok: false, reason: `deltas.skillStates names ${entries.length} skills (cap ${KIT_LIST_CAP})` }
  for (const [name, state] of entries) {
    if (!isKitSkillName(name)) return { ok: false, reason: `deltas.skillStates name ${JSON.stringify(name.slice(0, 64))} is not ${SKILL_GRAMMAR}` }
    if (state !== 'off' && state !== 'invocable') return { ok: false, reason: `deltas.skillStates[${JSON.stringify(name)}] must be 'off' or 'invocable'` }
    skillStates[name] = state
  }
  return { ok: true, deltas: { mcpOff: mcpOff.names, skillStates, extensionsOff: extensionsOff.names } }
}

/**
 * THE WIRE'S NARROWING for a kit: the exact shape or a typed reason. Unknown
 * sibling fields are dropped (the record carries exactly its schema; an old
 * reader of a newer kit ignores what it does not know — the record family's
 * convention). Never returns a partial kit: refuse whole, or accept whole.
 */
export function validateSessionKit(raw: unknown): KitValidation {
  if (!isRecord(raw)) return { ok: false, reason: 'a kit must be an object' }
  if (raw.schema !== 1) return { ok: false, reason: `kit schema ${JSON.stringify(raw.schema)} is not 1` }
  const mcp = validateNames(raw.mcp, 'mcp', isKitMcpName, MCP_GRAMMAR)
  if (!mcp.ok) return mcp
  const skills = validateNames(raw.skills, 'skills', isKitSkillName, SKILL_GRAMMAR)
  if (!skills.ok) return skills
  const invocable = validateNames(raw.invocable, 'invocable', isKitSkillName, SKILL_GRAMMAR)
  if (!invocable.ok) return invocable
  const both = skills.names.find(name => invocable.names.includes(name))
  if (both !== undefined) return { ok: false, reason: `skill ${JSON.stringify(both)} is listed both ambient and invocable — a skill has one state` }
  const kit: SessionKitV1 = { schema: 1, mcp: mcp.names, skills: skills.names, invocable: invocable.names }
  if (raw.skillsOff !== undefined) {
    const skillsOff = validateNames(raw.skillsOff, 'skillsOff', isKitSkillName, SKILL_GRAMMAR)
    if (!skillsOff.ok) return skillsOff
    const contradicted = skillsOff.names.find(name => skills.names.includes(name) || invocable.names.includes(name))
    if (contradicted !== undefined) return { ok: false, reason: `skill ${JSON.stringify(contradicted)} is listed both off and on/invocable — a skill has one state` }
    if (skillsOff.names.length > 0) kit.skillsOff = skillsOff.names
  }
  if (raw.extensions !== undefined) {
    if (!isRecord(raw.extensions)) return { ok: false, reason: 'extensions must be an object of on|off' }
    const entries = Object.entries(raw.extensions)
    if (entries.length > KIT_LIST_CAP) return { ok: false, reason: `extensions names ${entries.length} extensions (cap ${KIT_LIST_CAP})` }
    const extensions: Record<string, 'on' | 'off'> = {}
    for (const [name, state] of entries) {
      if (!isKitExtensionName(name)) return { ok: false, reason: `extension name ${JSON.stringify(name.slice(0, 64))} is not ${EXTENSION_GRAMMAR}` }
      if (state !== 'on' && state !== 'off') return { ok: false, reason: `extensions[${JSON.stringify(name)}] must be 'on' or 'off'` }
      extensions[name] = state
    }
    kit.extensions = extensions
  }
  if (raw.resolved !== undefined) {
    if (raw.resolved !== false) return { ok: false, reason: 'resolved carries only false (a resolved kit omits the field)' }
    const deltas = validateKitDeltas(raw.deltas)
    if (!deltas.ok) return { ok: false, reason: `an unresolved kit needs its deltas — ${deltas.reason}` }
    kit.resolved = false
    kit.deltas = deltas.deltas
  } else if (raw.deltas !== undefined) {
    return { ok: false, reason: 'deltas ride only an unresolved kit (resolved: false)' }
  }
  return { ok: true, kit }
}

/** A deep copy — the record never aliases a caller's arrays. */
export function cloneSessionKit(kit: SessionKitV1): SessionKitV1 {
  return JSON.parse(JSON.stringify(kit)) as SessionKitV1
}

// ── the stamp seams (the supervisor's two mutation sites ride these) ────────

/** Where a stamped kit came from: 'carried' — the door's own snapshot;
 *  'derived' — the daemon's menu composition; 'preset' — the daemon's
 *  PRESET derivation (L24(4): the admit named a saved
 *  preset and the kit was derived from ITS deltas instead of the menu's). */
export type KitStampSource = 'carried' | 'derived' | 'preset'

/** THE STAMP at admission (a fresh mint, a warm claim): the record literal's
 *  kit fragment — a COPY when a kit was carried, NOTHING when none was
 *  (absent = whole-config; never `kit: undefined`, never an empty kit).
 *  Called only from the supervisor's two mints. */
export function kitStampOf(kit: SessionKitV1 | undefined): { kit: SessionKitV1 } | Record<string, never> {
  return kit !== undefined ? { kit: cloneSessionKit(kit) } : {}
}

/**
 * THE RE-STAMP (the §0.4 law): a reactivated record takes the CURRENT
 * menu's kit and the displaced kit goes to the session's receipt as history
 * — never reloaded. Model, effort and the settings snapshot are NOT touched
 * here: their retention is the record's own law and this seam's deliberate
 * contrast. A pre-kit record (no kit to displace) stamps without a receipt
 * row: nothing was displaced. Fail-soft on the receipt: the row is the
 * honesty valve, the stamp is the law — a receipt write that fails never
 * refuses a reactivation.
 */
export function restampSessionKit(rec: ConcourseWorkerRecordV1, next: SessionKitV1, source: KitStampSource, by: string): void {
  const displaced = rec.kit
  rec.kit = cloneSessionKit(next)
  if (displaced === undefined) return
  try {
    const home = getProjectDir(rec.workspaceId)
    mkdirSync(home, { recursive: true })
    appendSessionReceipt(home, rec.sessionId, {
      at: new Date().toISOString(),
      by,
      kind: 'kit-restamp',
      // The sentence tells the truth per source: a preset re-stamp did NOT
      // come from the menu (the admit answer names WHICH preset).
      summary:
        source === 'preset'
          ? 'kit re-stamped from the named preset (preset); the kit this session parked with is history here, never reloaded'
          : `kit re-stamped from the current menu (${source}); the kit this session parked with is history here, never reloaded`,
      details: { source, was: displaced, now: cloneSessionKit(next) },
    })
  } catch (err) {
    logForDebugging(`[kit] re-stamp receipt failed for ${rec.sessionId}: ${err}`)
  }
}

/**
 * THE RECORD-LESS RESUME'S LOUD ROW (the recordToEntry
 * precedent's law: ABSENT inputs derive loudly, never default silently). A
 * bare history transcript admitted with no standing record mints a fresh
 * stamp on the cold road — this row says so on the session's receipt: the
 * session came back under the CURRENT menu's kit; whatever it once ran
 * with is unknowable here and nothing was displaced. The same kind as the
 * re-stamp (the viewer's kit family renders it), the same fail-soft valve:
 * a receipt write that fails never refuses the resume. Not a pen — the
 * record's kit was stamped by the mint; this only ledgers the loudness.
 */
export function noteRecordlessResumeKit(
  rec: Pick<ConcourseWorkerRecordV1, 'workspaceId' | 'sessionId'>,
  kit: SessionKitV1,
  source: KitStampSource,
  by: string,
): void {
  try {
    const home = getProjectDir(rec.workspaceId)
    mkdirSync(home, { recursive: true })
    appendSessionReceipt(home, rec.sessionId, {
      at: new Date().toISOString(),
      by,
      kind: 'kit-restamp',
      summary: `kit ${source === 'carried' ? "carried by the screen's menu" : 'derived fresh from the current menu'} (record-less resume); the transcript's past life left no kit to displace`,
      details: { source, now: cloneSessionKit(kit) },
    })
  } catch (err) {
    logForDebugging(`[kit] record-less-resume receipt failed for ${rec.sessionId}: ${err}`)
  }
}

// ── the dials' edit grammar (the sessionControl action 'set-kit') ──────────

/** The wire's set-kit payload: the dial edits, one gesture each. A skill
 *  dial speaks the tri-state; MCP and extension dials speak on/off. */
export interface SessionKitEditV1 {
  mcp?: Array<{ name: string; on: boolean }>
  skills?: Array<{ name: string; state: 'on' | 'invocable' | 'off' }>
  extensions?: Array<{ name: string; on: boolean }>
}

export type KitEditValidation = { ok: true; edit: SessionKitEditV1 } | { ok: false; reason: string }

/** The wire's narrowing for a dial edit: the exact shape or a typed reason.
 *  An edit naming no dial refuses — a no-op frame is a caller's bug, never
 *  a silent 'applied'. */
export function validateSessionKitEdit(raw: unknown): KitEditValidation {
  if (!isRecord(raw)) return { ok: false, reason: 'kitEdit must be an object' }
  const edit: SessionKitEditV1 = {}
  let dials = 0
  const bounded = (field: 'mcp' | 'skills' | 'extensions'): unknown[] | undefined | string => {
    const v = raw[field]
    if (v === undefined) return undefined
    if (!Array.isArray(v)) return `kitEdit.${field} must be an array of dials`
    if (v.length > KIT_LIST_CAP) return `kitEdit.${field} names ${v.length} dials (cap ${KIT_LIST_CAP})`
    return v
  }
  const mcp = bounded('mcp')
  if (typeof mcp === 'string') return { ok: false, reason: mcp }
  if (mcp !== undefined) {
    edit.mcp = []
    for (const entry of mcp) {
      if (!isRecord(entry) || typeof entry.name !== 'string' || typeof entry.on !== 'boolean') return { ok: false, reason: 'kitEdit.mcp dials are { name, on }' }
      if (!isKitMcpName(entry.name)) return { ok: false, reason: `kitEdit.mcp name ${JSON.stringify(entry.name.slice(0, 64))} is not ${MCP_GRAMMAR}` }
      edit.mcp.push({ name: entry.name, on: entry.on })
      dials++
    }
  }
  const skills = bounded('skills')
  if (typeof skills === 'string') return { ok: false, reason: skills }
  if (skills !== undefined) {
    edit.skills = []
    for (const entry of skills) {
      if (!isRecord(entry) || typeof entry.name !== 'string' || (entry.state !== 'on' && entry.state !== 'invocable' && entry.state !== 'off')) {
        return { ok: false, reason: 'kitEdit.skills dials are { name, state: on|invocable|off }' }
      }
      if (!isKitSkillName(entry.name)) return { ok: false, reason: `kitEdit.skills name ${JSON.stringify(entry.name.slice(0, 64))} is not ${SKILL_GRAMMAR}` }
      edit.skills.push({ name: entry.name, state: entry.state })
      dials++
    }
  }
  const extensions = bounded('extensions')
  if (typeof extensions === 'string') return { ok: false, reason: extensions }
  if (extensions !== undefined) {
    edit.extensions = []
    for (const entry of extensions) {
      if (!isRecord(entry) || typeof entry.name !== 'string' || typeof entry.on !== 'boolean') return { ok: false, reason: 'kitEdit.extensions dials are { name, on }' }
      if (!isKitExtensionName(entry.name)) return { ok: false, reason: `kitEdit.extensions name ${JSON.stringify(entry.name.slice(0, 64))} is not ${EXTENSION_GRAMMAR}` }
      edit.extensions.push({ name: entry.name, on: entry.on })
      dials++
    }
  }
  if (dials === 0) return { ok: false, reason: 'kitEdit names no dial' }
  return { ok: true, edit }
}

/** A pre-kit record's kit, materialized from its whole-config reality: an
 *  UNRESOLVED kit whose deltas carry the STANDING MCP off-record the
 *  process was actually enforcing — exactly what the session was running —
 *  so the first dial in an old session is an edit, never a refusal.
 *  AMENDED (the lead-ruled defect fix): the empty-deltas
 *  materialization was honest only while nothing forwarded it — once the
 *  live forward exists, an empty-deltas kit WIDENS the process on its
 *  first dial (the unresolved membership arm never consults the record
 *  again, so a record-disabled server would silently become a member).
 *  Skills and extensions stay empty: an un-kitted process never applied
 *  the menu's skill or extension states — only the MCP off-record was
 *  live (recordMembership). Names are grammar-filtered like the
 *  derivation's (a store spelling the wire would refuse must not poison
 *  the kit). */
export function materializedWholeConfigKit(mcpOff: readonly string[] = []): SessionKitV1 {
  return {
    schema: 1,
    mcp: [],
    skills: [],
    invocable: [],
    resolved: false,
    deltas: { mcpOff: mcpOff.filter(name => isKitMcpName(name)), skillStates: {}, extensionsOff: [] },
  }
}

/** The daemon writer's materialization for a record: the workspace slice's
 *  rendered off-record (the same store the derivation reads, workspace-
 *  keyed — never the daemon's own cwd). Fail-soft like the derivation: an
 *  unreadable store materializes empty — today's behaviour, never a
 *  refusal. */
export function materializedKitForWorkspace(workspaceDir: string): SessionKitV1 {
  try {
    return materializedWholeConfigKit(kitDeltasForWorkspace(workspaceDir).mcpOff)
  } catch (err) {
    logForDebugging(`[kit] the materialization for ${workspaceDir} fell to empty deltas: ${err}`)
    return materializedWholeConfigKit()
  }
}

/**
 * PURE: the kit after a dial edit. Two arms, one grammar — a RESOLVED kit
 * (the screen composed it: its lists ARE the membership) edits its closed
 * lists; an UNRESOLVED kit (the daemon derived it: the runner completes
 * against the deltas) edits its deltas — never its provisional lists.
 * Returns the INPUT by identity when nothing changes, so the writer can
 * answer 'noop' without a write.
 */
export function applyKitEdit(kit: SessionKitV1, edit: SessionKitEditV1): SessionKitV1 {
  const next = cloneSessionKit(kit)
  let changed = false
  const without = (list: string[], name: string): string[] => list.filter(entry => entry !== name)
  if (next.resolved === false) {
    const deltas = next.deltas ?? { mcpOff: [], skillStates: {}, extensionsOff: [] }
    next.deltas = deltas
    for (const dial of edit.mcp ?? []) {
      const off = deltas.mcpOff.includes(dial.name)
      if (dial.on && off) {
        deltas.mcpOff = without(deltas.mcpOff, dial.name)
        changed = true
      } else if (!dial.on && !off) {
        deltas.mcpOff.push(dial.name)
        changed = true
      }
    }
    for (const dial of edit.skills ?? []) {
      const standing = deltas.skillStates[dial.name] ?? 'on'
      if (standing === dial.state) continue
      if (dial.state === 'on') delete deltas.skillStates[dial.name]
      else deltas.skillStates[dial.name] = dial.state
      changed = true
    }
    for (const dial of edit.extensions ?? []) {
      const off = deltas.extensionsOff.includes(dial.name)
      if (dial.on && off) {
        deltas.extensionsOff = without(deltas.extensionsOff, dial.name)
        changed = true
      } else if (!dial.on && !off) {
        deltas.extensionsOff.push(dial.name)
        changed = true
      }
    }
    return changed ? next : kit
  }
  for (const dial of edit.mcp ?? []) {
    const listed = next.mcp.includes(dial.name)
    if (dial.on && !listed) {
      next.mcp.push(dial.name)
      changed = true
    } else if (!dial.on && listed) {
      next.mcp = without(next.mcp, dial.name)
      changed = true
    }
  }
  for (const dial of edit.skills ?? []) {
    // Four standings, not three (D3): EXPLICITLY off (the skillsOff row) is
    // distinct from merely ABSENT — absence is off only for boot-visible
    // names, so an off-dial on an absent name is a CHANGE (it makes the off
    // durable for born-later skills too; the lead's Q4 ruling — the noop
    // here was the lying dial).
    const standing = next.skills.includes(dial.name)
      ? 'on'
      : next.invocable.includes(dial.name)
        ? 'invocable'
        : (next.skillsOff ?? []).includes(dial.name)
          ? 'off'
          : 'absent'
    if (standing === dial.state) continue
    next.skills = without(next.skills, dial.name)
    next.invocable = without(next.invocable, dial.name)
    if (next.skillsOff !== undefined) {
      next.skillsOff = without(next.skillsOff, dial.name)
      if (next.skillsOff.length === 0) delete next.skillsOff
    }
    if (dial.state === 'on') next.skills.push(dial.name)
    else if (dial.state === 'invocable') next.invocable.push(dial.name)
    else next.skillsOff = [...(next.skillsOff ?? []), dial.name]
    changed = true
  }
  for (const dial of edit.extensions ?? []) {
    const extensions = next.extensions ?? {}
    const standingOn = (extensions[dial.name] ?? 'on') === 'on'
    if (standingOn === dial.on) continue
    extensions[dial.name] = dial.on ? 'on' : 'off'
    next.extensions = extensions
    changed = true
  }
  return changed ? next : kit
}

/** THE THIRD WRITER's pen (sessionKitOp.ts's set-kit): the record's kit
 *  set. The pen itself writes no receipt — a dial is the session's own
 *  act, not a displacement; the WRITER above it receipts the dial as
 *  'kit-dial'. Every `.kit =` assignment in the tree lives in
 *  THIS module. */
export function setSessionKit(rec: ConcourseWorkerRecordV1, kit: SessionKitV1): void {
  rec.kit = cloneSessionKit(kit)
}

/**
 * THE COMPLETION's pen (the fourth writer — sessionSeat's session_facts
 * arm): an UNRESOLVED record stamp becomes the RESOLVED kit
 * the runner reported — the ONLY road from provisional to resolved, taken
 * ONCE (a resolved record never moves again on this seam; a pre-kit record
 * is never stamped from a facts answer; an answer still unresolved stamps
 * nothing). No receipt: nothing is displaced — the provisional stamp was
 * a promise this fulfils.
 */
export function resolveSessionKitOnRecord(rec: ConcourseWorkerRecordV1, resolved: SessionKitV1): boolean {
  if (rec.kit === undefined || rec.kit.resolved !== false) return false
  if (resolved.resolved === false) return false
  rec.kit = cloneSessionKit(resolved)
  return true
}

// ── THE DERIVATION (the daemon-side fallback at the admission) ─────────────

/**
 * The kit for a birth its screen never saw — a coordinator launch_session,
 * another terminal's door, a record-less resume, a dispatch: the workspace's
 * menu DELTAS (the §0.3 workspace-keyed read — never the daemon's own cwd)
 * plus the MCP names the daemon can enumerate from the config it already
 * holds (the user scope's servers and the workspace slice's own) minus the
 * off-record, stamped UNRESOLVED: the lists are provisional, and the runner
 * completes the snapshot at its first boot against the roster IT resolves
 * (skills, extensions, .mcp.json approval and policy are the runner's own
 * walk — never re-run in the daemon) and reports it through session_facts
 * The config view is getGlobalConfig()'s — the one
 * reader, whose freshness watcher bounds a foreign write's staleness to its
 * 1s poll; the carried road (bootBirthFacts) stays the immediate-birth
 * truth for the screen that just wrote the menu. Fail-soft: an unreadable
 * store derives the EMPTY deltas — everything on, today's behaviour — never
 * a refusal.
 */
export function deriveSessionKitForWorkspace(workspaceDir: string): SessionKitV1 {
  let deltas: KitDeltasV1 = emptyKitDeltas()
  let known: string[] = []
  try {
    deltas = kitDeltasForWorkspace(workspaceDir)
    known = knownMcpNamesForWorkspace(workspaceDir)
  } catch (err) {
    logForDebugging(`[kit] the derivation for ${workspaceDir} fell to the empty deltas: ${err}`)
  }
  return {
    schema: 1,
    mcp: known.filter(name => isKitMcpName(name) && !deltas.mcpOff.includes(name)),
    skills: [],
    invocable: [],
    resolved: false,
    deltas,
  }
}

/** The MCP names the daemon can enumerate from the config it already holds
 *  (the user scope's servers and the workspace slice's own) — the shared
 *  census both derivations read. */
function knownMcpNamesForWorkspace(workspaceDir: string): string[] {
  const user = Object.keys(getGlobalConfig().mcpServers ?? {})
  const local = Object.keys(getProjectConfigForWorkspace(workspaceDir).mcpServers ?? {})
  return [...new Set([...user, ...local])]
}

// ── THE PRESET DERIVATION (the coordinator's door; L24(4) + the operator's
//    both-doors ruling) ──────────────────────────────────────────────────────

export type PresetKitDerivation = { ok: true; kit: SessionKitV1; note?: string } | { ok: false; reason: string }

/**
 * The kit for a birth that NAMED A PRESET: derived exactly like the menu
 * road (RECORD E's shape — provisional lists, `resolved: false`, the
 * runner's completion at first boot finishes it) but from the PRESET's
 * deltas instead of the workspace's menu deltas. NEVER fail-soft — the
 * caller asked for a preset BY NAME, so an unknown name, a damaged entry,
 * or deltas the wire's own law refuses answer TYPED and no session is born
 * (the closed-roster law: a silent fall to the menu default would be a
 * leak of scope). THE HONEST RESOLVE (the global store's per-repo trade):
 * an MCP delta naming a server this workspace lacks does not bite (absent
 * = on stands) and the `note` names it for the launch receipt; skill and
 * extension deltas are the runner's roster to judge, said so in the note.
 */
export function deriveSessionKitForPreset(presetName: string, workspaceDir: string): PresetKitDerivation {
  const resolved = kitPresetDeltas(presetName)
  if (!resolved.ok) return { ok: false, reason: resolved.reason }
  // The wire's own law before anything is stamped: a hand-edited entry
  // whose names break the kit grammars refuses here, typed.
  const verdict = validateKitDeltas(resolved.deltas)
  if (!verdict.ok) return { ok: false, reason: `preset '${presetName}' refused — ${verdict.reason}` }
  const deltas = verdict.deltas
  let known: string[] = []
  try {
    known = knownMcpNamesForWorkspace(workspaceDir)
  } catch (err) {
    // The census is best-effort (the same tolerance the menu derivation
    // has); the deltas themselves are already validated above.
    logForDebugging(`[kit] the preset census for ${workspaceDir} fell empty: ${err}`)
  }
  const unbiting = deltas.mcpOff.filter(name => !known.includes(name))
  const parts: string[] = []
  if (unbiting.length > 0) {
    parts.push(
      `${unbiting.length} MCP delta${unbiting.length === 1 ? '' : 's'} name${unbiting.length === 1 ? 's' : ''} servers this repo lacks (${unbiting.slice(0, 6).join(', ')}${unbiting.length > 6 ? ', …' : ''}) — they don't bite`,
    )
  }
  if (Object.keys(deltas.skillStates).length > 0 || deltas.extensionsOff.length > 0) {
    parts.push("skill and extension deltas resolve at the session's first boot")
  }
  return {
    ok: true,
    kit: {
      schema: 1,
      mcp: known.filter(name => isKitMcpName(name) && !deltas.mcpOff.includes(name)),
      skills: [],
      invocable: [],
      resolved: false,
      deltas,
    },
    ...(parts.length > 0 ? { note: `preset '${presetName}': ${parts.join('; ')}` } : {}),
  }
}
