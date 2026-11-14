import memoize from 'lodash-es/memoize.js'
import { dirname, parse, relative, resolve, sep } from 'path'

import { getOriginalCwd } from '../../bootstrap/state.js'
import { untrustedWorkspaceHeadless } from '../../utils/config/trust.js'
import { normalizePathForComparison } from '../../utils/file.js'
import { getFsImplementation } from '../../utils/fsOperations.js'
import { toTildePath } from '../../utils/path.js'
import { decidingGuideOf, folderSources } from './adapters/index.js'
import { attachedInstructions, instructionAttached } from './attachedText.js'
import { agentsMdConvention } from './adapters/agentsMd.js'
import { conventionsForProfile, otherToolFormats, sharedFormatLabel } from './compositionOrder.js'
import type { InstructionBundleEntry, InstructionConvention, InstructionSourceEntry } from './contracts.js'
import { processRulesDir } from './discovery.js'
import { getInstructionCompositionState, getInstructionFiles, onInstructionCacheInvalidated } from './engine.js'
import { mercuryNativeConvention } from './nativeSource.js'

type InstructionListingRow = { path: string; tool: string; state: string; globs?: string[]; named?: string }

type Held = (path: string) => boolean

const toolOf = (entry: InstructionSourceEntry | undefined): string | null =>
  otherToolFormats().find(convention => convention.id === entry?.convention)?.label ?? null

export function toolPrefixOf(entry: InstructionSourceEntry | undefined): string | null {
  const tool = toolOf(entry)
  return tool === null ? null : `${tool} · `
}

const namedWords = (by: string | undefined): string => (by === undefined ? '' : ` · named by ${by}`)

export function loadedStateOf(entry: InstructionSourceEntry): string {
  return `${entry.offered === undefined ? '' : ' · offered by its description'}${namedWords(entry.namedBy)}`
}

export function listingRowWords(row: InstructionListingRow, shownPath: string, held: Held): string {
  const state = row.globs === undefined ? row.state : `${instructionAttached(row.path) && held(row.path) ? 'loaded' : 'loads'} with ${row.globs.join(', ')}${namedWords(row.named)}`
  return `${row.tool} · ${shownPath} · ${state}`
}

export function attachedRows(held: Held, listed: readonly string[]): InstructionListingRow[] {
  const known = new Set(listed.map(normalizePathForComparison))
  const rows: InstructionListingRow[] = []
  for (const { path, convention, globs } of attachedInstructions()) {
    if (known.has(normalizePathForComparison(path)) || !held(path)) continue
    const tool = otherToolFormats().find(format => format.id === convention)?.label ?? (convention === undefined || convention === mercuryNativeConvention.id ? 'Mercury-native' : 'shared guide')
    rows.push({ path, tool, state: globs === undefined ? 'loaded with its folder' : `loaded with ${globs.join(', ')}` })
  }
  return rows
}

export function sharedSourcesNote(entries: InstructionBundleEntry[]): string | null {
  const shared = entries.filter(entry => entry.family === 'shared')
  if (shared.length === 0) return null
  const first = agentsMdConvention.label ?? agentsMdConvention.id
  const counts = new Map<string, number>()
  for (const entry of shared) {
    const label = sharedFormatLabel(entry.convention) ?? first
    counts.set(label, (counts.get(label) ?? 0) + 1)
  }
  const why = 'no MERCURY.md in or above the working directory'
  if (counts.size === 1 && counts.has(first)) return `${shared.length} ${first} source(s): ${why}`
  return `${shared.length} source(s) from other tools (${[...counts].map(([label, count]) => `${label} ${count}`).join(' · ')}): ${why}`
}

function dormantWords(rule: InstructionSourceEntry): string {
  if (rule.dormant === 'manual') return 'not loaded: manual, @-mention it'
  if (rule.dormant === 'off') return 'not loaded: its paths list is empty'
  if (rule.dormant === 'unreadable') return 'not loaded: its header is not YAML'
  return `not loaded: ${rule.why ?? 'its scope is not one Mercury reads'}`
}

function chainOutward(start: string): string[] {
  const dirs: string[] = []
  for (let dir = start; dir !== parse(dir).root; dir = dirname(dir)) dirs.push(dir)
  return dirs.reverse()
}

const isFile = (path: string): boolean => {
  try {
    return getFsImplementation().statSync(path).isFile()
  } catch {
    return false
  }
}

function nearerName(convention: InstructionConvention, holder: string, sources: string[]): string {
  const standing = sources.find(source => getFsImplementation().existsSync(source)) ?? convention.projectRulesDirs(holder)[0] ?? holder
  return relative(holder, standing).split(sep).join('/')
}

const rulesOf = (convention: InstructionConvention, source: string): Promise<InstructionSourceEntry[]> =>
  processRulesDir({ convention, rulesDir: source, type: 'Project', processedPaths: new Set(), includeExternal: false, conditionalRule: false, every: true })

export const getInstructionListing = memoize(async (): Promise<InstructionListingRow[]> => {
  armListingInvalidation()
  if (untrustedWorkspaceHeadless()) return []
  const files = await getInstructionFiles()
  const { resolution, fallbackComposed, nearestHolders, importedScoped, namedRules } = getInstructionCompositionState()
  if (resolution.resolved !== 'auto') return []
  const loaded = new Set(files.map(file => normalizePathForComparison(file.path)))
  const rows: InstructionListingRow[] = []
  const add = (path: string, tool: string, state: string, globs?: string[], named?: string): void => {
    const spelled = normalizePathForComparison(path)
    if (loaded.has(spelled)) return
    loaded.add(spelled)
    rows.push({ path, tool, state, globs, named })
  }
  for (const rule of importedScoped) add(rule.path, toolOf(rule) ?? '', '', rule.globs ?? [])
  for (const { convention, rulesDir, by } of namedRules) {
    for (const rule of await rulesOf(convention, rulesDir)) {
      if (rule.dormant !== undefined) add(rule.path, convention.label ?? convention.id, `${dormantWords(rule)}${namedWords(by)}`)
      else if (rule.globs !== undefined) add(rule.path, convention.label ?? convention.id, '', rule.globs, by)
    }
  }
  const start = resolve(getOriginalCwd())
  const own = folderSources(start)
  const decider = fallbackComposed ? null : decidingGuideOf(start)
  const decided = (path: string): string =>
    `not loaded: MERCURY.md decides; import it with @${relative(dirname(decider ?? start), path).split(sep).join('/')}`
  for (const dir of chainOutward(start)) {
    for (const convention of otherToolFormats()) {
      const tool = convention.label ?? convention.id
      const nearer = convention.nearestOnly ? nearestHolders[convention.id] : undefined
      const sources = own.rules(convention, dir)
      if (decider !== null) {
        for (const path of [...own.guides(convention, dir), ...own.within(convention, dir, convention.localDirFiles?.(dir) ?? [])]) {
          if (isFile(path) && !convention.isExcluded(path, 'Project')) add(path, tool, decided(path))
        }
      }
      for (const source of sources) {
        for (const rule of await rulesOf(convention, source)) {
          if (decider !== null) add(rule.path, tool, decided(rule.path))
          else if (nearer !== undefined && nearer !== dir) add(rule.path, tool, `not loaded: a nearer ${nearerName(convention, nearer, own.rules(convention, nearer))} is read`)
          else if (rule.dormant !== undefined) add(rule.path, tool, dormantWords(rule))
          else if (rule.globs !== undefined) add(rule.path, tool, '', rule.globs)
        }
      }
    }
  }
  return rows
})

export async function otherToolsImportLines(): Promise<{ project: string[]; aside: string[] }> {
  const project: string[] = []
  const aside: string[] = []
  if (untrustedWorkspaceHeadless()) return { project, aside }
  await getInstructionFiles()
  const { resolution, fallbackComposed, nearestHolders, namedRules } = getInstructionCompositionState()
  if (resolution.resolved !== 'auto' || !fallbackComposed) return { project, aside }
  const start = resolve(getOriginalCwd())
  const own = folderSources(start)
  const line = (path: string): string => `@${relative(start, path).split(sep).join('/')}`
  const stands = (path: string): boolean => getFsImplementation().existsSync(path)
  for (const dir of chainOutward(start)) {
    for (const convention of conventionsForProfile('auto').filter(c => c.fallback)) {
      if (convention.nearestOnly && nearestHolders[convention.id] !== dir) continue
      const lines = dir === start ? project : aside
      for (const path of [...own.guides(convention, dir), ...own.rules(convention, dir)]) {
        if (stands(path) && !convention.isExcluded(path, 'Project')) lines.push(line(path))
      }
      for (const path of own.within(convention, dir, convention.localDirFiles?.(dir) ?? [])) {
        if (stands(path) && !convention.isExcluded(path, 'Local')) aside.push(line(path))
      }
    }
  }
  for (const { convention, rulesDir, guides } of namedRules) {
    for (const path of [...guides, rulesDir]) {
      if (stands(path) && !convention.isExcluded(path, 'User')) aside.push(`@${toTildePath(path).split(sep).join('/').replace(/ /g, '\\ ')}`)
    }
  }
  return { project, aside }
}

let listingInvalidationArmed = false
function armListingInvalidation(): void {
  if (listingInvalidationArmed) return
  listingInvalidationArmed = true
  onInstructionCacheInvalidated(() => {
    getInstructionListing.cache.clear?.()
  })
}
