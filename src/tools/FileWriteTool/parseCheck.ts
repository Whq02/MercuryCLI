import { basename, extname } from 'node:path'

import { getLspServerManager } from '../../services/lsp/manager.js'
import type { TSNode } from '../../services/structure/grammarFacility.js'

import { FRONTMATTER_REGEX, parseFrontmatter } from '../../utils/frontmatterParser.js'
import { MAX_LISTING_DESC_CHARS } from '../SkillTool/constants.js'
type ParseFormat = 'JSON' | 'YAML' | 'TOML'

function formatForPath(filePath: string): ParseFormat | undefined {
  const ext = extname(filePath).toLowerCase()
  if (ext === '.json') return 'JSON'
  if (ext === '.yaml' || ext === '.yml') return 'YAML'
  if (ext === '.toml') return 'TOML'
  return undefined
}

function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
}

function parseOnce(format: ParseFormat, text: string): string | undefined {
  const body = stripBom(text)
  try {
    if (format === 'JSON') {
      JSON.parse(body)
    } else if (format === 'YAML') {
      const yaml = (Bun as unknown as { YAML?: { parse: (input: string) => unknown } }).YAML
      yaml?.parse(body)
    } else {
      Bun.TOML.parse(body)
    }
    return undefined
  } catch (err) {
    const raw =
      err instanceof Error
        ? err.message
        : typeof (err as { message?: unknown } | null)?.message === 'string'
          ? (err as { message: string }).message
          : String(err)
    const cleaned = raw
      .replace(/^(?:(?:JSON|YAML|TOML)\s+Parse error|BuildMessage):\s*/i, '')
      .trim()
    const pos = (err as { position?: { line?: number; column?: number } } | null)?.position
    if (typeof pos?.line === 'number') {
      const col = typeof pos.column === 'number' ? `, column ${pos.column}` : ''
      return `${format} parse error (line ${pos.line}${col}): ${cleaned}`
    }
    return `${format} parse error: ${cleaned}`
  }
}

function normalizeParseError(err: string): string {
  return err
    .replace(/\s*\(line \d+(?:, column \d+)?\)/gi, '')
    .replace(/\b(?:line|column|position|offset)\s+\d+/gi, '')
}

type SourceParseError = { line: number; node: string; key: string }

function sourceParseErrors(root: TSNode): SourceParseError[] {
  const errors: SourceParseError[] = []
  const stack = [root]
  while (stack.length > 0) {
    const node = stack.pop()!
    if (!node.hasError && !node.isMissing && node.type !== 'ERROR') continue
    const children = node.children.filter(child => child.hasError || child.isMissing || child.type === 'ERROR')
    if (children.length > 0) {
      for (let i = children.length - 1; i >= 0; i--) stack.push(children[i]!)
      continue
    }
    const problem = node.isMissing ? `missing ${node.type}` : node.type === 'ERROR' ? 'ERROR' : `syntax error in ${node.type}`
    errors.push({
      line: node.startPosition.row + 1,
      node: problem,
      key: node.type === 'ERROR' ? `${problem}:${node.text.replace(/\s+/g, ' ').trim()}` : problem,
    })
  }
  return errors
}

async function checkSourceParseError(filePath: string, before: string | null, after: string): Promise<string | undefined> {
  try {
    const { languageForFile, loadGrammarEngine, parsePolyglot } = await import('../../services/structure/grammarFacility.js')
    const language = languageForFile(filePath)
    if (!language) return undefined
    const engine = await loadGrammarEngine()
    if (engine.state !== 'ok') return undefined
    const errorsIn = async (text: string): Promise<SourceParseError[] | undefined> => {
      const parsed = await parsePolyglot(engine, language, stripBom(text))
      if ('state' in parsed) return undefined
      try {
        return sourceParseErrors(parsed.tree.rootNode)
      } finally {
        parsed.tree.delete()
      }
    }
    const afterErrors = await errorsIn(after)
    if (!afterErrors?.length) return undefined
    const beforeErrors = before === null ? [] : await errorsIn(before)
    if (beforeErrors === undefined) return undefined
    const remaining = new Map<string, number>()
    for (const error of beforeErrors) remaining.set(error.key, (remaining.get(error.key) ?? 0) + 1)
    const introduced = afterErrors.find(error => {
      const count = remaining.get(error.key) ?? 0
      if (count === 0) return true
      remaining.set(error.key, count - 1)
      return false
    })
    if (!introduced) return undefined
    const names: Record<string, string> = {
      typescript: 'TypeScript', javascript: 'JavaScript', tsx: 'TSX', 'c-sharp': 'C#', cpp: 'C++',
      css: 'CSS', php: 'PHP', powershell: 'PowerShell', ini: 'INI', html: 'HTML',
    }
    const name = names[language.name] ?? language.name.charAt(0).toUpperCase() + language.name.slice(1)
    return `${name} parse error at line ${introduced.line}: ${introduced.node} (the edit introduced it)`
  } catch {
    return undefined
  }
}

function skillProblem(text: string): string | undefined {
  if (!FRONTMATTER_REGEX.test(text)) return 'SKILL.md needs YAML frontmatter with a description.'
  const parsed = parseFrontmatter(text)
  if (parsed.parseError) return `SKILL.md frontmatter: ${parsed.parseError.message}`
  const description = parsed.frontmatter.description
  if (typeof description !== 'string' || !description.trim()) return 'SKILL.md needs a non-empty text description in frontmatter.'
  if (description.trim().length > MAX_LISTING_DESC_CHARS) return `SKILL.md description exceeds the ${MAX_LISTING_DESC_CHARS}-character listing budget; shorten it to keep its trigger visible.`
  return undefined
}
export async function checkIntroducedParseError(
  filePath: string,
  beforeContent: string | null,
  afterContent: string,
  hasLspServer?: boolean,
): Promise<string | undefined> {
  if (basename(filePath) === 'SKILL.md') {
    const problem = skillProblem(afterContent)
    return problem && (beforeContent === null || problem !== skillProblem(beforeContent)) ? problem : undefined
  }
  const format = formatForPath(filePath)
  const coveredByLsp =
    hasLspServer ?? ((getLspServerManager()?.getServersForFile(filePath).length ?? 0) > 0)
  if (coveredByLsp) return undefined
  if (format === undefined) return checkSourceParseError(filePath, beforeContent, afterContent)
  const afterErr = parseOnce(format, afterContent)
  if (afterErr === undefined) return undefined
  if (beforeContent !== null) {
    const beforeErr = parseOnce(format, beforeContent)
    if (beforeErr !== undefined && normalizeParseError(beforeErr) === normalizeParseError(afterErr)) {
      return undefined
    }
  }
  return afterErr
}
