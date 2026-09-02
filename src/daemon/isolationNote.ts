// ============================================================================
//  daemon/isolationNote — BOARD CONTROLS item 6 (operator, 03:1x): every
//  dispatched agent's prompt OPENS with a short ground note composed at
//  dispatch from the admission's REAL isolation fact — never a guess. Two
//  shapes: a worktree fork (your own copy; commit/push; never touch the
//  base) and the shared folder (others may edit the same files; announce
//  and confine edits; never reformat/mass-rewrite) — a read-only lease
//  speaks the shared shape with its no-writes fact. 2–4 lines, always.
//
//  One pure composer; the dispatch delivery seam (concourseDispatch's
//  post-admit deliver — the git-ready replay rides the same door) and the
//  crew pack (crewSpawn — teammates always share the repo folder) both
//  speak through it. A redirect to an existing session composes nothing
//  (the session was briefed at its birth); a bash line is a command, not a
//  prompt, and carries none.
// ============================================================================
import { basename } from 'node:path'

/** The note's leading mark — every shape opens with it; the strip half and
 *  the title derivations key on exactly this. */
export const GROUND_NOTE_MARK = '[ground] '

/** The title/brief derivations' strip half: the ground note is FRAMING,
 *  never the operator's words — a board brief, a stage-2 title and a
 *  session-picker row derive from the words alone. The note ends at its
 *  first blank line; a lone note yields '' (a session with only framing
 *  has no words yet). */
export function stripGroundNote(raw: string): string {
  if (!raw.startsWith(GROUND_NOTE_MARK)) return raw
  const cut = raw.indexOf('\n\n')
  return cut >= 0 ? raw.slice(cut + 2) : ''
}

export interface IsolationFactV1 {
  /** 'shared' (the solo in-place kind) speaks the shared-folder shape —
   *  the same ground truth the exclusive-on-ground arm already tells. */
  isolation: 'exclusive' | 'shared' | 'worktree-isolated' | 'read-only'
  /** The session's canonical workspace root (the record's own field). */
  workspaceId: string
  /** The daemon-minted fork branch, when one was carved. */
  branchName?: string
}

/** The 2–4 line ground note for a dispatched agent, from the REAL fact. */
export function isolationAwarenessNote(fact: IsolationFactV1): string {
  const name = basename(fact.workspaceId) || fact.workspaceId
  if (fact.isolation === 'worktree-isolated') {
    return [
      `${GROUND_NOTE_MARK}You work in your own git worktree${fact.branchName !== undefined ? ` on branch ${fact.branchName}` : ''} — your own copy of ${name}.`,
      'Commit and push your work here; never touch the base checkout — folding back is the operator\'s move, not yours.',
    ].join('\n')
  }
  if (fact.isolation === 'read-only') {
    return [
      `${GROUND_NOTE_MARK}You hold a READ-ONLY lease on the shared folder ${name} — others may edit the same files while you read.`,
      'Write nothing here; report what you find instead.',
    ].join('\n')
  }
  return [
    `${GROUND_NOTE_MARK}You work directly in the shared folder ${name} — the base checkout itself; other agents and the operator may edit the same files.`,
    'Announce and confine your edits to what the task needs; never reformat or mass-rewrite files.',
  ].join('\n')
}
