#!/usr/bin/env bun
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { check, finish, freshSignal, scratchDir, section, sourceText } from './computerProofKit.ts'

const { collectReadiness } = await import('../../src/utils/readiness.ts')
const { resetDesktopDriverForTest } = await import('../../src/services/desktop/resolveDriver.ts')
const { claimDesktop, releaseDesktopClaim } = await import('../../src/services/desktop/desktopClaim.ts')
const { desktopSnapshot } = await import('../../src/services/desktop/desktopSession.ts')
type ReadinessRecord = import('../../src/utils/readiness.ts').ReadinessRecord

const scratch = scratchDir('readiness')
const row = (opts?: { includeEnv?: boolean }): ReadinessRecord | undefined => collectReadiness(opts).records.find(r => r.id === 'tool:computer')

section('§1 disabled when the flag is unset')
{
  delete process.env.MERCURY_COMPUTER_USE
  resetDesktopDriverForTest()
  const record = row()
  check('the row exists with kind tool and the resolver as its source', record !== undefined && record.kind === 'tool' && record.source === 'desktop driver resolver', JSON.stringify(record))
  check('state disabled with the flag named', record?.state === 'disabled' && record.detail === 'MERCURY_COMPUTER_USE unset — Computer tool absent from the catalog', JSON.stringify(record))
  process.env.MERCURY_COMPUTER_USE = '1'
}

section('§2 configured with the fake driver and nothing driving')
{
  process.env.MERCURY_DESKTOP_DRIVER = 'fake'
  resetDesktopDriverForTest()
  const record = row()
  check('state configured, the detail names the resolved driver and that no session is driving', record?.state === 'configured' && /driver fake resolved/.test(record.detail) && record.detail.includes('no session driving'), JSON.stringify(record))
  check('the detail is under 300 characters', (record?.detail.length ?? 999) < 300)
  const label = record?.label ?? ''
  check('the label names the Computer tool', label.toLowerCase().includes('computer'), label)
}

section('§3 unavailable when the driver is switched off')
{
  process.env.MERCURY_DESKTOP_DRIVER = 'none'
  resetDesktopDriverForTest()
  const record = row()
  check('state unavailable naming the switch', record?.state === 'unavailable' && record.detail.includes('MERCURY_DESKTOP_DRIVER=none'), JSON.stringify(record))
  process.env.MERCURY_DESKTOP_DRIVER = 'fake'
  resetDesktopDriverForTest()
}

section('§4 degraded when a grant is denied')
{
  const scene = join(scratch, 'denied.json')
  writeFileSync(scene, JSON.stringify({ permissions: { session: 'desktop', screenCapture: 'granted', input: 'denied', reason: 'no accessibility grant' } }))
  process.env.MERCURY_DESKTOP_FAKE_SCENE = scene
  resetDesktopDriverForTest()
  const record = row()
  check('state degraded naming the denied grant', record?.state === 'degraded' && record.detail.includes('denied'), JSON.stringify(record))
  delete process.env.MERCURY_DESKTOP_FAKE_SCENE
  resetDesktopDriverForTest()
}

section('§5 ready while a session is driving')
{
  const verdict = await claimDesktop(freshSignal())
  check('the claim is taken in the scratch home', verdict.held === true, JSON.stringify(verdict))
  check("the driving snapshot reads 'driving'", desktopSnapshot().phase === 'driving', JSON.stringify(desktopSnapshot()))
  const record = row()
  check('state ready with the driving detail', record?.state === 'ready' && record.detail.includes('driving'), JSON.stringify(record))
  await releaseDesktopClaim()
  check("after the release the snapshot reads 'idle' and the row is configured again", desktopSnapshot().phase === 'idle' && row()?.state === 'configured', JSON.stringify(row()))
}

section('§6 the health seam and the doctor row')
{
  const record = row({ includeEnv: false })
  check('collectReadiness({ includeEnv: false }) carries the same row', record !== undefined && record.id === 'tool:computer' && record.state === 'configured', JSON.stringify(record))
  const health = sourceText('src/utils/healthReport.ts')
  check("healthReport.ts carries the doctor row id 'iface-computer-use'", health.includes("'iface-computer-use'"))
  check("healthReport.ts labels it 'Computer use'", health.includes("'Computer use'"))
}

finish('prove-computer-readiness')
