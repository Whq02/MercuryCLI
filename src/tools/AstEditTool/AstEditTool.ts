import type { UUID } from 'node:crypto'
import { stat } from 'node:fs/promises'

import { z } from 'zod/v4'

import { flagEnv } from '../../substrate/flagRegistry.js'
import { buildTool, type ToolEffectOutcome, type ToolUseContext } from '../../Tool.js'
import type { InlineChangeViewData } from '../../components/InlineChangeView.js'
import type { AssistantMessage } from '../../types/message.js'
import { runVerbatimTextCommit } from '../../services/changeTransaction/changeSetCommit.js'
import { changeTransactionEnabled } from '../../services/changeTransaction/contracts.js'
import { dropSeenLines } from '../../services/changeTransaction/seenLines.js'
import { mintFileAnchor } from '../../services/changeTransaction/snapshotAnchor.js'
import { rememberAnchoredSnapshot } from '../../services/changeTransaction/snapshotRing.js'
import { getLspServerManager } from '../../services/lsp/manager.js'
import { ownerFromToolUseContext } from '../../utils/run/resolveOwner.js'
import { structurePolyglotEnabled } from '../../services/structure/contracts.js'
import { resolveGrammarEngineDir } from '../../utils/structure/grammarFacility.js'
import {
  activateConditionalSkillsForPaths,
  addSkillDirectories,
  discoverSkillDirsForPaths,
} from '../../skills/loadSkillsDir.js'
import {
  astLanguageNames,
  availableAstLanguages,
  GRAMMAR_PACK_REMEDY,
  isAstRefusal,
  patternErrorText,
  patternRefusedEverywhere,
  planAstRewrite,
  renderLeftOut,
  renderSearchTrailer,
  resolveAstLanguage,
  resolveAstScope,
  type AstRewritePlan,
  type AstScope,
} from '../../services/structure/astPatterns.js'
import { getCwd } from '../../utils/cwd.js'
import { isEnvTruthy } from '../../utils/envUtils.js'
import { isENOENT } from '../../utils/errors.js'
import { logForDebugging } from '../../utils/debug.js'
import { FILE_NOT_FOUND_CWD_NOTE, findSimilarFile, getFileModificationTime, suggestPathUnderCwd } from '../../utils/file.js'
import { fileHistoryEnabled, fileHistoryTrackEdit } from '../../services/changeTransaction/fileHistory.js'
import { controlCharacterPathRefusal, expandPath } from '../../utils/path.js'
import type { PermissionDecision } from '../../utils/permissions/PermissionResult.js'
import {
  checkReadPermissionForTool,
  checkWritePermissionForTool,
  getResolvedWorkingDirPaths,
  matchingRuleForInput,
  ruleMatcherFor,
} from '../../utils/permissions/filesystem.js'
import { mercurySecretPath } from '../../utils/permissions/protectedPaths.js'
import { reasonForRule, refusalWithReason, ruleWords } from '../../utils/permissions/ruleReason.js'
import { semanticBoolean } from '../../utils/semanticBoolean.js'
import { clipWithEllipsis, plural } from '../../utils/stringUtils.js'
import { syncServersAfterWrite } from '../LSPTool/mercuryOps.js'
import { AST_GLOB_FIELD, AST_PATH_FIELD, AST_PATTERN_FIELD, astLanguageField } from '../AstSearchTool/prompt.js'
import { AST_EDIT_TOOL_NAME, getAstEditDescription } from './prompt.js'
import {
  getToolUseSummary,
  renderToolResultMessage,
  renderToolUseErrorMessage,
  renderToolUseMessage,
  renderToolUseRejectedMessage,
} from './UI.js'
import { passedOver } from '../../utils/passedOver.js'
import { unbuilt, type Unbuilt } from '../../pi/holes.js'


const ruleSchema = z.strictObject({
  pattern: z.string(),
  rewrite: z.string(),
})

const EXCLUSIVE_FORMS_MESSAGE =
  'Pass either pattern and rewrite for one rule, or a non-empty rules array of { pattern, rewrite } pairs, never both.'

const inputSchema = z.strictObject({
  pattern: z.string().optional().describe(AST_PATTERN_FIELD),
  rewrite: z
    .string()
    .optional()
    .describe('Replacement code in target language: $NAME and $$$NAME insert captured source ($_/$$$ cannot be inserted; every meta-variable must be captured); "" deletes the node (and its line when owned).'),
  rules: z
    .array(ruleSchema)
    .optional()
    .describe('Pattern/rewrite pairs applied in one pass over the original text, in place of pattern and rewrite.'),
  path: z.string().optional().describe(AST_PATH_FIELD),
  glob: z.string().optional().describe(AST_GLOB_FIELD),
  lang: z.string().optional().describe(astLanguageField()),
  apply: semanticBoolean(z.boolean().optional()).describe(
    'Default false dry-runs (returns diff + plan token); true writes using plan.',
  ),
  plan: z.string().optional().describe('The plan token (ae-…) the dry run returned; apply refuses when a file, the pattern, the rewrite, the rules or the scope differs from that dry run.'),
})

type Input = z.infer<typeof inputSchema>

type Output = {
  state: 'dry-run' | 'applied' | 'no-change' | 'no-matches'
  pattern: string
  rewrite: string
  scope: string
  text: string
  plan?: string
  matchCount: number
  fileCount: number
  changedPaths: string[]
  changeView?: InlineChangeViewData
}

const outputSchema = z.object({
  state: z.enum(['dry-run', 'applied', 'no-change', 'no-matches']),
  pattern: z.string(),
  rewrite: z.string(),
  scope: z.string(),
  text: z.string(),
  plan: z.string().optional(),
  matchCount: z.number(),
  fileCount: z.number(),
  changedPaths: z.array(z.string()),
  changeView: z.any().optional(),
})

const pathShim = {
  name: AST_EDIT_TOOL_NAME,
  getPath: (i: { file_path: string }) => i.file_path,
}

function scopeFor(input: Input, context: ToolUseContext): AstScope {
  const permCtx = context.getAppState().toolPermissionContext
  let denyRules = ruleMatcherFor(permCtx, 'read', 'deny')
  if (denyRules !== null) denyRules = ruleMatcherFor(permCtx, 'read', 'deny', getResolvedWorkingDirPaths(getCwd()))
  const scope = resolveAstScope({
    ...(input.path !== undefined && { path: expandPath(input.path) }),
    ...(input.glob !== undefined && { glob: input.glob }),
    ...(input.lang !== undefined && { lang: input.lang }),
    cwd: getCwd(),
    trackLinks: denyRules !== null,
    readable: (abs, throughLink) => mercurySecretPath(abs) === null && (denyRules !== null
      ? denyRules(abs).length === 0 && (!throughLink || checkReadPermissionForTool(pathShim, { file_path: abs }, permCtx).behavior !== 'deny')
      : matchingRuleForInput(abs, permCtx, 'read', 'deny') === null),
  })
  if (isAstRefusal(scope)) throw new Error(scope.refused)
  scope.display = input.path === undefined || input.path === '' ? '.' : input.path
  return scope
}

async function planFor(input: Input, context: ToolUseContext): Promise<{ scope: AstScope; plan: AstRewritePlan }> {
  const scope = scopeFor(input, context)
  const plan = await planAstRewrite(scope, {
    ...(input.rules !== undefined ? { rules: input.rules } : { pattern: input.pattern ?? '', rewrite: input.rewrite ?? '' }),
    signal: context.abortController.signal,
  })
  if (isAstRefusal(plan)) throw new Error(plan.refused)
  if (input.rules === undefined && patternRefusedEverywhere(scope, plan.search)) {
    throw new Error(patternErrorText(input.pattern ?? '', plan.search))
  }
  return { scope, plan }
}

function changeViewOf(plan: AstRewritePlan, state: 'proposed' | 'applied'): InlineChangeViewData {
  return {
    state,
    action: 'rewrite',
    files: plan.files.map(f => ({
      file: f.rel,
      hunks: f.hunks,
      ...(f.omittedHunks > 0 ? { omittedHunks: f.omittedHunks } : {}),
      changedLines: f.changedLines,
    })),
    matchCount: plan.matchCount,
    hunkCount: plan.files.reduce((n, f) => n + f.hunks.length + f.omittedHunks, 0),
    refs: [],
  }
}

function renderBatchSummaryLines(plan: AstRewritePlan): string[] {
  const batch = plan.batch
  if (!batch) return []
  const lines: string[] = ['Rules:']
  for (const r of batch.rules) {
    const pat = JSON.stringify(clipWithEllipsis(r.pattern.replace(/\s+/g, ' '), 50))
    const rw = JSON.stringify(clipWithEllipsis(r.rewrite.replace(/\s+/g, ' '), 50))
    const unch = r.unchangedMatches > 0 ? ` (${r.unchangedMatches} already rewritten)` : ''
    lines.push(
      `  rule ${r.ruleIndex} (${pat} → ${rw}): ${r.changedMatches} ${plural(r.changedMatches, 'rewrite')} in ${r.filesChanged} ${plural(r.filesChanged, 'file')}${unch}`,
    )
  }
  lines.push(
    `Matched nothing: ${batch.unmatchedRules.length > 0 ? batch.unmatchedRules.map(i => `rule ${i}`).join(', ') : 'none'}.`,
  )
  if (batch.coalesced.length > 0) {
    const shown = batch.coalesced.slice(0, 20).map(c => `${c.rel}:${c.line}:${c.col} [rules ${c.ruleIndices.join(', ')}]`)
    const more = batch.coalesced.length > 20 ? `; +${batch.coalesced.length - 20} more` : ''
    lines.push(`Coalesced edits (${batch.coalesced.length}): ${shown.join('; ')}${more}.`)
  } else {
    lines.push('Coalesced edits: none.')
  }
  return lines
}

function dryRunText(scope: AstScope, plan: AstRewritePlan): string {
  const files = plan.files.length
  const batch = plan.batch
  const lines: string[] = [
    batch
      ? `Dry run — ${plan.matchCount} ${plural(plan.matchCount, 'match', 'matches')} in ${files} ${plural(files, 'file')} would change across ${batch.rules.length} ${plural(batch.rules.length, 'rule')}; nothing written.${
          plan.unchangedMatches > 0 ? ` ${plan.unchangedMatches} ${plural(plan.unchangedMatches, 'match', 'matches')} already in the rewritten form stay untouched.` : ''
        }`
      : `Dry run — ${plan.matchCount} ${plural(plan.matchCount, 'match', 'matches')} in ${files} ${plural(files, 'file')} would change; nothing written.${
          plan.unchangedMatches > 0 ? ` ${plan.unchangedMatches} ${plural(plan.unchangedMatches, 'match', 'matches')} already in the rewritten form stay untouched.` : ''
        }`,
  ]
  if (batch) lines.push(...renderBatchSummaryLines(plan))
  for (const f of plan.files) {
    if (batch) {
      const changes = batch.fileChanges.get(f.rel) ?? []
      const shown = changes.slice(0, 30).map(c => `${c.line}:${c.col} [rule${c.ruleIndices.length > 1 ? 's' : ''} ${c.ruleIndices.join('+')}]`).join(', ')
      const more = changes.length > 30 ? `, +${changes.length - 30} more` : ''
      lines.push('', `Rule attribution for ${f.rel}: ${shown}${more}`, f.diff)
    } else {
      lines.push('', f.diff)
    }
    if (f.diffOmittedLines > 0) lines.push(`(… ${f.diffOmittedLines} more diff ${plural(f.diffOmittedLines, 'line')} in ${f.rel})`)
  }
  lines.push('', `plan: ${plan.token} — write these changes with apply: true, plan: "${plan.token}" (refused if any of these files changes first).`)
  lines.push(...renderSearchTrailer(scope, plan.search), ...renderLeftOut(plan.leftOut))
  return lines.join('\n')
}

async function astEditCall(input: Input, context: ToolUseContext, parentMessage: AssistantMessage) {
  const startedAt = Date.now()
  const { scope, plan } = await planFor(input, context)
  const base = {
    pattern: input.rules ? input.rules.map(r => r.pattern).join(' ; ') : (input.pattern ?? ''),
    rewrite: input.rules ? input.rules.map(r => r.rewrite).join(' ; ') : (input.rewrite ?? ''),
    scope: scope.display,
    matchCount: plan.matchCount,
    fileCount: plan.files.length,
  }

  if (plan.files.length === 0) {
    const already = plan.unchangedMatches > 0
    const emptyScope = scope.files.length === 0
    const targetLabel = input.rules
      ? `${input.rules.length} ${plural(input.rules.length, 'rule')}`
      : JSON.stringify(input.pattern)
    const head = emptyScope
      ? `Nothing searched: no files with a supported language ${scope.singleFile ? scope.display : `under ${scope.display}`}${scope.glob ? ` matching ${scope.glob}` : ''}${scope.lang ? ` in ${scope.lang.name}` : ''} — nothing to rewrite.`
      : already
        ? `${plan.unchangedMatches} ${plural(plan.unchangedMatches, 'match', 'matches')} of ${targetLabel} already read exactly as the rewrite — nothing to write.`
        : `No matches for ${targetLabel} — nothing to rewrite.`
    const trailer = renderSearchTrailer(scope, plan.search)
    const text = [head, ...renderBatchSummaryLines(plan), ...(emptyScope ? trailer.slice(1) : trailer), ...renderLeftOut(plan.leftOut)].join('\n')
    return {
      data: { ...base, state: already ? ('no-change' as const) : ('no-matches' as const), text, changedPaths: [] } satisfies Output,
      effect: {
        outcome: 'no-change' as const,
        operation: 'ast.preview',
        changedPaths: [],
        evidence: already ? `${plan.unchangedMatches} match(es) already in the rewritten form` : `no structural matches in ${scope.files.length} file(s)`,
        startedAt,
        completedAt: Date.now(),
      },
    }
  }

  if (input.apply !== true) {
    return {
      data: {
        ...base,
        state: 'dry-run' as const,
        text: dryRunText(scope, plan),
        plan: plan.token,
        changedPaths: [],
        changeView: changeViewOf(plan, 'proposed'),
      } satisfies Output,
      effect: {
        outcome: 'succeeded' as const,
        operation: 'ast.preview',
        changedPaths: [],
        evidence: `dry run: ${plan.matchCount} match(es) in ${plan.files.length} file(s), plan ${plan.token}`,
        startedAt,
        completedAt: Date.now(),
        details: { plan: plan.token, matches: plan.matchCount, files: plan.files.length },
      },
    }
  }

  if (input.plan?.trim() !== plan.token) {
    const whatDiffered = input.rules
      ? 'a file, the rules or the scope differs from the dry run you read'
      : 'a file, the pattern, the rewrite or the scope differs from the dry run you read'
    throw new Error(
      `Plan ${input.plan} does not match the current dry run (${plan.token}): ${whatDiffered}. Nothing was written. The current dry run follows — apply it with plan: "${plan.token}" if it is what you want.\n\n${dryRunText(scope, plan)}`,
    )
  }

  const permCtx = context.getAppState().toolPermissionContext
  const denied: string[] = []
  for (const f of plan.files) {
    const decision = checkWritePermissionForTool(pathShim, { file_path: f.abs }, permCtx)
    if (decision.behavior === 'allow') continue
    if (decision.behavior === 'deny') {
      denied.push(f.rel)
      continue
    }
  }
  if (denied.length > 0) {
    const rows = denied.map(p => `  ${p} — denied by a rule`)
    throw new Error(
      `Apply refused — ${rows.length} ${plural(rows.length, 'file')} not writable:\n${rows.join('\n')}\nNothing was written (a denied path refuses the whole edit). Adjust permission rules, then apply again.`,
    )
  }
  if (context.abortController.signal.aborted) {
    throw new Error('Cancelled before writing — nothing was written.')
  }

  const owner = ownerFromToolUseContext(context)
  for (const f of plan.files) {
    if (fileHistoryEnabled()) {
      await fileHistoryTrackEdit(context.updateFileHistoryState, f.abs, parentMessage.uuid as UUID)
    }
  }

  const outcome = await runVerbatimTextCommit({
    ownerKey: owner,
    source: 'ast-edit',
    files: plan.files.map(f => ({ canonicalPath: f.abs, originalText: f.before, plannedText: f.after })),
    signal: context.abortController.signal,
  })
  switch (outcome.kind) {
    case 'stale': {
      const rels = outcome.stalePaths.map(p => plan.files.find(f => f.abs === p)?.rel ?? p)
      throw new Error(`Stale — changed since the dry run: ${rels.join(', ')}. Nothing was written. Run the dry run again and apply the new plan.`)
    }
    case 'cancelled':
      throw new Error('Cancelled before writing — nothing was written.')
    case 'in-flight':
      throw new Error(`Another live Mercury process is committing this exact change (operation ${outcome.operationId}) — nothing was written here.`)
    case 'failed-restored':
      throw new Error(
        `Apply FAILED (${outcome.reason}) — partial application is failure; every touched file was restored to its original bytes and VERIFIED by reread.`,
      )
    case 'indeterminate': {
      const rels = outcome.divergedPaths.map(p => plan.files.find(f => f.abs === p)?.rel ?? p)
      throw new Error(
        `Apply INDETERMINATE (${outcome.reason}) — the final state differs from both the plan and the original at: ${rels.join(', ')}; re-read those files before relying on them.`,
      )
    }
    case 'replayed': {
      const text = `Plan ${plan.token} was already committed — replayed the prior result without writing twice (${outcome.changedPaths.length} ${plural(outcome.changedPaths.length, 'file')}).`
      return {
        data: { ...base, state: 'no-change' as const, text, plan: plan.token, changedPaths: [], changeView: changeViewOf(plan, 'applied') } satisfies Output,
        effect: {
          outcome: 'no-change' as const,
          operation: 'file.astEdit',
          changedPaths: [],
          evidence: `replayed committed plan ${plan.token}`,
          startedAt,
          completedAt: Date.now(),
          details: { plan: plan.token, replayedOperationId: outcome.operationId },
        },
      }
    }
    case 'committed':
      break
  }

  const lspManager = getLspServerManager()
  const syncFailures: string[] = []
  const anchors = new Map<string, string>()
  for (const f of plan.files) {
    context.nestedMemoryAttachmentTriggers?.add(f.abs)
    context.readFileState.set(f.abs, {
      content: f.after,
      timestamp: getFileModificationTime(f.abs),
      offset: undefined,
      limit: undefined,
    })
    if (lspManager) {
      const sync = await syncServersAfterWrite(lspManager, f.abs, f.after, f.before, owner)
      if (!sync.ok) syncFailures.push(`${f.rel}: ${sync.reason}`)
    }
    const anchor = mintFileAnchor(f.after)
    anchors.set(f.abs, anchor)
    rememberAnchoredSnapshot(owner, anchor, f.after, f.abs)
    dropSeenLines(owner, f.abs)
  }
  if (!isEnvTruthy(flagEnv('MERCURY_BARE'))) {
    const paths = plan.files.map(f => f.abs)
    discoverSkillDirsForPaths(paths, getCwd())
      .then(dirs => (dirs.length > 0 ? addSkillDirectories(dirs) : undefined))
      .catch(passedOver)
    activateConditionalSkillsForPaths(paths, getCwd())
  }

  const withAnchors = changeTransactionEnabled()
  const rows = plan.files.map(f => {
    if (plan.batch) {
      const changes = plan.batch.fileChanges.get(f.rel) ?? []
      const ruleSet = [...new Set(changes.flatMap(c => c.ruleIndices))].sort((a, b) => a - b)
      return `  ${f.rel} — ${f.matchCount} ${plural(f.matchCount, 'rewrite')} (rule${ruleSet.length === 1 ? '' : 's'} ${ruleSet.join(', ')})${withAnchors ? ` (anchor: ${anchors.get(f.abs)})` : ''}`
    }
    return `  ${f.rel} — ${f.matchCount} ${plural(f.matchCount, 'rewrite')}${withAnchors ? ` (anchor: ${anchors.get(f.abs)})` : ''}`
  })
  const text = [
    `Applied ${plan.matchCount} structural ${plural(plan.matchCount, 'rewrite')} in ${plan.files.length} ${plural(plan.files.length, 'file')} (re-read verified):`,
    ...rows,
    ...renderBatchSummaryLines(plan),
    ...renderLeftOut(plan.leftOut),
    ...(syncFailures.length > 0
      ? [`Written and verified, but the editor/language-server sync failed for: ${syncFailures.join('; ')} — re-open those files before relying on live diagnostics.`]
      : []),
  ].join('\n')
  const effectOutcome: ToolEffectOutcome = syncFailures.length > 0 ? 'indeterminate' : 'succeeded'
  return {
    data: {
      ...base,
      state: 'applied' as const,
      text,
      plan: plan.token,
      changedPaths: outcome.changedPaths,
      changeView: changeViewOf(plan, 'applied'),
    } satisfies Output,
    effect: {
      outcome: effectOutcome,
      operation: 'file.astEdit',
      changedPaths: outcome.changedPaths,
      evidence:
        syncFailures.length > 0
          ? `wrote ${outcome.changedPaths.length} file(s), re-read verified; editor sync failed for ${syncFailures.length}`
          : `applied ${plan.matchCount} structural rewrite(s) in ${plan.files.length} file(s), re-read verified`,
      startedAt,
      completedAt: Date.now(),
      details: { plan: plan.token, matches: plan.matchCount, files: plan.files.length, operationId: outcome.operationId },
    },
  }
}

export const AstEditTool: Unbuilt = unbuilt('src/tools/AstEditTool/AstEditTool.ts:443')

