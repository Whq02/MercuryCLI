#!/usr/bin/env bun

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { checker, scratchRoot, guardWrite } from './harness.ts'

const ROOT = scratchRoot('sourcetruth')
const t = checker()

const { makeOwnerKey } = await import('../../src/services/run/ownerKey.ts')
const sidecar = await import('../../src/services/run/runSidecar.ts')
const currentWork = await import('../../src/services/workbench/currentWork.ts')

t.section('§1 — an unreadable sidecar is not reported as "no run"')
const unreadableOwner = makeOwnerKey({ workspace: ROOT, sessionId: 'keel-unreadable', lane: 'main' })
{
  const path = guardWrite(ROOT, sidecar.runSidecarPath(unreadableOwner))
  mkdirSync(path, { recursive: true })

  const load = await sidecar.loadRunSidecar(unreadableOwner)
  t.check(
    'loadRunSidecar distinguishes unreadable from absent',
    load.state !== 'none',
    `state=${load.state} (the sidecar path exists and cannot be read)`,
  )
}

t.section('§2 — the recovery classifier does not flatten unreadable to none')
{
  const recovery = await currentWork.classifyRecovery(unreadableOwner, null)
  t.check(
    'classifyRecovery reports the unreadable source rather than "none"',
    recovery.state !== 'none',
    `state=${recovery.state}`,
  )
}

t.section('§3–§5 — unreadable workbench sources are not rendered as empty')
{
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
