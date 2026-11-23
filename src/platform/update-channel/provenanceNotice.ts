import { existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'

export const PROVENANCE_NOTICE_MARKER_PREFIX = 'provenance-noted-'

function realpathSafe(p: string): string {
  try {
    return realpathSync(p)
  } catch {
    return p
  }
}

export function provenanceNoticeMarkerPath(payloadDir: string): string | null {
  const dir = realpathSafe(payloadDir)
  const parent = dirname(dir)
  if (!existsSync(join(parent, 'current.txt'))) return null
  return join(parent, `${PROVENANCE_NOTICE_MARKER_PREFIX}${basename(dir)}.txt`)
}

export function provenanceNoticeIsOnce(state: string): boolean {
  return state === 'unsigned' || state === 'unrecognized-key'
}

export function provenanceNoticeSaid(payloadDir: string, state: string): boolean {
  const marker = provenanceNoticeMarkerPath(payloadDir)
  if (marker === null) return false
  try {
    return readFileSync(marker, 'utf8').split('\n')[0]?.trim() === state
  } catch {
    return false
  }
}

export function recordProvenanceNotice(payloadDir: string, state: string): void {
  const marker = provenanceNoticeMarkerPath(payloadDir)
  if (marker === null) return
  try {
    writeFileSync(marker, `${state}\n${new Date().toISOString()}\n`)
  } catch {
    return
  }
}
