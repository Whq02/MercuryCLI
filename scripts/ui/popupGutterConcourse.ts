import { mock } from 'bun:test'
import type * as React from 'react'
import type { Mounted } from '../lib/settingsPopupHarness.ts'

type Rect = { left: number; right: number; top: number; bottom: number }
export async function concoursePopupFrames({ sizes, wrap, mount, settle, waitFor, check, judge, save }: {
  sizes: string[]
  wrap: (node: React.ReactNode) => React.ReactNode
  mount: (node: React.ReactNode, columns: number, rows: number) => Promise<Mounted>
  settle: (ms: number) => Promise<void>
  waitFor: (predicate: () => boolean, ms: number) => Promise<boolean>
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
  const supervisor = await import('../../src/daemon/concourseSupervisor.ts')
  mock.module('../../src/daemon/concourseSupervisor.ts', () => ({ ...supervisor, effectiveSeatCeiling: () => 1 }))
  const capacity = await import('../../src/services/switchboard/capacityCheck.ts')
  let ask = false
  mock.module('../../src/services/switchboard/capacityCheck.ts', () => ({ ...capacity, needsCapacityAsk: () => ask, effectiveSeatCeiling: () => 1 }))
  const conversation = await import('../../src/services/concourse/coordinatorConversation.ts')
  let manager = false
  const plan = { goal: 'Fixture plan', lanes: [{ title: 'Fixture task', scope: 'read', deliverables: 'report', territory: 'fixture/**' }], seats: 'one', supervision: 'supervising', state: 'proposed' }
  mock.module('../../src/services/concourse/coordinatorConversation.ts', () => ({ ...conversation, readCoordinatorConversation: async () => manager ? [{ id: 'fixture-plan', role: 'coordinator', text: 'Fixture plan', ts: 1, plan }] : [] }))
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
    { name: 'concourse-coordinator', title: 'COORDINATOR', door: 'coordinator' },
    { name: 'concourse-seat', title: "Past the machine's reading", door: 'seat' },
    { name: 'concourse-manager-seat', title: "Past the machine's reading", door: 'manager' },
    { name: 'concourse-git', title: 'Start a git repository', door: 'git' },
  ]
  for (const size of sizes) {
    const [columns, rows] = size.split('x').map(Number) as [number, number]
    for (const surface of surfaces) {
      if (columns < 100 && ['coordinator', 'seat', 'manager'].includes(surface.door)) continue
      manager = surface.door === 'manager'
      _resetConcourseCapsuleForTesting()
      resetChromeModeLatchForTests()
      resetOverlayStackForTests()
      ask = surface.door === 'capacity'
      saveGlobalConfig(c => ({ ...c, switchboardCapacity: { askedAt: 1, allowed: false, recommendedSeats: 1 } }))
      const snapshot = referenceFixtureSnapshot() as unknown as Snapshot
      snapshot.needsYou = surface.door === 'git' ? [{ ...snapshot.needsYou[0]!, obligationId: 'fixture-git', sessionId: 'folder:/fixture', ref: 'permission:git-init:fixture' }] : []
      snapshot.counts.live = 4
      snapshot.coordinator = { mode: 'rules-only' }
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
      await settle(250)
      if (surface.door === 'effort') scene.push('e')
      if (surface.door === 'ground' || surface.door === 'trust') scene.push('\r')
      if (surface.door === 'atlas') scene.push('?')
      if (surface.door === 'coordinator') scene.push('\x13')
      if (surface.door === 'seat') { scene.push('a fixture dispatch'); await settle(40); scene.push('\r') }
      if (surface.door === 'manager') {
        scene.push('\x1b[Z')
        await waitFor(() => scene.screen().includes("The manager's plan"), 4000)
        scene.push('\r')
      }
      const opened = await waitFor(() => scene.screen().includes(surface.title), 4000)
      await settle(100)
      const lines = scene.lines()
      save(`${surface.name}-${size}`, lines)
      check(`${surface.name} ${size}: the source popup opened`, opened, lines.filter(line => /fault|refused|COORDINATOR/.test(line)).join(' | '))
      if (['coordinator', 'git'].includes(surface.door) && columns >= 120) check(`${surface.name} ${size}: the wide coordinator is an inline pane, not a floating box`, opened)
      else judge(`${surface.name} ${size}`, lines, surface.title, { left: 0, right: columns - 1, top: 0, bottom: rows - 1 }, columns, rows)
      scene.unmount()
    }
  }
  mock.restore()
  resetOverlayStackForTests()
}
