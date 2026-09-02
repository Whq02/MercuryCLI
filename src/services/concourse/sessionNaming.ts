
import { projectDisplayName } from '../../utils/bootCardFacts.js'

export function newSessionTitle(workspaceDir: string): string {
  return `new session · ${projectDisplayName(workspaceDir)} · ready`
}

export function isWorkerIdTitle(title: string): boolean {
  return /^concourse-w\d+$/.test(title.trim())
}

export function sessionTitleOf(
  rec: { title?: string; workspaceId: string },
  briefOf: () => string | null,
): string {
  const stored = (rec.title ?? '').trim()
  if (stored.length > 0) return stored
  const brief = briefOf()
  if (brief !== null && brief.trim().length > 0) return brief.trim()
  return newSessionTitle(rec.workspaceId)
}

export function shouldMintTitle(
  rec: { title?: string; titleMintedAt?: number; endedAt?: number },
  assistantTurns: number,
): boolean {
  if (rec.endedAt !== undefined) return false
  if ((rec.title ?? '').trim().length > 0) return false
  if (rec.titleMintedAt !== undefined) return false
  return assistantTurns >= 2
}
