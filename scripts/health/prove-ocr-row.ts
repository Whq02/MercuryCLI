import assert from 'node:assert/strict'
(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const { enableConfigs } = await import('../../src/platform/settings/config.ts')
enableConfigs()
const { ocrReadinessCheck } = await import('../../src/platform/health/healthReport.ts')
const { renderPlainCertificate } = await import('../../src/commands/verbs/healthPresentation.ts')
const { ocrInstallHint } = await import('../../src/tools/kit/ocr.ts')
let recognitions = 0
for (const fixture of [
  { platform: 'darwin', native: true, tesseract: false, languages: ['en-US'], name: 'macOS Vision' },
  { platform: 'win32', native: true, tesseract: false, languages: ['en-US'], name: 'Windows OCR' },
  { platform: 'linux', native: false, tesseract: true, languages: ['eng', 'fra'], name: 'Tesseract' },
  { platform: 'darwin', native: false, tesseract: true, languages: ['eng'], name: 'Tesseract' },
  { platform: 'win32', native: false, tesseract: false, languages: [], name: null },
  { platform: 'linux', native: false, tesseract: true, languages: [], name: null },
]) {
  const spec = ocrReadinessCheck({
    platform: fixture.platform,
    native: () => fixture.native ? { languages: fixture.languages, recognise: async () => { recognitions++; return 'not run' } } : undefined,
    probe: async () => fixture.tesseract,
    listLanguages: async () => fixture.languages,
  })
  const check = { id: spec.id, label: spec.label, probe: spec.probe, depth: spec.depth, ...await spec.run() }
  const row = JSON.parse(JSON.stringify(check))
  assert.equal(row.id, 'iface-ocr')
  assert.equal(row.label, 'OCR')
  assert.equal(row.probe, 'configuration')
  assert.equal(row.depth, 'fast')
  assert.equal(row.status, fixture.name === null ? 'info' : 'ok')
  if (fixture.name !== null) {
    assert.equal(row.evidence, fixture.name)
    assert.equal(row.detail, `Languages: ${fixture.languages.join(', ')}`)
    assert.equal(row.fix, undefined)
  } else {
    assert.match(row.evidence, /^unavailable — /)
    assert.ok(row.evidence.includes(row.fix), `ocrReadinessCheck(${fixture.platform}) evidence omitted fix hint in src/platform/health/healthReport.ts: evidence=${row.evidence} fix=${row.fix}`)
    if (!fixture.tesseract) assert.equal(row.fix, ocrInstallHint(fixture.platform))
    else assert.match(row.fix, /no installed recognition languages/)
  }
  const text = renderPlainCertificate({ sections: [{ title: 'INTERFACE', checks: [row] }], verdict: 'certified', durationMs: 0 })
  assert.ok(text.includes(`OCR — ${row.evidence}`), `renderPlainCertificate(${fixture.platform}) missing OCR row in src/commands/verbs/healthPresentation.ts: ${text.slice(0, 200)}`)
}
assert.equal(recognitions, 0)
const { interfaceChecks } = await import('../../src/platform/health/sections/interface.ts')
const listed = interfaceChecks().filter(entry => entry.id === 'iface-ocr')
assert.equal(listed.length, 1)
assert.deepEqual({ label: listed[0]!.label, probe: listed[0]!.probe, depth: listed[0]!.depth, timeoutMs: listed[0]!.timeoutMs }, { label: 'OCR', probe: 'configuration', depth: 'fast', timeoutMs: 11_000 })
console.log('PASS OCR row uses the resolved engine in JSON and text; unavailable carries its hint; health never recognises an image')
