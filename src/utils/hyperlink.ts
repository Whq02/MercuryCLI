import chalk from 'chalk'

import { supportsHyperlinks } from '../ink/session/capabilities.js'

export const OSC8_START = '\u001b]8;;'
export const OSC8_END = '\u0007'

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
