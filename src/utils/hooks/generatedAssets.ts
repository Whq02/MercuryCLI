import picomatch from 'picomatch'
import { hasMalformedTokens, hasShellQuoteSingleQuoteBug, tryParseShellCommand } from '../bash/shellQuote.js'
import { basename } from 'node:path'

export const GENERATED_ASSETS_MAP = 'scripts/gate/generated-assets.tsv'

export interface GeneratedAssetRow {
  assets: string[]
  generator: string
  check: string | null
  sources: string[]
  line: number
}

export function parseGeneratedAssetsMap(text: string): { rows: GeneratedAssetRow[]; errors: string[] } {
  const rows: GeneratedAssetRow[] = []
  const errors: string[] = []
  text.split('\n').forEach((raw, index) => {
    const line = raw.replace(/\r$/, '')
    if (line.trim() === '' || line.trimStart().startsWith('#')) return
    const cols = line.split('\t')
    if (cols.length < 4) {
      errors.push(`line ${index + 1}: expected asset<TAB>generator<TAB>check<TAB>sources, found ${cols.length} column(s)`)
      return
    }
    const [asset, generator, check, sources] = cols as [string, string, string, string]
    const assets = asset.trim().split(/\s+/).filter(Boolean)
    const sourceList = sources.trim().split(/\s+/).filter(Boolean)
    if (assets.length === 0 || generator.trim() === '' || sourceList.length === 0) {
      errors.push(`line ${index + 1}: an empty asset, generator or sources column`)
      return
    }
    rows.push({ assets, generator: generator.trim(), check: check.trim() === '-' || check.trim() === '' ? null : check.trim(), sources: sourceList, line: index + 1 })
  })
  return { rows, errors }
}

export function repoPathsIn(text: string): string[] {
  const out = new Set<string>()
  for (const m of text.matchAll(/["'](?:\.\/)?((?:src|scripts|assets|docs|vendor|integrations|mercury-skills)\/[^"'\s]+)["']/g)) {
    out.add(m[1]!)
  }
  return [...out]
}

export interface AssetVerdictInput {
  rows: readonly GeneratedAssetRow[]
  commitPaths: readonly string[]
  contentOf: (path: string) => string | null
  previousContentOf?: (path: string) => string | null
  readFile: (path: string) => string | null
  chainedVerifies: readonly string[]
}

export interface OwedAsset {
  row: GeneratedAssetRow
  touched: { path: string; source: string }[]
}

const matchOptions = { dot: true }

function pathMatches(path: string, glob: string): boolean {
  if (!glob.includes('*') && !glob.includes('?') && !glob.includes('{')) return path === glob
  return picomatch.isMatch(path, glob, matchOptions)
}

export function generatedAssetsOwed(input: AssetVerdictInput): OwedAsset[] {
  const owed: OwedAsset[] = []
  for (const row of input.rows) {
    const touched: OwedAsset['touched'] = []
    const generators = row.generator.split('&&').flatMap(part => commandWords(part) ?? []).filter(word => /\.(?:ts|tsx|js|mjs|py|sh)$/.test(word))
    for (const source of [...row.sources, ...generators]) {
      if (source.startsWith('files-of:')) {
        const named = new Set(repoPathsIn(input.readFile(source.slice('files-of:'.length)) ?? ''))
        for (const path of input.commitPaths) if (named.has(path)) touched.push({ path, source })
      } else if (source.startsWith('re:')) {
        let pattern: RegExp
        try {
          pattern = new RegExp(source.slice('re:'.length))
        } catch {
          continue
        }
        for (const path of input.commitPaths) {
          const content = input.contentOf(path)
          const previous = input.previousContentOf?.(path) ?? null
          if (content !== null && pattern.test(content) || previous !== null && pattern.test(previous)) touched.push({ path, source })
        }
      } else {
        for (const path of input.commitPaths) if (pathMatches(path, source)) touched.push({ path, source })
      }
    }
    if (touched.length === 0) continue
    if (row.assets.every(asset => input.commitPaths.some(path => pathMatches(path, asset)))) continue
    if (row.check !== null && checkChained(row.check, input.chainedVerifies)) continue
    owed.push({ row, touched })
  }
  return owed
}

export function commandWords(command: string): string[] | null {
  const parsed = tryParseShellCommand(command, key => `$${key}`)
  if (!parsed.success || hasMalformedTokens(command, parsed.tokens) || hasShellQuoteSingleQuoteBug(command)) return null
  const tokens = parsed.tokens.filter(token => typeof token !== 'object' || !('comment' in token))
  if (tokens.some(token => typeof token !== 'string')) return null
  const words = tokens as string[]
  if (words.some(word => /[$`]/.test(word))) return null
  return words
}

export function checkChained(check: string, chainedVerifies: readonly string[]): boolean {
  const expected = commandWords(check)
  if (!expected?.length) return false
  const normalized = (words: string[]): string[] => {
    const argv = [...words]
    argv[0] = basename(argv[0]!)
    if (argv[0] === 'bun' && argv[1] === 'run') argv.splice(1, 1)
    return argv.map(word => word.replace(/^\.\//, ''))
  }
  const wanted = normalized(expected)
  return chainedVerifies.some(segment => {
    const words = commandWords(segment)
    if (words === null) return false
    const actual = normalized(words)
    return actual.length === wanted.length && actual.every((word, index) => word === wanted[index])
  })
}

export function describeOwedAssets(owed: readonly OwedAsset[], mapPath: string = GENERATED_ASSETS_MAP): string {
  const lines = owed.map(o => {
    const touched = [...new Set(o.touched.map(t => t.path))].slice(0, 4).join(', ')
    const extra = o.touched.length > 4 ? ` (+${o.touched.length - 4} more)` : ''
    const check = o.row.check === null ? 'no separate check — commit the regenerated asset' : `chain its check before the commit: ${o.row.check}`
    return `${o.row.assets.join(' ')} — derived from ${touched}${extra}; regenerate: ${o.row.generator}; or ${check}`
  })
  return `Generated assets owed by this commit (${mapPath}, ${owed.length} row(s)): ${lines.join(' | ')}`
}
