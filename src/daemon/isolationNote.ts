import { basename } from 'node:path'

export const GROUND_NOTE_MARK = '[ground] '

export function stripGroundNote(raw: string): string {
  if (!raw.startsWith(GROUND_NOTE_MARK)) return raw
  const cut = raw.indexOf('\n\n')
  return cut >= 0 ? raw.slice(cut + 2) : ''
}

export interface IsolationFactV1 {
  isolation: 'exclusive' | 'shared' | 'worktree-isolated' | 'read-only'
  workspaceId: string
  branchName?: string
}

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
