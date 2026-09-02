
import { randomBytes } from 'node:crypto'
import { flagEnv } from '../../substrate/flagRegistry.js'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
} from 'node:fs'
import * as path from 'node:path'
import { durableAtomicPublishSync } from '../../substrate/durablePublish.js'
import { createReviewArtifact } from '../../utils/artifacts/reviewStore.js'
import { getCwd } from '../../utils/cwd.js'
import { getMercuryHome } from '../../utils/envUtils.js'
import { execFileNoThrowWithCwd } from '../../utils/execFileNoThrow.js'
import { gitExe } from '../../utils/git.js'
import { fetchGitDiffFor } from '../../utils/gitDiff.js'
import { resolveProjectConfigPath } from '../../utils/projectConfig.js'
import { createAgentWorktree } from '../../utils/worktree.js'

const GIT_TIMEOUT_MS = 8000


export interface WorkContextSetupState {
  copiedFiles: string[]
  skippedExisting: string[]
  setupCommand?: { cmd: string; code: number; outputTail: string }
}

export interface WorkContextV1 {
  schema: 1
  contextId: string
  sessionId: string
  roots: string[]
  mode: 'local' | 'worktree'
  worktreePath?: string
  laneId?: string
  branch?: string
  baseSha?: string
  headSha?: string
  setupState?: WorkContextSetupState
  model?: string
  permissionMode?: string
  artifactRefs: string[]
  receiptRefs: string[]
  pendingCommentIds: string[]
  status: 'active' | 'parked' | 'archived'
  createdAt: number
  updatedAt: number
  parkedAt?: number
  recoveryArtifactRef?: string
}

export interface HandoffOperation {
  op:
    | 'provision-worktree'
    | 'copy-setup-file'
    | 'run-setup-command'
    | 'rebind-conversation'
    | 'carry-pending-comments'
  detail: string
}

export interface HandoffPreview {
  ok: boolean
  from: { mode: 'local' | 'worktree'; root: string; dirtyPaths: string[] }
  to: {
    mode: 'local' | 'worktree'
    root: string | null
    dirtyPaths: string[]
    exists: boolean
  }
  divergence: { ahead: number; behind: number } | null
  overlap: string[]
  verification: string | null
  pendingComments: number
  operations: HandoffOperation[]
  conflicts: Array<{ path: string; reason: string }>
  suggestedResolutions: string[]
  observedDigest: string | null
}

export type WorkContextResult<T> = { ok: true; value: T } | { ok: false; reason: string }


export function workContextsRoot(): string {
  const override = flagEnv('MERCURY_WORK_CONTEXTS_DIR')
  if (override && override.trim() !== '') return override
  return path.join(getMercuryHome(), 'work-contexts')
}

function contextPath(id: string): string {
  return path.join(workContextsRoot(), `${id}.json`)
}

function writeContext(ctx: WorkContextV1): void {
  mkdirSync(workContextsRoot(), { recursive: true })
  durableAtomicPublishSync(contextPath(ctx.contextId), JSON.stringify(ctx, null, 2))
}

export function readWorkContext(id: string): WorkContextV1 | null {
  try {
    const raw = JSON.parse(readFileSync(contextPath(id), 'utf8')) as WorkContextV1
    return raw.schema === 1 && raw.contextId === id ? raw : null
  } catch {
    return null
  }
}

export function listWorkContexts(filter?: {
  sessionId?: string
  status?: WorkContextV1['status']
}): WorkContextV1[] {
  try {
    const root = workContextsRoot()
    if (!existsSync(root)) return []
    return readdirSync(root)
      .filter(f => f.endsWith('.json'))
      .map(f => readWorkContext(f.slice(0, -5)))
      .filter((c): c is WorkContextV1 => c !== null)
      .filter(
        c =>
          (!filter?.sessionId || c.sessionId === filter.sessionId) &&
          (!filter?.status || c.status === filter.status),
      )
      .sort((a, b) => b.updatedAt - a.updatedAt)
  } catch {
    return []
  }
}


async function gitIn(cwd: string, args: string[]): Promise<{ stdout: string; code: number }> {
  return execFileNoThrowWithCwd(gitExe(), args, {
    cwd,
    timeout: GIT_TIMEOUT_MS,
    preserveOutputOnError: false,
  })
}

async function dirtyPathsIn(cwd: string): Promise<string[]> {
  const { stdout, code } = await gitIn(cwd, ['status', '--porcelain=v1', '-uall', '-z'])
  if (code !== 0) return []
  const paths = new Set<string>()
  const records = stdout.split('\0')
  for (let i = 0; i < records.length; i++) {
    const rec = records[i]!
    if (rec.length < 4) continue
    const xy = rec.slice(0, 2)
    paths.add(rec.slice(3))
    if (xy.includes('R') || xy.includes('C')) {
      const origin = records[i + 1]
      if (origin && origin.length > 0) {
        paths.add(origin)
        i++
      }
    }
  }
  return [...paths]
}

async function handoffFenceDigest(cwd: string): Promise<string | null> {
  const { createHash } = await import('node:crypto')
  const head = await headOf(cwd)
  if (!head) return null
  const { stdout: patch, code } = await gitIn(cwd, ['--no-optional-locks', 'diff', 'HEAD'])
  if (code !== 0) return null
  const { stdout: untracked } = await gitIn(cwd, ['ls-files', '--others', '--exclude-standard'])
  return createHash('sha256').update(head).update(patch).update(untracked).digest('hex').slice(0, 16)
}

async function branchOf(cwd: string): Promise<string | null> {
  const { stdout, code } = await gitIn(cwd, ['rev-parse', '--abbrev-ref', 'HEAD'])
  return code === 0 ? stdout.trim() : null
}

async function headOf(cwd: string): Promise<string | null> {
  const { stdout, code } = await gitIn(cwd, ['rev-parse', 'HEAD'])
  return code === 0 ? stdout.trim() : null
}

async function divergenceBetween(
  a: string,
  b: string,
): Promise<{ ahead: number; behind: number } | null> {
  const headA = await headOf(a)
  const headB = await headOf(b)
  if (!headA || !headB) return null
  if (headA === headB) return { ahead: 0, behind: 0 }
  const { stdout, code } = await gitIn(a, ['rev-list', '--left-right', '--count', `${headA}...${headB}`])
  if (code !== 0) return null
  const m = stdout.trim().match(/^(\d+)\s+(\d+)$/)
  return m ? { ahead: Number(m[1]), behind: Number(m[2]) } : null
}

function realpathOrSelf(p: string): string {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return (require('node:fs') as typeof import('node:fs')).realpathSync(p)
  } catch {
    return p
  }
}


export interface WorktreeSetupConfig {
  copyFiles: string[]
  setupCommand?: string
}

export function readWorktreeSetupConfig(root: string): WorktreeSetupConfig {
  try {
    const file = resolveProjectConfigPath(root, 'worktree-setup.json')
    if (!file) return { copyFiles: [] }
    const raw = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>
    const copyFiles = Array.isArray(raw.copyFiles)
      ? raw.copyFiles.filter((f): f is string => typeof f === 'string').slice(0, 50)
      : []
    const setupCommand = typeof raw.setupCommand === 'string' ? raw.setupCommand : undefined
    return { copyFiles, ...(setupCommand !== undefined && { setupCommand }) }
  } catch {
    return { copyFiles: [] }
  }
}

export function copySetupFiles(
  fromRoot: string,
  toRoot: string,
  setup: WorktreeSetupConfig,
): WorkContextSetupState {
  const copied: string[] = []
  const skipped: string[] = []
  for (const rel of setup.copyFiles) {
    const src = path.join(fromRoot, rel)
    const dst = path.join(toRoot, rel)
    try {
      if (!existsSync(src)) continue
      if (existsSync(dst)) {
        skipped.push(rel)
        continue
      }
      mkdirSync(path.dirname(dst), { recursive: true })
      copyFileSync(src, dst)
      copied.push(rel)
    } catch {
      skipped.push(rel)
    }
  }
  return { copiedFiles: copied, skippedExisting: skipped }
}


export function bindWorkContext(input: {
  sessionId: string
  mode: 'local' | 'worktree'
  root: string
  worktreePath?: string
  laneId?: string
  branch?: string
  baseSha?: string
  headSha?: string
  model?: string
  permissionMode?: string
  artifactRefs?: string[]
  receiptRefs?: string[]
  pendingCommentIds?: string[]
}): WorkContextV1 {
  const now = Date.now()
  const ctx: WorkContextV1 = {
    schema: 1,
    contextId: `wc-${randomBytes(4).toString('hex')}`,
    sessionId: input.sessionId,
    roots: [input.root],
    mode: input.mode,
    ...(input.worktreePath !== undefined && { worktreePath: input.worktreePath }),
    ...(input.laneId !== undefined && { laneId: input.laneId }),
    ...(input.branch !== undefined && { branch: input.branch }),
    ...(input.baseSha !== undefined && { baseSha: input.baseSha }),
    ...(input.headSha !== undefined && { headSha: input.headSha }),
    ...(input.model !== undefined && { model: input.model }),
    ...(input.permissionMode !== undefined && { permissionMode: input.permissionMode }),
    artifactRefs: input.artifactRefs ?? [],
    receiptRefs: input.receiptRefs ?? [],
    pendingCommentIds: input.pendingCommentIds ?? [],
    status: 'active',
    createdAt: now,
    updatedAt: now,
  }
  writeContext(ctx)
  return ctx
}

export function updateWorkContext(
  id: string,
  patch: Partial<
    Pick<
      WorkContextV1,
      | 'mode'
      | 'worktreePath'
      | 'laneId'
      | 'branch'
      | 'baseSha'
      | 'headSha'
      | 'model'
      | 'permissionMode'
      | 'artifactRefs'
      | 'receiptRefs'
      | 'pendingCommentIds'
      | 'setupState'
    >
  >,
): WorkContextResult<WorkContextV1> {
  const ctx = readWorkContext(id)
  if (!ctx) return { ok: false, reason: `no work context '${id}'` }
  const next: WorkContextV1 = { ...ctx, ...patch, updatedAt: Date.now() }
  writeContext(next)
  return { ok: true, value: next }
}


export async function previewHandoff(input: {
  contextId: string
  to: { mode: 'local' | 'worktree'; root?: string; newWorktreeSlug?: string }
}): Promise<WorkContextResult<HandoffPreview>> {
  const ctx = readWorkContext(input.contextId)
  if (!ctx) return { ok: false, reason: `no work context '${input.contextId}'` }
  const fromRoot = ctx.mode === 'worktree' ? (ctx.worktreePath ?? ctx.roots[0]!) : ctx.roots[0]!

  const fromDirty = await dirtyPathsIn(fromRoot)
  const toRoot =
    input.to.mode === 'worktree'
      ? (input.to.root ?? null)
      : (input.to.root ?? ctx.roots[0]!)
  const toExists = toRoot !== null && existsSync(toRoot)
  const toDirty = toExists ? await dirtyPathsIn(toRoot!) : []

  const overlap = fromDirty.filter(p => toDirty.includes(p))
  const divergence = toExists ? await divergenceBetween(fromRoot, toRoot!) : null

  const observedDigest = await handoffFenceDigest(fromRoot)

  const operations: HandoffOperation[] = []
  const setup = readWorktreeSetupConfig(ctx.roots[0]!)
  if (input.to.mode === 'worktree' && toRoot === null) {
    operations.push({
      op: 'provision-worktree',
      detail: `create a managed worktree (slug '${input.to.newWorktreeSlug ?? 'wb'}') via the ONE worktree machinery`,
    })
    for (const f of setup.copyFiles) {
      operations.push({ op: 'copy-setup-file', detail: `${f} (only if absent at the destination)` })
    }
    if (setup.setupCommand) {
      operations.push({ op: 'run-setup-command', detail: setup.setupCommand })
    }
  }
  operations.push({
    op: 'rebind-conversation',
    detail: `context ${ctx.contextId}: ${ctx.mode} → ${input.to.mode}${toRoot ? ` (${toRoot})` : ''}`,
  })
  if (ctx.pendingCommentIds.length > 0) {
    operations.push({
      op: 'carry-pending-comments',
      detail: `${ctx.pendingCommentIds.length} open comment ref(s) move with the context`,
    })
  }

  const conflicts = overlap.map(p => ({
    path: p,
    reason: 'dirty in BOTH the source and the destination — the handoff would act on contradicting trees',
  }))

  const preview: HandoffPreview = {
    ok: conflicts.length === 0,
    from: { mode: ctx.mode, root: fromRoot, dirtyPaths: fromDirty },
    to: { mode: input.to.mode, root: toRoot, dirtyPaths: toDirty, exists: toExists },
    divergence,
    overlap,
    verification: null,
    pendingComments: ctx.pendingCommentIds.length,
    operations,
    conflicts,
    suggestedResolutions:
      conflicts.length > 0
        ? [
            'commit or stash the destination changes first',
            'park this lane instead (p in /workbench) and integrate later',
            'open /diff to inspect the overlapping paths side by side',
          ]
        : [],
    observedDigest,
  }
  return { ok: true, value: preview }
}

export async function executeHandoff(input: {
  contextId: string
  to: { mode: 'local' | 'worktree'; root?: string; newWorktreeSlug?: string }
  preview: HandoffPreview
}): Promise<WorkContextResult<{ context: WorkContextV1; setup?: WorkContextSetupState }>> {
  const ctx = readWorkContext(input.contextId)
  if (!ctx) return { ok: false, reason: `no work context '${input.contextId}'` }
  if (!input.preview.ok) {
    return {
      ok: false,
      reason: `the preview has ${input.preview.conflicts.length} conflict(s) — resolve them first (${input.preview.suggestedResolutions[0] ?? ''})`,
    }
  }
  const current = await handoffFenceDigest(
    ctx.mode === 'worktree' ? (ctx.worktreePath ?? ctx.roots[0]!) : ctx.roots[0]!,
  )
  if (
    input.preview.observedDigest !== null &&
    current !== null &&
    current !== input.preview.observedDigest
  ) {
    return { ok: false, reason: 'the tree moved since the preview — re-preview the handoff' }
  }

  let toRoot = input.to.root ?? null
  let setupState: WorkContextSetupState | undefined
  let laneId = ctx.laneId

  if (input.to.mode === 'worktree' && toRoot === null) {
    const { stdout: sessionRoot, code: rootCode } = await gitIn(getCwd(), [
      'rev-parse',
      '--show-toplevel',
    ])
    const { stdout: ctxRoot, code: ctxCode } = await gitIn(ctx.roots[0]!, [
      'rev-parse',
      '--show-toplevel',
    ])
    if (
      rootCode !== 0 ||
      ctxCode !== 0 ||
      realpathOrSelf(sessionRoot.trim()) !== realpathOrSelf(ctxRoot.trim())
    ) {
      return {
        ok: false,
        reason: `cannot provision a worktree here: this session's repo (${sessionRoot.trim() || 'unknown'}) is not the context's repo (${ctx.roots[0]}) — run the handoff from the owning project`,
      }
    }
    const created = await createAgentWorktree(input.to.newWorktreeSlug ?? `wb_${ctx.contextId.slice(3)}`)
    toRoot = created.worktreePath
    laneId = `wt:${created.worktreePath}`
    const setup = readWorktreeSetupConfig(ctx.roots[0]!)
    setupState = copySetupFiles(ctx.roots[0]!, toRoot, setup)
    if (setup.setupCommand) {
      const { stdout, code } = await execFileNoThrowWithCwd(
        '/bin/sh',
        ['-c', setup.setupCommand],
        { cwd: toRoot, timeout: 120_000, preserveOutputOnError: true },
      )
      setupState.setupCommand = {
        cmd: setup.setupCommand,
        code,
        outputTail: stdout.slice(-400),
      }
    }
  }

  const branch = toRoot ? await branchOf(toRoot) : await branchOf(ctx.roots[0]!)
  const head = toRoot ? await headOf(toRoot) : await headOf(ctx.roots[0]!)
  const updated = updateWorkContext(ctx.contextId, {
    mode: input.to.mode,
    ...(input.to.mode === 'worktree' && toRoot !== null && { worktreePath: toRoot }),
    ...(input.to.mode === 'local' && { worktreePath: undefined, laneId: undefined }),
    ...(input.to.mode === 'worktree' && laneId !== undefined && { laneId }),
    ...(branch !== null && { branch }),
    ...(head !== null && { headSha: head }),
    ...(setupState !== undefined && { setupState }),
  })
  if (!updated.ok) return updated
  return { ok: true, value: { context: updated.value, ...(setupState && { setup: setupState }) } }
}


export async function parkWorkContext(id: string): Promise<WorkContextResult<{ recoveryRef: string }>> {
  const ctx = readWorkContext(id)
  if (!ctx) return { ok: false, reason: `no work context '${id}'` }
  const root = ctx.mode === 'worktree' ? (ctx.worktreePath ?? ctx.roots[0]!) : ctx.roots[0]!
  const dirty = existsSync(root) ? await dirtyPathsIn(root) : []
  const branch = existsSync(root) ? await branchOf(root) : null
  const head = existsSync(root) ? await headOf(root) : null
  const artifact = createReviewArtifact({
    kind: 'report',
    title: `parked lane ${ctx.laneId ?? ctx.contextId}`,
    producer: { sessionId: ctx.sessionId },
    workspace: { roots: ctx.roots },
    body: {
      kind: 'report',
      markdown: [
        `# Parked work context ${ctx.contextId}`,
        '',
        `- mode: ${ctx.mode}`,
        ...(ctx.worktreePath ? [`- worktree: ${ctx.worktreePath}`] : []),
        ...(branch ? [`- branch: ${branch}`] : []),
        ...(head ? [`- head: ${head}`] : []),
        `- dirty paths (${dirty.length}): ${dirty.slice(0, 30).join(', ') || 'none'}`,
        `- artifact refs: ${ctx.artifactRefs.join(' · ') || 'none'}`,
        `- pending comments: ${ctx.pendingCommentIds.length}`,
        '',
        `Restore with restoreWorkContext('${ctx.contextId}') — nothing was deleted.`,
      ].join('\n'),
    },
    initialStatus: 'ready-for-review',
  })
  if (!artifact.ok) return { ok: false, reason: `recovery artifact failed: ${artifact.reason}` }
  const recoveryRef = `mercury://artifact/${artifact.value.id}`
  const now = Date.now()
  writeContext({ ...ctx, status: 'parked', parkedAt: now, updatedAt: now, recoveryArtifactRef: recoveryRef })
  return { ok: true, value: { recoveryRef } }
}

export function restoreWorkContext(id: string): WorkContextResult<WorkContextV1> {
  const ctx = readWorkContext(id)
  if (!ctx) return { ok: false, reason: `no work context '${id}'` }
  if (ctx.status !== 'parked') return { ok: false, reason: `context '${id}' is ${ctx.status}, not parked` }
  if (ctx.mode === 'worktree' && ctx.worktreePath && !existsSync(ctx.worktreePath)) {
    return {
      ok: false,
      reason: `the worktree ${ctx.worktreePath} no longer exists — see the recovery artifact ${ctx.recoveryArtifactRef ?? ''}`,
    }
  }
  const next: WorkContextV1 = { ...ctx, status: 'active', updatedAt: Date.now() }
  writeContext(next)
  return { ok: true, value: next }
}

export async function cleanupLane(input: {
  contextId: string
  baseRoot: string
}): Promise<WorkContextResult<{ removedWorktree: string }>> {
  const ctx = readWorkContext(input.contextId)
  if (!ctx) return { ok: false, reason: `no work context '${input.contextId}'` }
  if (ctx.mode !== 'worktree' || !ctx.worktreePath) {
    return { ok: false, reason: 'only worktree contexts have a lane to clean up' }
  }
  const wt = ctx.worktreePath
  if (!existsSync(wt)) {
    return { ok: false, reason: `worktree ${wt} does not exist` }
  }
  const dirty = await dirtyPathsIn(wt)
  if (dirty.length > 0) {
    return {
      ok: false,
      reason: `NOT clean — ${dirty.length} dirty path(s) (${dirty.slice(0, 5).join(', ')}); park it instead (parkWorkContext preserves a recovery artifact)`,
    }
  }
  const laneHead = await headOf(wt)
  if (!laneHead) return { ok: false, reason: 'cannot resolve the lane HEAD' }
  const { code: ancestorCode } = await gitIn(input.baseRoot, [
    'merge-base',
    '--is-ancestor',
    laneHead,
    'HEAD',
  ])
  if (ancestorCode !== 0) {
    return {
      ok: false,
      reason: `NOT integrated — the lane head ${laneHead.slice(0, 8)} is not an ancestor of the base; merge it first or park the lane`,
    }
  }
  const { code: removeCode, stdout } = await gitIn(input.baseRoot, ['worktree', 'remove', wt])
  if (removeCode !== 0) {
    return { ok: false, reason: `git worktree remove refused: ${stdout.slice(0, 200)}` }
  }
  const now = Date.now()
  writeContext({ ...ctx, status: 'archived', updatedAt: now })
  return { ok: true, value: { removedWorktree: wt } }
}
