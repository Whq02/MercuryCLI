#!/usr/bin/env bun

let failures = 0
const t = (name: string, ok: boolean, detail = ''): void => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && detail ? ` — ${detail}` : ''}`)
  if (!ok) failures = 1
}


{
  const { flagEnv } = await import('../../src/platform/substrate/flagRegistry.ts')
  const { SurfaceFaultInjection } = await import('../../src/screen/routes/SurfaceRouter.tsx')
  delete process.env.MERCURY_FAULT_INJECT_SURFACE
  t('§4 unset ⇒ renders nothing (byte-identical)', SurfaceFaultInjection({ kind: 'concourse' }) === null, 'SurfaceFaultInjection in src/screen/routes/SurfaceRouter.tsx must return null when MERCURY_FAULT_INJECT_SURFACE is unset')
  process.env.MERCURY_FAULT_INJECT_SURFACE = 'concourse'
  t('§4 the registry row exists (flagEnv resolves — an unregistered read THROWS)', flagEnv('MERCURY_FAULT_INJECT_SURFACE') === 'concourse', 'the MERCURY_FAULT_INJECT_SURFACE row must be registered in FLAG_REGISTRY and flagEnv in the flag registry (FLAG_REGISTRY) must return its value')
  let threw = false
  try {
    SurfaceFaultInjection({ kind: 'concourse' })
  } catch (error) {
    threw = /fault injection: surface 'concourse'/.test(String(error))
  }
  t('§4 the NAMED kind throws with the naming message', threw, 'SurfaceFaultInjection in src/screen/routes/SurfaceRouter.tsx must throw an error naming the surface kind when MERCURY_FAULT_INJECT_SURFACE equals that kind')
  t('§4 …and a different kind is untouched', SurfaceFaultInjection({ kind: 'boot-settings' }) === null, 'SurfaceFaultInjection in src/screen/routes/SurfaceRouter.tsx must return null for a kind other than the one named in MERCURY_FAULT_INJECT_SURFACE')
  delete process.env.MERCURY_FAULT_INJECT_SURFACE
}

console.log(failures === 0 ? 'SURFACE BOUNDARY: ALL PASS' : 'SURFACE BOUNDARY: RED')
process.exit(failures)
