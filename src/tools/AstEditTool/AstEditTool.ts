import type { UUID } from 'node:crypto'
import { stat } from 'node:fs/promises'

import { z } from 'zod/v4'

import { buildTool, type ToolEffectOutcome, type ToolUseContext } from '../../Tool.js'
import type { InlineChangeViewData } from '../../components/InlineChangeView.js'
import { runVerbatimTextCommit } from '../../services/changeTransaction/changeSetCommit.js'
import { changeTransactionEnabled } from '../../services/changeTransaction/contracts.js'
import { dropSeenLines } from '../../services/changeTransaction/seenLines.js'
import { mintFileAnchor } from '../../services/changeTransaction/snapshotAnchor.js'
import { rememberAnchoredSnapshot } from '../../services/changeTransaction/snapshotRing.js'
import { diagnosticTracker } from '../../services/diagnosticTracking.js'
import { getLspServerManager } from '../../services/lsp/manager.js'
import { notifyVscodeFileUpdated } from '../../services/mcp/vscodeSdkMcp.js'
import { ownerFromToolUseContext } from '../../services/run/resolveOwner.js'
import { structurePolyglotEnabled } from '../../services/structure/contracts.js'
import { resolveGrammarEngineDir } from '../../services/structure/grammarFacility.js'
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
  renderSearchTrailer,
  resolveAstLanguage,
  resolveAstScope,
  type AstRewritePlan,
  type AstScope,
} from '../../utils/astPatterns.js'
import { getCwd } from '../../utils/cwd.js'
import { isEnvTruthy } from '../../utils/envUtils.js'
import { isENOENT } from '../../utils/errors.js'
import { FILE_NOT_FOUND_CWD_NOTE, findSimilarFile, getFileModificationTime, suggestPathUnderCwd } from '../../utils/file.js'
import { fileHistoryEnabled, fileHistoryTrackEdit } from '../../utils/fileHistory.js'
import { expandPath } from '../../utils/path.js'
import type { PermissionDecision } from '../../utils/permissions/PermissionResult.js'
import {
  checkReadPermissionForTool,
  checkWritePermissionForTool,
  matchingRuleForInput,
  pathInAllowedWorkingPath,
} from '../../utils/permissions/filesystem.js'
import { semanticBoolean } from '../../utils/semanticBoolean.js'
import { plural } from '../../utils/stringUtils.js'
import { syncServersAfterWrite } from '../LSPTool/mercuryOps.js'
import { AST_EDIT_TOOL_NAME, getAstEditDescription } from './prompt.js'
import {
  getToolUseSummary,
  renderToolResultMessage,
  renderToolUseErrorMessage,
  renderToolUseMessage,
  renderToolUseRejectedMessage,
} from './UI.js'

/**
 * The AstEdit tool: structural rewrites over the packaged tree-sitter
 * grammars. The dry run (the default) plans every match's rewrite, parse-
 * guards the planned output, and returns the unified diff per file plus a
 * content-addressed plan token; apply:true with that token re-plans, refuses
 * on any drift, and writes through the ONE shared journaled commit walk
 * (ordered path locks, digest revalidation, atomic staging with rollback,
 * re-read verification) after the file-history snapshot every editing tool
 * takes — so /rewind restores it like an Edit. Permissions: a dry run reads
 * (the read ladder over the scope); an apply asks like Edit does, ONE
 * aggregate decision over every target, a denied path refusing the whole
 * set.
 *
 * Gate: MERCURY_STRUCTURE_POLYGLOT (the grammar engine's own registered
 * flag). Proof: scripts/ast-tools/run-all.sh.
 */

const inputSchema = z.strictObject({
  pattern: z
    .string()
    .describe('The structural pattern to match — code in the target language with $NAME (one node) and $$$NAME (a sequence) meta-variables'),
  rewrite: z
    .string()
    .describe('The replacement, as code; $NAME and $$$NAME insert the captured source. "" deletes each matched node.'),
  path: z.string().optional().describe('Where to rewrite — a file or a directory; the current working directory when omitted.'),
  glob: z.string().optional().describe('Restrict to files matching this glob, relative to path, e.g. "**/*.ts"'),
  lang: z.string().optional().describe('Force one language instead of detecting it per file from the extension'),
  apply: semanticBoolean(z.boolean().optional()).describe(
    'Omitted or false: a dry run — the diff and a plan token, nothing written. true: write the change; needs plan from the dry run.',
  ),
  plan: z.string().optional().describe('The plan token (ae-…) the dry run returned; apply refuses when anything differs from that dry run.'),
})

type Input = z.infer<typeof inputSchema>

type Output = {
  state: 'dry-run' | 'applied' | 'no-change' | 'no-matches'
  pattern: string
  rewrite: string
  scope: string
  /** The model-facing text, built once. */
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

/** The write ladder judges each target path under this tool's name. */
const pathShim = {
  name: AST_EDIT_TOOL_NAME,
  getPath: (i: { file_path: string }) => i.file_path,
} as unknown as Parameters<typeof checkWritePermissionForTool>[0]

function scopeFor(input: Input, context: ToolUseContext): AstScope {
  const permCtx = context.getAppState().toolPermissionContext
  const scope = resolveAstScope({
    ...(input.path !== undefined && { path: expandPath(input.path) }),
    ...(input.glob !== undefined && { glob: input.glob }),
    ...(input.lang !== undefined && { lang: input.lang }),
    cwd: getCwd(),
    readable: abs => matchingRuleForInput(abs, permCtx, 'read', 'deny') === null,
  })
  if (isAstRefusal(scope)) throw new Error(scope.refused)
  scope.display = input.path === undefined || input.path === '' ? '.' : input.path
  return scope
}

/** Resolve the scope and plan the rewrite; every refusal throws with its
 *  reason (nothing is written by planning, ever). */
async function planFor(input: Input, context: ToolUseContext): Promise<{ scope: AstScope; plan: AstRewritePlan }> {
  const scope = scopeFor(input, context)
  const plan = await planAstRewrite(scope, {
    pattern: input.pattern,
    rewrite: input.rewrite,
    signal: context.abortController.signal,
  })
  if (isAstRefusal(plan)) throw new Error(plan.refused)
  if (patternRefusedEverywhere(scope, plan.search)) throw new Error(patternErrorText(input.pattern, plan.search))
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

function dryRunText(scope: AstScope, plan: AstRewritePlan): string {
  const files = plan.files.length
  const lines: string[] = [
    `Dry run — ${plan.matchCount} ${plural(plan.matchCount, 'match', 'matches')} in ${files} ${plural(files, 'file')} would change; nothing written.${
      plan.unchangedMatches > 0 ? ` ${plan.unchangedMatches} ${plural(plan.unchangedMatches, 'match', 'matches')} already in the rewritten form stay untouched.` : ''
    }`,
  ]
  for (const f of plan.files) {
    lines.push('', f.diff)
    if (f.diffOmittedLines > 0) lines.push(`(… ${f.diffOmittedLines} more diff ${plural(f.diffOmittedLines, 'line')} in ${f.rel})`)
  }
  lines.push('', `plan: ${plan.token} — write these changes with apply: true, plan: "${plan.token}" (refused if any of these files changes first).`)
  lines.push(...renderSearchTrailer(scope, plan.search))
  return lines.join('\n')
}

export const AstEditTool = buildTool({
  name: AST_EDIT_TOOL_NAME,
  strict: true,
  maxResultSizeChars: 60_000,
  searchHint: 'structural code rewrite by syntax pattern across files, dry-run diff then apply',
  capability: {
    intents: [
      'rewrite every match of a code pattern',
      'rename a function or call shape across files',
      'structural refactor with a dry-run diff',
      'delete every occurrence of a code construct',
      'codemod by syntax pattern in python go rust or typescript',
    ],
    units: ['structural-mutation', 'text-mutation'],
    class: 'mutation',
    transaction: { kind: 'file', receipts: true },
    evidence: ['change'],
    resources: ['file', 'receipt'],
    preview: true,
    cancellation: 'cooperative',
    latency: 'fast',
    gate: 'MERCURY_STRUCTURE_POLYGLOT',
    conditions: ['the packaged tree-sitter grammar engine (dist/vendor/treesitter beside the bundle, or the workspace package)'],
    proof: 'scripts/ast-tools/run-all.sh',
  },
  inputSchema,
  outputSchema,
  // Never advertise a tool that would fail to launch: the flag AND a
  // resolvable grammar engine.
  isEnabled() {
    return structurePolyglotEnabled() && resolveGrammarEngineDir().state === 'ok'
  },
  isReadOnly(input: Input) {
    return input?.apply !== true
  },
  isConcurrencySafe(input: Input) {
    return input?.apply !== true
  },
  userFacingName: () => 'Structural edit',
  getToolUseSummary,
  getActivityDescription(input: Partial<Input> | undefined): string {
    if (!input?.pattern) return 'Structural edit'
    return input.apply ? `Rewriting ${input.pattern}` : `Planning a rewrite of ${input.pattern}`
  },
  toAutoClassifierInput(input: Input): string {
    return `${input.apply ? 'apply' : 'dry run'} ${input.pattern} -> ${input.rewrite}${input.path ? ` in ${input.path}` : ''}`
  },
  getPath(input: Partial<Input> | undefined): string {
    return input?.path || getCwd()
  },
  async description(): Promise<string> {
    return getAstEditDescription()
  },
  async prompt(): Promise<string> {
    return getAstEditDescription()
  },
  async validateInput(input: Input) {
    if (input.pattern.trim() === '') {
      return { result: false as const, message: 'pattern is empty — give a structural pattern such as "oldName($$$ARGS)".', errorCode: 1 }
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
    if (input.apply === true && (input.plan === undefined || input.plan.trim() === '')) {
      return {
        result: false as const,
        message: 'apply: true needs plan — run the dry run first (the same call without apply), read the diff, then use the plan token it returned as plan.',
        errorCode: 3,
      }
    }
    if (input.apply !== true && input.plan !== undefined && input.plan.trim() !== '') {
      return {
        result: false as const,
        message: 'plan accompanies apply: true — omit it for a dry run, or use apply: true to write that plan.',
        errorCode: 4,
      }
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
          errorCode: 5,
        }
      }
    }
    return { result: true as const }
  },
  async checkPermissions(input: Input, context): Promise<PermissionDecision> {
    const permCtx = context.getAppState().toolPermissionContext
    // A dry run reads: the read ladder over the scope path.
    if (input.apply !== true) {
      return checkReadPermissionForTool(AstEditTool, input, permCtx) as PermissionDecision
    }
    // An apply writes: plan the rewrite over the CURRENT files to learn the
    // exact targets, then the write ladder per target — ONE aggregate
    // decision, a denied path refusing the whole set (the ChangeSet law).
    let planned: { scope: AstScope; plan: AstRewritePlan }
    try {
      planned = await planFor(input, context)
    } catch {
      // The call itself refuses with the typed reason — nothing to authorize.
      return { behavior: 'allow', updatedInput: input } as PermissionDecision
    }
    const targets = planned.plan.files
    // Nothing to write, or a plan token that does not name THIS plan: the
    // call refuses honestly with zero writes — no dialog is owed for it.
    if (targets.length === 0 || input.plan?.trim() !== planned.plan.token) {
      return { behavior: 'allow', updatedInput: input } as PermissionDecision
    }
    let needsAsk = false
    for (const f of targets) {
      const decision = checkWritePermissionForTool(pathShim, { file_path: f.abs }, permCtx)
      if (decision.behavior === 'deny') {
        return {
          ...decision,
          message: `Permission to edit ${f.rel} has been denied — a denied file refuses the whole structural edit (zero writes).`,
        } as PermissionDecision
      }
      if (decision.behavior !== 'allow') needsAsk = true
    }
    if (needsAsk) {
      const shown = targets.slice(0, 3).map(f => f.rel).join(', ')
      const more = targets.length > 3 ? ` and ${targets.length - 3} more` : ''
      return {
        behavior: 'ask',
        message: `Rewrite ${planned.plan.matchCount} ${plural(planned.plan.matchCount, 'match', 'matches')} of ${JSON.stringify(input.pattern)} in ${targets.length} ${plural(targets.length, 'file')} (${shown}${more})? One decision covers every file; a denied file means zero writes.`,
      } as PermissionDecision
    }
    return { behavior: 'allow', updatedInput: input } as PermissionDecision
  },
  async call(input: Input, context: ToolUseContext, _canUseTool, parentMessage) {
    const startedAt = Date.now()
    const { scope, plan } = await planFor(input, context)
    const base = {
      pattern: input.pattern,
      rewrite: input.rewrite,
      scope: scope.display,
      matchCount: plan.matchCount,
      fileCount: plan.files.length,
    }

    // No matches, or every match already in the rewritten form: an honest
    // zero with the census of what was searched.
    if (plan.files.length === 0) {
      const already = plan.unchangedMatches > 0
      const head = already
        ? `${plan.unchangedMatches} ${plural(plan.unchangedMatches, 'match', 'matches')} of ${JSON.stringify(input.pattern)} already read exactly as the rewrite — nothing to write.`
        : `No matches for ${JSON.stringify(input.pattern)} — nothing to rewrite.`
      const text = [head, ...renderSearchTrailer(scope, plan.search)].join('\n')
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

    // The dry run: the diff, the token, nothing written.
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

    // The apply: the token must name THIS plan over the CURRENT bytes.
    if (input.plan?.trim() !== plan.token) {
      throw new Error(
        `Plan ${input.plan} does not match the current dry run (${plan.token}): a file, the pattern, the rewrite or the scope differs from the dry run you read. Nothing was written. The current dry run follows — apply it with plan: "${plan.token}" if it is what you want.\n\n${dryRunText(scope, plan)}`,
      )
    }

    // Aggregate authorization backstop (the harness ask covered the set):
    // deny rules stay absolute; an ask-class path must sit inside the
    // session's write scope. ANY refused path ⇒ zero writes.
    const permCtx = context.getAppState().toolPermissionContext
    const denied: string[] = []
    const outOfScope: string[] = []
    for (const f of plan.files) {
      const decision = checkWritePermissionForTool(pathShim, { file_path: f.abs }, permCtx)
      if (decision.behavior === 'allow') continue
      if (decision.behavior === 'deny') {
        denied.push(f.rel)
        continue
      }
      if (!pathInAllowedWorkingPath(f.abs, permCtx)) outOfScope.push(f.rel)
    }
    if (denied.length > 0 || outOfScope.length > 0) {
      const rows = [
        ...denied.map(p => `  ${p} — blocked by a deny rule`),
        ...outOfScope.map(p => `  ${p} — outside the session's write scope`),
      ]
      throw new Error(
        `Apply refused — ${rows.length} ${plural(rows.length, 'file')} not writable:\n${rows.join('\n')}\nNothing was written (a refused path refuses the whole edit). Add the directory with /add-dir or adjust permission rules, then apply again.`,
      )
    }
    if (context.abortController.signal.aborted) {
      throw new Error('Cancelled before writing — nothing was written.')
    }

    // Pre-write projections for EVERY target: the diagnostics baseline and
    // the file-history snapshot (the Edit tool's own owners, reused) — the
    // /rewind restore point exists before the first byte lands.
    const owner = ownerFromToolUseContext(context)
    for (const f of plan.files) {
      await diagnosticTracker.beforeFileEdited(f.abs)
      if (fileHistoryEnabled()) {
        await fileHistoryTrackEdit(context.updateFileHistoryState, f.abs, parentMessage.uuid as UUID)
      }
    }

    // The ONE shared journaled commit walk: ordered path locks, digest
    // revalidation of every original, staged temps + the journal record,
    // compensation verified by reread.
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

    // Post-apply observation for EVERY written path: read-state refresh (the
    // next Edit sees fresh bytes), editor notification with exact
    // before/after, awaited bounded LSP didChange/didSave, a fresh anchor for
    // patch chaining; the seen-lines ledger is dropped (the honest
    // under-record — a later anchored edit re-reads).
    const lspManager = getLspServerManager()
    const syncFailures: string[] = []
    const anchors = new Map<string, string>()
    for (const f of plan.files) {
      context.readFileState.set(f.abs, {
        content: f.after,
        timestamp: getFileModificationTime(f.abs),
        offset: undefined,
        limit: undefined,
      })
      notifyVscodeFileUpdated(f.abs, f.before, f.after)
      if (lspManager) {
        const sync = await syncServersAfterWrite(lspManager, f.abs, f.after)
        if (!sync.ok) syncFailures.push(`${f.rel}: ${sync.reason}`)
      }
      const anchor = mintFileAnchor(f.after)
      anchors.set(f.abs, anchor)
      rememberAnchoredSnapshot(owner, anchor, f.after, f.abs)
      dropSeenLines(owner, f.abs)
    }
    if (!isEnvTruthy(process.env.MERCURY_SIMPLE)) {
      const paths = plan.files.map(f => f.abs)
      discoverSkillDirsForPaths(paths, getCwd())
        .then(dirs => (dirs.length > 0 ? addSkillDirectories(dirs) : undefined))
        .catch(() => {})
      activateConditionalSkillsForPaths(paths, getCwd())
    }

    const withAnchors = changeTransactionEnabled()
    const rows = plan.files.map(
      f => `  ${f.rel} — ${f.matchCount} ${plural(f.matchCount, 'rewrite')}${withAnchors ? ` (anchor: ${anchors.get(f.abs)})` : ''}`,
    )
    const text = [
      `Applied ${plan.matchCount} structural ${plural(plan.matchCount, 'rewrite')} in ${plan.files.length} ${plural(plan.files.length, 'file')} (re-read verified):`,
      ...rows,
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
  },
  mapToolResultToToolResultBlockParam(data: Output, toolUseID: string) {
    return { tool_use_id: toolUseID, type: 'tool_result' as const, content: data.text }
  },
  extractSearchText(data: Output): string {
    return data.text
  },
  renderToolUseMessage,
  renderToolResultMessage,
  renderToolUseRejectedMessage,
  renderToolUseErrorMessage,
})

export type { Output as AstEditOutput }
