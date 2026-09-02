// ============================================================================
//  resources/workbench — mercury://workbench/*.
//
//  Forms:
//    mercury://workbench                → children (current + threads + lanes)
//    mercury://workbench/current        → the WorkbenchSnapshot (bounded)
//    mercury://workbench/thread/<id>    → one thread row + its owning refs
//    mercury://workbench/lane/<id>      → one lane row (+ on-demand git state)
//
//  A projection resource: everything answered here is derived from the
//  owning stores at resolve time — deep-links (mercury:// refs) point at the
//  owners, never clones of them. Distinct outcomes: unknown id → absent;
//  flag off / gather failure → unavailable (named); an empty workbench is a
//  real, ok, empty snapshot.
// ============================================================================

import {
  getWorkbenchSnapshot,
  resolveWorkbenchSnapshot,
} from '../../workbench/projection.js'
import { workbenchEnabled, type WorkbenchSnapshot } from '../../workbench/contracts.js'
import { registerResourceAdapter } from '../registry.js'
import type {
  ParsedRef,
  Resource,
  ResourceChild,
  ResourceContext,
  ResourceResult,
} from '../contracts.js'
import { boundedTextView } from '../contracts.js'

function snapshotSummaryLines(snap: WorkbenchSnapshot): string[] {
  const lines: string[] = []
  const g = snap.generation
  lines.push(
    `project ${snap.projectRoot} · ${g.branch ?? '?'}@${(g.headSha ?? '').slice(0, 8) || '?'}` +
      `${g.clean === undefined ? '' : g.clean ? ' clean' : ' dirty'}` +
      `${g.treeDigest ? ` · tree ${g.treeDigest.slice(0, 12)}` : ''}`,
  )
  lines.push(
    `root: ${snap.root.title} — phase ${snap.root.phase}` +
      (snap.root.blocker ? ` · BLOCKED: ${snap.root.blocker}` : ''),
  )
  if (snap.threads.length === 0) {
    lines.push('threads: none')
  } else {
    lines.push(`threads (${snap.threads.length}):`)
    for (const t of snap.threads) {
      lines.push(
        `  [${t.kind}] ${t.title} — ${t.phase}` +
          (t.model ? ` · ${t.model}` : '') +
          (t.worktreePath ? ` · wt ${t.worktreePath}` : '') +
          (t.changedPaths.length > 0 ? ` · ${t.changedPaths.length} paths` : '') +
          (t.blocker ? ` · BLOCKED: ${t.blocker}` : ''),
      )
    }
  }
  if (snap.lanes.length > 0) {
    lines.push(`lanes (${snap.lanes.length}):`)
    for (const l of snap.lanes) {
      lines.push(
        `  [${l.source}] ${l.laneId} — ${l.status}` +
          (l.goal ? ` · ${l.goal}` : '') +
          (l.handoffReady ? ' · HANDOFF READY' : ''),
      )
    }
  }
  for (const m of snap.missions) {
    lines.push(`mission ${m.title} — ${m.state} (${m.slices.length} slices)`)
  }
  if (snap.nextAction) lines.push(`next: ${snap.nextAction}`)
  return lines
}

async function snapshotFor(ctx: ResourceContext): Promise<
  | { state: 'ok'; snap: WorkbenchSnapshot }
  | { state: 'unavailable'; note: string }
> {
  try {
    const snap = await resolveWorkbenchSnapshot(
      ctx.getAppState ? { getAppState: ctx.getAppState } : undefined,
    )
    if (!snap) {
      return { state: 'unavailable', note: 'the workbench is disabled (MERCURY_WORKBENCH=0)' }
    }
    return { state: 'ok', snap }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return { state: 'unavailable', note: `workbench gather failed: ${msg.slice(0, 200)}` }
  }
}

function currentResource(snap: WorkbenchSnapshot, ref: ParsedRef): Resource {
  const full = snapshotSummaryLines(snap).join('\n')
  const view = boundedTextView(full, ref.selectors)
  return {
    ref: 'mercury://workbench/current',
    kind: 'workbench',
    title: 'workbench',
    summary: `${snap.threads.length} threads · ${snap.lanes.length} lanes · ${snap.missions.length} missions`,
    version: String(snap.version),
    mutable: true,
    text: view.text,
    page: view.page,
    structured: snap,
    children: [
      ...snap.threads.map(t => ({
        ref: `mercury://workbench/thread/${t.id}`,
        title: t.title,
        summary: `${t.kind} · ${t.phase}`,
      })),
      ...snap.lanes.map(l => ({
        ref: `mercury://workbench/lane/${encodeURIComponent(l.laneId)}`,
        title: l.laneId,
        summary: `${l.source} · ${l.status}`,
      })),
    ],
  }
}

export const workbenchAdapter = {
  kind: 'workbench',
  describe: 'the unified agent/worktree workbench projection (current · work · thread/<id> · lane/<id>)',
  async resolve(ref: ParsedRef, ctx: ResourceContext): Promise<ResourceResult> {
    if (!workbenchEnabled()) {
      return { state: 'unavailable', note: 'the workbench is disabled (MERCURY_WORKBENCH=0)' }
    }
    const [head, ...rest] = ref.id.split('/')
    if (ref.id === '' || head === '' || head === undefined) {
      // Kind root behaves as a listing resource.
      const got = await snapshotFor(ctx)
      if (got.state !== 'ok') return got
      return { state: 'ok', resource: currentResource(got.snap, ref) }
    }
    if (head === 'current') {
      const got = await snapshotFor(ctx)
      if (got.state !== 'ok') return got
      return { state: 'ok', resource: currentResource(got.snap, ref) }
    }
    if (head === 'work') {
      // the CurrentWork projection as a resource — the
      // SAME derivation the terminal lane's facts come from, so an editor/
      // ACP consumer reading this can never diverge from the cockpit.
      try {
        const { gatherCurrentWork } = await import('../../workbench/currentWork.js')
        const work = await gatherCurrentWork(
          ctx.getAppState ? { getAppState: ctx.getAppState } : undefined,
        )
        const lines = [
          `outcome: ${work.outcome ?? '(none)'} · scale ${work.scale}` +
            (work.phase ? ` · ${work.phase}` : ''),
          `items: ${work.completedCount}/${work.planItems.length} done` +
            (work.activeItem ? ` · active: ${work.activeItem.title}` : '') +
            (work.blockedItems.length > 0 ? ` · blocked: ${work.blockedItems.map(b => b.title).join(', ')}` : ''),
          work.blocker
            ? `blocker (${work.blocker.ownedBy}): ${work.blocker.description}`
            : work.nextAction
              ? `next: ${work.nextAction}`
              : 'next: (nothing derived)',
          `changed: ${work.totalChangedPaths} path(s)` +
            (work.verification ? ` · checks ${work.verification.state}` : ''),
          work.review
            ? `review: ${work.review.awaitingReview} awaiting · ${work.review.openComments} comments` +
              (work.review.anyStale ? ' · STALE artifact(s)' : '')
            : 'review: unavailable',
          `recovery: ${work.recovery.state}`,
        ]
        const view = boundedTextView(lines.join('\n'), ref.selectors)
        return {
          state: 'ok',
          resource: {
            ref: 'mercury://workbench/work',
            kind: 'workbench',
            title: 'current work',
            summary: `${work.scale} · ${work.completedCount}/${work.planItems.length}`,
            version: String(work.generatedAt),
            mutable: true,
            text: view.text,
            page: view.page,
            structured: work,
            children: [],
          },
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        return { state: 'unavailable', note: `current-work gather failed: ${msg.slice(0, 200)}` }
      }
    }
    if (head === 'thread') {
      const id = decodeURIComponent(rest.join('/'))
      const got = await snapshotFor(ctx)
      if (got.state !== 'ok') return got
      const row =
        id === 'root' ? got.snap.root : got.snap.threads.find(t => t.id === id)
      if (!row) {
        return { state: 'absent', note: `no workbench thread '${id}' in the current projection` }
      }
      const lines = [
        `${row.title} — [${row.kind}] phase ${row.phase} · state ${row.state}`,
        ...(row.model ? [`model ${row.model}${row.effortOverride ? ` @${row.effortOverride}` : ''}`] : []),
        ...(row.worktreePath ? [`worktree ${row.worktreePath}`] : []),
        ...(row.changedPaths.length > 0
          ? [`changed (${row.totalChangedPaths ?? row.changedPaths.length}): ${row.changedPaths.slice(0, 20).join(', ')}`]
          : []),
        ...(row.verification ? [`verification: ${row.verification}`] : []),
        ...(row.blocker ? [`BLOCKED: ${row.blocker}`] : []),
      ]
      const view = boundedTextView(lines.join('\n'), ref.selectors)
      return {
        state: 'ok',
        resource: {
          ref: `mercury://workbench/thread/${id}`,
          kind: 'workbench',
          title: row.title,
          summary: `${row.kind} · ${row.phase}`,
          version: String(got.snap.version),
          mutable: true,
          text: view.text,
          page: view.page,
          structured: row,
          sourceRefs: row.refs,
        },
      }
    }
    if (head === 'lane') {
      const id = decodeURIComponent(rest.join('/'))
      const got = await snapshotFor(ctx)
      if (got.state !== 'ok') return got
      const lane = got.snap.lanes.find(l => l.laneId === id)
      if (!lane) {
        return { state: 'absent', note: `no workbench lane '${id}' in the current projection` }
      }
      const lines = [
        `${lane.laneId} — [${lane.source}] ${lane.status}`,
        ...(lane.goal ? [`goal: ${lane.goal}`] : []),
        ...(lane.worktreePath ? [`worktree ${lane.worktreePath}`] : []),
        ...(lane.handoffReady ? ['HANDOFF READY — adopt or return'] : []),
      ]
      const view = boundedTextView(lines.join('\n'), ref.selectors)
      return {
        state: 'ok',
        resource: {
          ref: `mercury://workbench/lane/${encodeURIComponent(id)}`,
          kind: 'workbench',
          title: lane.laneId,
          summary: `${lane.source} · ${lane.status}`,
          version: String(got.snap.version),
          mutable: true,
          text: view.text,
          page: view.page,
          structured: lane,
          sourceRefs: lane.refs,
        },
      }
    }
    return {
      state: 'absent',
      note: `unknown workbench form '${head}' — forms: current · thread/<id> · lane/<id>`,
    }
  },
  async list(): Promise<ResourceChild[]> {
    if (!workbenchEnabled()) return []
    const snap = getWorkbenchSnapshot()
    const children: ResourceChild[] = [
      { ref: 'mercury://workbench/current', title: 'current', summary: 'the live workbench projection' },
    ]
    if (snap) {
      for (const t of snap.threads.slice(0, 30)) {
        children.push({
          ref: `mercury://workbench/thread/${t.id}`,
          title: t.title,
          summary: `${t.kind} · ${t.phase}`,
        })
      }
    }
    return children
  },
}

registerResourceAdapter(workbenchAdapter)
