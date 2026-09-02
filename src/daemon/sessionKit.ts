import { mkdirSync } from 'node:fs'
import { logForDebugging } from '../utils/debug.js'
import { getProjectDir } from '../utils/sessionStorage/paths.js'
import { appendSessionReceipt } from '../services/switchboard/sessionReceipts.js'
import { getGlobalConfig, getProjectConfigForWorkspace } from '../utils/config.js'
import { emptyKitDeltas, kitDeltasForWorkspace, type KitDeltasV1 } from '../services/mcp/kitStore.js'
import { kitPresetDeltas } from '../services/mcp/presetStore.js'
import type { ConcourseWorkerRecordV1 } from './concourseSupervisor.js'

export interface SessionKitV1 {
  schema: 1
  mcp: string[]
  skills: string[]
  invocable: string[]
  skillsOff?: string[]
  extensions?: Record<string, 'on' | 'off'>
  resolved?: false
  deltas?: KitDeltasV1
}

export const KIT_MCP_NAME_PATTERN = /^[a-zA-Z0-9_-]+$/
export const KIT_EXTENSION_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,39}$/
export const KIT_EXTENSION_SERVER_PATTERN = /^ext:[a-z0-9][a-z0-9-]{0,39}:[^\s\x00-\x1f\x7f]{1,128}$/
export const KIT_SKILL_NAME_PATTERN = /^[^\s/\\\x00-\x1f\x7f]{1,200}$/
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

export function cloneSessionKit(kit: SessionKitV1): SessionKitV1 {
  return JSON.parse(JSON.stringify(kit)) as SessionKitV1
}


export type KitStampSource = 'carried' | 'derived' | 'preset'

export function kitStampOf(kit: SessionKitV1 | undefined): { kit: SessionKitV1 } | Record<string, never> {
  return kit !== undefined ? { kit: cloneSessionKit(kit) } : {}
}

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


export interface SessionKitEditV1 {
  mcp?: Array<{ name: string; on: boolean }>
  skills?: Array<{ name: string; state: 'on' | 'invocable' | 'off' }>
  extensions?: Array<{ name: string; on: boolean }>
}

export type KitEditValidation = { ok: true; edit: SessionKitEditV1 } | { ok: false; reason: string }

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

export function materializedKitForWorkspace(workspaceDir: string): SessionKitV1 {
  try {
    return materializedWholeConfigKit(kitDeltasForWorkspace(workspaceDir).mcpOff)
  } catch (err) {
    logForDebugging(`[kit] the materialization for ${workspaceDir} fell to empty deltas: ${err}`)
    return materializedWholeConfigKit()
  }
}

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

export function setSessionKit(rec: ConcourseWorkerRecordV1, kit: SessionKitV1): void {
  rec.kit = cloneSessionKit(kit)
}

export function resolveSessionKitOnRecord(rec: ConcourseWorkerRecordV1, resolved: SessionKitV1): boolean {
  if (rec.kit === undefined || rec.kit.resolved !== false) return false
  if (resolved.resolved === false) return false
  rec.kit = cloneSessionKit(resolved)
  return true
}


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

function knownMcpNamesForWorkspace(workspaceDir: string): string[] {
  const user = Object.keys(getGlobalConfig().mcpServers ?? {})
  const local = Object.keys(getProjectConfigForWorkspace(workspaceDir).mcpServers ?? {})
  return [...new Set([...user, ...local])]
}


export type PresetKitDerivation = { ok: true; kit: SessionKitV1; note?: string } | { ok: false; reason: string }

export function deriveSessionKitForPreset(presetName: string, workspaceDir: string): PresetKitDerivation {
  const resolved = kitPresetDeltas(presetName)
  if (!resolved.ok) return { ok: false, reason: resolved.reason }
  const verdict = validateKitDeltas(resolved.deltas)
  if (!verdict.ok) return { ok: false, reason: `preset '${presetName}' refused — ${verdict.reason}` }
  const deltas = verdict.deltas
  let known: string[] = []
  try {
    known = knownMcpNamesForWorkspace(workspaceDir)
  } catch (err) {
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
