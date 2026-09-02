import chalk from 'chalk'

import { supportsHyperlinks } from '../ink/session/capabilities.js'

/**
 * OSC 8 clickable-link wrapping with a plain-text fallback. BEL terminates
 * the sequence because it is more widely supported than the string
 * terminator.
 */
export const OSC8_START = '\u001b]8;;'
export const OSC8_END = '\u0007'

/**
 * When hyperlinks are supported (session capability, overridable for tests)
 * emit the OSC 8 link around the display text (defaulting to the URL),
 * coloured with a BASIC ANSI blue — 24-bit colours are not preserved by the
 * line-wrapping library across an OSC 8 boundary, basic ANSI is. When
 * unsupported, return the bare URL and ignore any supplied display text.
 */
export function createHyperlink(
  url: string,
  content?: string,
  options?: { supportsHyperlinks?: boolean },
): string {
  const supported = options?.supportsHyperlinks ?? supportsHyperlinks()
  if (!supported) return url
  const text = chalk.blue(content ?? url)
  return `${OSC8_START}${url}${OSC8_END}${text}${OSC8_START}${OSC8_END}`
}
