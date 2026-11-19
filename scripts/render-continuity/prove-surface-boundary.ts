#!/usr/bin/env bun

let failures = 0
const t = (name: string, ok: boolean, detail = ''): void => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && detail ? ` — ${detail}` : ''}`)
  if (!ok) failures = 1
}


{
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
