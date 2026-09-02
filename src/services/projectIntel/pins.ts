// ============================================================================
//  projectIntel/pins — operator context marks.
//
//  The operator corrects Mercury's working set through the current action
//  vocabulary (/orient pin|drop <path>): a PINNED path always rides the
//  capsule as active work ('operator-pinned'); a DROPPED path is excluded
//  and COUNTED in the capsule's named omissions ('operator-dropped').
//  Session-scoped, owner-keyed, bounded; never durable (a correction is a
//  statement about THIS task, not the repo).
// ============================================================================

import { isAbsolute, normalize as normalizePath, relative, sep } from 'node:path'
import { OwnerScopedStore, type OwnerKey } from '../primitives/owner.js'

interface ContextMarks {
  pins: Set<string>
  drops: Set<string>
}

const marks = new OwnerScopedStore<ContextMarks>({
  name: 'project-intel-marks',
  create: () => ({ pins: new Set(), drops: new Set() }),
  cap: 32,
})

const MAX_MARKS = 32

/** Canonicalize a mark to the workspace-relative form the capsule matches
 *  (audit C3: the natural paste is an ABSOLUTE path — accepting it and then
 *  never matching was a success-shaped lie). Returns null for a path that
 *  cannot belong to this workspace, with the reason. */
function canonicalMark(
  path: string,
  workspace: string,
): { rel: string } | { rel: null; reason: string } {
  let p = path.trim().replace(/^["'`]+|["'`]+$/g, '')
  if (!p) return { rel: null, reason: 'empty path' }
  if (isAbsolute(p)) {
    const r = relative(workspace, p)
    if (!r || r.startsWith(`..${sep}`) || r === '..' || isAbsolute(r)) {
      return { rel: null, reason: `outside this workspace (${workspace})` }
    }
    p = r
  }
  p = normalizePath(p).replace(/\/+$/, '')
  if (!p || p === '.' || p.startsWith('..')) return { rel: null, reason: 'not a workspace path' }
  return { rel: p }
}

export function pinContextItem(
  owner: OwnerKey,
  path: string,
  workspace: string,
): { ok: boolean; note: string } {
  const c = canonicalMark(path, workspace)
  if (c.rel === null) return { ok: false, note: `cannot pin: ${c.reason}` }
  const m = marks.get(owner)
  if (m.pins.size >= MAX_MARKS && !m.pins.has(c.rel)) {
    return { ok: false, note: `pin cap (${MAX_MARKS}) reached — /orient clear something first` }
  }
  m.drops.delete(c.rel)
  m.pins.add(c.rel)
  return { ok: true, note: `pinned ${c.rel} (rides the working set as operator-pinned)` }
}

export function dropContextItem(
  owner: OwnerKey,
  path: string,
  workspace: string,
): { ok: boolean; note: string } {
  const c = canonicalMark(path, workspace)
  if (c.rel === null) return { ok: false, note: `cannot drop: ${c.reason}` }
  const m = marks.get(owner)
  if (m.drops.size >= MAX_MARKS && !m.drops.has(c.rel)) {
    return { ok: false, note: `drop cap (${MAX_MARKS}) reached` }
  }
  m.pins.delete(c.rel)
  m.drops.add(c.rel)
  return { ok: true, note: `dropped ${c.rel} (excluded from the working set, counted in omissions)` }
}

export function clearContextMark(
  owner: OwnerKey,
  path: string,
  workspace: string,
): { ok: boolean; note: string } {
  const c = canonicalMark(path, workspace)
  if (c.rel === null) return { ok: false, note: `cannot clear: ${c.reason}` }
  const m = marks.get(owner)
  const had = m.pins.delete(c.rel) || m.drops.delete(c.rel)
  return { ok: had, note: had ? `cleared mark on ${c.rel}` : `no mark on ${c.rel}` }
}

export function getContextMarks(owner: OwnerKey): { pins: string[]; drops: string[] } {
  const m = marks.get(owner)
  return { pins: [...m.pins].sort(), drops: [...m.drops].sort() }
}

/** TEST-ONLY. */
export function _resetContextMarksForTesting(): void {
  marks.clearAllForShutdown()
}
