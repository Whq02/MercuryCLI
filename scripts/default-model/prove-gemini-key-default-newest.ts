#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const home = mkdtempSync(join(tmpdir(), 'gemini-key-default-'))
process.env.MERCURY_CONFIG_DIR = home
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.GEMINI_API_KEY = 'fixture-family-key'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
delete process.env.GOOGLE_API_KEY
delete process.env.ANTHROPIC_API_KEY
delete process.env.OPENAI_API_KEY
let ids = ['gemini-2.5-flash', 'gemini-3.8-flash', 'gemini-3.1-pro-preview', 'gemini-3.7-flash']
const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch() { return Response.json({ models: ids.map(id => ({ name: `models/${id}`, supportedGenerationMethods: ['generateContent'] })) }) } })
process.env.MERCURY_GEMINI_API_BASE = `http://127.0.0.1:${server.port}/v1beta`
const { enableConfigs } = await import('../../src/utils/config.ts')
enableConfigs()
const { refreshGeminiCatalogue, __resetGeminiCatalogueForTest, newestGeminiGenerationFirst, geminiGeneration } = await import('../../src/services/providers/gemini/geminiCatalogue.ts')
const { computedDefault, resetComputedDefaultMemo } = await import('../../src/utils/model/computedDefault.ts')
const { recordSignIn } = await import('../../src/utils/accounts/signInLedger.ts')

let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ' — ' + detail : ''}`)
  if (!cond) failures++
}
const defaultFor = async (list: string[]): Promise<{ setting?: string; why: string; source: string }> => {
  ids = list
  __resetGeminiCatalogueForTest()
  await refreshGeminiCatalogue('api-key', { force: true })
  resetComputedDefaultMemo()
  const decision = computedDefault()
  return { setting: decision.setting, why: decision.why, source: decision.source }
}

try {
  console.log('§1 a Gemini-key-only home defaults to the newest generation, not the first row')
  recordSignIn('gemini', 'api-key')
  const newest = await defaultFor(ids)
  check('the computed default is the newest generation the key can use', newest.setting?.endsWith('gemini-3.8-flash') === true, `${newest.setting} (${newest.source})`)
  check("…and its reason says so", newest.why.includes("the newest generation this sign-in can use (by the id's version, then the catalogue's order)"), newest.why)
  const two = await defaultFor(['gemini-2.5-flash', 'gemini-3.7-flash'])
  check('a two-row list picks the newer', two.setting?.endsWith('gemini-3.7-flash') === true, String(two.setting))
  const tie = await defaultFor(['gemini-3.7-pro-preview', 'gemini-3.7-flash', 'gemini-2.5-flash'])
  check("rows of one generation keep the catalogue's order (the first of the newest wins)", tie.setting?.endsWith('gemini-3.7-pro-preview') === true, String(tie.setting))
  const one = await defaultFor(['gemini-2.5-flash'])
  check('one row is the default whatever its generation', one.setting?.endsWith('gemini-2.5-flash') === true, String(one.setting))

  console.log('\n§2 the sort is the dispatcher\'s own, shared')
  check('gemini-3.8-flash reads generation 3.8', JSON.stringify(geminiGeneration('gemini-3.8-flash')) === '[3,8]')
  check('gemini-3-pro reads 3.0', JSON.stringify(geminiGeneration('gemini-3-pro')) === '[3,0]')
  check('an id without the grammar reads 0.0', JSON.stringify(geminiGeneration('learnlm-2.0-flash')) === '[0,0]')
  const ordered = newestGeminiGenerationFirst(['gemini-2.5-flash', 'gemini-3.8-flash', 'gemini-3.1-pro-preview', 'gemini-3.7-flash'], id => id)
  check('newest first, then the id\'s minor', ordered.join(',') === 'gemini-3.8-flash,gemini-3.7-flash,gemini-3.1-pro-preview,gemini-2.5-flash', ordered.join(','))

  console.log('\n§3 refusals: no invented ranking elsewhere')
  const foreign = ['openrouter/anthropic/claude-opus-5-5', 'openrouter/openai/gpt-5.4', 'openrouter/google/gemini-3-pro', 'llama3.2:latest']
  check('ids outside the gemini grammar keep the order they came in', newestGeminiGenerationFirst(foreign, id => id).join(',') === foreign.join(','))
  const mixed = ['gemini-2.5-flash', 'learnlm-2.0-flash', 'gemini-3.7-flash']
  check('an id without the grammar sorts after every generation, in its own order', newestGeminiGenerationFirst(mixed, id => id).join(',') === 'gemini-3.7-flash,gemini-2.5-flash,learnlm-2.0-flash')
  check('the sort never changes the input array', mixed.join(',') === 'gemini-2.5-flash,learnlm-2.0-flash,gemini-3.7-flash')
} finally {
  server.stop(true)
  rmSync(home, { recursive: true, force: true })
}
console.log(failures === 0 ? '\nprove-gemini-key-default-newest: all green' : `\nprove-gemini-key-default-newest: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
