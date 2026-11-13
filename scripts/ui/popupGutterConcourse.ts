import { mock } from 'bun:test'
import type * as React from 'react'
import type { Mounted } from '../lib/settingsPopupHarness.ts'
import { settledFrame } from './popupFrameSettle.ts'

type Rect = { left: number; right: number; top: number; bottom: number }
export async function concoursePopupFrames({ sizes, wrap, mount, check, judge, save }: {
  sizes: string[]
  wrap: (node: React.ReactNode) => React.ReactNode
  mount: (node: React.ReactNode, columns: number, rows: number) => Promise<Mounted>
  check: (label: string, ok: boolean, detail?: string) => void
  judge: (label: string, lines: string[], title: string, host: Rect, columns: number, rows: number) => void
  save: (name: string, lines: string[]) => void
}): Promise<void> {
  const { createElement: h } = await import('react')
  const { ConcourseScreen, _resetConcourseCapsuleForTesting, armSignInPickerReturn } = await import('../../src/components/concourse/ConcourseScreen.tsx')
  const { referenceFixtureSnapshot } = await import('../notifications/concourseReferenceSeed.ts')
  const { resetChromeModeLatchForTests } = await import('../../src/hooks/useLayoutTier.ts')
  const { resetOverlayStackForTests } = await import('../../src/context/overlayStack.ts')
  const { saveGlobalConfig } = await import('../../src/utils/config.ts')
  const { getCwd } = await import('../../src/utils/cwd.ts')
  const workers = await import('../../src/daemon/concourseWorkers.ts')
  mock.module('../../src/daemon/concourseWorkers.ts', () => ({ ...workers, effectiveSeatCeiling: () => 1 }))
  const capacity = await import('../../src/services/switchboard/capacityCheck.ts')
  let ask = false
  mock.module('../../src/services/switchboard/capacityCheck.ts', () => ({ ...capacity, needsCapacityAsk: () => ask, effectiveSeatCeiling: () => 1 }))
  const callbacks = new Proxy({}, { get: () => async () => undefined })
  type Snapshot = import('../../src/components/concourse/contracts.ts').ConcourseSnapshotV1
  const surfaces = [
    { name: 'concourse-default', title: 'Mercury · model', door: 'default' },
    { name: 'concourse-model', title: 'Mercury · model', door: 'model' },
    { name: 'concourse-effort', title: 'EFFORT', door: 'effort' },
    { name: 'concourse-atlas', title: 'CONCOURSE — keys', door: 'atlas' },
    { name: 'concourse-capacity', title: 'FIRST BOOT', door: 'capacity' },
    { name: 'concourse-ground', title: 'REPO —', door: 'ground' },
    { name: 'concourse-trust', title: 'UNTRUSTED FOLDER', door: 'trust' },
    { name: 'concourse-git', title: 'Start a git repository', door: 'git' },
  ]
  for (const size of sizes) {
    const [columns, rows] = size.split('x').map(Number) as [number, number]
    for (const surface of surfaces) {
      _resetConcourseCapsuleForTesting()
      resetChromeModeLatchForTests()
      resetOverlayStackForTests()
      ask = surface.door === 'capacity'
      saveGlobalConfig(c => ({ ...c, switchboardCapacity: { askedAt: 1, allowed: false, recommendedSeats: 1 } }))
      const snapshot = referenceFixtureSnapshot() as unknown as Snapshot
      snapshot.needsYou = surface.door === 'git' ? [{ ...snapshot.needsYou[0]!, obligationId: 'fixture-git', sessionId: 'folder:/fixture', ref: 'permission:git-init:fixture' }] : []
      snapshot.counts.live = 4
      const row = snapshot.groups.flatMap(g => g.rows)[0]!
      row.workspaceDir = getCwd()
      if (surface.door === 'ground' || surface.door === 'trust') {
        row.state = 'elsewhere'
        row.door = surface.door === 'ground' ? { kind: 'pick-project', more: 1 } : { kind: 'switch-project', dir: '/untrusted-popup-fixture', running: 1, needsYou: 0, finished: 0 }
      }
      if (surface.door === 'default') armSignInPickerReturn({ kind: 'default' })
      if (surface.door === 'model') armSignInPickerReturn({ kind: 'session', sessionId: row.sessionId, title: row.title })
      const reducedStage = ['effort', 'ground', 'trust', 'atlas'].includes(surface.door)
      const scene = await mount(wrap(h(ConcourseScreen, { snapshot, callbacks: callbacks as never, reducedStage })), columns, rows)
      await settledFrame(scene)
      if (surface.door === 'effort') scene.push('e')
      if (surface.door === 'ground' || surface.door === 'trust') scene.push('\r')
      if (surface.door === 'atlas') scene.push('?')
      const opened = await settledFrame(scene, frame => frame.includes(surface.title))
      const lines = scene.lines()
      save(`${surface.name}-${size}`, lines)
      check(`${surface.name} ${size}: the source popup opened`, opened, lines.filter(line => /fault|refused/.test(line)).join(' | '))
      judge(`${surface.name} ${size}`, lines, surface.title, { left: 0, right: columns - 1, top: 0, bottom: rows - 1 }, columns, rows)
      scene.unmount()
    }
  }
  mock.restore()
  resetOverlayStackForTests()
}
