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

export const GENERATED_FILE_HEAD_LINES = 12

const GENERATED_DECLARATION =
  /(?:generated|composed) by\s+`?(?:bun run |bun |node |bash )?(scripts\/[A-Za-z0-9_./-]+\.(?:ts|tsx|mjs|js|sh|py))|"(?:generatedBy|composedBy)":\s*"(scripts\/[A-Za-z0-9_./-]+)"|Regenerate:\s+`?(?:bun run |bun |node |bash )?(scripts\/[A-Za-z0-9_./-]+\.(?:ts|tsx|mjs|js|sh|py))/i

export function generatedFileDeclaration(path: string, head: string): string | null {
  if (path === GENERATED_ASSETS_MAP) return null
  if (/\.generated\.[A-Za-z0-9]+$/.test(path)) return 'its name'
  const lines = head.split('\n').slice(0, GENERATED_FILE_HEAD_LINES).join('\n')
  const match = GENERATED_DECLARATION.exec(lines)
  if (!match) return null
  const script = match[1] ?? match[2] ?? match[3]!
  return script === path ? null : script
}

export function assetRowFor(path: string, rows: readonly GeneratedAssetRow[]): GeneratedAssetRow | null {
  return rows.find(row => row.assets.some(asset => pathMatches(path, asset))) ?? null
}

export interface UnregisteredGeneratedFile {
  path: string
  declares: string
}

export function unregisteredGeneratedFiles(
  files: ReadonlyArray<{ path: string; head: string }>,
  rows: readonly GeneratedAssetRow[],
): UnregisteredGeneratedFile[] {
  const out: UnregisteredGeneratedFile[] = []
  for (const file of files) {
    const declares = generatedFileDeclaration(file.path, file.head)
    if (declares === null || assetRowFor(file.path, rows) !== null) continue
    out.push({ path: file.path, declares })
  }
  return out
}

export function describeUnregisteredGeneratedFiles(files: readonly UnregisteredGeneratedFile[], mapPath: string = GENERATED_ASSETS_MAP): string {
  const lines = files.map(f => `${f.path} (declares ${f.declares === 'its name' ? 'itself generated by its name' : `generation by ${f.declares}`})`)
  return `Generated files with no registered generator (${mapPath}, ${files.length} file(s)): ${lines.join(' | ')} — run the generator with --register, or give the file a generator`
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
