import '../lib/hermetic.ts'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { HOST_RECIPES } from '../../src/models/hosting/recipes.ts'
import { startHostEngine } from '../../src/models/hosting/ssh.ts'
import { weightManifest, weightCheckScript } from '../../src/models/hosting/keptWeights.ts'
import { hostRecipeSchema, exportHostRecipesJson } from '../../src/models/hosting/recipesFile.ts'

const expected = new Map([
  ['glm53-flash-gguf-b300', { file: 'mmproj-F16.gguf', size: 1128047296 }],
  ['nemotron35-super-gguf-rtx-pro-6000', { file: 'mmproj-BF16.gguf', size: 1733695840 }],
])
const commands: string[] = []
const runner = { async run(_command: string, args: string[]) { commands.push(args.at(-1)!); return 'MERCURY_PREBUILT_ENGINE yes' }, tunnel(): never { throw new Error('no tunnel') } }
const script = (): string => commands.findLast(command => command.includes('nohup setsid'))!.replaceAll("'\\''", "'")
for (const recipe of HOST_RECIPES.filter(row => row.engine === 'llamacpp')) {
  const projector = expected.get(recipe.id)!
  assert.ok(projector, recipe.id)
  assert.equal((recipe as any).mmproj, projector.file, `${recipe.id} must name its projector`)
  assert.equal((hostRecipeSchema.parse(recipe) as any).mmproj, projector.file)
  assert.equal(JSON.parse(exportHostRecipesJson([recipe])).recipes[0].mmproj, projector.file)
  const manifest = weightManifest(recipe)
  assert.equal(manifest.files.find(file => file.path === projector.file)?.size, projector.size)
  assert.ok(weightCheckScript(manifest, '/fixture/kept', true).includes(projector.file), 'fast-load downloads and verifies the same projector')
  const manifestBytes = manifest.files.reduce((sum, file) => sum + file.size, 0)
  assert.ok(recipe.diskGb * 1e9 > manifestBytes, `${recipe.id}: diskGb=${recipe.diskGb}GB does not exceed manifest bytes=${manifestBytes}; check host recipes.ts`)
  for (const prebuilt of [true, false]) {
    commands.length = 0
    const launchRunner = { ...runner, async run(command: string, args: string[]) { await runner.run(command, args); return prebuilt ? 'MERCURY_PREBUILT_ENGINE yes' : '' } }
    await startHostEngine({ host: 'fixture' }, recipe, launchRunner, new AbortController().signal, false, true)
    const text = script()
    const download = text.replaceAll("'\\''", "'").replaceAll('\\"', '"')
    assert.ok(download.includes(`--include '${recipe.include}' '${projector.file}'`), 'the download (inside the stall watchdog when guarded) names the projector beside the quant: ' + download)
    assert.ok(text.includes(`'--mmproj' '/workspace/mercury-host/${recipe.id}/weights/${projector.file}'`), text)
    assert.ok(text.includes(prebuilt ? "'llama-server'" : "'/workspace/mercury-host/llama.cpp/build/bin/llama-server'"), `${recipe.id} (prebuilt=${prebuilt}): launch script missing expected llama-server binary path; check startHostEngine`)
  }
  commands.length = 0
  await startHostEngine({ host: 'fixture' }, recipe, runner, new AbortController().signal, false, true, undefined, '/fixture/kept')
  const keptScript = script()
  assert.ok(keptScript.includes(`'--mmproj' '/fixture/kept/${projector.file}'`), `${recipe.id}: kept-weights launch script missing --mmproj for ${projector.file}; check startHostEngine`)
  assert.ok(!keptScript.includes('hf download'), `${recipe.id}: kept-weights launch script unexpectedly invoked hf download; check startHostEngine`)
  const bank = mkdtempSync(join(process.env.MERCURY_CONFIG_DIR!, 'bank-'))
  try {
    const count = Number(/-00001-of-(\d+)\.gguf$/.exec(recipe.weightFile!)![1])
    mkdirSync(join(bank, recipe.weightFile!.split('/')[0]!), { recursive: true })
    for (let part = 1; part <= count; part++) writeFileSync(join(bank, recipe.weightFile!.replace('-00001-of-', `-${String(part).padStart(5, '0')}-of-`)), 'fixture')
    await assert.rejects(startHostEngine({ host: 'fixture' }, recipe, runner, new AbortController().signal, false, true, bank), /projector/)
    writeFileSync(join(bank, projector.file), 'fixture')
    await startHostEngine({ host: 'fixture' }, recipe, runner, new AbortController().signal, false, true, bank)
  } finally { rmSync(bank, { recursive: true, force: true }) }
  commands.length = 0
  await startHostEngine({ host: 'fixture' }, { ...recipe, mmproj: undefined } as any, runner, new AbortController().signal, false, true)
  assert.ok(!script().includes('--mmproj'), `${recipe.id}: text-only launch script without mmproj unexpectedly passed --mmproj; check startHostEngine`)
  console.log(`PASS ${recipe.id}: projector on download, prebuilt/source launch, kept weights, bank validation and recipe export; text-only has no --mmproj`)
}
