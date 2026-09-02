import { createHash } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { sliceHeadAtGrapheme, sliceTailAtGrapheme } from '../intl.js'
import { getToolResultsDir } from '../toolResultStorage.js'

export const HOOK_CONTEXT_CAP_CHARS = 24_000
const HEAD_SHARE = 0.7

export interface BoundedHookContext {
  text: string
  truncated: boolean
  omittedChars: number
  spilledTo?: string
}

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

export function boundSeamContext(text: string | null | undefined, fileLabel: string, cap: number = HOOK_CONTEXT_CAP_CHARS): BoundedHookContext {
  const whole = text ?? ''
  if (whole.length <= cap) return { text: whole, truncated: false, omittedChars: 0 }
  return shapeBoundedContext(whole, cap, spillSeamContext(whole, fileLabel))
}

export function boundHookContext(text: string | null | undefined, label: string, cap: number = HOOK_CONTEXT_CAP_CHARS): BoundedHookContext {
  return boundSeamContext(text, `hook-${label}`, cap)
}
