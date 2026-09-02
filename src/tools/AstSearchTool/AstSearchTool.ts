import { stat } from 'node:fs/promises'

import { z } from 'zod/v4'

import { buildTool, type ToolUseContext } from '../../Tool.js'
import { anchorPatchEnabled } from '../../services/changeTransaction/anchorPatch.js'
import { fileGeneration, recordSeenLines } from '../../services/changeTransaction/seenLines.js'
import { ownerFromToolUseContext } from '../../services/run/resolveOwner.js'
import { structurePolyglotEnabled } from '../../services/structure/contracts.js'
import { resolveGrammarEngineDir } from '../../services/structure/grammarFacility.js'
import {
  AST_BOUNDS,
  astLanguageNames,
  availableAstLanguages,
  GRAMMAR_PACK_REMEDY,
  isAstRefusal,
  patternErrorText,
  patternRefusedEverywhere,
  renderMatch,
  renderSearchTrailer,
  resolveAstLanguage,
  resolveAstScope,
  searchAstPattern,
  type AstMatch,
} from '../../utils/astPatterns.js'
import { getCwd } from '../../utils/cwd.js'
import { isENOENT } from '../../utils/errors.js'
import { FILE_NOT_FOUND_CWD_NOTE, findSimilarFile, suggestPathUnderCwd } from '../../utils/file.js'
import { expandPath } from '../../utils/path.js'
import { checkReadPermissionForTool, matchingRuleForInput } from '../../utils/permissions/filesystem.js'
import { semanticNumber } from '../../utils/semanticNumber.js'
import { plural } from '../../utils/stringUtils.js'
import { AST_SEARCH_TOOL_NAME, getAstSearchDescription } from './prompt.js'
import {
  getToolUseSummary,
  isResultTruncated,
  renderToolResultMessage,
  renderToolUseErrorMessage,
  renderToolUseMessage,
} from './UI.js'

/**
 * The AstSearch tool: structural code search over the packaged tree-sitter
 * grammars. A pattern in the target language with meta-variables is matched
 * against every file's syntax tree; results carry the matched code and the
 * captures, bounded and paged, with an honest census of what was not
 * searched. Read-only, concurrency-safe, the read-permission ladder over
 * the scope path plus per-file read-deny rules.
 *
 * Gate: MERCURY_STRUCTURE_POLYGLOT (the grammar engine's own registered
 * flag). Proof: scripts/ast-tools/run-all.sh.
 */

const inputSchema = z.strictObject({
  pattern: z
    .string()
    .describe(
      'The structural pattern: code in the target language with meta-variables — $NAME for one node, $$$NAME for a sequence, e.g. "$FN($$$ARGS)" or "if ($COND) { $$$BODY }"',
    ),
  path: z
    .string()
    .optional()
    .describe('Where to search — a file or a directory; the current working directory when omitted.'),
  glob: z
    .string()
    .optional()
    .describe('Restrict the search to files matching this glob, relative to path, e.g. "**/*.ts" or "src/**/*.py"'),
  lang: z
    .string()
    .optional()
    .describe('Force one language instead of detecting it per file from the extension (typescript, python, go, rust, …)'),
  mode: z
    .enum(['matches', 'count'])
    .optional()
    .describe('"matches" (the default) lists each match with its captures; "count" tallies matches per file'),
  limit: semanticNumber(z.number().optional()).describe(
    `Matches to return (default ${AST_BOUNDS.defaultLimit}, max ${AST_BOUNDS.maxLimit}); the rest is counted, never dropped silently.`,
  ),
  offset: semanticNumber(z.number().optional()).describe('Matches to skip before the window (paging). Default 0.'),
})

type Input = z.infer<typeof inputSchema>

type Output = {
  mode: 'matches' | 'count'
  pattern: string
  scope: string
  /** The model-facing text, built once. */
  text: string
  matchCount: number
  fileCount: number
  filesSearched: number
  shown: number
  offset: number
  truncated: boolean
  capped: boolean
  parseFailures: number
}

// Resumed transcripts guard persisted results through this schema.
const outputSchema = z.object({
  mode: z.enum(['matches', 'count']),
  pattern: z.string(),
  scope: z.string(),
  text: z.string(),
  matchCount: z.number(),
  fileCount: z.number(),
  filesSearched: z.number(),
  shown: z.number(),
  offset: z.number(),
  truncated: z.boolean(),
  capped: z.boolean(),
  parseFailures: z.number(),
})

function clampLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) return AST_BOUNDS.defaultLimit
  return Math.min(Math.max(Math.floor(limit), 1), AST_BOUNDS.maxLimit)
}

function countText(matches: AstMatch[], capped: boolean): { rows: string[]; files: number } {
  const perFile = new Map<string, number>()
  for (const m of matches) perFile.set(m.rel, (perFile.get(m.rel) ?? 0) + 1)
  const rows = [...perFile.entries()].map(([rel, n]) => `${rel}: ${n}${capped ? '+' : ''}`)
  return { rows, files: perFile.size }
}

export const AstSearchTool = buildTool({
  name: AST_SEARCH_TOOL_NAME,
  strict: true,
  maxResultSizeChars: 30_000,
  searchHint: 'structural code search by syntax pattern with meta-variables across languages',
  capability: {
    intents: [
      'find code by its syntax shape',
      'search for calls with a given argument shape',
      'find a construct inside another construct',
      'count occurrences of a code pattern per file',
      'search python go rust or typescript structurally',
    ],
    units: ['source-reading', 'code-intelligence'],
    class: 'observation',
    cancellation: 'cooperative',
    latency: 'fast',
    gate: 'MERCURY_STRUCTURE_POLYGLOT',
    conditions: ['the packaged tree-sitter grammar engine (dist/vendor/treesitter beside the bundle, or the workspace package)'],
    proof: 'scripts/ast-tools/run-all.sh',
  },
  inputSchema,
  outputSchema,
  // Never advertise a tool that would fail to launch: the flag AND a
  // resolvable grammar engine (the artifact's own vendored dir, or the
  // workspace package for source runs).
  isEnabled() {
    return structurePolyglotEnabled() && resolveGrammarEngineDir().state === 'ok'
  },
  isReadOnly: () => true,
  isConcurrencySafe: () => true,
  // The tool's own verdict: the read-permission ladder over its scope path.
  async checkPermissions(input, context): Promise<ReturnType<typeof checkReadPermissionForTool>> {
    return checkReadPermissionForTool(AstSearchTool, input, context.getAppState().toolPermissionContext)
  },
  isSearchOrReadCommand: () => ({ isSearch: true, isRead: false }),
  userFacingName: () => 'Structural search',
  getToolUseSummary,
  getActivityDescription(input: Partial<Input> | undefined): string {
    return input?.pattern ? `Searching for the shape ${input.pattern}` : 'Searching structurally'
  },
  toAutoClassifierInput(input: Input): string {
    return input.path ? `${input.pattern} in ${input.path}` : input.pattern
  },
  getPath(input: Partial<Input> | undefined): string {
    // Deliberately unexpanded — the scope resolver expands.
    return input?.path || getCwd()
  },
  async description(): Promise<string> {
    return getAstSearchDescription()
  },
  async prompt(): Promise<string> {
    // Deliberately the same string as the description.
    return getAstSearchDescription()
  },
  async validateInput(input: Input) {
    if (input.pattern.trim() === '') {
      return { result: false as const, message: 'pattern is empty — give a structural pattern such as "$FN($$$ARGS)".', errorCode: 1 }
    }
    if (input.lang !== undefined && input.lang.trim() !== '') {
      const resolved = resolveAstLanguage(input.lang)
      if (!resolved) {
        return {
          result: false as const,
          message: `Unknown language "${input.lang}". Supported languages: ${astLanguageNames().join(', ')}. Omit lang to detect the language per file from its extension.`,
          errorCode: 2,
        }
      }
      if (!availableAstLanguages().some(l => l.name === resolved.name)) {
        return {
          result: false as const,
          message: `lang "${input.lang}" routes to ${resolved.name}, but this build does not carry the ${resolved.name} grammar: ${GRAMMAR_PACK_REMEDY}. Languages this build carries: ${astLanguageNames().join(', ')}.`,
          errorCode: 2,
        }
      }
    }
    if (input.offset !== undefined && (!Number.isFinite(input.offset) || input.offset < 0)) {
      return { result: false as const, message: 'offset must be a non-negative number.', errorCode: 3 }
    }
    if (input.path !== undefined) {
      const expanded = expandPath(input.path)
      if (input.path.startsWith('\\\\') || input.path.startsWith('//')) {
        return { result: true as const }
      }
      try {
        await stat(expanded)
      } catch (err) {
        if (!isENOENT(err)) throw err
        let suggestion: string | undefined
        try {
          suggestion = await suggestPathUnderCwd(expanded)
        } catch {
          suggestion = undefined
        }
        if (suggestion === undefined) suggestion = findSimilarFile(expanded)
        return {
          result: false as const,
          message: `Path does not exist: ${input.path}. ${FILE_NOT_FOUND_CWD_NOTE} ${getCwd()}.${suggestion ? ` Did you mean ${suggestion}?` : ''}`,
          errorCode: 4,
        }
      }
    }
    return { result: true as const }
  },
  async call(input: Input, context: ToolUseContext) {
    const mode = input.mode ?? 'matches'
    const permCtx = context.getAppState().toolPermissionContext
    const scope = resolveAstScope({
      ...(input.path !== undefined && { path: expandPath(input.path) }),
      ...(input.glob !== undefined && { glob: input.glob }),
      ...(input.lang !== undefined && { lang: input.lang }),
      cwd: getCwd(),
      readable: abs => matchingRuleForInput(abs, permCtx, 'read', 'deny') === null,
    })
    if (isAstRefusal(scope)) throw new Error(scope.refused)
    // Keep the caller's spelling for the label (the resolver stores the
    // expanded absolute path as `display` when one was passed).
    scope.display = input.path === undefined || input.path === '' ? '.' : input.path

    const limit = clampLimit(input.limit)
    const offset = input.offset === undefined ? 0 : Math.max(0, Math.floor(input.offset))
    const result = await searchAstPattern(scope, {
      pattern: input.pattern,
      signal: context.abortController.signal,
      // Count mode materialises up to the cap; match mode only what the
      // window can show plus one page beyond, so the "N more" is exact up
      // to the cap.
      matchCap: mode === 'count' ? AST_BOUNDS.matchCap : Math.min(AST_BOUNDS.matchCap, Math.max(offset + limit + 1, AST_BOUNDS.maxLimit * 2)),
    })
    if (isAstRefusal(result)) throw new Error(result.refused)
    if (patternRefusedEverywhere(scope, result)) throw new Error(patternErrorText(input.pattern, result))

    const trailer = renderSearchTrailer(scope, result)
    const base = {
      mode,
      pattern: input.pattern,
      scope: scope.display,
      matchCount: result.matches.length,
      fileCount: result.filesWithMatches,
      filesSearched: result.filesParsed,
      offset,
      capped: result.capped,
      parseFailures: result.parseFailures.length,
    }

    if (scope.files.length === 0) {
      const text = [
        `Nothing searched: no files with a supported language ${scope.singleFile ? scope.display : `under ${scope.display}`}${scope.glob ? ` matching ${scope.glob}` : ''}${scope.lang ? ` in ${scope.lang.name}` : ''}.`,
        ...trailer.slice(1),
      ].join('\n')
      return { data: { ...base, text, shown: 0, truncated: false } satisfies Output }
    }

    if (result.matches.length === 0) {
      const text = [`No matches for ${JSON.stringify(input.pattern)}.`, ...trailer].join('\n')
      return { data: { ...base, text, shown: 0, truncated: false } satisfies Output }
    }

    if (mode === 'count') {
      const { rows, files } = countText(result.matches, result.capped)
      const total = result.matches.length
      const text = [
        ...rows,
        `${total}${result.capped ? '+' : ''} ${plural(total, 'match', 'matches')} across ${files} ${plural(files, 'file')}${result.capped ? ` (counting stopped at ${AST_BOUNDS.matchCap} — narrow the scope for an exact total)` : ''}.`,
        ...trailer,
      ].join('\n')
      return { data: { ...base, text, shown: rows.length, truncated: result.capped } satisfies Output }
    }

    const window = result.matches.slice(offset, offset + limit)
    const lines: string[] = []
    for (const m of window) lines.push(...renderMatch(m))
    const total = result.matches.length
    const remaining = Math.max(0, total - offset - window.length)
    const truncated = remaining > 0 || result.capped
    if (window.length === 0) {
      lines.push(`offset ${offset} is past the last match (${total}${result.capped ? '+' : ''} in total).`)
    } else if (truncated) {
      lines.push(
        `Showing ${offset + 1}-${offset + window.length} of ${total}${result.capped ? '+' : ''} ${plural(total, 'match', 'matches')} in ${result.filesWithMatches} ${plural(result.filesWithMatches, 'file')} — ${remaining}${result.capped ? '+' : ''} more; pass offset: ${offset + window.length} for the next page.`,
      )
    } else {
      lines.push(`${total} ${plural(total, 'match', 'matches')} in ${result.filesWithMatches} ${plural(result.filesWithMatches, 'file')}.`)
    }
    lines.push(...trailer)

    // Seen-lines evidence: every DISPLAYED match line counts as shown for
    // the patch dialect's per-line ledger. Under-recording only forces a
    // re-read; a misparse could fabricate sight, so only the lines the
    // model actually saw are recorded.
    if (anchorPatchEnabled()) {
      try {
        const owner = ownerFromToolUseContext(context)
        const generations = new Map<string, string | null>()
        for (const m of window) {
          if (!generations.has(m.abs)) generations.set(m.abs, fileGeneration(m.abs))
          const generation = generations.get(m.abs)
          if (generation == null) continue
          const shownLines = Math.min(m.endLine - m.startLine + 1, 4)
          recordSeenLines(owner, m.abs, generation, m.startLine, shownLines)
        }
      } catch {
        // Evidence recording never breaks a search.
      }
    }

    return {
      data: { ...base, text: lines.join('\n'), shown: window.length, truncated } satisfies Output,
    }
  },
  mapToolResultToToolResultBlockParam(data: Output, toolUseID: string) {
    return { tool_use_id: toolUseID, type: 'tool_result' as const, content: data.text }
  },
  extractSearchText(data: Output): string {
    return data.text
  },
  isResultTruncated,
  renderToolUseMessage,
  renderToolResultMessage,
  renderToolUseErrorMessage,
})

export type { Output as AstSearchOutput }
