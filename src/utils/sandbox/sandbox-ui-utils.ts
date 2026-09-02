/**
 * Presentation helpers for sandbox output — shaping violation text for the
 * terminal UI, nothing more.
 */

/**
 * Strip every <sandbox_violations> block from an error message so the
 * rendered text keeps only its human-readable part.
 */
export function removeSandboxViolationTags(text: string): string {
  return text.replace(/<sandbox_violations>[\s\S]*?<\/sandbox_violations>/g, '')
}
