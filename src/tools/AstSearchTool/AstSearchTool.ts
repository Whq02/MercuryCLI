import { stat } from 'node:fs/promises'

import { z } from 'zod/v4'

import { buildTool, type ToolUseContext } from '../../Tool.js'
import { anchorPatchEnabled } from '../../services/changeTransaction/anchorPatch.js'
import { fileGeneration, recordSeenLines } from '../../services/changeTransaction/seenLines.js'
import { ownerFromToolUseContext } from '../../utils/run/resolveOwner.js'
import { structurePolyglotEnabled } from '../../services/structure/contracts.js'
import { resolveGrammarEngineDir } from '../../utils/structure/grammarFacility.js'
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
} from '../../services/structure/astPatterns.js'
import { getCwd } from '../../utils/cwd.js'
import { isENOENT } from '../../utils/errors.js'
import { FILE_NOT_FOUND_CWD_NOTE, findSimilarFile, suggestPathUnderCwd } from '../../utils/file.js'
import { controlCharacterPathRefusal, expandPath } from '../../utils/path.js'
import { checkReadPermissionForTool, getResolvedWorkingDirPaths, matchingRuleForInput, ruleMatcherFor } from '../../utils/permissions/filesystem.js'
import { mercurySecretPath } from '../../utils/permissions/protectedPaths.js'
import { semanticNumber } from '../../utils/semanticNumber.js'
import { plural } from '../../utils/stringUtils.js'
import { AST_GLOB_FIELD, AST_PATH_FIELD, AST_PATTERN_FIELD, AST_SEARCH_TOOL_NAME, astLanguageField, getAstSearchDescription } from './prompt.js'
import {
  getToolUseSummary,
  isResultTruncated,
  renderToolResultMessage,
  renderToolUseErrorMessage,
  renderToolUseMessage,
} from './UI.js'
import { passedOver } from '../../utils/passedOver.js'
import { unbuilt, type Unbuilt } from '../../pi/holes.js'


const inputSchema = z.strictObject({
  pattern: z.string().describe(AST_PATTERN_FIELD),
  path: z.string().optional().describe(AST_PATH_FIELD),
  glob: z.string().optional().describe(AST_GLOB_FIELD),
  lang: z.string().optional().describe(astLanguageField()),
  mode: z
    .enum(['matches', 'count'])
    .optional()
    .describe('Default "matches" (each match + captures); "count" tallies per file'),
  limit: semanticNumber(z.number().optional()).describe(
    `Max matches (default ${AST_BOUNDS.defaultLimit}, max ${AST_BOUNDS.maxLimit}; rest counted)`,
  ),
  offset: semanticNumber(z.number().optional()).describe('Matches skipped before limit (default 0)'),
})

type Input = z.infer<typeof inputSchema>

type Output = {
  mode: 'matches' | 'count'
  pattern: string
  scope: string
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

export const AstSearchTool: Unbuilt = unbuilt('src/tools/AstSearchTool/AstSearchTool.ts:104')

