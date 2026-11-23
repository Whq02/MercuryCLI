#!/usr/bin/env bun
let failures = 0
function check(label: string, cond: boolean, detail = '', hint = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}${!cond && hint ? ` | ${hint}` : ''}`)
}

{
  const globals = globalThis as Record<string, unknown>
  if (globals.MACRO === undefined) globals.MACRO = { VERSION: '1.0.0' }
  const probeTargets = process.env.MERCURY_LOCAL_PROBE_TARGETS
  process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
  const { enableConfigs } = await import('../../src/platform/settings/config.ts')
  enableConfigs()
  const { runHealthReport } = await import('../../src/platform/health/healthReport.ts')
  const cert = await runHealthReport({ depth: 'fast' })
  if (probeTargets === undefined) delete process.env.MERCURY_LOCAL_PROBE_TARGETS
  else process.env.MERCURY_LOCAL_PROBE_TARGETS = probeTargets
  const printed = cert.sections.flatMap(entry => entry.checks)
  const objects = printed.filter(row => /\[object [A-Za-z]+\]/.test(`${row.evidence} ${row.detail ?? ''} ${row.fix ?? ''}`)).map(row => row.id)
  check(`no row of a fast certificate prints an object as [object …] (${printed.length} rows run here)`, printed.length > 100 && objects.length === 0, objects.join(', '), 'the listed row ids interpolate an object into evidence, detail or fix; stringify it in that row of src/platform/health/sections')
  const slots = printed.find(row => row.id === 'provider-slots')
  check(
    "FC-095: the router row's engine word is 'configured' (never LIVE without a probe)",
    slots?.evidence.startsWith('anthropic configured (') === true,
    slots?.evidence,
    'change the provider-slots row in authChecks (src/platform/health/sections/auth.ts)',
  )
  check('FC-095: the LIVE spelling is out of the router row', slots !== undefined && !/\bLIVE\b/.test(slots.evidence), slots?.evidence, 'change the provider-slots row in authChecks (src/platform/health/sections/auth.ts)')
  const { authChecks } = await import('../../src/platform/health/sections/auth.ts')
  const before = { key: process.env.ZAI_API_KEY, base: process.env.MERCURY_ZAI_API_BASE, targets: process.env.MERCURY_LOCAL_PROBE_TARGETS }
  process.env.ZAI_API_KEY = 'fixture-zai-key'
  process.env.MERCURY_ZAI_API_BASE = 'http://127.0.0.1:9'
  process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
  const keyed = await (await authChecks()).find(row => row.id === 'provider-slots')?.run()
  for (const [name, value] of [['ZAI_API_KEY', before.key], ['MERCURY_ZAI_API_BASE', before.base], ['MERCURY_LOCAL_PROBE_TARGETS', before.targets]] as const) {
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
  const engineLine = / · engines: (.*?) · engine seats/.exec(keyed?.evidence ?? '')?.[1] ?? ''
  const words = engineLine.split(' · ').filter(part => /(?:^|[ ,])zai(?:,|$)/.test(part))
  check(
    "FC-095: with a Z.AI key the engine reads available, and the row's word for it is 'configured' (no probe went out, so never LIVE)",
    keyed?.status === 'ok' && words.length === 1 && words[0]!.startsWith('configured ') && !/\bLIVE\b/.test(keyed.evidence),
    keyed?.evidence,
    'change the engine word built in the provider-slots row in authChecks (src/platform/health/sections/auth.ts)',
  )
}

console.log(failures === 0 ? 'HEALTH EVIDENCE STRING LAWS HOLD' : `${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
