#!/usr/bin/env bun
// ============================================================================
//  scripts/engine-durability/prove-source-truth.ts — M0 reproducer for defect H, the
//  unreadable-source conflation. FIVE confirmed sites, not the three the
//  source advisory found.
//
//  ORACLE: a source that could not be READ is not the same fact as a source
//  that was read and held nothing. A denied or unreadable sidecar is never
//  reported as absent; an artifact-store read failure never becomes
//  "0 reviews". This is the module's OWN stated law — projection.ts applies it
//  correctly for partySeats, treeDigest and the main-run fallback (all degrade
//  to null). The five sites below are the inconsistency, not a missing design.
//
//  What the code does today:
//    · loadRunSidecar   — `catch { return { state: 'none' } }` over EVERY read
//                         failure, so EISDIR/EACCES reads as "no run exists";
//    · classifyRecovery — `catch { return { state: 'none' } }`, same shape;
//    · listArtifactHeadFacts / listContextLaneFacts — `catch { return [] }`
//                         over a store enumeration that threw;
//    · listGitWorktreeLanes — `if (!Array.isArray(worktrees)) return []`,
//                         which DISCARDS the typed GitUnavailable the source
//                         already returns.
//
//  Induction is deterministic and uid-independent: an unreadable sidecar is a
//  DIRECTORY at the sidecar path (EISDIR), and an unreadable store root is a
//  FILE where a directory is expected (ENOTDIR) — both exist, so neither can
//  be mistaken for an honest absence.
//
//  The contract the fix must provide, named here so this reproducer is a
//  specification: a read failure that is not ENOENT never resolves to the
//  absent state, and the workbench snapshot carries a per-source state
//  (`sources`) whose vocabulary distinguishes unavailable from empty.
// ============================================================================

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { checker, scratchRoot, guardWrite } from './harness.ts'

const ROOT = scratchRoot('sourcetruth')
const t = checker()

const { makeOwnerKey } = await import('../../src/services/run/ownerKey.ts')
const sidecar = await import('../../src/services/run/runSidecar.ts')
const currentWork = await import('../../src/services/workbench/currentWork.ts')

// ── §1 an unreadable run sidecar is not an absent run ───────────────────────
t.section('§1 — an unreadable sidecar is not reported as "no run"')
const unreadableOwner = makeOwnerKey({ workspace: ROOT, sessionId: 'keel-unreadable', lane: 'main' })
{
  const path = guardWrite(ROOT, sidecar.runSidecarPath(unreadableOwner))
  // A DIRECTORY at the sidecar path: it exists, and reading it is EISDIR.
  mkdirSync(path, { recursive: true })

  const load = await sidecar.loadRunSidecar(unreadableOwner)
  t.check(
    'loadRunSidecar distinguishes unreadable from absent',
    load.state !== 'none',
    `state=${load.state} (the sidecar path exists and cannot be read)`,
  )
}

// ── §2 the recovery classifier carries that distinction ────────────────────
t.section('§2 — the recovery classifier does not flatten unreadable to none')
{
  const recovery = await currentWork.classifyRecovery(unreadableOwner, null)
  t.check(
    'classifyRecovery reports the unreadable source rather than "none"',
    recovery.state !== 'none',
    `state=${recovery.state}`,
  )
}

// ── §3–§5 unreadable projection sources are not empty collections ──────────
t.section('§3–§5 — unreadable workbench sources are not rendered as empty')
{
  // A FILE where each store root should be a directory: exists, ENOTDIR on
  // enumeration. And a workspace that is not a git repository, which the git
  // observer already reports as a typed unavailable.
  const workspace = join(ROOT, 'workspace')
  mkdirSync(workspace, { recursive: true })
  writeFileSync(guardWrite(ROOT, join(ROOT, 'review-artifacts')), 'not a directory')
  writeFileSync(guardWrite(ROOT, join(ROOT, 'lanes')), 'not a directory')

  const bootstrap = await import('../../src/bootstrap/state.ts')
  bootstrap.setOriginalCwd(workspace)
  bootstrap.setCwdState(workspace)

  const projection = await import('../../src/services/workbench/projection.ts')
  projection._resetWorkbenchForTesting()
  const snap = (await projection.resolveWorkbenchSnapshot()) as
    | (Record<string, unknown> & { artifactHeads?: unknown[]; lanes?: unknown[] })
    | null

  t.check('the workbench snapshot resolved', snap !== null, snap === null ? 'null snapshot' : '')

  const sources = (snap?.sources ?? null) as Record<string, { state?: string }> | null
  t.check(
    'the snapshot carries per-source states',
    sources !== null,
    sources === null ? 'no `sources` on WorkbenchSnapshot' : '',
  )
  for (const id of ['artifacts', 'contextLanes', 'gitWorktrees'] as const) {
    t.check(
      `source "${id}" reports unavailable rather than empty`,
      sources?.[id]?.state === 'unavailable',
      `state=${String(sources?.[id]?.state)}`,
    )
  }
}

t.finish('prove-source-truth')
