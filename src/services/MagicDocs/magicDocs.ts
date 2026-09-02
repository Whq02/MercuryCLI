import { registerFileReadListener } from '../../tools/FileReadTool/FileReadTool.js'
import { registerPostSamplingHook } from '../../utils/hooks/postSamplingHooks.js'
import { buildMagicDocsUpdatePrompt } from './prompts.js'

/**
 * Magic-Doc detection/tracking and the forked-subagent update pass.
 *
 * INERT in this build: the initializer is an empty stub, so neither
 * the read listener nor the post-sampling hook is ever registered, and the
 * tracking map can never gain an entry. Both live entry points
 * (`initMagicDocs`, `clearTrackedMagicDocs`) keep their no-op observable
 * behaviour; the registrars stay imported (unused) as the spec records.
 */

// Imported but deliberately unused — the activation surface is severed.
void registerFileReadListener
void registerPostSamplingHook
void buildMagicDocsUpdatePrompt

const trackedDocs = new Map<string, { path: string }>()

/**
 * A file is a Magic Doc when a line matches `# MAGIC DOC: <title>` —
 * case-insensitive, anchored to a line start (not the file start); the
 * first matching line wins. Whitespace after `#` optional, at least one
 * whitespace between the two words, none before the colon, optional after.
 * An italic line (`_…_` / `*…*`, ends may differ) directly below (allowing
 * one blank line) supplies per-document instructions.
 */
export function detectMagicDocHeader(content: string): { title: string; instructions?: string } | null {
  const lines = content.split(/\r?\n/)
  const marker = /^#\s*magic\s+doc:\s*(.*)$/i
  for (let index = 0; index < lines.length; index++) {
    const match = marker.exec(lines[index] as string)
    if (match === null) continue
    const title = (match[1] as string).trim()
    let next = index + 1
    if (next < lines.length && (lines[next] as string).trim() === '') next++
    const candidate = next < lines.length ? (lines[next] as string).trim() : ''
    const italic = /^[_*](.*)[_*]$/.exec(candidate)
    if (italic !== null && candidate.length >= 2) {
      const inner = (italic[1] as string).trim()
      return { title, instructions: inner }
    }
    return { title }
  }
  return null
}

/** Registered once per path; the update pass always re-reads the file. */
export function registerMagicDoc(filePath: string): void {
  if (!trackedDocs.has(filePath)) trackedDocs.set(filePath, { path: filePath })
}

export function clearTrackedMagicDocs(): void {
  trackedDocs.clear()
}

/** Empty stub in this build — nothing registers. */
export async function initMagicDocs(): Promise<void> {}
