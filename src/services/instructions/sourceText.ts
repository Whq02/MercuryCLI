import { Lexer } from 'marked'
import { dirname, extname } from 'path'
import { stripBOM } from '../../utils/jsonRead.js'

import { truncateEntrypointContent } from '../../memdir/memdir.js'
import { logForDebugging } from '../../utils/debug.js'
import {
  parseFrontmatter,
  splitPathInFrontmatter,
} from '../../utils/frontmatterParser.js'
import type { MemoryType } from '../../utils/memory/types.js'
import { expandPath } from '../../utils/path.js'
import type { InstructionSourceEntry } from './contracts.js'

export const TEXT_FILE_EXTENSIONS = new Set([
  '.md',
  '.txt',
  '.text',
  '.json',
  '.yaml',
  '.yml',
  '.toml',
  '.xml',
  '.csv',
  '.html',
  '.htm',
  '.css',
  '.scss',
  '.sass',
  '.less',
  '.js',
  '.ts',
  '.tsx',
  '.jsx',
  '.mjs',
  '.cjs',
  '.mts',
  '.cts',
  '.py',
  '.pyi',
  '.pyw',
  '.rb',
  '.erb',
  '.rake',
  '.go',
  '.rs',
  '.java',
  '.kt',
  '.kts',
  '.scala',
  '.c',
  '.cpp',
  '.cc',
  '.cxx',
  '.h',
  '.hpp',
  '.hxx',
  '.cs',
  '.swift',
  '.sh',
  '.bash',
  '.zsh',
  '.fish',
  '.ps1',
  '.bat',
  '.cmd',
  '.env',
  '.ini',
  '.cfg',
  '.conf',
  '.config',
  '.properties',
  '.sql',
  '.graphql',
  '.gql',
  '.proto',
  '.vue',
  '.svelte',
  '.astro',
  '.ejs',
  '.hbs',
  '.pug',
  '.jade',
  '.php',
  '.pl',
  '.pm',
  '.lua',
  '.r',
  '.R',
  '.dart',
  '.ex',
  '.exs',
  '.erl',
  '.hrl',
  '.clj',
  '.cljs',
  '.cljc',
  '.edn',
  '.hs',
  '.lhs',
  '.elm',
  '.ml',
  '.mli',
  '.f',
  '.f90',
  '.f95',
  '.for',
  '.cmake',
  '.make',
  '.makefile',
  '.gradle',
  '.sbt',
  '.rst',
  '.adoc',
  '.asciidoc',
  '.org',
  '.tex',
  '.latex',
  '.lock',
  '.log',
  '.diff',
  '.patch',
])

export function parseFrontmatterPaths(rawContent: string): {
  content: string
  paths?: string[]
} {
  const { frontmatter, content } = parseFrontmatter(rawContent)

  if (!frontmatter.paths) {
    return { content }
  }

  const patterns = splitPathInFrontmatter(frontmatter.paths)
    .map(pattern => {
      return pattern.endsWith('/**') ? pattern.slice(0, -3) : pattern
    })
    .filter((p: string) => p.length > 0)

  if (patterns.length === 0 || patterns.every((p: string) => p === '**')) {
    return { content }
  }

  return { content, paths: patterns }
}

function stripHtmlCommentsFromTokens(tokens: ReturnType<Lexer['lex']>): {
  content: string
  stripped: boolean
} {
  let result = ''
  let stripped = false

  const commentSpan = /<!--[\s\S]*?-->/g

  for (const token of tokens) {
    if (token.type === 'html') {
      const trimmed = token.raw.trimStart()
      if (trimmed.startsWith('<!--') && trimmed.includes('-->')) {
        const residue = token.raw.replace(commentSpan, '')
        stripped = true
        if (residue.trim().length > 0) {
          result += residue
        }
        continue
      }
    }
    result += token.raw
  }

  return { content: result, stripped }
}

type MarkdownToken = {
  type: string
  text?: string
  href?: string
  tokens?: MarkdownToken[]
  raw?: string
  items?: MarkdownToken[]
}

function extractIncludePathsFromTokens(
  tokens: ReturnType<Lexer['lex']>,
  basePath: string,
): { includePaths: string[]; bareMentionPaths: string[] } {
  const absolutePaths = new Set<string>()
  const bareMentions = new Set<string>()

  function extractPathsFromText(textContent: string) {
    const includeRegex = /(?:^|\s)@((?:[^\s\\]|\\ |\\(?=\S))+)/g
    let match
    while ((match = includeRegex.exec(textContent)) !== null) {
      let path = match[1]
      if (!path) continue

      const hashIndex = path.indexOf('#')
      if (hashIndex !== -1) {
        path = path.substring(0, hashIndex)
      }
      if (!path) continue

      path = path.replace(/\\ /g, ' ')

      path = path.replace(/[.,;:!?]+$/, '')

      if (path) {
        const isValidPath =
          path.startsWith('./') ||
          path.startsWith('~/') ||
          (path.startsWith('/') && path !== '/') ||
          (!path.startsWith('@') &&
            !path.match(/^[#%^&*()]+/) &&
            path.match(/^[a-zA-Z0-9._-]/))

        if (isValidPath) {
          const resolvedPath = expandPath(path, dirname(basePath))
          const hasPathEvidence = path.includes('/') || path.includes('.')
          if (hasPathEvidence) {
            absolutePaths.add(resolvedPath)
          } else {
            bareMentions.add(resolvedPath)
          }
        }
      }
    }
  }

  function processElements(elements: MarkdownToken[]) {
    for (const element of elements) {
      if (element.type === 'code' || element.type === 'codespan') {
        continue
      }

      if (element.type === 'html') {
        const raw = element.raw || ''
        const trimmed = raw.trimStart()
        if (trimmed.startsWith('<!--') && trimmed.includes('-->')) {
          const commentSpan = /<!--[\s\S]*?-->/g
          const residue = raw.replace(commentSpan, '')
          if (residue.trim().length > 0) {
            extractPathsFromText(residue)
          }
        }
        continue
      }

      if (element.type === 'text') {
        extractPathsFromText(element.text || '')
      }

      if (element.tokens) {
        processElements(element.tokens)
      }

      if (element.items) {
        processElements(element.items)
      }
    }
  }

  processElements(tokens as MarkdownToken[])
  return { includePaths: [...absolutePaths], bareMentionPaths: [...bareMentions] }
}

export function parseInstructionFileContent(
  rawContent: string,
  filePath: string,
  type: MemoryType,
  includeBasePath?: string,
): { info: InstructionSourceEntry | null; includePaths: string[]; bareMentionPaths: string[] } {
  const ext = extname(filePath).toLowerCase()
  if (ext && !TEXT_FILE_EXTENSIONS.has(ext)) {
    logForDebugging(`Skipping non-text file in @include: ${filePath}`)
    return { info: null, includePaths: [], bareMentionPaths: [] }
  }

  rawContent = stripBOM(rawContent)

  const { content: withoutFrontmatter, paths } =
    parseFrontmatterPaths(rawContent)

  const hasComment = withoutFrontmatter.includes('<!--')
  const tokens =
    hasComment || includeBasePath !== undefined
      ? new Lexer({ gfm: false }).lex(withoutFrontmatter)
      : undefined

  const strippedContent =
    hasComment && tokens
      ? stripHtmlCommentsFromTokens(tokens).content
      : withoutFrontmatter

  const extracted =
    tokens && includeBasePath !== undefined
      ? extractIncludePathsFromTokens(tokens, includeBasePath)
      : { includePaths: [], bareMentionPaths: [] }

  let finalContent = strippedContent
  if (type === 'AutoMem' || type === 'TeamMem') {
    finalContent = truncateEntrypointContent(strippedContent).content
  }

  const contentDiffersFromDisk = finalContent !== rawContent
  return {
    info: {
      path: filePath,
      type,
      content: finalContent,
      globs: paths,
      contentDiffersFromDisk,
      rawContent: contentDiffersFromDisk ? rawContent : undefined,
    },
    includePaths: extracted.includePaths,
    bareMentionPaths: extracted.bareMentionPaths,
  }
}
