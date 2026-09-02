#!/usr/bin/env bun
// ============================================================================
//  prove-surface-boundary — the route-surface host contains its surface.
//
//  The router's own docblock records the recovery road: the root REPL tree
//  stays MOUNTED for the whole process lifetime beneath any route surface.
//  Yet the surface itself (the board — a ~2,000-line live-data control
//  plane reading rosters, worktrees and transcripts off disk — or the Boot
//  face) rendered BARE: one render throw anywhere inside it reached the
//  app-root boundary, which persists a report and ENDS THE PROCESS — every
//  mounted chat beneath died with a screen that was one route away from a
//  live session. The law: entry.render(route) sits inside a
//  SurfaceErrorBoundary whose catch persists a 'surface'-origin crash
//  report and paints an honest full-viewport card — the crash costs the
//  screen, never the process, and the card names only moves that truly
//  fire (the present-moves strip resolver + the exit chord's one notice).
//
//  §1 the render seam is wrapped
//  §2 the boundary is real (catch + persist + the honest card's sources)
//  §3 the crash-report origin carries the surface arm
// ============================================================================
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(import.meta.dir, '..', '..')
const router = readFileSync(join(ROOT, 'src', 'components', 'SurfaceRouter.tsx'), 'utf8')
const crash = readFileSync(join(ROOT, 'src', 'utils', 'crashReport.ts'), 'utf8')

let failures = 0
const t = (name: string, ok: boolean, detail = ''): void => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && detail ? ` — ${detail}` : ''}`)
  if (!ok) failures = 1
}

// §1 the one render seam, wrapped
{
  const seams = router.match(/entry\.render\(route\)/g) ?? []
  t('§1 the router has exactly one surface render seam', seams.length === 1, `${seams.length} seams`)
  const at = router.indexOf('entry.render(route)')
  const above = router.slice(Math.max(0, at - 600), at)
  t('§1 the seam sits inside SurfaceErrorBoundary', above.includes('<SurfaceErrorBoundary'), 'a bare surface render — one throw ends the process and every chat beneath')
}

// §2 the boundary is real
{
  t('§2 the boundary class exists in the router module', /class SurfaceErrorBoundary extends React\.Component/.test(router))
  t('§2 …with the derived error state', /static getDerivedStateFromError/.test(router))
  t('§2 …persisting a surface-origin crash report in its catch', /persistCrashReport\(error, errorInfo, 'surface'\)/.test(router))
  t('§2 the card names the report path from the one display helper', router.includes('crashReportDirDisplay()'))
  t('§2 the card derives its moves from the present-moves resolver', router.includes('stripKeyMapHint()'))
  t('§2 the card reuses the exit chord\'s one notice', router.includes('exitChordNoticeText(null)'))
}

// §3 the origin arm
{
  t('§3 persistCrashReport accepts the surface origin', /'app-root' \| 'message-boundary' \| 'boot' \| 'surface'/.test(crash))
}

// §4 the fault-injection arm (A5's capture road): the crash card must be
// CAPTURABLE by a driven run — a real surface throw is not scriptable, so
// MERCURY_FAULT_INJECT_SURFACE names a route kind whose entry throws as the
// boundary's FIRST child. Unset is byte-identical.
{
  t('§4 the arm exists and throws inside the boundary', router.includes('function SurfaceFaultInjection') && router.includes("flagEnv('MERCURY_FAULT_INJECT_SURFACE')"))
  const boundaryAt = router.indexOf('<SurfaceErrorBoundary kind={route.kind}>')
  const armAt = router.indexOf('<SurfaceFaultInjection kind={route.kind} />')
  const renderAt = router.indexOf('{entry.render(route)}')
  t('§4 …mounted as the boundary\'s first child, ahead of the surface render', boundaryAt !== -1 && armAt > boundaryAt && renderAt > armAt)
  const { flagEnv } = await import('../../src/substrate/flagRegistry.ts')
  const { SurfaceFaultInjection } = await import('../../src/components/SurfaceRouter.tsx')
  delete process.env.MERCURY_FAULT_INJECT_SURFACE
  t('§4 unset ⇒ renders nothing (byte-identical)', SurfaceFaultInjection({ kind: 'concourse' }) === null)
  process.env.MERCURY_FAULT_INJECT_SURFACE = 'concourse'
  t('§4 the registry row exists (flagEnv resolves — an unregistered read THROWS)', flagEnv('MERCURY_FAULT_INJECT_SURFACE') === 'concourse')
  let threw = false
  try {
    SurfaceFaultInjection({ kind: 'concourse' })
  } catch (error) {
    threw = /fault injection: surface 'concourse'/.test(String(error))
  }
  t('§4 the NAMED kind throws with the naming message', threw)
  t('§4 …and a different kind is untouched', SurfaceFaultInjection({ kind: 'boot-settings' }) === null)
  delete process.env.MERCURY_FAULT_INJECT_SURFACE
}

console.log(failures === 0 ? 'SURFACE BOUNDARY: ALL PASS' : 'SURFACE BOUNDARY: RED')
process.exit(failures)
