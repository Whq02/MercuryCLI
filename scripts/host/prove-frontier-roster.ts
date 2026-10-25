import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { HOST_RECIPES, type HostRecipe } from '../../src/services/host/recipes.ts'
import { exportHostRecipesJson } from '../../src/services/host/recipesFile.ts'

if (!process.env.MERCURY_CONFIG_DIR) throw new Error('A scratch MERCURY_CONFIG_DIR is required')
const shipped = JSON.parse(exportHostRecipesJson()).recipes as HostRecipe[]
const added = HOST_RECIPES.filter(row => row.verified.on === '2026-10-22' || row.id.startsWith('hy4-preview-') || row.model === 'thinkingmachines/Inkling-NVFP4')
const manifests = JSON.parse(readFileSync(new URL('../../assets/host/weights.json', import.meta.url), 'utf8')) as Array<{ model: string; revision: string; files: Array<{ size: number }> }>
let failures = 0
let checks = 0
const check = (name: string, body: () => void): void => {
  checks++
  try { body(); console.log('PASS ' + name) } catch (error) { failures++; console.error('FAIL ' + name + ': ' + String(error)) }
}
const value = (row: HostRecipe, ...names: string[]): string | undefined => {
  const at = row.flags.findIndex(flag => names.includes(flag))
  return at < 0 ? undefined : row.flags[at + 1]
}
check('the audit still covers 45 new rows in the 78-row, 32-repository roster', () => {
  assert.equal(added.length, 45)
  assert.equal(HOST_RECIPES.length, 78)
  assert.equal(new Set(HOST_RECIPES.map(row => row.model)).size, 32)
})
for (const row of added) check(row.id + ' exports its full shape, byte sum and context without a capability reduction', () => {
  const manifest = manifests.find(entry => entry.model === row.model)!
  assert.match(manifest.revision, /^[a-f0-9]{40}$/)
  assert.equal(manifest.files.reduce((sum, file) => sum + file.size, 0) / 1e9, row.weightsGb)
  assert.ok(row.diskGb >= row.weightsGb + 12)
  assert.equal(Number(value(row, '--tp', '--tp-size', '--tensor-parallel-size') ?? 1) * Number(value(row, '--pp-size') ?? 1), row.count * (row.nodes ?? 1))
  assert.ok(Number(value(row, '--ep', '--ep-size') ?? 1) <= row.count * (row.nodes ?? 1))
  assert.equal(row.context, row.contextPerSlot)
  assert.ok(row.context! >= 131072)
  assert.deepEqual(shipped.find(entry => entry.id === row.id), row)
})
for (const row of added.filter(row => row.model === 'Qwen/Qwen3.8-Flash-Next-FP8')) check(row.id + ' opts into the documented structured-tool parser', () => {
  assert.equal(value(row, '--reasoning-parser'), 'auto')
  assert.equal(value(row, '--tool-call-parser'), 'auto')
})
for (const row of added.filter(row => row.model === 'openai/gpt-oss-120b')) check(row.id + ' enables vLLM Harmony function calling', () => {
  assert.equal(value(row, '--tool-call-parser'), 'openai')
  assert.ok(row.flags.includes('--enable-auto-tool-choice'))
})
for (const row of added.filter(row => row.model === 'stepfun-ai/Step-5-Preview')) check(row.id + ' exposes the vendor low/medium/high effort vocabulary', () => {
  assert.deepEqual(row.efforts?.levels, ['low', 'medium', 'high'])
  assert.equal(row.efforts?.verified.source, row.source)
  assert.match(row.efforts?.verified.note ?? '', /high is the default/)
})
for (const id of ['step5-preview-b300', 'step5-preview-h200', 'nemotron35-super-nvfp4-rtx-pro-6000']) check(id + ' carries the vendor verificationStatus badge without claiming a Mercury measurement', () => {
  const row = added.find(row => row.id === id)!
  assert.equal(row.verified.by, 'documented')
  assert.equal(row.verified.note, 'verified')
  assert.equal(row.verified.on, '2026-10-22')
  assert.equal(row.verified.source, row.source)
  assert.ok(row.verification.startsWith('verified · '))
})
for (const row of HOST_RECIPES.filter(row => row.id.startsWith('hy4-preview-'))) check(row.id + ' serves the 262144-token hardware budget (SGLang Hy4-Preview, read 2026-10-25)', () => {
  assert.match(row.label, /770B/)
  assert.equal(row.context, 262144)
  assert.equal(value(row, '--context-length'), '262144')
  assert.equal(row.verified.on, '2026-10-25')
})
for (const row of HOST_RECIPES.filter(row => row.model === 'thinkingmachines/Inkling-NVFP4')) check(row.id + ' has 975B parameters and xhigh (SGLang Inkling, read 2026-10-25)', () => {
  assert.match(row.label, /975B/)
  assert.deepEqual(row.efforts?.levels, ['low', 'medium', 'high', 'xhigh', 'max'])
})
console.log(`FRONTIER ROSTER ${failures ? 'RED' : 'GREEN'} — ${checks} checks, ${failures} failed`)
process.exitCode = failures ? 1 : 0
