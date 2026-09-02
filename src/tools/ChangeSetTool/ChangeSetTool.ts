// ============================================================================
//  ChangeSet tool — atomic multi-file text change sets.
//
//  ONE compact model-authored call prepares, reviews, and applies an anchored
//  text change spanning several EXISTING files:
//    preview + changes            → immutable content-addressed plan (writes
//                                   NOTHING; the operator-review path);
//    apply + changes              → the fast one-call path: plan, ONE
//                                   aggregate decision, apply;
//    apply + plan_id              → apply a previewed plan (stale plans
//                                   refuse with current anchors);
//    status/discard + plan_id     → inspect / retire a plan.
//
//  The write mechanics live in the ONE shared change-set core
//  (services/changeTransaction/changeSetCommit.ts): ordered path locks,
//  recovery bundle + durable staging + the text-change-set journal record
//  before the first commit, digest-guarded compensation verified by reread,
//  idempotent recovery, committed-plan replay. This tool owns the model
//  surface, the aggregate decision, notifications, and the ONE effect/
//  receipt/transaction/card per executed set.
//
//  Gate: MERCURY_CHANGESET (default-ON, registered; composes with
//  MERCURY_CHANGE_RECEIPTS + MERCURY_EDIT_HUNKS).
//  Proofs: scripts/changesets/.
// ============================================================================

import { z } from 'zod/v4'
import { changeViewSearchText } from '../StructureTool/StructureTool.js'
import { relative } from 'node:path'
import { existsSync, readFileSync } from 'node:fs'
import { buildTool, type ChangeIntentProjection, type ToolEffectOutcome, type ToolUseContext } from '../../Tool.js'
import type { InlineChangeViewData } from '../../components/InlineChangeView.js'
import {
  ANCHOR_PATCH_TEACHING,
  anchorPatchEnabled,
  parseAnchorPatch,
} from '../../services/changeTransaction/anchorPatch.js'
import {
  lowerAnchorPatch,
  type LoweredPatch,
} from '../../services/changeTransaction/anchorPatchLower.js'
import {
  CHANGESET_BOUNDS,
  changeSetEnabled,
  type ChangeSetMemberInput,
  type ChangeSetPlan,
  type ChangeSetTargetBytes,
} from '../../services/changeTransaction/changeSetContracts.js'
import { publishPatchRegister } from '../../services/changeTransaction/patchRegisters.js'
import {
  checkSeenLines,
  dropSeenLines,
  fileGeneration,
  moveSeenLines,
  shiftSeenLinesAfterApply,
} from '../../services/changeTransaction/seenLines.js'
import { rememberAnchoredSnapshot } from '../../services/changeTransaction/snapshotRing.js'
import {
  formatChangeSetRefusal,
  planChangeSet,
  plannedDiskBytes,
  sha256Hex,
} from '../../services/changeTransaction/changeSetPlan.js'
import {
  runTextChangeSetCommit,
  type CommitTarget,
} from '../../services/changeTransaction/changeSetCommit.js'
import {
  changeSetPlanEvicted,
  changeSetPlanExpired,
  getChangeSetPlan,
  rememberChangeSetPlan,
  setChangeSetPlanState,
} from '../../services/changeTransaction/changeSetStore.js'
import {
  recordNoChangeOutcome,
  type RepetitionVerdict,
} from '../../services/changeTransaction/repetitionPolicy.js'
import { mintFileAnchor } from '../../services/changeTransaction/snapshotAnchor.js'
import { diagnosticTracker } from '../../services/diagnosticTracking.js'
import { getLspServerManager } from '../../services/lsp/manager.js'
import { notifyVscodeFileUpdated } from '../../services/mcp/vscodeSdkMcp.js'
import { ownerFromToolUseContext } from '../../services/run/resolveOwner.js'
import {
  activateConditionalSkillsForPaths,
  addSkillDirectories,
  discoverSkillDirsForPaths,
} from '../../skills/loadSkillsDir.js'
import { syncServersAfterWrite } from '../LSPTool/mercuryOps.js'
import { getCwd } from '../../utils/cwd.js'
import { isEnvTruthy } from '../../utils/envUtils.js'
import { getFileModificationTime } from '../../utils/file.js'
import {
  fileHistoryEnabled,
  fileHistoryTrackEdit,
} from '../../utils/fileHistory.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { expandPath } from '../../utils/path.js'
import { checkWritePermissionForTool, pathInAllowedWorkingPath } from '../../utils/permissions/filesystem.js'
import type { PermissionDecision } from '../../utils/permissions/PermissionResult.js'
import {
  renderToolResultMessage,
  renderToolUseErrorMessage,
  renderToolUseMessage,
  renderToolUseRejectedMessage,
  userFacingName,
} from './UI.js'

export const CHANGESET_TOOL_NAME = 'ChangeSet'

const OPS = ['preview', 'apply', 'status', 'discard'] as const

const baseShape = () => ({
  op: z.enum(OPS).describe('The change-set operation'),
  changes: z
    .array(
      z.strictObject({
        file_path: z.string().describe('Absolute path to an EXISTING text file'),
        expected_anchor: z
          .string()
          .describe('REQUIRED staleness anchor from a prior Read of this file (the "(anchor: …)" value)'),
        hunks: z
          .array(
            z.strictObject({
              lines: z
                .string()
                .describe('1-based original line ("12") or inclusive range ("12-18") of the anchored snapshot'),
              replace: z
                .string()
                .describe('Replacement body ("" deletes the range; with insert, the inserted body)'),
              insert: z
                .enum(['before', 'after'])
                .optional()
                .describe('Insert relative to the single anchor line instead of replacing it'),
            }),
          )
          .min(1)
          .describe('Disjoint line-addressed hunks against the anchored snapshot (the Edit hunk vocabulary)'),
      }),
    )
    .optional()
    .describe('preview / apply: the file members (one per existing text file)'),
  plan_id: z
    .string()
    .optional()
    .describe('apply / status / discard: a plan id (cs-…) from a prior preview'),
})

/** The widest (patch-capable) shape — the static type derives from this;
 *  the runtime schema narrows when the dialect gate is off (strictly more
 *  restrictive, so every accepted value inhabits the wide type). */
const widestSchemaFactory = () =>
  z.strictObject({
    ...baseShape(),
    patch: z
      .string()
      .optional()
      .describe(
        'preview / apply: ONE anchored patch string instead of changes[] — file sections with replace/insert/delete/cut/paste/move-to/delete-file ops over the "(anchor: …)" values from Read (the dialect is spelled out in the tool description)',
      ),
  })

type WidestSchema = ReturnType<typeof widestSchemaFactory>

const inputSchema = lazySchema((): WidestSchema => {
  if (!anchorPatchEnabled()) return z.strictObject(baseShape()) as unknown as WidestSchema
  return widestSchemaFactory()
})

type SchemaType = WidestSchema
export type Input = z.infer<SchemaType>
export type Output = {
  op: Input['op']
  result: string
  outcome: ToolEffectOutcome
  planId?: string
  changeView?: InlineChangeViewData
  /** bounded-repetition ceiling — the model sees a tool error
   *  while the internal outcome stays a truthful no-change. */
  repetitionStop?: boolean
}

// ── helpers ─────────────────────────────────────────────────────────────────

/** Per-path shim for the estate write-permission owner (deny rules ·
 *  safety checks · implement mode · allow rules — one path at a time). */
const pathShim = {
  name: CHANGESET_TOOL_NAME,
  getPath: (i: { file_path: string }) => i.file_path,
} as unknown as Parameters<typeof checkWritePermissionForTool>[0]

// the scope predicate IS Write/Edit's pathInAllowedWorkingPath —
// the hand-rolled copy here rooted on the LIVE cwd, joined with '/', and
// skipped symlink symmetry, so on Windows a file in the session's PRIMARY
// working directory read out-of-scope (backslash paths never matched the
// '/'-joined prefix) while Write/Edit operated freely. One predicate, three
// tools — divergence closed.
function isWithinWriteScope(
  abs: string,
  permCtx: Parameters<typeof pathInAllowedWorkingPath>[1],
): boolean {
  return pathInAllowedWorkingPath(abs, permCtx)
}

function displayPath(abs: string): string {
  const rel = relative(getCwd(), abs)
  return rel.startsWith('..') ? abs : rel
}

function changeViewOf(
  plan: ChangeSetPlan,
  state: InlineChangeViewData['state'],
  opts: { nextAction?: string; refs?: string[]; now?: number } = {},
): InlineChangeViewData {
  const now = opts.now ?? Date.now()
  return {
    state,
    action: 'changeset',
    files: plan.targets
      .filter(t => t.changed)
      .map(t => ({
        file: targetLabel(t),
        hunks: t.diff.hunks,
        ...(t.diff.omittedHunks > 0 ? { omittedHunks: t.diff.omittedHunks } : {}),
        changedLines: t.diff.hunks.reduce((n, h) => n + h.lines.length, 0),
      })),
    hunkCount: plan.totalHunks,
    ...(plan.noChangePaths.length > 0 ? { noChangePaths: plan.noChangePaths.map(displayPath) } : {}),
    planMeta: {
      id: plan.id,
      digest12: plan.digest.slice(0, 12),
      ageMs: Math.max(0, now - plan.createdAt),
      expiresInMs: plan.expiresAt - now,
    },
    refs: opts.refs ?? [],
    ...(opts.nextAction ? { nextAction: opts.nextAction } : {}),
  }
}

function intentOf(plan: ChangeSetPlan): ChangeIntentProjection {
  return {
    targetPaths: plan.targets.map(t => t.canonicalPath),
    targetVersions: plan.targets.map(t => ({ path: t.canonicalPath, version: t.expectedAnchor })),
  }
}

interface OpResult {
  op: Input['op']
  result: string
  outcome: ToolEffectOutcome
  planId?: string
  changeView?: InlineChangeViewData
  effectOperation: string
  changedPaths: string[]
  details?: Record<string, unknown>
  intent?: ChangeIntentProjection
  /** bounded-repetition ceiling on a no-change apply. */
  repetitionStop?: boolean
}

function planContext(
  context: ToolUseContext,
  lowered?: LoweredPatch,
): Parameters<typeof planChangeSet>[1] {
  const owner = ownerFromToolUseContext(context)
  const permCtx = context.getAppState().toolPermissionContext
  return {
    ownerKey: owner,
    readEvidence: (canonicalPath: string, requestedPath: string) => {
      const entry =
        context.readFileState.get(canonicalPath) ??
        context.readFileState.get(expandPath(requestedPath))
      if (!entry || entry.isPartialView) {
        return {
          ok: false as const,
          message: 'file has not been read (fully) this session — Read it first, then carry its anchor',
        }
      }
      return { ok: true as const }
    },
    scopeCheck: (canonicalPath: string) => {
      const decision = checkWritePermissionForTool(pathShim, { file_path: canonicalPath }, permCtx)
      if (decision.behavior === 'deny') return 'blocked by a permission deny rule'
      if (decision.behavior === 'allow') return null
      return isWithinWriteScope(canonicalPath, permCtx)
        ? null
        : "outside the session's write scope — add the directory with /add-dir (or an explicit allow rule)"
    },
    // The patch path sharpens read evidence to the per-line ledger: an edit
    // into never-displayed lines refuses with the smallest re-read hint.
    // Recovered members are exempt — their relocation proof (byte-identical
    // moved windows) IS the sight evidence for those exact lines.
    ...(lowered
      ? {
          seenLinesCheck: (
            target: { canonicalPath: string; requestedPath: string },
            spans: Parameters<typeof checkSeenLines>[3],
          ) => {
            const meta = lowered.memberMeta.get(target.requestedPath)
            if (meta?.recovered) return { ok: true as const }
            const generation =
              fileGeneration(target.canonicalPath) ?? fileGeneration(target.requestedPath)
            if (generation === null) return { ok: true as const }
            const verdict = checkSeenLines(
              owner,
              target.canonicalPath,
              generation,
              spans,
              displayPath(target.canonicalPath),
            )
            if (verdict.ok) return { ok: true as const }
            const fallback = checkSeenLines(
              owner,
              expandPath(target.requestedPath),
              generation,
              spans,
              displayPath(target.canonicalPath),
            )
            if (fallback.ok) return { ok: true as const }
            return { ok: false as const, message: verdict.hint }
          },
        }
      : {}),
  }
}

// ── patch-input resolution (the dialect in front of the planner) ────────────

/** Lowered patch state stashed per plan id so a previewed patch applied
 *  later still publishes its registers and shifts its ledger. Bounded by
 *  the plan ring's own size. */
const loweredByPlanId = new Map<string, LoweredPatch>()
function stashLowered(planId: string, lowered: LoweredPatch): void {
  loweredByPlanId.delete(planId)
  loweredByPlanId.set(planId, lowered)
  while (loweredByPlanId.size > CHANGESET_BOUNDS.planRing * 2) {
    const oldest = loweredByPlanId.keys().next().value as string | undefined
    if (oldest === undefined) break
    loweredByPlanId.delete(oldest)
  }
}

function resolvePatchInput(
  patchText: string,
  context: ToolUseContext,
): { lowered: LoweredPatch } | { error: string } {
  if (!anchorPatchEnabled()) {
    return { error: 'the patch dialect is not enabled (MERCURY_ANCHOR_PATCH) — use changes[]' }
  }
  const parsed = parseAnchorPatch(patchText)
  if (!parsed.ok) {
    return {
      error: `patch parse failed [${parsed.code}] at line ${parsed.line}: ${parsed.message}`,
    }
  }
  const owner = ownerFromToolUseContext(context)
  const lowered = lowerAnchorPatch(parsed, owner)
  if (!lowered.ok) {
    return { error: `patch rejected [${lowered.code}]: ${lowered.message}` }
  }
  return { lowered }
}

/** Re-derive commit bytes for a stored plan against CURRENT disk. Returns
 *  the stale set when any target drifted from the plan's original digest. */
function rederiveBytes(plan: ChangeSetPlan): { bytes: Map<string, ChangeSetTargetBytes> } | { stalePaths: string[] } {
  const bytes = new Map<string, ChangeSetTargetBytes>()
  const stalePaths: string[] = []
  for (const t of plan.targets) {
    let raw: Buffer | null = null
    try {
      raw = readFileSync(t.canonicalPath)
    } catch {
      raw = null
    }
    if (raw === null || sha256Hex(raw) !== t.originalDigest) {
      stalePaths.push(t.canonicalPath)
      continue
    }
    // A stored move must still find its landing pad free.
    if (t.fileOp === 'move' && t.newPath !== undefined && existsSync(t.newPath)) {
      stalePaths.push(t.newPath)
      continue
    }
    bytes.set(t.canonicalPath, {
      canonicalPath: t.canonicalPath,
      originalBytes: raw,
      plannedBytes:
        t.fileOp === 'delete'
          ? Buffer.alloc(0)
          : plannedDiskBytes(t.plannedContent, t.encoding, t.lineEndings),
    })
  }
  if (stalePaths.length > 0) return { stalePaths }
  return { bytes }
}

function staleRefusalText(plan: ChangeSetPlan, stalePaths: string[]): string {
  const lines = [
    `Stale plan ${plan.id} — ${stalePaths.length} file(s) changed since the plan was made. Nothing was written.`,
  ]
  for (const p of stalePaths) {
    let current = ''
    try {
      current = mintFileAnchor(readFileSync(p, 'utf8').replaceAll('\r\n', '\n'))
    } catch {
      current = 'unreadable'
    }
    lines.push(`  ${displayPath(p)}: current anchor ${current} — re-read this file`)
  }
  lines.push('Re-read the drifted files, then re-plan with op:"preview" (plans are immutable).')
  return lines.join('\n')
}

// ── op implementations ──────────────────────────────────────────────────────

/** One target's display line ('a.ts', 'a.ts → b.ts (move)', 'a.ts (delete)'). */
function targetLabel(t: ChangeSetPlan['targets'][number]): string {
  if (t.fileOp === 'move' && t.newPath !== undefined) {
    return `${displayPath(t.canonicalPath)} → ${displayPath(t.newPath)} (move)`
  }
  if (t.fileOp === 'delete') return `${displayPath(t.canonicalPath)} (delete)`
  return displayPath(t.canonicalPath)
}

/** Patch-mode extras for a result body: repair/recovery warnings + block
 *  resolution notes, each bounded. */
function loweredNotes(lowered: LoweredPatch | undefined): string[] {
  if (!lowered) return []
  const lines: string[] = []
  for (const w of lowered.warnings.slice(0, 12)) lines.push(`note: ${w}`)
  for (const [path, meta] of lowered.memberMeta) {
    for (const n of meta.blockNotes.slice(0, 8)) lines.push(`note: ${displayPath(path)}: ${n}`)
  }
  return lines
}

function runPreview(input: Input, context: ToolUseContext): OpResult {
  const owner = ownerFromToolUseContext(context)
  let members = input.changes as ChangeSetMemberInput[]
  let lowered: LoweredPatch | undefined
  if (input.patch !== undefined) {
    const resolved = resolvePatchInput(input.patch, context)
    if ('error' in resolved) {
      return {
        op: 'preview',
        result: `${resolved.error}\nNothing was written.`,
        outcome: 'failed',
        effectOperation: 'changeset.preview',
        changedPaths: [],
      }
    }
    lowered = resolved.lowered
    members = lowered.members
  }
  const planned = planChangeSet(members, planContext(context, lowered))
  if (!planned.ok) {
    return {
      op: 'preview',
      result: formatChangeSetRefusal(planned),
      outcome: 'failed',
      effectOperation: 'changeset.preview',
      changedPaths: [],
    }
  }
  const { plan } = planned
  rememberChangeSetPlan(owner, plan)
  if (lowered) stashLowered(plan.id, lowered)
  const mins = Math.round(CHANGESET_BOUNDS.planTtlMs / 60_000)
  const lines = [
    `Prepared plan ${plan.id} (digest ${plan.digest.slice(0, 12)}) — ${plan.changedPaths.length} file(s) to change, ${plan.totalHunks} hunk(s).`,
    ...plan.targets.filter(t => t.changed).map(t => `  ${targetLabel(t)}`),
    ...(plan.noChangePaths.length > 0
      ? [`already satisfied (will not be written): ${plan.noChangePaths.map(displayPath).join(', ')}`]
      : []),
    ...loweredNotes(lowered),
    `Nothing was written. Apply with { op: "apply", plan_id: "${plan.id}" } within ${mins} minutes; the plan refuses if any file drifts.`,
  ]
  return {
    op: 'preview',
    result: lines.join('\n'),
    outcome: 'no-change',
    planId: plan.id,
    changeView: changeViewOf(plan, 'prepared'),
    effectOperation: 'changeset.preview',
    changedPaths: [],
    details: { planId: plan.id, planDigest: plan.digest.slice(0, 12), files: plan.targets.length, hunks: plan.totalHunks },
  }
}

async function runApply(
  input: Input,
  context: ToolUseContext,
  parentMessageUuid: string,
): Promise<OpResult> {
  const owner = ownerFromToolUseContext(context)
  const permCtx = context.getAppState().toolPermissionContext

  // 1. Resolve the plan + exact bytes.
  let plan: ChangeSetPlan
  let bytes: Map<string, ChangeSetTargetBytes>
  let lowered: LoweredPatch | undefined
  if (input.changes !== undefined || input.patch !== undefined) {
    let members = input.changes as ChangeSetMemberInput[]
    if (input.patch !== undefined) {
      const resolved = resolvePatchInput(input.patch, context)
      if ('error' in resolved) {
        return {
          op: 'apply',
          result: `${resolved.error}\nNothing was written.`,
          outcome: 'failed',
          effectOperation: 'file.changeSet',
          changedPaths: [],
        }
      }
      lowered = resolved.lowered
      members = lowered.members
    }
    const planned = planChangeSet(members, planContext(context, lowered))
    if (!planned.ok) {
      return {
        op: 'apply',
        result: formatChangeSetRefusal(planned),
        outcome: 'failed',
        effectOperation: 'file.changeSet',
        changedPaths: [],
      }
    }
    plan = planned.plan
    bytes = planned.bytes
    rememberChangeSetPlan(owner, plan)
    if (lowered) stashLowered(plan.id, lowered)
  } else {
    const id = input.plan_id!
    const stored = getChangeSetPlan(owner, id)
    if (!stored) {
      const wasEvicted = changeSetPlanEvicted(owner, id)
      return {
        op: 'apply',
        result: wasEvicted
          ? `Plan ${id} expired from the bounded plan ring (${CHANGESET_BOUNDS.planRing} retained) — re-plan with op:"preview". Nothing was written.`
          : `No plan '${id}' in this conversation — plan ids come from op:"preview". Nothing was written.`,
        outcome: 'failed',
        effectOperation: 'file.changeSet',
        changedPaths: [],
      }
    }
    if (stored.ownerKey !== owner) {
      return {
        op: 'apply',
        result: `Plan ${id} belongs to a different owner — plans never cross conversations. Re-plan with op:"preview". Nothing was written.`,
        outcome: 'failed',
        effectOperation: 'file.changeSet',
        changedPaths: [],
      }
    }
    if (stored.state === 'discarded') {
      return {
        op: 'apply',
        result: `Plan ${id} was discarded — re-plan with op:"preview". Nothing was written.`,
        outcome: 'failed',
        effectOperation: 'file.changeSet',
        changedPaths: [],
      }
    }
    if (changeSetPlanExpired(stored)) {
      setChangeSetPlanState(owner, id, 'expired')
      return {
        op: 'apply',
        result: `Plan ${id} expired (${Math.round(CHANGESET_BOUNDS.planTtlMs / 60_000)} minute lifetime) — re-read the files and re-plan with op:"preview". Nothing was written.`,
        outcome: 'failed',
        planId: id,
        changeView: changeViewOf(stored, 'expired', {
          nextAction: 're-read the files, then op:"preview" again (plans are immutable)',
        }),
        effectOperation: 'file.changeSet',
        changedPaths: [],
      }
    }
    if (stored.state === 'applied') {
      // Committed-plan replay: report the prior terminal result WITHOUT a
      // second write — but only while disk still holds the planned bytes.
      const drifted: string[] = []
      for (const t of stored.targets.filter(x => x.changed)) {
        let ok = false
        try {
          ok = sha256Hex(readFileSync(t.canonicalPath)) === t.plannedDigest
        } catch {
          ok = false
        }
        if (!ok) drifted.push(t.canonicalPath)
      }
      if (drifted.length > 0) {
        return {
          op: 'apply',
          result:
            `Plan ${id} was already applied, and ${drifted.length} file(s) have since changed again ` +
            `(${drifted.map(displayPath).join(', ')}). Nothing was written. Re-read and re-plan with op:"preview".`,
          outcome: 'failed',
          planId: id,
          effectOperation: 'file.changeSet',
          changedPaths: [],
          intent: intentOf(stored),
        }
      }
      return {
        op: 'apply',
        result: `Plan ${id} was already committed — replayed the prior result without writing twice (files: ${stored.changedPaths.map(displayPath).join(', ')}; still verified on disk).`,
        outcome: 'no-change',
        planId: id,
        changeView: changeViewOf(stored, 'applied'),
        effectOperation: 'file.changeSet',
        changedPaths: [],
        details: {
          planId: id,
          ...(stored.operationId !== undefined && { replayedOperationId: stored.operationId }),
          priorChangedPaths: stored.changedPaths,
        },
        intent: intentOf(stored),
      }
    }
    if (stored.state === 'stale' || stored.state === 'failed' || stored.state === 'cancelled' || stored.state === 'indeterminate') {
      return {
        op: 'apply',
        result: `Plan ${id} is '${stored.state}'${stored.note ? ` — ${stored.note}` : ''}. Re-read the files and re-plan with op:"preview". Nothing was written.`,
        outcome: 'failed',
        planId: id,
        effectOperation: 'file.changeSet',
        changedPaths: [],
      }
    }
    lowered = loweredByPlanId.get(id)
    const derived = rederiveBytes(stored)
    if ('stalePaths' in derived) {
      setChangeSetPlanState(owner, id, 'stale', {
        note: `drifted since preview: ${derived.stalePaths.map(displayPath).join(', ')}`,
      })
      return {
        op: 'apply',
        result: staleRefusalText(stored, derived.stalePaths),
        outcome: 'failed',
        planId: id,
        changeView: changeViewOf(stored, 'stale', {
          nextAction: `re-read ${derived.stalePaths.map(displayPath).join(', ')}, then op:"preview" again`,
        }),
        effectOperation: 'file.changeSet',
        changedPaths: [],
        intent: intentOf(stored),
      }
    }
    plan = stored
    bytes = derived.bytes
  }

  const changedTargets = plan.targets.filter(t => t.changed)

  // 2. All-satisfied ⇒ ONE truthful no-change effect: empty changedPaths,
  //    noChangePaths named, ZERO filesystem writes, ZERO notifications.
  // the set-level no-change joins the bounded repetition
  //    policy — one observation per member, the plan digest IS the
  //    deterministically serialized intent; the set's verdict is the MIN
  //    member streak (every member must have repeated identically). The
  //    committed-plan replay stays OUT — its result already self-names.
  if (changedTargets.length === 0) {
    setChangeSetPlanState(owner, plan.id, 'no-change')
    let verdict: RepetitionVerdict | null = null
    for (const t of plan.targets) {
      const v = recordNoChangeOutcome(owner, {
        operation: 'file.changeSet',
        path: t.canonicalPath,
        revision: t.observedAnchor,
        intentDigest: plan.digest.slice(0, 16),
        displayPath: displayPath(t.canonicalPath),
      })
      if (verdict === null || v.streak < verdict.streak) verdict = v
    }
    const repetitionNote =
      verdict && verdict.streak >= 2 ? ` ${verdict.guidance}` : ''
    return {
      op: 'apply',
      result: `No changes needed — every member of plan ${plan.id} is already satisfied (${plan.noChangePaths.map(displayPath).join(', ')}). Nothing was written.${repetitionNote}`,
      outcome: 'no-change',
      planId: plan.id,
      changeView: changeViewOf(plan, 'no-change'),
      effectOperation: 'file.changeSet',
      changedPaths: [],
      ...(verdict?.atCeiling ? { repetitionStop: true } : {}),
      details: {
        planId: plan.id,
        planDigest: plan.digest.slice(0, 12),
        files: plan.targets.length,
        hunks: plan.totalHunks,
        noChangePaths: plan.noChangePaths,
      },
      intent: intentOf(plan),
    }
  }

  // 3. Aggregate authorization backstop (the LSP policy): the harness ask
  //    covered the set; deny rules stay absolute, an 'ask' backstop write
  //    stays inside the session's write scope. ANY refused path ⇒ zero writes.
  const denied: string[] = []
  const outOfScope: string[] = []
  for (const t of changedTargets) {
    const decision = checkWritePermissionForTool(pathShim, { file_path: t.canonicalPath }, permCtx)
    if (decision.behavior === 'allow') continue
    if (decision.behavior === 'deny') {
      denied.push(t.canonicalPath)
      continue
    }
    if (!isWithinWriteScope(t.canonicalPath, permCtx)) outOfScope.push(t.canonicalPath)
  }
  if (denied.length > 0 || outOfScope.length > 0) {
    const lines = [
      ...denied.map(p => `  ${displayPath(p)} — blocked by a deny rule`),
      ...outOfScope.map(p => `  ${displayPath(p)} — outside the session's write scope`),
    ]
    return {
      op: 'apply',
      result:
        `Apply refused — ${lines.length} file(s) not writable:\n${lines.join('\n')}\n` +
        'Nothing was written (a denied path refuses the WHOLE set). Add the directory with /add-dir or adjust permission rules, then re-apply.',
      outcome: 'failed',
      planId: plan.id,
      effectOperation: 'file.changeSet',
      changedPaths: [],
      intent: intentOf(plan),
    }
  }

  if (context.abortController?.signal.aborted) {
    setChangeSetPlanState(owner, plan.id, 'cancelled', { note: 'cancelled before commit' })
    return {
      op: 'apply',
      result: 'Cancelled before commit — nothing was written.',
      outcome: 'failed',
      planId: plan.id,
      effectOperation: 'file.changeSet',
      changedPaths: [],
      intent: intentOf(plan),
    }
  }

  // 4. Pre-write projections: diagnostics baseline + file-history backups
  //    for every changed target (the FileEdit owners, reused).
  for (const t of changedTargets) {
    await diagnosticTracker.beforeFileEdited(t.canonicalPath)
    if (fileHistoryEnabled()) {
      await fileHistoryTrackEdit(
        context.updateFileHistoryState,
        t.canonicalPath,
        parentMessageUuid as never,
      )
    }
  }

  // 5. The shared journaled commit walk. A move is a delete at the old path
  //    plus a create at the new one, inside the SAME walk.
  const commitTargets: CommitTarget[] = changedTargets.flatMap(t => {
    const b = bytes.get(t.canonicalPath)!
    if (t.fileOp === 'delete') {
      return [
        {
          canonicalPath: t.canonicalPath,
          originalDigest: t.originalDigest,
          plannedDigest: t.plannedDigest,
          originalBytes: b.originalBytes,
          plannedBytes: Buffer.alloc(0),
          mode: t.mode,
          kind: 'delete' as const,
        },
      ]
    }
    if (t.fileOp === 'move' && t.newPath !== undefined) {
      return [
        {
          canonicalPath: t.canonicalPath,
          originalDigest: t.originalDigest,
          plannedDigest: sha256Hex(Buffer.alloc(0)),
          originalBytes: b.originalBytes,
          plannedBytes: Buffer.alloc(0),
          mode: t.mode,
          kind: 'delete' as const,
        },
        {
          canonicalPath: t.newPath,
          originalDigest: sha256Hex(Buffer.alloc(0)),
          plannedDigest: t.plannedDigest,
          originalBytes: Buffer.alloc(0),
          plannedBytes: b.plannedBytes,
          mode: t.mode,
          kind: 'create' as const,
        },
      ]
    }
    return [
      {
        canonicalPath: t.canonicalPath,
        originalDigest: t.originalDigest,
        plannedDigest: t.plannedDigest,
        originalBytes: b.originalBytes,
        plannedBytes: b.plannedBytes,
        mode: t.mode,
      },
    ]
  })
  const outcome = await runTextChangeSetCommit({
    ownerKey: owner,
    source: 'changeset',
    planDigest: plan.digest,
    targets: commitTargets,
    signal: context.abortController?.signal,
  })

  // 6. Terminal classification → ONE effect.
  switch (outcome.kind) {
    case 'stale': {
      setChangeSetPlanState(owner, plan.id, 'stale', {
        note: `drifted at commit: ${outcome.stalePaths.map(displayPath).join(', ')}`,
      })
      return {
        op: 'apply',
        result: staleRefusalText(plan, outcome.stalePaths),
        outcome: 'failed',
        planId: plan.id,
        changeView: changeViewOf(plan, 'stale', {
          nextAction: `re-read ${outcome.stalePaths.map(displayPath).join(', ')}, then op:"preview" again`,
        }),
        effectOperation: 'file.changeSet',
        changedPaths: [],
        intent: intentOf(plan),
      }
    }
    case 'cancelled': {
      setChangeSetPlanState(owner, plan.id, 'cancelled', { note: 'cancelled before commit' })
      return {
        op: 'apply',
        result: 'Cancelled before commit — nothing was written.',
        outcome: 'failed',
        planId: plan.id,
        effectOperation: 'file.changeSet',
        changedPaths: [],
        intent: intentOf(plan),
      }
    }
    case 'in-flight': {
      return {
        op: 'apply',
        result: `Another live Mercury process is applying this exact plan right now (operation ${outcome.operationId}). Nothing was written here — wait for it to settle, then op:"status".`,
        outcome: 'failed',
        planId: plan.id,
        effectOperation: 'file.changeSet',
        changedPaths: [],
        intent: intentOf(plan),
      }
    }
    case 'failed-restored': {
      setChangeSetPlanState(owner, plan.id, 'failed', { note: outcome.reason })
      return {
        op: 'apply',
        result: `Apply FAILED — ${outcome.reason}. Every written path was restored to its original bytes and verified by reread; the working tree is unchanged.`,
        outcome: 'failed',
        planId: plan.id,
        changeView: changeViewOf(plan, 'failed', { nextAction: 'inspect the failure, then re-apply or re-plan' }),
        effectOperation: 'file.changeSet',
        changedPaths: [],
        intent: intentOf(plan),
      }
    }
    case 'indeterminate': {
      setChangeSetPlanState(owner, plan.id, 'indeterminate', { note: outcome.reason })
      return {
        op: 'apply',
        result:
          `Apply INDETERMINATE — ${outcome.reason}.\n` +
          `Final state differs from both plan and original at: ${outcome.divergedPaths.map(displayPath).join(', ')}.\n` +
          (outcome.landedPaths.length > 0
            ? `Landed as planned: ${outcome.landedPaths.map(displayPath).join(', ')}.\n`
            : '') +
          'Re-read the named files before relying on their content; the recovery bundle is retained.',
        outcome: 'indeterminate',
        planId: plan.id,
        changeView: changeViewOf(plan, 'indeterminate', {
          nextAction: `re-read ${outcome.divergedPaths.map(displayPath).join(', ')} and settle by hand`,
        }),
        effectOperation: 'file.changeSet',
        changedPaths: outcome.landedPaths,
        details: { planId: plan.id, divergedPaths: outcome.divergedPaths },
        intent: intentOf(plan),
      }
    }
    case 'replayed': {
      return {
        op: 'apply',
        result: `Plan ${plan.id} was already committed — replayed the prior result without writing twice (files: ${outcome.changedPaths.map(displayPath).join(', ')}).`,
        outcome: 'no-change',
        planId: plan.id,
        changeView: changeViewOf(plan, 'applied'),
        effectOperation: 'file.changeSet',
        changedPaths: [],
        details: { planId: plan.id, replayedOperationId: outcome.operationId, priorChangedPaths: outcome.changedPaths },
        intent: intentOf(plan),
      }
    }
    case 'committed':
      break
  }

  // 7. Post-apply observation for EVERY changed path: read-state refresh,
  //    editor notification with exact before/after, awaited bounded LSP
  //    didChange/didSave. A sync failure/timeout downgrades the effect to
  //    INDETERMINATE with the exact written paths — writes stay verified.
  //    Deletes close the document and drop state; moves carry state (and
  //    the seen-lines ledger) to the destination.
  const lspManager = getLspServerManager()
  const syncFailures: string[] = []
  const freshAnchors: Array<{ path: string; anchor: string }> = []
  for (const t of changedTargets) {
    const b = bytes.get(t.canonicalPath)!
    const originalLF = b.originalBytes.toString(t.encoding).replaceAll('\r\n', '\n')
    if (t.fileOp === 'delete') {
      context.readFileState.delete(t.canonicalPath)
      dropSeenLines(owner, t.canonicalPath)
      if (lspManager) await lspManager.closeFile(t.canonicalPath).catch(() => {})
      continue
    }
    const landedPath = t.fileOp === 'move' && t.newPath !== undefined ? t.newPath : t.canonicalPath
    if (t.fileOp === 'move') {
      context.readFileState.delete(t.canonicalPath)
      if (lspManager) await lspManager.closeFile(t.canonicalPath).catch(() => {})
    }
    context.readFileState.set(landedPath, {
      content: t.plannedContent,
      timestamp: getFileModificationTime(landedPath),
      offset: undefined,
      limit: undefined,
    })
    if (t.fileOp !== 'move') {
      notifyVscodeFileUpdated(landedPath, originalLF, t.plannedContent)
    }
    if (lspManager) {
      const sync = await syncServersAfterWrite(lspManager, landedPath, t.plannedContent)
      if (!sync.ok) syncFailures.push(`${displayPath(landedPath)}: ${sync.reason}`)
    }
    // Fresh-anchor chaining: the next patch edits WITHOUT a re-read. The
    // ring remembers the exact text; the ledger shifts through the applied
    // spans (rewritten regions count as seen — the model authored them).
    const anchor = mintFileAnchor(t.plannedContent)
    freshAnchors.push({ path: landedPath, anchor })
    rememberAnchoredSnapshot(owner, anchor, t.plannedContent, landedPath)
    const generation = fileGeneration(landedPath)
    if (generation !== null) {
      if (t.fileOp === 'move') moveSeenLines(owner, t.canonicalPath, landedPath, generation)
      shiftSeenLinesAfterApply(owner, landedPath, generation, t.hunkSpans, span =>
        span.replace === ''
          ? 0
          : (span.replace.endsWith('\n') ? span.replace.slice(0, -1) : span.replace).split('\n')
              .length,
      )
    }
  }
  // Registers publish exactly here — after their cut's writes LANDED.
  const publishedRegisters: string[] = []
  if (lowered) {
    for (const [name, reg] of lowered.registerPublications) {
      const res = publishPatchRegister(owner, name, {
        content: reg.content,
        fromPath: reg.fromPath,
        cutAt: Date.now(),
      })
      if (res.ok) publishedRegisters.push(name)
    }
  }
  if (!isEnvTruthy(process.env.MERCURY_SIMPLE)) {
    const paths = changedTargets.map(t => t.canonicalPath)
    discoverSkillDirsForPaths(paths, getCwd())
      .then(dirs => (dirs.length > 0 ? addSkillDirectories(dirs) : undefined))
      .catch(() => {})
    activateConditionalSkillsForPaths(paths, getCwd())
  }

  setChangeSetPlanState(owner, plan.id, 'applied', {
    appliedAt: Date.now(),
    operationId: outcome.operationId,
  })
  const anchorByPath = new Map(freshAnchors.map(a => [a.path, a.anchor]))
  const changedList = changedTargets
    .map(t => {
      const landed = t.fileOp === 'move' && t.newPath !== undefined ? t.newPath : t.canonicalPath
      const anchor = anchorByPath.get(landed)
      return `  ${targetLabel(t)}${anchor !== undefined ? ` (anchor: ${anchor})` : ''}`
    })
    .join('\n')
  const patchNotes = [
    ...loweredNotes(lowered),
    ...(publishedRegisters.length > 0
      ? [`registers published: ${publishedRegisters.join(', ')}`]
      : []),
  ]
  const patchNoteBlock = patchNotes.length > 0 ? `\n${patchNotes.join('\n')}` : ''
  const noChangeNote =
    plan.noChangePaths.length > 0
      ? `\nalready satisfied (not written): ${plan.noChangePaths.map(displayPath).join(', ')}`
      : ''
  const details = {
    planId: plan.id,
    planDigest: plan.digest.slice(0, 12),
    files: changedTargets.length,
    hunks: plan.totalHunks,
    noChangePaths: plan.noChangePaths,
    operationId: outcome.operationId,
    stabilization: syncFailures.length === 0 ? 'synced' : 'unconfirmed',
  }
  if (syncFailures.length > 0) {
    return {
      op: 'apply',
      result:
        `Applied plan ${plan.id} — ${changedTargets.length} file(s) written and verified by reread, ` +
        `but editor/language-server sync did not complete:\n${syncFailures.map(f => `  ${f}`).join('\n')}\n` +
        `The files ARE written; the servers' view is unconfirmed. Verify with a real check.${noChangeNote}`,
      outcome: 'indeterminate',
      planId: plan.id,
      changeView: changeViewOf(plan, 'applied', { nextAction: 'run a real check — server sync unconfirmed' }),
      effectOperation: 'file.changeSet',
      changedPaths: outcome.changedPaths,
      details,
      intent: intentOf(plan),
    }
  }
  return {
    op: 'apply',
    result: `Applied plan ${plan.id} — ${changedTargets.length} file(s), ${plan.totalHunks} hunk(s), verified by reread:\n${changedList}${patchNoteBlock}${noChangeNote}`,
    outcome: 'succeeded',
    planId: plan.id,
    changeView: changeViewOf(plan, 'applied'),
    effectOperation: 'file.changeSet',
    changedPaths: outcome.changedPaths,
    details,
    intent: intentOf(plan),
  }
}

function runStatus(input: Input, context: ToolUseContext): OpResult {
  const owner = ownerFromToolUseContext(context)
  const id = input.plan_id!
  const plan = getChangeSetPlan(owner, id)
  if (!plan) {
    const wasEvicted = changeSetPlanEvicted(owner, id)
    return {
      op: 'status',
      result: wasEvicted
        ? `Plan ${id} expired from the bounded plan ring (${CHANGESET_BOUNDS.planRing} retained).`
        : `No plan '${id}' in this conversation.`,
      outcome: 'no-change',
      effectOperation: 'changeset.status',
      changedPaths: [],
    }
  }
  const expired = plan.state === 'prepared' && changeSetPlanExpired(plan)
  if (expired) setChangeSetPlanState(owner, id, 'expired')
  const freshness = plan.targets.map(t => {
    let fresh = false
    try {
      fresh = sha256Hex(readFileSync(t.canonicalPath)) === t.originalDigest
    } catch {
      fresh = false
    }
    return `  ${displayPath(t.canonicalPath)}: ${fresh ? 'unchanged since plan' : 'DRIFTED since plan'}${t.changed ? '' : ' · already satisfied'}`
  })
  const state = expired ? 'expired' : plan.state
  const lines = [
    `Plan ${plan.id} [${state}] — ${plan.changedPaths.length} to change, ${plan.noChangePaths.length} already satisfied, ${plan.totalHunks} hunk(s).`,
    ...freshness,
    ...(plan.note ? [`note: ${plan.note}`] : []),
    ...(plan.operationId ? [`operation: ${plan.operationId}`] : []),
  ]
  return {
    op: 'status',
    result: lines.join('\n'),
    outcome: 'no-change',
    planId: plan.id,
    changeView: changeViewOf(plan, state as InlineChangeViewData['state'], {
      nextAction:
        state === 'prepared'
          ? `apply with { op: "apply", plan_id: "${plan.id}" }`
          : state === 'stale' || state === 'expired'
            ? 're-read the drifted files, then op:"preview" again'
            : undefined,
    }),
    effectOperation: 'changeset.status',
    changedPaths: [],
  }
}

function runDiscard(input: Input, context: ToolUseContext): OpResult {
  const owner = ownerFromToolUseContext(context)
  const id = input.plan_id!
  const plan = getChangeSetPlan(owner, id)
  if (!plan) {
    return {
      op: 'discard',
      result: `No plan '${id}' in this conversation — nothing to discard.`,
      outcome: 'no-change',
      effectOperation: 'changeset.discard',
      changedPaths: [],
    }
  }
  if (plan.state === 'applied') {
    return {
      op: 'discard',
      result: `Plan ${id} was already applied — discard changes nothing on disk. Use file history to rewind if needed.`,
      outcome: 'failed',
      effectOperation: 'changeset.discard',
      changedPaths: [],
    }
  }
  if (plan.state === 'discarded') {
    return {
      op: 'discard',
      result: `Plan ${id} is already discarded.`,
      outcome: 'no-change',
      planId: id,
      effectOperation: 'changeset.discard',
      changedPaths: [],
    }
  }
  const updated = setChangeSetPlanState(owner, id, 'discarded', { note: 'discarded by the caller' })!
  return {
    op: 'discard',
    result: `Discarded plan ${id} — it can no longer be applied. Nothing was written.`,
    outcome: 'no-change',
    planId: id,
    changeView: changeViewOf(updated, 'discarded'),
    effectOperation: 'changeset.discard',
    changedPaths: [],
  }
}

// ── the tool ────────────────────────────────────────────────────────────────

export const ChangeSetTool = buildTool({
  name: CHANGESET_TOOL_NAME,
  searchHint:
    'atomic multi-file edit: anchored hunks across several files, one reviewed change set, preview apply refactor',
  maxResultSizeChars: 60_000,
  strict: true,
  shouldDefer: true,
  capability: {
    intents: [
      'apply one coordinated change across several files',
      'atomic multi-file edit with one review',
      'preview a multi-file change set before applying',
      'coordinated cross-file refactor with drift refusal',
    ],
    units: ['text-mutation'],
    class: 'mutation',
    transaction: { kind: 'file', receipts: true },
    evidence: ['change'],
    resources: ['file', 'receipt'],
    cancellation: 'cooperative',
    latency: 'fast',
    gate: 'MERCURY_CHANGESET',
    proof: 'scripts/changesets/run-all.sh',
  },
  async description() {
    return 'Prepare, review, and apply one anchored text change across several existing files'
  },
  async prompt() {
    return `Atomic multi-file text change sets: ONE call prepares, reviews, and applies an anchored change spanning several EXISTING text files, with all-target preflight before the first write, one aggregate operator decision, drift refusal per target, deterministic journaled recovery, and exact outcome truth.

Operations:
1. { op: "apply", changes: [...] } — the fast path: preflight every member, obtain ONE aggregate decision, apply. Use this when you already hold fresh Read anchors for every file.
2. { op: "preview", changes: [...] } — the review path: build an immutable content-addressed plan (cs-…) and write NOTHING. Then { op: "apply", plan_id: "cs-…" }. A drifted file refuses the whole apply with current anchors and exact reread instructions.
3. { op: "status", plan_id } — plan state + per-file freshness.
4. { op: "discard", plan_id } — retire a prepared plan.

Each changes[] member targets ONE existing text file with the Edit hunk vocabulary:
  { file_path, expected_anchor (REQUIRED — the "(anchor: …)" value from your Read), hunks: [{ lines: "N" | "N-M", replace, insert?: "before"|"after" }] }
Hunks are 1-based against the anchored snapshot and must be disjoint; "" deletes the range; insert takes a single anchor line.

The contract (exact, never vague):
· any preparation/validation/scope/drift failure writes NOTHING — the valid subset of an invalid set is never applied;
· a normal apply reaches the complete planned state, verified by reread;
· a midway interruption is journaled and deterministically reconciled at the next boot;
· if later bytes prevent safe reconciliation, the exact unresolved paths are named — uncertainty is never reported as success.

Already-satisfied members are NOT failures: they are omitted from writes and reported as noChangePaths. An all-satisfied set returns one truthful no-change result with zero writes. Applying an already-committed plan replays the prior result without writing twice.

Bounds (an exceeded bound names the limit and the smallest recovery): ${CHANGESET_BOUNDS.maxFiles} files/set · ${CHANGESET_BOUNDS.maxHunksPerFile} hunks/file · ${CHANGESET_BOUNDS.maxHunksTotal} hunks/set · 4MB staged content/set · ${CHANGESET_BOUNDS.planRing} retained plans · ${Math.round(CHANGESET_BOUNDS.planTtlMs / 60_000)}-minute plan lifetime.

NOT this tool (refused by name): file creation (Write) · binary content · notebooks (NotebookEdit) · command execution (Bash)${anchorPatchEnabled() ? ' · deletion/moves outside a patch (the patch dialect carries delete-file and move-to; the JSON changes[] form does not)' : ' · deletion/moves (Bash / lsp.pathRename)'}. Single-file edits are usually better served by Edit.${
      anchorPatchEnabled() ? `\n\n${ANCHOR_PATCH_TEACHING}` : ''
    }`
  },
  userFacingName,
  getToolUseSummary(input?: Partial<Input>) {
    if (!input?.op) return null
    if (Array.isArray(input.changes) && input.changes.length > 0) {
      return `${input.op} · ${input.changes.length} file${input.changes.length === 1 ? '' : 's'}`
    }
    if (typeof input.patch === 'string' && input.patch.length > 0) {
      const files = new Set(
        [...input.patch.matchAll(/^file\s+(\S+)\s/gm)].map(m => m[1]),
      ).size
      return files > 0 ? `${input.op} · patch (${files} file${files === 1 ? '' : 's'})` : `${input.op} · patch`
    }
    return input.plan_id ? `${input.op} · ${input.plan_id}` : input.op
  },
  getActivityDescription(input?: Partial<Input>) {
    if (!input?.op) return 'Change set'
    return input.op === 'apply' ? 'Applying change set' : `Change set ${input.op}`
  },
  get inputSchema(): SchemaType {
    return inputSchema()
  },
  toAutoClassifierInput(input: Input) {
    const paths = (input.changes ?? []).map(c => c.file_path).join(', ')
    const patchPaths =
      typeof input.patch === 'string'
        ? [...input.patch.matchAll(/^file\s+(\S+)\s/gm)].map(m => m[1]).join(', ')
        : ''
    return `changeset ${input.op}: ${paths || patchPaths || input.plan_id || ''}`
  },
  isConcurrencySafe() {
    return false
  },
  isReadOnly(input: Input) {
    return input.op !== 'apply'
  },
  async validateInput(input: Input) {
    if (input.op === 'preview') {
      const hasChanges = input.changes != null && input.changes.length > 0
      const hasPatch = input.patch != null && input.patch.length > 0
      if (hasChanges === hasPatch) {
        return { result: false as const, behavior: 'ask' as const, message: 'preview takes EXACTLY ONE of changes (one member per file) or patch (the dialect string).', errorCode: 1 }
      }
      if (input.plan_id !== undefined) {
        return { result: false as const, behavior: 'ask' as const, message: 'preview takes changes/patch, not plan_id — plans are minted BY preview.', errorCode: 1 }
      }
    }
    if (input.op === 'apply') {
      // An empty string or empty array is ABSENT, not a third choice: a
      // provider that serializes an omitted optional as `null` OR as `""`
      // must read the same as omitting it (the wire seam strips nulls too,
      // openaiWire.stripNullArgs). Otherwise `plan_id: ""` counted as a
      // provided field and the model retried the same call against the same
      // count error.
      const hasChanges = input.changes != null && input.changes.length > 0
      const hasPatch = typeof input.patch === 'string' && input.patch.length > 0
      const hasPlan = typeof input.plan_id === 'string' && input.plan_id.trim().length > 0
      const given = [hasChanges, hasPatch, hasPlan].filter(Boolean).length
      if (given !== 1) {
        // Name the one-of choice AND what this call actually carried, so the
        // model corrects the specific mistake instead of re-sending it.
        const present = [hasChanges && 'changes', hasPatch && 'patch', hasPlan && 'plan_id'].filter(Boolean) as string[]
        const carried =
          present.length === 0
            ? 'this call provided none of them (empty values count as absent)'
            : `this call provided ${present.join(' and ')}`
        return {
          result: false as const,
          behavior: 'ask' as const,
          message: `apply takes EXACTLY ONE of changes (the fast path), patch (the dialect string), or plan_id (a previewed plan) — ${carried}. Send exactly one.`,
          errorCode: 1,
        }
      }
    }
    if ((input.op === 'status' || input.op === 'discard') && input.patch !== undefined) {
      return { result: false as const, behavior: 'ask' as const, message: `${input.op} takes plan_id only.`, errorCode: 1 }
    }
    if ((input.op === 'status' || input.op === 'discard') && !input.plan_id) {
      return { result: false as const, behavior: 'ask' as const, message: `${input.op} requires plan_id.`, errorCode: 1 }
    }
    if ((input.op === 'status' || input.op === 'discard') && input.changes !== undefined) {
      return { result: false as const, behavior: 'ask' as const, message: `${input.op} takes plan_id only.`, errorCode: 1 }
    }
    return { result: true as const }
  },
  async checkPermissions(input: Input, context): Promise<PermissionDecision> {
    if (input.op !== 'apply') {
      return { behavior: 'allow', updatedInput: input }
    }
    const permCtx = context.getAppState().toolPermissionContext
    let paths: string[]
    if (input.patch !== undefined) {
      // Pure parse (no fs): every section path + every move destination
      // joins the ONE aggregate decision.
      const parsed = parseAnchorPatch(input.patch)
      if (!parsed.ok) {
        // The call itself will refuse with the typed parse error — nothing
        // to authorize.
        return { behavior: 'allow', updatedInput: input }
      }
      const set = new Set<string>()
      for (const section of parsed.sections) {
        set.add(expandPath(section.path))
        for (const op of section.ops) {
          if (op.kind === 'move-to') set.add(expandPath(op.newPath))
        }
      }
      paths = [...set]
    } else if (input.changes !== undefined) {
      paths = input.changes.map(c => expandPath(c.file_path))
    } else {
      const owner = ownerFromToolUseContext(context)
      const plan = input.plan_id ? getChangeSetPlan(owner, input.plan_id) : undefined
      paths = plan?.changedPaths ?? []
    }
    if (paths.length === 0) {
      // No resolvable targets — the call itself refuses honestly, zero writes.
      return { behavior: 'allow', updatedInput: input }
    }
    let needsAsk = false
    for (const p of paths) {
      const decision = checkWritePermissionForTool(pathShim, { file_path: p }, permCtx)
      if (decision.behavior === 'deny') {
        // Pass the estate deny through (reason preserved) with the
        // aggregate-law message: a denied path refuses the WHOLE set.
        return {
          ...decision,
          message: `Permission to edit ${p} has been denied — a denied path refuses the whole change set (zero writes).`,
        }
      }
      if (decision.behavior !== 'allow') needsAsk = true
    }
    if (needsAsk) {
      return {
        behavior: 'ask',
        message: `Apply this change set (${paths.length} file${paths.length === 1 ? '' : 's'})? One decision covers every path; any denied path means zero writes.`,
      }
    }
    return { behavior: 'allow', updatedInput: input }
  },
  inputsEquivalent(a: Input, b: Input) {
    return (
      a.op === b.op &&
      a.plan_id === b.plan_id &&
      a.patch === b.patch &&
      JSON.stringify(a.changes ?? null) === JSON.stringify(b.changes ?? null)
    )
  },
  async call(input: Input, context: ToolUseContext, _canUseTool, parentMessage) {
    const startedAt = Date.now()
    let op: OpResult
    try {
      switch (input.op) {
        case 'preview':
          op = runPreview(input, context)
          break
        case 'apply':
          op = await runApply(input, context, parentMessage.uuid)
          break
        case 'status':
          op = runStatus(input, context)
          break
        case 'discard':
          op = runDiscard(input, context)
          break
      }
    } catch (err) {
      op = {
        op: input.op,
        result: `${input.op} failed: ${(err as Error).message}`,
        outcome: 'failed',
        effectOperation: input.op === 'apply' ? 'file.changeSet' : `changeset.${input.op}`,
        changedPaths: [],
      }
    }
    // The edit-outcome ledger (FN-013 LOOP-06): an APPLY is the edit
    // attempt (preview/status/discard are planning verbs); every apply
    // settles through this one chokepoint, so counts are one-for-one. The
    // typed refusal spelling is read back through the formatter's own
    // grammar readers (one owner — they live beside the formatter and are
    // pinned together); no path or content rides the count.
    if (input.op === 'apply') {
      try {
        const { recordEditOutcome } = await import('../../services/changeTransaction/editOutcomeLedger.js')
        const { anchorPatchCodeOfResult, changeSetRefusalCodeOfResult } = await import(
          '../../services/changeTransaction/changeSetPlan.js'
        )
        const surface = input.patch !== undefined ? 'anchor-patch' : 'changeset'
        const outcome =
          op.outcome === 'succeeded'
            ? 'applied'
            : op.outcome === 'no-change'
              ? 'no-change'
              : (changeSetRefusalCodeOfResult(op.result) ?? anchorPatchCodeOfResult(op.result) ?? 'failed')
        recordEditOutcome(
          ownerFromToolUseContext(context),
          context.options.mainLoopModel,
          surface,
          outcome,
        )
      } catch {
        /* a counter must never break the settle */
      }
    }
    const output: Output = {
      op: op.op,
      result: op.result,
      outcome: op.outcome,
      ...(op.planId !== undefined && { planId: op.planId }),
      ...(op.changeView !== undefined && { changeView: op.changeView }),
      ...(op.repetitionStop === true && { repetitionStop: true }),
    }
    return {
      data: output,
      effect: {
        outcome: op.outcome,
        operation: op.effectOperation,
        changedPaths: op.changedPaths,
        evidence: op.result.split('\n')[0]?.slice(0, 200) ?? '',
        startedAt,
        completedAt: Date.now(),
        ...(op.details !== undefined && { details: op.details }),
      },
      ...(op.intent !== undefined && { changeIntent: op.intent }),
    }
  },
  mapToolResultToToolResultBlockParam(output: Output, toolUseId: string) {
    return {
      tool_use_id: toolUseId,
      type: 'tool_result' as const,
      content: output.result,
      // the bounded-repetition ceiling surfaces as a
      // model-visible tool error; the internal outcome stays no-change.
      ...(output.repetitionStop === true && { is_error: true }),
    }
  },
  renderToolUseMessage,
  renderToolUseRejectedMessage,
  renderToolUseErrorMessage,
  renderToolResultMessage,
  // HZ7 projection: the renderer paints `result` or the inline change
  // view's hunks — search indexes both.
  extractSearchText({ result, changeView }) {
    return changeView ? `${result ?? ''}\n${changeViewSearchText(changeView)}` : (result ?? '')
  },
})

export { changeSetEnabled as isChangeSetToolCatalogEnabled }
