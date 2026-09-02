// ============================================================================
//  instructions/sourceText.ts — pure text mechanics of the ONE instruction
//  engine: text-file gating, frontmatter `paths:`
//  extraction, block-level HTML-comment stripping, @include path extraction,
//  and the single-lex content parse. No I/O, no config, no state — the
//  established text behavior, byte-exact (oracle-pinned).
// ============================================================================
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

// The @include allowlist: only these extensions may be pulled into the
// composed instruction text. Everything else is presumed binary (images,
// PDFs, archives) — composing those would pour non-text bytes into the
// system prompt.
export const TEXT_FILE_EXTENSIONS = new Set([
  // Markdown and text
  '.md',
  '.txt',
  '.text',
  // Data formats
  '.json',
  '.yaml',
  '.yml',
  '.toml',
  '.xml',
  '.csv',
  // Web
  '.html',
  '.htm',
  '.css',
  '.scss',
  '.sass',
  '.less',
  // JS/TS family
  '.js',
  '.ts',
  '.tsx',
  '.jsx',
  '.mjs',
  '.cjs',
  '.mts',
  '.cts',
  // Python
  '.py',
  '.pyi',
  '.pyw',
  // Ruby
  '.rb',
  '.erb',
  '.rake',
  // Go
  '.go',
  // Rust
  '.rs',
  // Java/Kotlin/Scala
  '.java',
  '.kt',
  '.kts',
  '.scala',
  // C/C++
  '.c',
  '.cpp',
  '.cc',
  '.cxx',
  '.h',
  '.hpp',
  '.hxx',
  // C#
  '.cs',
  // Swift
  '.swift',
  // Shell
  '.sh',
  '.bash',
  '.zsh',
  '.fish',
  '.ps1',
  '.bat',
  '.cmd',
  // Config
  '.env',
  '.ini',
  '.cfg',
  '.conf',
  '.config',
  '.properties',
  // Database
  '.sql',
  '.graphql',
  '.gql',
  // Protocol
  '.proto',
  // Frontend framework SFCs
  '.vue',
  '.svelte',
  '.astro',
  // Templating
  '.ejs',
  '.hbs',
  '.pug',
  '.jade',
  // Other languages
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
  // Build files
  '.cmake',
  '.make',
  '.makefile',
  '.gradle',
  '.sbt',
  // Documentation
  '.rst',
  '.adoc',
  '.asciidoc',
  '.org',
  '.tex',
  '.latex',
  // Lock files (text in practice)
  '.lock',
  // Misc
  '.log',
  '.diff',
  '.patch',
])

/**
 * Split frontmatter off raw file content and normalize its `paths:` globs.
 * `paths` comes back undefined for an unconditional file — no frontmatter
 * paths, or patterns that all reduce to match-everything.
 */
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
      // A trailing /** is redundant under the ignore library — a bare
      // 'path' already matches the path AND everything under it.
      return pattern.endsWith('/**') ? pattern.slice(0, -3) : pattern
    })
    .filter((p: string) => p.length > 0)

  // All-'**' (or nothing left) means the condition binds nowhere — the file
  // is effectively unconditional, and undefined says so.
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

  // One well-formed comment span. Non-greedy, so several comments sharing a
  // line each match on their own; [\s\S] lets a span cross newlines.
  const commentSpan = /<!--[\s\S]*?-->/g

  for (const token of tokens) {
    if (token.type === 'html') {
      const trimmed = token.raw.trimStart()
      if (trimmed.startsWith('<!--') && trimmed.includes('-->')) {
        // CommonMark ends a type-2 HTML block at the LINE carrying `-->` —
        // whatever follows `-->` on that line rides inside this token. So:
        // strip only the comment spans, keep the residue.
        const residue = token.raw.replace(commentSpan, '')
        stripped = true
        if (residue.trim().length > 0) {
          // e.g. `<!-- note --> Use bun` — "Use bun" survives.
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

// Walk pre-lexed tokens for @path include references and resolve them
// absolute. Comment-interior text contributes only its residue (handled per
// token below), so an @path spelled inside a block comment never composes.
//
// FC-110: prose @mentions are not imports. The capture consumes to the
// next whitespace, so "Lint with @typescript-eslint." used to become the
// import path "typescript-eslint." — sentence punctuation swallowed, then
// a fabricated missing-import warn in the doctor. Two accommodations:
// trailing sentence punctuation ([.,;:!?]) cannot end an import (its cost:
// a real file whose name ends in one of those cannot be imported), and a
// token with NO path evidence after the trim — no slash and no dot, the
// shape of "@alice" or a scoped-package name — is returned as a BARE
// MENTION beside the imports: pure text cannot know whether it names a
// real file, so the I/O layer existence-gates it (a bare @Makefile that
// exists still composes; prose mentions warn nothing).
function extractIncludePathsFromTokens(
  tokens: ReturnType<Lexer['lex']>,
  basePath: string,
): { includePaths: string[]; bareMentionPaths: string[] } {
  const absolutePaths = new Set<string>()
  const bareMentions = new Set<string>()

  function extractPathsFromText(textContent: string) {
    // The token: anything but whitespace, where a backslash is EITHER an
    // escaped space (`\ `) or a path separator (`\` followed by a non-space
    // character). The earlier class excluded the backslash outright, so a
    // Windows spelling — @docs\style.md, @.\docs\style.md, @C:\shared\rules.md,
    // the spelling Explorer and Mercury's own Grep output hand an operator —
    // stopped at the first separator and resolved to an existing DIRECTORY,
    // which passed the missing-target diagnostic and then died as a
    // swallowed EISDIR: the imported rules were never in force and nothing
    // said so (FN-015 rank 44). The resolver downstream handles native
    // spellings; a POSIX host that meets one gets an honest diagnostic.
    const includeRegex = /(?:^|\s)@((?:[^\s\\]|\\ |\\(?=\S))+)/g
    let match
    while ((match = includeRegex.exec(textContent)) !== null) {
      let path = match[1]
      if (!path) continue

      // A #fragment names a section, not a file — drop it before resolving.
      const hashIndex = path.indexOf('#')
      if (hashIndex !== -1) {
        path = path.substring(0, hashIndex)
      }
      if (!path) continue

      // Backslash-escaped spaces become real spaces.
      path = path.replace(/\\ /g, ' ')

      // Trailing sentence punctuation belongs to the sentence, not the path.
      path = path.replace(/[.,;:!?]+$/, '')

      // The accepted spellings: @path · @./path · @~/path · @/path.
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

  // Depth-first over the token tree; only text nodes (and comment residue)
  // can carry an @path.
  function processElements(elements: MarkdownToken[]) {
    for (const element of elements) {
      // Code is quoted material — an @path inside a fence or codespan is
      // being SHOWN, not requested.
      if (element.type === 'code' || element.type === 'codespan') {
        continue
      }

      // An html token that is a comment still contributes its RESIDUE (the
      // text after `-->` on the closing line, e.g. `<!-- note --> @./x.md`);
      // non-comment html tokens contribute nothing.
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

      // Lists hang their children off `items`, not `tokens`.
      if (element.items) {
        processElements(element.items)
      }
    }
  }

  processElements(tokens as MarkdownToken[])
  return { includePaths: [...absolutePaths], bareMentionPaths: [...bareMentions] }
}

/**
 * Parse raw instruction-file content into an InstructionSourceEntry. Pure —
 * no io. With includeBasePath set, @include paths resolve during the same
 * lex and ride back with the parse, sparing the discovery layer a second
 * lex of identical content.
 */
export function parseInstructionFileContent(
  rawContent: string,
  filePath: string,
  type: MemoryType,
  includeBasePath?: string,
): { info: InstructionSourceEntry | null; includePaths: string[]; bareMentionPaths: string[] } {
  // The allowlist gate (TEXT_FILE_EXTENSIONS): a non-text extension never
  // parses — see the set's rationale above.
  const ext = extname(filePath).toLowerCase()
  if (ext && !TEXT_FILE_EXTENSIONS.has(ext)) {
    logForDebugging(`Skipping non-text file in @include: ${filePath}`)
    return { info: null, includePaths: [], bareMentionPaths: [] }
  }

  // C15 (BOM class): a UTF-8 BOM — Windows Notepad's default — broke every
  // position-0 grammar here (frontmatter undetected, the first heading
  // unrecognized) and rode into the composed content, so the engine's
  // digest dedupe told BOM'd and clean copies of one file apart. Strip
  // before any parse.
  rawContent = stripBOM(rawContent)

  const { content: withoutFrontmatter, paths } =
    parseFrontmatterPaths(rawContent)

  // ONE lex serves both the strip and the @include extraction. gfm:false is
  // the extractor's requirement (~/path must not tokenize as
  // strikethrough); the strip is indifferent (html blocks are CommonMark).
  const hasComment = withoutFrontmatter.includes('<!--')
  const tokens =
    hasComment || includeBasePath !== undefined
      ? new Lexer({ gfm: false }).lex(withoutFrontmatter)
      : undefined

  // The token-rebuild path runs ONLY when a comment genuinely needs
  // stripping: marked normalizes \r\n during lex, so round-tripping a CRLF
  // file through token.raw would flip contentDiffersFromDisk for no reason.
  const strippedContent =
    hasComment && tokens
      ? stripHtmlCommentsFromTokens(tokens).content
      : withoutFrontmatter

  const extracted =
    tokens && includeBasePath !== undefined
      ? extractIncludePathsFromTokens(tokens, includeBasePath)
      : { includePaths: [], bareMentionPaths: [] }

  // Memory entrypoints ride the memdir line+byte caps.
  let finalContent = strippedContent
  if (type === 'AutoMem' || type === 'TeamMem') {
    finalContent = truncateEntrypointContent(strippedContent).content
  }

  // One flag covers every transform above (frontmatter strip, comment
  // strip, entrypoint truncation): when set, rawContent rides along so
  // disk-equality checks compare against what is actually on disk.
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
