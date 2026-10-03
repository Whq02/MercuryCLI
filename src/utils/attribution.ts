import { TERMINAL_OUTPUT_TAGS } from '../constants/xml.js'
import { getInitialSettings } from './settings/settings.js'


export type AttributionTexts = {
  commit: string
  pr: string
}

const DEFAULT_PR_ATTRIBUTION = 'Generated with [Mercury CLI](https://mercury-cli.ai)'
const DEFAULT_COMMIT_TRAILER = 'Co-Authored-By: Mercury <https://mercury-cli.ai>'

export function getAttributionTexts(): AttributionTexts {
  const settings = getInitialSettings()
  const attribution = settings.credit?.lines
  if (attribution) {
    return {
      commit: attribution.commit ?? DEFAULT_COMMIT_TRAILER,
      pr: attribution.pr ?? DEFAULT_PR_ATTRIBUTION,
    }
  }
  if (settings.credit?.mercury === false) {
    return { commit: '', pr: '' }
  }
  return { commit: DEFAULT_COMMIT_TRAILER, pr: DEFAULT_PR_ATTRIBUTION }
}

type PromptCountEntry = {
  type: string
  message?: { content?: unknown }
}

function containsTerminalOutputTag(text: string): boolean {
  return TERMINAL_OUTPUT_TAGS.some(tag => text.includes(`<${tag}>`))
}

export function countUserPromptsInMessages(entries: readonly PromptCountEntry[]): number {
  let count = 0
  for (const entry of entries) {
    if (entry.type !== 'user') continue
    const content = entry.message?.content
    if (!content) continue
    if (typeof content === 'string') {
      if (content.trim().length === 0) continue
      if (containsTerminalOutputTag(content)) continue
      count++
      continue
    }
    if (Array.isArray(content)) {
      const hasRealBlock = content.some(block => {
        if (typeof block !== 'object' || block === null) return false
        const type = (block as { type?: unknown }).type
        if (type === 'text') {
          const text = (block as { text?: unknown }).text
          return typeof text === 'string' && !containsTerminalOutputTag(text)
        }
        return type === 'image' || type === 'document'
      })
      if (hasRealBlock) count++
    }
  }
  return count
}
