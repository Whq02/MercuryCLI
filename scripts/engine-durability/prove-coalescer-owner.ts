#!/usr/bin/env bun

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { checker, scratchRoot, waitUntil } from './harness.ts'

scratchRoot('coalescer')
const t = checker()

const bootstrap = await import('../../src/boot/process-state/processState.ts')
bootstrap.setIsInteractive(false)
const { enableConfigs } = await import('../../src/platform/config/globalConfig.ts')
enableConfigs()

const projection = await import('../../src/screen/workbench/projection.ts')
const version = (): number => projection.getWorkbenchSnapshot()?.version ?? 0
const stamp = (): number | undefined => projection.getWorkbenchSnapshot()?.gatherGeneration
await projection.gatherWorkbenchInputs({})

t.section('§1 — a stopped engine mints a FRESH lane on restart')
{
  projection._resetWorkbenchForTesting()
  const unsub1 = projection.subscribeWorkbench(() => {})
  const filled = await waitUntil(() => version() > 0)
  t.check('first engine start reached its initial fill', filled, `version=${version()}`)
  const afterFirst = version()

  unsub1()
  const unsub2 = projection.subscribeWorkbench(() => {})
  const restarted = await waitUntil(() => version() > afterFirst)
  t.check(
    'a second engine start still refreshes (the released-lane trap)',
    restarted,
    `version ${afterFirst} → ${version()}`,
  )
  unsub2()
  projection._resetWorkbenchForTesting()
}

t.section('§2 — the snapshot names the trigger generation it observed')
{
  projection._resetWorkbenchForTesting()
  const unsub = projection.subscribeWorkbench(() => {})
  const filled = await waitUntil(() => version() > 0)
  t.check('engine reached its initial fill', filled, `version=${version()}`)

  const first = stamp()
  t.check(
    'the initial fill carries a gather generation',
    typeof first === 'number' && first >= 1,
    `gatherGeneration=${String(first)}`,
  )

  const before = version()
  projection.pokeWorkbench()
  projection.pokeWorkbench()
  await waitUntil(() => version() >= before + 2)
  const later = stamp()
  t.check(
    'the stamp advances to the last accepted trigger',
    typeof later === 'number' && typeof first === 'number' && later > first,
    `gatherGeneration ${String(first)} → ${String(later)}`,
  )

  unsub()
  projection._resetWorkbenchForTesting()
}


t.finish('prove-coalescer-owner')
