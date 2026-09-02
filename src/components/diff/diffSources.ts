// ============================================================================
//  diff/diffSources — the /diff workspace's SOURCE model.
//
//  One vocabulary for where a diff comes from; every source resolves to the
//  SAME DiffData shape the dialog already renders (StructuredPatchHunk maps
//  produced by the existing owners — git via the parameterized fetchers,
//  turns via tool-result structuredPatch, artifacts via their STORED bodies
//  or the same structuredPatch producer the edit tools use). The dialog
//  never parses a patch itself.
// ============================================================================

import { structuredPatch, type StructuredPatchHunk } from 'diff'
import type { DiffData } from '../../hooks/useDiffData.js'
import type { TurnDiff } from '../../hooks/useTurnDiffs.js'
import {
  branchDiffSpec,
  type GitDiffSpec,
} from '../../utils/gitDiff.js'
import {
  listReviewArtifactHeads,
  readReviewArtifactState,
} from '../../utils/artifacts/reviewStore.js'
import type { ReviewArtifactVersion } from '../../utils/artifacts/reviewContracts.js'
import { lanesEnabled, listLanes } from '../../services/contextLanes/lanes.js'
import { gitWorktrees } from '../../services/gitGraph/observe.js'
import { laneDisplayName } from '../../services/workbench/selectors.js'
import { getCwd } from '../../utils/cwd.js'

export type WorkspaceDiffSource =
  | { type: 'current' }
  | { type: 'unstaged' }
  | { type: 'staged' }
  | { type: 'branch'; base: string; spec: GitDiffSpec }
  | { type: 'lane'; label: string; worktreePath: string }
  | { type: 'handoff'; laneId: string; label: string; paths: string[] }
  | { type: 'artifact'; artifactId: string; label: string }
  | { type: 'turn'; turn: TurnDiff }

/** Stable identity for comment-artifact binding + selection carry. */
export function sourceKey(s: WorkspaceDiffSource): string {
  switch (s.type) {
    case 'current':
      return 'current'
    case 'unstaged':
      return 'unstaged'
    case 'staged':
      return 'staged'
    case 'branch':
      return `branch:${s.base}`
    case 'lane':
      return `lane:${s.worktreePath}`
    case 'handoff':
      return `handoff:${s.laneId}`
    case 'artifact':
      return `artifact:${s.artifactId}`
    case 'turn':
      return `turn:${s.turn.turnIndex}`
  }
}

export function sourceLabel(s: WorkspaceDiffSource): string {
  switch (s.type) {
    case 'current':
      return 'Current'
    case 'unstaged':
      return 'Unstaged'
    case 'staged':
      return 'Staged'
    case 'branch':
      return `Branch~${s.base}`
    case 'lane':
      return `wt:${s.label}`
    case 'handoff':
      return `H:${s.label}`
    case 'artifact':
      return `A:${s.label}`
    case 'turn':
      return `T${s.turn.turnIndex}`
  }
}

export function sourceTitle(s: WorkspaceDiffSource): { title: string; subtitle: string } {
  switch (s.type) {
    case 'current':
      return { title: 'Uncommitted changes', subtitle: '(git diff HEAD)' }
    case 'unstaged':
      return { title: 'Unstaged changes', subtitle: '(git diff)' }
    case 'staged':
      return { title: 'Staged changes', subtitle: '(git diff --cached)' }
    case 'branch':
      return { title: 'Branch vs base', subtitle: `(merge-base ${s.base}…HEAD)` }
    case 'lane':
      return { title: `Lane ${s.label}`, subtitle: s.worktreePath }
    case 'handoff':
      return { title: `Handoff ${s.label}`, subtitle: `${s.paths.length} observed path(s)` }
    case 'artifact':
      return { title: `Artifact ${s.label}`, subtitle: 'stored versions' }
    case 'turn':
      return {
        title: `Turn ${s.turn.turnIndex}`,
        subtitle: s.turn.userPromptPreview ? `"${s.turn.userPromptPreview}"` : '',
      }
  }
}

/** The standing summary card's 'source' value — DESCRIPTIVE per source
 *  (the earlier vocabulary for the pre-existing sources is preserved
 *  byte-for-byte: 'uncommitted (HEAD)' and 'turn N'). */
export function sourceSummaryValue(s: WorkspaceDiffSource): string {
  switch (s.type) {
    case 'current':
      return 'uncommitted (HEAD)'
    case 'turn':
      return `turn ${s.turn.turnIndex}`
    case 'unstaged':
      return 'unstaged (worktree)'
    case 'staged':
      return 'staged (index)'
    case 'branch':
      return `vs base ${s.base}`
    case 'lane':
      return `worktree ${s.label}`
    case 'handoff':
      return `handoff ${s.label}`
    case 'artifact':
      return `artifact ${s.label}`
  }
}

/** The git spec a source resolves through — null for non-git sources. */
export function sourceGitSpec(s: WorkspaceDiffSource): GitDiffSpec | null {
  switch (s.type) {
    case 'current':
      return { args: ['HEAD'], includeUntracked: true }
    case 'unstaged':
      return { args: [], includeUntracked: true }
    case 'staged':
      return { args: ['--cached'] }
    case 'branch':
      // The spec is resolved at ENUMERATION (merge-base) and carried on the
      // source — a null here silently rendered the HEAD diff under the
      // Branch header (verify wave, UI finding 1).
      return s.spec
    case 'lane':
      return { args: ['HEAD'], cwd: s.worktreePath, includeUntracked: true }
    case 'handoff':
      return { args: ['HEAD', '--', ...s.paths] }
    default:
      return null
  }
}

// ── artifact DiffData (stored bodies; no patch parsing) ─────────────────────

function markdownOf(v: ReviewArtifactVersion): string | null {
  return 'markdown' in v.body ? v.body.markdown : null
}

export function artifactDiffData(artifactId: string): DiffData {
  const state = readReviewArtifactState(artifactId)
  if (!state) return { stats: null, files: [], hunks: new Map(), loading: false }
  const latest = state.versions[state.versions.length - 1]!

  if (latest.body.kind === 'diff') {
    // A stored diff body IS hunks — passthrough, never reparse.
    const hunks = new Map<string, StructuredPatchHunk[]>()
    const files = latest.body.files.map(f => {
      hunks.set(f.path, f.hunks as StructuredPatchHunk[])
      let added = 0
      let removed = 0
      for (const h of f.hunks) {
        for (const line of h.lines) {
          if (line.startsWith('+')) added++
          else if (line.startsWith('-')) removed++
        }
      }
      return {
        path: f.path,
        linesAdded: added,
        linesRemoved: removed,
        isBinary: false,
        isLargeFile: false,
        isTruncated: false,
      }
    })
    return {
      stats: {
        filesCount: files.length,
        linesAdded: files.reduce((a, f) => a + f.linesAdded, 0),
        linesRemoved: files.reduce((a, f) => a + f.linesRemoved, 0),
      },
      files,
      hunks,
      loading: false,
    }
  }

  // Markdown-bodied kinds: latest version against its predecessor via the
  // SAME structuredPatch producer the edit tools use.
  const prior = state.versions.find(v => v.version === latest.version - 1)
  const before = prior ? (markdownOf(prior) ?? '') : ''
  const after = markdownOf(latest) ?? ''
  const label = `${state.id}.md`
  const patch = structuredPatch(label, label, before, after, undefined, undefined, { context: 3 })
  const hunks = new Map<string, StructuredPatchHunk[]>()
  if (patch.hunks.length > 0) hunks.set(label, patch.hunks)
  let added = 0
  let removed = 0
  for (const h of patch.hunks) {
    for (const line of h.lines) {
      if (line.startsWith('+')) added++
      else if (line.startsWith('-')) removed++
    }
  }
  return {
    stats: { filesCount: patch.hunks.length > 0 ? 1 : 0, linesAdded: added, linesRemoved: removed },
    files:
      patch.hunks.length > 0
        ? [
            {
              path: label,
              linesAdded: added,
              linesRemoved: removed,
              isBinary: false,
              isLargeFile: false,
              isTruncated: false,
            },
          ]
        : [],
    hunks,
    loading: false,
  }
}

// ── source enumeration (bounded; every leg failure-isolated) ────────────────

// per-family source budgets (the old single MAX_EXTRA_SOURCES=8
// early-return let a worktree flood starve handoffs/artifacts out of existence).
const MAX_LANE_SOURCES = 4
const MAX_HANDOFF_SOURCES = 3
const MAX_ARTIFACT_SOURCES = 3

export async function enumerateExtraSources(sessionId: string | null): Promise<WorkspaceDiffSource[]> {
  const out: WorkspaceDiffSource[] = []

  try {
    const branch = await branchDiffSpec()
    if (branch) out.push({ type: 'branch', base: branch.base, spec: branch.spec })
  } catch {
    /* no branch source */
  }

  // PER-FAMILY budgets, not one global early-return cap.
  // The old shape enumerated lanes first and RETURNED at MAX_EXTRA_SOURCES,
  // so a stale-worktree flood (19 observed live) didn't just push handoff and
  // artifact sources right — it prevented them from being enumerated at all.
  // Each family now has its own bound; no family can starve another.
  try {
    const worktrees = gitWorktrees(getCwd())
    if (Array.isArray(worktrees)) {
      let laneBudget = MAX_LANE_SOURCES
      for (const wt of worktrees) {
        if (wt.isMain) continue
        if (laneBudget-- <= 0) break
        // the shared lane display-name derivation (workbench
        // selectors) — a lane reads the same on /workbench and this strip.
        out.push({
          type: 'lane',
          label: laneDisplayName({ worktreePath: wt.path }).slice(0, 14),
          worktreePath: wt.path,
        })
      }
    }
  } catch {
    /* no lane sources */
  }

  try {
    if (lanesEnabled()) {
      let handoffBudget = MAX_HANDOFF_SOURCES
      for (const lane of listLanes(sessionId ? { parentSessionId: sessionId } : undefined)) {
        if (!lane.handoff || lane.handoff.changedPaths.length === 0) continue
        if (handoffBudget-- <= 0) break
        out.push({
          type: 'handoff',
          laneId: lane.id,
          label: lane.goal.slice(0, 12),
          paths: lane.handoff.changedPaths.slice(0, 50),
        })
      }
    }
  } catch {
    /* no handoff sources */
  }

  try {
    // Project-scoped: the home store may hold other projects' artifacts.
    let artifactBudget = MAX_ARTIFACT_SOURCES
    for (const head of listReviewArtifactHeads({ root: getCwd() })) {
      const isDiffKind = head.kind === 'diff'
      const hasCompare = head.latestVersion >= 2
      if (!isDiffKind && !hasCompare) continue
      if (artifactBudget-- <= 0) break
      out.push({
        type: 'artifact',
        artifactId: head.id,
        label: head.title.slice(0, 14),
      })
    }
  } catch {
    /* no artifact sources */
  }

  return out
}
