/**
 * The bound on hook output entering the model's context (sweep #2,
 * C28). A chatty hook, a wrapped process that dumps a log, or a
 * SessionStart script that prints a whole repository index would otherwise land in
 * context whole — every turn, unbounded. Past the cap the complete text is
 * spilled to the session's tool-results directory (the same home large MCP
 * results already use) and the model receives a head-and-tail preview with
 * an omission marker that names the file, so nothing is silently lost and
 * nothing silently floods (law 1, law 6: one seam — the attachment→message
 * projection).
 */
import { createHash } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { sliceHeadAtGrapheme, sliceTailAtGrapheme } from '../intl.js'
import { getToolResultsDir } from '../toolResultStorage.js'

/** Roughly six thousand tokens: a generous ceiling for real guidance, a
 *  hard stop for a log dump. */
export const HOOK_CONTEXT_CAP_CHARS = 24_000
const HEAD_SHARE = 0.7

export interface BoundedHookContext {
  text: string
  truncated: boolean
  omittedChars: number
  spilledTo?: string
}

/**
 * Pure shaping given a spill outcome — exported so the prover pins the
 * preview geometry without touching the filesystem.
 */
export function shapeBoundedContext(
  text: string,
  cap: number,
  spill: { path?: string; error?: string },
): BoundedHookContext {
  if (text.length <= cap) return { text, truncated: false, omittedChars: 0 }
  const headLength = Math.floor(cap * HEAD_SHARE)
  const tailLength = cap - headLength
  const head = sliceHeadAtGrapheme(text, headLength)
  const tail = sliceTailAtGrapheme(text, tailLength)
  const omitted = text.length - headLength - tailLength
  const where =
    spill.path !== undefined
      ? `the complete output (${text.length.toLocaleString()} characters) is saved at ${spill.path} — read it in chunks if it matters`
      : `the complete output (${text.length.toLocaleString()} characters) could not be saved${spill.error ? `: ${spill.error}` : ''}`
  return {
    text: `${head}\n[... ${omitted.toLocaleString()} characters omitted — ${where} ...]\n${tail}`,
    truncated: true,
    omittedChars: omitted,
    ...(spill.path !== undefined ? { spilledTo: spill.path } : {}),
  }
}

/** Spill the complete text synchronously (the projection is sync). The
 *  name is content-addressed so a resume re-projecting the same attachment
 *  rewrites the same file instead of minting a twin. */
function spillSeamContext(text: string, fileLabel: string): { path?: string; error?: string } {
  try {
    const dir = getToolResultsDir()
    mkdirSync(dir, { recursive: true })
    const digest = createHash('sha1').update(text).digest('hex').slice(0, 12)
    const safeLabel = fileLabel.replace(/[^a-zA-Z0-9_-]+/g, '-').slice(0, 40) || 'seam'
    const path = join(dir, `${safeLabel}-${digest}.txt`)
    writeFileSync(path, text, 'utf8')
    return { path }
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) }
  }
}

/** Bound one conversation-entering seam's model-visible text; under the cap
 *  it is returned as is. The seam law in one sentence: no external process
 *  wedges a session — past the cap the model gets a head-and-tail preview
 *  whose marker names where the complete bytes live. TOTAL over wire-legal
 *  inputs: a hook may omit the field its type promises, and the projection
 *  layer never crashes on that — an absent value bounds to the empty
 *  excerpt. */
export function boundSeamContext(text: string | null | undefined, fileLabel: string, cap: number = HOOK_CONTEXT_CAP_CHARS): BoundedHookContext {
  const whole = text ?? ''
  if (whole.length <= cap) return { text: whole, truncated: false, omittedChars: 0 }
  return shapeBoundedContext(whole, cap, spillSeamContext(whole, fileLabel))
}

/** Bound one hook's model-visible text (the hook-labelled spill family). */
export function boundHookContext(text: string | null | undefined, label: string, cap: number = HOOK_CONTEXT_CAP_CHARS): BoundedHookContext {
  return boundSeamContext(text, `hook-${label}`, cap)
}
