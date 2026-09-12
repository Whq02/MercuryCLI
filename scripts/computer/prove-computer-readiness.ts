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

section('§1 disabled when the switch is =0; the rest of the proof reads the default (unset)')
{
  process.env.MERCURY_COMPUTER_USE = '0'
  resetDesktopDriverForTest()
  const record = row()
  check('the row exists with kind tool and the resolver as its source', record !== undefined && record.kind === 'tool' && record.source === 'desktop driver resolver', JSON.stringify(record))
  check('state disabled naming =0 and the untouched driver', record?.state === 'disabled' && record.detail === 'MERCURY_COMPUTER_USE=0 — Computer tool absent from the catalog; no desktop driver is touched', JSON.stringify(record))
  delete process.env.MERCURY_COMPUTER_USE
}

section('§2 configured with the fake driver and nothing driving')
{
  process.env.MERCURY_DESKTOP_DRIVER = 'fake'
  resetDesktopDriverForTest()
  const record = row()
  check('state configured, the detail names the resolved driver, that no session is driving and the access type', record?.state === 'configured' && /driver fake resolved/.test(record.detail) && record.detail.includes('no session driving · access asks'), JSON.stringify(record))
  check('the detail is under 300 characters', (record?.detail.length ?? 999) < 300)
  const label = record?.label ?? ''
  check('the label names the Computer tool', label.toLowerCase().includes('computer'), label)
}

section('§3 unavailable when the driver is switched off')
{
  process.env.MERCURY_DESKTOP_DRIVER = 'none'
  resetDesktopDriverForTest()
  const record = row()
  check('state unavailable naming the switch and the absent tool', record?.state === 'unavailable' && record.detail.includes('MERCURY_DESKTOP_DRIVER=none') && record.detail.endsWith('— Computer tool absent from the catalog'), JSON.stringify(record))
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

section('§7 the access words beside the switch: the setting in words, the posture read where the doctor reads it')
{
  const { computerAccessWords } = await import('../../src/services/desktop/computerAccess.ts')
  delete process.env.MERCURY_COMPUTER_ACCESS
  delete process.env.MERCURY_SKIP_PERMISSIONS
  check('unset with Sovereign mode off: access asks', computerAccessWords() === 'access asks' && row()?.detail.endsWith('access asks') === true, JSON.stringify(row()))
  process.env.MERCURY_COMPUTER_ACCESS = 'permissive'
  check('permissive saved: access permissive', computerAccessWords() === 'access permissive' && row()?.detail.endsWith('access permissive') === true, JSON.stringify(row()))
  process.env.MERCURY_COMPUTER_ACCESS = 'full'
  check('full saved: access full (saved)', computerAccessWords() === 'access full (saved)' && row()?.detail.endsWith('access full (saved)') === true, JSON.stringify(row()))
  delete process.env.MERCURY_COMPUTER_ACCESS
  process.env.MERCURY_SKIP_PERMISSIONS = '1'
  check('unset with Sovereign mode on: access full (by sovereign mode)', computerAccessWords() === 'access full (by sovereign mode)' && row()?.detail.endsWith('access full (by sovereign mode)') === true, JSON.stringify(row()))
  process.env.MERCURY_COMPUTER_ACCESS = 'asks'
  check('asks saved with Sovereign mode on: access asks — a saved value wins', computerAccessWords() === 'access asks', computerAccessWords())
  delete process.env.MERCURY_COMPUTER_ACCESS
  delete process.env.MERCURY_SKIP_PERMISSIONS
  const driver = sourceText('src/services/desktop/nativeDriver.ts')
  check("the doctor's Computer use line carries the same words after the switch", driver.includes('`on · ${computerAccessWords()}`'))
}

finish('prove-computer-readiness')
