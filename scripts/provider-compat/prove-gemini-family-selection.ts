#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const home = mkdtempSync(join(tmpdir(), 'gemini-family-'))
process.env.MERCURY_CONFIG_DIR = home
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.GEMINI_API_KEY = 'fixture-family-key'
delete process.env.GOOGLE_API_KEY
let ids = ['gemini-2.5-flash', 'gemini-3.8-flash', 'gemini-3.1-pro-preview', 'gemini-3.7-flash']
const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch() { return Response.json({ models: ids.map(id => ({ name: `models/${id}`, supportedGenerationMethods: ['generateContent'] })) }) } })
process.env.MERCURY_GEMINI_API_BASE = `http://127.0.0.1:${server.port}/v1beta`
const { enableConfigs } = await import('../../src/utils/config.ts')
enableConfigs()
const { refreshGeminiCatalogue, __resetGeminiCatalogueForTest } = await import('../../src/services/providers/gemini/geminiCatalogue.ts')
const { resolveEngineDispatch } = await import('../../src/utils/crew/engineDispatch.ts')
let failures = 0
try {
  for (const [list, expected] of [[ids, 'gemini-3.8-flash'], [['gemini-2.5-flash', 'gemini-3.7-flash'], 'gemini-3.7-flash'], [['gemini-2.5-flash'], 'gemini-2.5-flash']] as Array<[string[], string]>) {
    ids = list
    __resetGeminiCatalogueForTest()
    await refreshGeminiCatalogue('api-key', { force: true })
    const result = await resolveEngineDispatch('gemini')
    const ok = result?.model === expected
    console.log(`${ok ? 'PASS' : 'FAIL'} gemini picks the newest account-listed generation: ${result?.model}; expected ${expected}`)
    if (!ok) failures++
  }
} finally { server.stop(true); rmSync(home, { recursive: true, force: true }) }
if (failures) process.exit(1)
console.log('prove-gemini-family-selection: GREEN')
