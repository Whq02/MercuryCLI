import { readFileSync } from 'node:fs'
import { getSystemPromptSectionCache, setSystemPromptSectionCacheEntry } from '../bootstrap/state.js'
import type { BoundPrefixSection } from '../types/message.js'
import { isOwnerKey, parseOwnerKey } from '../services/run/ownerKey.js'
import { prefixLedgerPath } from '../services/providers/anthropic/prefixRecordStore.js'
import { MERCURY_CONSTITUTION, MERCURY_HEADLESS_CONSTITUTION } from './mercuryContract.js'

const STATIC_SET = 'static-composition'
const RECORDED_WHOLE = 'recorded-composition'
const currentStaticSets = [MERCURY_CONSTITUTION, MERCURY_HEADLESS_CONSTITUTION].map(law => JSON.stringify(['head', 'constitution', law]))

export function recordCurrentStaticComposition(law: string = MERCURY_CONSTITUTION): void {
  setSystemPromptSectionCacheEntry(STATIC_SET, JSON.stringify(['head', 'constitution', law]), null)
}

export function carriesRecordedWhole(sections: readonly BoundPrefixSection[]): boolean {
  return sections.some(section => section.name === RECORDED_WHOLE)
}

export function staticCompositionChanged(sections: readonly BoundPrefixSection[]): boolean {
  const recorded = sections.findLast(section => section.name === STATIC_SET)
  if (recorded) return !currentStaticSets.includes(recorded.value ?? '')
  const contract = sections.findLast(section => section.name === 'mercury-contract')
  if (typeof contract?.value !== 'string') return false
  try {
    const rows = JSON.parse(contract.value) as Array<{ name?: unknown }>
    return !Array.isArray(rows) || rows.some(row => row.name !== 'response-profile')
  } catch {
    return true
  }
}

export function restoreWholeRecordedComposition(boundKey: string): boolean {
  const parts = boundKey.split('|')
  const owner = parts.slice(0, -2).join('|')
  if (!isOwnerKey(owner)) return false
  try {
    const saved = JSON.parse(readFileSync(prefixLedgerPath(parseOwnerKey(owner).sessionId), 'utf8')) as {
      version?: unknown; owner?: unknown; record?: { key?: unknown; system?: Array<{ text?: unknown }> }
    }
    if (saved.version !== 1 || saved.owner !== owner || saved.record?.key !== boundKey) return false
    const blocks = saved.record.system
    if (!Array.isArray(blocks) || blocks.length === 0 || blocks.some(block => typeof block?.text !== 'string')) return false
    setSystemPromptSectionCacheEntry(RECORDED_WHOLE, JSON.stringify(blocks.map(block => block.text)), parts.at(-1) ?? null)
    return true
  } catch {
    return false
  }
}

export function recordedComposition(model?: string): string[] | null {
  const entry = getSystemPromptSectionCache().get(RECORDED_WHOLE)
  if (!entry || (model !== undefined && entry.key !== model) || typeof entry.value !== 'string') return null
  try {
    const value = JSON.parse(entry.value) as unknown
    return Array.isArray(value) && value.every(block => typeof block === 'string') ? value : null
  } catch {
    return null
  }
}

export function isWholeRecordedComposition(prompt: readonly string[]): boolean {
  const recorded = recordedComposition()
  return recorded !== null && recorded.length === prompt.length && recorded.every((block, index) => block === prompt[index])
}
