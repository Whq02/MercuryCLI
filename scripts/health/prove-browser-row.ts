import assert from 'node:assert/strict'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const { enableConfigs } = await import('../../src/platform/settings/config.ts')
enableConfigs()
const report = await import('../../src/platform/health/healthReport.ts')
const { renderPlainCertificate } = await import('../../src/commands/verbs/healthPresentation.ts')
const cache = join(tmpdir(), 'fixture-browser-cache')
const executablePath = join(cache, 'chrome-for-testing')
const installed = () => [{ family: 'chrome' as const, label: 'Google Chrome', executablePath: join(cache, 'operator-app') }]

console.log('RED on the base: INTERFACE has no iface-browser check')
assert.equal(typeof report.browserReadinessCheck, 'function')
for (const kind of ['managed', 'pin', 'absent', 'broken'] as const) {
  const spec = report.browserReadinessCheck({
    pin: () => kind === 'pin' || kind === 'broken' ? executablePath : undefined,
    exists: () => kind !== 'broken',
    managed: () => kind === 'managed' ? [{ buildId: '142.0.7444.0', executablePath, sizeBytes: 1 }] : [],
    installed,
    cacheDir: () => cache,
  })
  const check = { id: spec.id, label: spec.label, probe: spec.probe, depth: spec.depth, ...await spec.run() }
  const json = JSON.parse(JSON.stringify({ sections: [{ id: 'interface', title: 'INTERFACE', checks: [check] }] }))
  const row = json.sections[0].checks[0]
  assert.equal(row.id, 'iface-browser')
  assert.equal(row.label, 'Browser')
  assert.equal(row.probe, 'configuration')
  assert.equal(row.depth, 'fast')
  assert.equal(row.status, kind === 'managed' || kind === 'pin' ? 'ok' : 'info')
  if (kind === 'managed') assert.equal(row.evidence, `drives Chrome for Testing 142.0.7444.0 (managed cache ${cache})`)
  if (kind === 'pin') assert.equal(row.evidence, `operator pin ${executablePath}`)
  if (kind === 'absent') assert.equal(row.evidence, 'no managed browser — /browser install downloads Chrome for Testing once (the consent step names the exact download size; the current stable is about 185 MB, twice that unpacked); your installed Google Chrome is never driven')
  if (kind === 'broken') assert.match(row.evidence, /MERCURY_BROWSER_PATH is set to .* which does not exist/)
  assert.match(row.detail, /not driven: it is your app/)
  const text = renderPlainCertificate({ sections: json.sections, verdict: 'certified', durationMs: 0 })
  assert.ok(text.includes(`[${row.status.toUpperCase()}] Browser — ${row.evidence}`), `renderPlainCertificate(${kind}) missing Browser row in src/commands/verbs/healthPresentation.ts: ${text.slice(0, 200)}`)
}
const { interfaceChecks } = await import('../../src/platform/health/sections/interface.ts')
const listed = interfaceChecks().filter(row => row.id === 'iface-browser')
assert.equal(listed.length, 1)
assert.deepEqual({ label: listed[0]!.label, probe: listed[0]!.probe, depth: listed[0]!.depth }, { label: 'Browser', probe: 'configuration', depth: 'fast' })
console.log('PASS browser row JSON and plain words for managed, pinned, absent and broken browsers; no browser is executed')
