import { Lexer } from 'marked'
import { dirname, extname } from 'path'

import { logForDebugging } from '../../utils/debug.js'
import { parseFrontmatter, splitPathInFrontmatter } from '../../utils/frontmatterParser.js'
import { stripBOM } from '../../utils/jsonRead.js'
import type { MemoryType } from '../../utils/memory/types.js'
import { expandPath } from '../../utils/path.js'
import type { InstructionSourceEntry } from './contracts.js'

const COMPOSABLE_EXTENSIONS = {
  prose: ['.md', '.txt', '.text', '.rst', '.adoc', '.asciidoc', '.org', '.tex', '.latex'],
  data: ['.json', '.yaml', '.yml', '.toml', '.xml', '.csv'],
  web: ['.html', '.htm', '.css', '.scss', '.sass', '.less', '.vue', '.svelte', '.astro'],
  templates: ['.ejs', '.hbs', '.pug', '.jade'],
  scripts: [
    '.js', '.ts', '.tsx', '.jsx', '.mjs', '.cjs', '.mts', '.cts',
    '.py', '.pyi', '.pyw', '.rb', '.erb', '.rake', '.php', '.pl', '.pm', '.lua', '.r', '.R',
    '.sh', '.bash', '.zsh', '.fish', '.ps1', '.bat', '.cmd',
  ],
  compiled: [
    '.go', '.rs', '.java', '.kt', '.kts', '.scala', '.cs', '.swift', '.dart',
    '.c', '.cpp', '.cc', '.cxx', '.h', '.hpp', '.hxx',
    '.ex', '.exs', '.erl', '.hrl', '.clj', '.cljs', '.cljc', '.edn',
    '.hs', '.lhs', '.elm', '.ml', '.mli', '.f', '.f90', '.f95', '.for',
  ],
  config: ['.env', '.ini', '.cfg', '.conf', '.config', '.properties', '.lock'],
  schemas: ['.sql', '.graphql', '.gql', '.proto'],
  build: ['.cmake', '.make', '.makefile', '.gradle', '.sbt'],
  records: ['.log', '.diff', '.patch'],
}

export const TEXT_FILE_EXTENSIONS = new Set(Object.values(COMPOSABLE_EXTENSIONS).flat())

function composable(filePath: string): boolean {
  const ext = extname(filePath).toLowerCase()
  return ext === '' || TEXT_FILE_EXTENSIONS.has(ext)
}

function narrowingPatterns(paths: string | string[]): string[] {
  const patterns = splitPathInFrontmatter(paths)
    .map(pattern => pattern.replace(/\/\*\*$/, ''))
    .filter(pattern => pattern !== '')
  return patterns.every(pattern => pattern === '**') ? [] : patterns
}

export function parseFrontmatterPaths(rawContent: string): {
  content: string
  paths?: string[]
} {
  const { frontmatter, content } = parseFrontmatter(rawContent)
  const raw = frontmatter.paths ?? frontmatter.globs
  const paths = raw ? narrowingPatterns(raw) : []
  return paths.length === 0 ? { content } : { content, paths }
}

type LexedToken = {
  type: string
  raw: string
  text?: string
  tokens?: LexedToken[]
  items?: LexedToken[]
}

const lexMarkdown = (text: string): LexedToken[] => new Lexer({ gfm: false }).lex(text) as LexedToken[]

const COMMENT_SPAN = /<!--[\s\S]*?-->/g

function commentResidue(token: LexedToken): string | null {
  if (token.type !== 'html') return null
  const opening = token.raw.trimStart()
  return opening.startsWith('<!--') && opening.includes('-->') ? token.raw.replace(COMMENT_SPAN, '') : null
}

function contributionOf(token: LexedToken): string {
  const residue = commentResidue(token)
  if (residue === null) return token.raw
  return residue.trim() === '' ? '' : residue
}

const withoutHtmlComments = (tokens: LexedToken[]): string => tokens.map(contributionOf).join('')

function* readableTexts(tokens: LexedToken[]): Generator<string> {
  for (const token of tokens) {
    if (token.type === 'code' || token.type === 'codespan') continue
    if (token.type === 'html') {
      const residue = commentResidue(token)
      if (residue !== null && residue.trim() !== '') yield residue
      continue
    }
    if (token.type === 'text') yield token.text ?? ''
    yield* readableTexts(token.tokens ?? [])
    yield* readableTexts(token.items ?? [])
  }
}

const AT_SPELLING = /(?:^|\s)@((?:[^\s\\]|\\ |\\(?=\S))+)/g
const SENTENCE_TAIL = /[.,;:!?]+$/
const PATH_OPENING = /^[A-Za-z0-9._-]/

function importSpellingsIn(text: string): string[] {
  const spellings: string[] = []
  for (const [, captured = ''] of text.matchAll(AT_SPELLING)) {
    const spelling = captured.split('#', 1)[0]!.replace(/\\ /g, ' ').replace(SENTENCE_TAIL, '')
    if (spelling !== '') spellings.push(spelling)
  }
  return spellings
}

const isImportSpelling = (spelling: string): boolean =>
  PATH_OPENING.test(spelling) || spelling.startsWith('~/') || (spelling.startsWith('/') && spelling !== '/')

const carriesPathEvidence = (spelling: string): boolean => spelling.includes('/') || spelling.includes('.')

type IncludeMentions = { includePaths: string[]; bareMentionPaths: string[] }

const noMentions = (): IncludeMentions => ({ includePaths: [], bareMentionPaths: [] })

function includeMentionsOf(tokens: LexedToken[], includeBasePath: string): IncludeMentions {
  const home = dirname(includeBasePath)
  const includes = new Set<string>()
  const bare = new Set<string>()
  for (const text of readableTexts(tokens)) {
    for (const spelling of importSpellingsIn(text).filter(isImportSpelling)) {
      (carriesPathEvidence(spelling) ? includes : bare).add(expandPath(spelling, home))
    }
  }
  return { includePaths: [...includes], bareMentionPaths: [...bare] }
}

function readBody(body: string, includeBasePath: string | undefined): { content: string } & IncludeMentions {
  const commented = body.includes('<!--')
  if (!commented && includeBasePath === undefined) return { content: body, ...noMentions() }
  const tokens = lexMarkdown(body)
  return {
    content: commented ? withoutHtmlComments(tokens) : body,
    ...(includeBasePath === undefined ? noMentions() : includeMentionsOf(tokens, includeBasePath)),
  }
}

function entryOf(
  path: string,
  type: MemoryType,
  raw: string,
  content: string,
  globs: string[] | undefined,
): InstructionSourceEntry {
  const transformed = content !== raw
  return { path, type, content, globs, contentDiffersFromDisk: transformed, rawContent: transformed ? raw : undefined }
}

export function parseInstructionFileContent(
  rawContent: string,
  filePath: string,
  type: MemoryType,
  includeBasePath?: string,
): { info: InstructionSourceEntry | null } & IncludeMentions {
  if (!composable(filePath)) {
    logForDebugging(`An @import target that is not a text file composes nothing: ${filePath}`)
    return { info: null, ...noMentions() }
  }
  const raw = stripBOM(rawContent)
  const { content: body, paths } = parseFrontmatterPaths(raw)
  const { content, ...mentions } = readBody(body, includeBasePath)
  return { info: entryOf(filePath, type, raw, content, paths), ...mentions }
}
