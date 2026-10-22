import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

assert.ok(process.env.MERCURY_CONFIG_DIR, 'a scratch MERCURY_CONFIG_DIR is required')
const readBack = process.argv.indexOf('--read-bank')
if (readBack >= 0) {
  const { enableConfigs } = await import('../../src/utils/config.ts')
  enableConfigs()
  const { fastLoadRecipes } = await import('../../src/services/host/fastLoad.ts')
  const { bankState } = await import('../../src/services/host/bank.ts')
  const recipe = fastLoadRecipes().find(row => row.id === process.argv[readBack + 1])
  console.log(JSON.stringify({ recipe, state: recipe && bankState(recipe) }))
} else {
  const { llmhostFixture } = await import('../providers/lib/llmhostFixture.ts')
  const f = await llmhostFixture()
  process.env.HOME = f.home
  let checks = 0
  const check = (name: string, truth: unknown) => { assert.ok(truth, name); checks++; console.log('PASS ' + name) }
  try {
    const { HOST_RECIPES } = await import('../../src/services/host/recipes.ts')
    const { rememberSessionHostRecipe, forgetSessionHostRecipes } = await import('../../src/services/host/recipesFile.ts')
    const { fastLoadRecipes } = await import('../../src/services/host/fastLoad.ts')
    const { rememberBankFolder, bankModelFolder, bankState, sealBank, readBankRegistry, recordBankFailure } = await import('../../src/services/host/bank.ts')
    const shape = HOST_RECIPES.find(row => row.engine === 'llamacpp')!
    const recipe = rememberSessionHostRecipe({ ...shape, id: 'hf-fixture-bank-persistence', model: 'fixture/bank-persistence', label: 'Fixture Bank Persistence', include: 'tiny-Q4_K_M.gguf', weightFile: 'tiny-Q4_K_M.gguf', mmproj: undefined, weightsGb: 12 / 1e9, verified: { by: 'unverified', source: 'https://huggingface.co/fixture/bank-persistence' } })
    const folder = rememberBankFolder(join(f.home, 'mercury-model-bank'))
    const modelFolder = bankModelFolder(folder, recipe)
    mkdirSync(modelFolder, { recursive: true })
    writeFileSync(join(modelFolder, recipe.weightFile!), 'tiny weights')
    await sealBank(recipe, folder, new AbortController().signal)
    check('banking seals and verifies the derived model before the session ends', bankState(recipe).banked && bankState(recipe).verifiedAt)
    forgetSessionHostRecipes()
    check('the Bank reloads a banked HF recipe after the session map is forgotten', fastLoadRecipes().some(row => row.id === recipe.id))
    const fresh = () => {
      const result = spawnSync(process.execPath, [fileURLToPath(import.meta.url), '--read-bank', recipe.id], { env: process.env, encoding: 'utf8' })
      assert.equal(result.status, 0, result.stderr)
      return JSON.parse(result.stdout.trim().split('\n').at(-1)!)
    }
    const first = fresh()
    check('a fresh process restores the complete recipe and verifies the bank state from disk', first.recipe?.model === recipe.model && first.recipe?.weightFile === recipe.weightFile && first.state?.banked && first.state?.verifiedAt)
    check('the Bank keeps one row for the same repo and quant', fastLoadRecipes().filter(row => row.model === recipe.model && row.include === recipe.include).length === 1)
    unlinkSync(join(modelFolder, recipe.weightFile!))
    const missing = fresh()
    check('the registry never substitutes for a missing weight file', missing.recipe?.id === recipe.id && !missing.state?.banked && !missing.state?.verifiedAt && missing.state?.missing === 1)
    writeFileSync(join(modelFolder, recipe.weightFile!), 'tiny weights')
    recordBankFailure(recipe, modelFolder, 'fixture verification failed')
    const failed = fresh()
    check('a verification failure keeps the model visible with its failure and without a verified date', failed.recipe?.id === recipe.id && failed.state?.banked && failed.state?.error === 'fixture verification failed' && !failed.state?.verifiedAt)
    const registry = readBankRegistry()
    check('the stored identity does not rely on the next search or the shipped recipe file', Object.values(registry.models).length === 1 && !HOST_RECIPES.some(row => row.id === recipe.id))
    rmSync(modelFolder, { recursive: true })
    check('a fresh Bank does not resurrect a model whose folder was removed', !fresh().recipe)
    console.log('HF BANK PERSISTENCE GREEN — ' + checks + ' checks; real fresh process, scratch files only')
  } finally { f.close() }
}
