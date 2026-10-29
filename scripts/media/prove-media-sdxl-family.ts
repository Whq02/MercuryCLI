import '../lib/hermetic.ts'
import assert from 'node:assert/strict'
import { closeSync, ftruncateSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { mediaCheckpointFile, mediaCheckpointInstalled, mediaModelJoined, mediaModelSupported, parseMediaCatalogue } from '../../src/services/media/catalogue.js'
import { mediaGenerationDetails } from '../../src/services/media/generation.js'
import { mediaPullPlan, mediaRows, mediaRuntimeChoice, type MediaSnapshot } from '../../src/services/media/setup.js'
import { proofHome, root } from './fixture.ts'

try {
  const bundled = JSON.parse(readFileSync(resolve(import.meta.dir, '../../src/extensions/bundled/mercury-media/server/catalog.json'), 'utf8')) as { runtime: { tag: string; families: string[]; componentFamilies: string[] }; recipes: Array<{ id: string; slots: Array<{ id: string; required: boolean }>; checkpoint?: { recipe: string; layout: string } }>; models: Array<{ id: string; recipe?: string; checkpoint?: { bytes: number } }> }
  const family = bundled.recipes.find(recipe => recipe.id === 'sdxl')
  assert.ok(family, 'the vendored engine carries the sdxl recipe family')
  assert.deepEqual(family.slots.map(slot => [slot.id, slot.required]), [['diffusion_model', true], ['clip_l', true], ['clip_g', true], ['vae', true]])
  assert.deepEqual(family.checkpoint, { recipe: 'sdxl-checkpoint', layout: 'sdxl' }, 'the family joins into the build\'s sdxl-checkpoint recipe')
  assert.deepEqual(bundled.models.filter(model => model.recipe === 'sdxl').map(model => [model.id, model.checkpoint]), [['sdxl-base-1.0', { bytes: 7105348108 }], ['pixel-party-xl', { bytes: 7105348108 }]])
  assert.deepEqual([bundled.runtime.families, bundled.runtime.componentFamilies], [['sdxl'], []], `runtime ${bundled.runtime.tag} runs SDXL through one joined checkpoint, not from components`)
  const shipped = parseMediaCatalogue(bundled)
  assert.deepEqual(shipped.models.map(model => model.id), ['z-image-turbo', 'flux2-klein-4b', 'qwen-image-21-turbo', 'qwen-image-21', 'wan22-ti2v-5b', 'minimax-h3-fl2va', 'sdxl-base-1.0', 'pixel-party-xl'], 'both SDXL rows are on the screen with the shipped runtime')
  assert.equal(mediaModelSupported(shipped, { id: 'pixel-party-xl', recipe: 'sdxl' }), true)
  assert.equal(mediaModelJoined(shipped, { id: 'pixel-party-xl', recipe: 'sdxl' }), true)
  assert.equal(mediaModelJoined(shipped, { id: 'z-image-turbo' }), false)
  assert.deepEqual(mediaCheckpointFile({ id: 'pixel-party-xl', checkpoint: { bytes: 7105348108 } }), { path: 'checkpoints/pixel-party-xl.safetensors', bytes: 7105348108 })
  const machine = { totalMemoryBytes: 48 * 1024 ** 3, usableMemoryBytes: 36 * 1024 ** 3 }
  const rows = mediaRows(shipped, root, machine, 100 * 1024 ** 3)
  const pixel = rows.find(row => row.model.id === 'pixel-party-xl')!
  const base = rows.find(row => row.model.id === 'sdxl-base-1.0')!
  assert.equal(pixel.words, 'pull 7.1 GB · 7.1 GB disk · 14.2 GB during the download · 11.3 GiB memory · 96.1 s/image · fits', 'the row keeps the shape of every other row and names what the download needs while it runs')
  assert.equal(base.words, 'pull 7.1 GB · 7.1 GB disk · 14.2 GB during the download · 11.3 GiB memory · — s/image · fits')
  assert.equal(pixel.bytes, 7105317250)
  assert.equal(pixel.pullBytes, 7105317250)
  assert.equal(pixel.model.license, 'CreativeML OpenRAIL-M')
  assert.equal(base.model.license, 'CreativeML Open RAIL++-M')
  const tight = mediaRows(shipped, root, machine, 12 * 1e9).find(row => row.model.id === 'pixel-party-xl')!
  assert.equal(tight.words, 'pull 7.1 GB · 7.1 GB disk · 14.2 GB during the download · 11.3 GiB memory · 96.1 s/image · needs disk space', 'the download and the join both have to fit: 14.2 GB during the download')
  assert.equal(tight.fit.diskFits, false)
  assert.equal(mediaRows(shipped, root, machine, 15 * 1e9).find(row => row.model.id === 'pixel-party-xl')!.fit.diskFits, true)
  assert.equal(mediaRows(shipped, root, { totalMemoryBytes: 16 * 1024 ** 3, usableMemoryBytes: 12 * 1024 ** 3 }, 100 * 1024 ** 3).find(row => row.model.id === 'pixel-party-xl')!.fit.fits, false)
  mkdirSync(join(root, 'models', 'checkpoints'), { recursive: true })
  const checkpoint = join(root, 'models', 'checkpoints', 'pixel-party-xl.safetensors')
  writeFileSync(checkpoint, Buffer.alloc(8))
  assert.equal(mediaCheckpointInstalled(root, shipped, pixel.model), false, 'a checkpoint of the wrong size is not installed')
  const handle = openSync(checkpoint, 'r+')
  try { ftruncateSync(handle, 7105348108) } finally { closeSync(handle) }
  assert.equal(mediaCheckpointInstalled(root, shipped, pixel.model), true)
  const afterJoin = mediaRows(shipped, root, machine, 1e9).find(row => row.model.id === 'pixel-party-xl')!
  assert.equal(afterJoin.words, 'installed · 7.1 GB disk · 11.3 GiB memory · 96.1 s/image · fits', 'after the join the row is installed although none of its four components remain')
  assert.deepEqual([afterJoin.installed, afterJoin.pullBytes], [true, 0])
  assert.equal(mediaRows(shipped, root, machine, 1e9).find(row => row.model.id === 'sdxl-base-1.0')!.installed, false, 'the base row has its own checkpoint')
  const components = parseMediaCatalogue(bundled, { runtime: { componentFamilies: ['sdxl'] } })
  assert.deepEqual([components.runtime.families, components.runtime.componentFamilies], [['sdxl'], ['sdxl']])
  assert.equal(mediaModelJoined(components, { id: 'pixel-party-xl', recipe: 'sdxl' }), false, 'a runtime that loads the components joins nothing')
  assert.equal(mediaRows(components, root, machine, 1e9).find(row => row.model.id === 'pixel-party-xl')!.installed, true, 'a checkpoint joined earlier keeps counting on a component-loading runtime')
  rmSync(checkpoint)
  const direct = mediaRows(components, root, machine, 8 * 1e9).find(row => row.model.id === 'pixel-party-xl')!
  assert.equal(direct.words, 'pull 7.1 GB · 7.1 GB disk · 11.3 GiB memory · 96.1 s/image · fits', 'without a join only the download has to fit')
  const snapshot: MediaSnapshot = { root, catalogue: shipped, rows, config: { imageModel: 'z-image-turbo' }, runtimeInstalled: true, runtime: mediaRuntimeChoice(shipped, 'darwin', 'arm64'), freeBytes: 100 * 1024 ** 3, ...machine }
  const plan = mediaPullPlan(snapshot, 'pixel-party-xl')
  assert.deepEqual(plan.args, ['pull-model', 'pixel-party-xl'])
  assert.equal(plan.bytes, 7105317250)
  assert.equal(plan.license, "CreativeML OpenRAIL-M · The model card asks: please do not host this model. The pull takes it from the author's Hugging Face repository.")
  assert.equal(plan.source, 'huggingface.co/pixelparty/pixel-party-xl, huggingface.co/stabilityai/stable-diffusion-xl-base-1.0, huggingface.co/madebyollin/sdxl-vae-fp16-fix')
  assert.equal(mediaPullPlan(snapshot, 'sdxl-base-1.0').license, 'CreativeML Open RAIL++-M')
  const details = mediaGenerationDetails('image', { model: 'pixel-party-xl', prompt: 'cute dragon' }, shipped, { imageModel: 'z-image-turbo' }, root)
  assert.equal(details, `pixel-party-xl\n1024×1024 · 25 steps · saved at 128×128\nOutput: ${root}/media\nPrompt: cute dragon`)
  const unlisted = parseMediaCatalogue({ ...bundled, runtime: { ...bundled.runtime, families: [] } })
  assert.equal(unlisted.models.map(model => model.id).includes('pixel-party-xl'), false, 'a runtime that lists no family keeps the rows off every screen')
  assert.throws(() => mediaGenerationDetails('image', { model: 'pixel-party-xl', prompt: 'cute dragon' }, unlisted, { imageModel: 'z-image-turbo' }, root), /Choose the image model in \/imagesetup/)
  assert.throws(() => parseMediaCatalogue(bundled, { runtime: { families: ['bad id!'] } }))
  console.log('media sdxl family: the vendored engine carries the family, its checkpoint recipe and both rows; with the shipped runtime both rows are listed in the existing row shape, the disk check counts the download and the join, a joined checkpoint of the pinned size makes the row installed with no component left, a component-loading runtime pulls without a join, and the pull card carries the licences and the card sentence')
} finally { rmSync(proofHome, { recursive: true, force: true }) }
