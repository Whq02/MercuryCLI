import { toolContext } from '../computer/computerToolKit.ts'
import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { llmhostFixture } from '../providers/lib/llmhostFixture.ts'

const f = await llmhostFixture({ model: 'Fixture/Vision' })
const state = f.state as typeof f.state & { vision?: boolean; inputModalities?: string[] }
state.dialect = 'llamacpp'
const { resetSettingsCache } = await import('../../src/utils/settings/settingsCache.ts')
const { compatModelEndpoint } = await import('../../src/services/providers/openaicompat/compatAccounts.ts')
const { inspectCompatServer } = await import('../../src/services/providers/openaicompat/compatProbe.ts')
const { ComputerTool } = await import('../../src/tools/ComputerTool/ComputerTool.ts')
const { clearImageRefusal } = await import('../../src/services/desktop/desktopSession.ts')
const model = `compat/pod-fixture/${f.model}`
const configure = (dialect: string): void => {
  writeFileSync(join(f.home, 'settings.json'), JSON.stringify({ compatProvider: { 'pod-fixture': { baseUrl: f.baseUrl, dialect, models: [f.model] } } }))
  resetSettingsCache()
}
const image = () => [f.createUserMessage({ content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAEElEQVQImWP4z8DwH4QZYAwAR8oH+XeAhlsAAAAASUVORK5CYII=' } }, { type: 'text', text: 'Describe this image.' }] as never })]
const hasImage = (): boolean => JSON.stringify(f.captures.at(-1)!.body.messages).includes('image_url')
const validate = () => ComputerTool.validateInput!({ action: 'screenshot' }, toolContext({ model }))
const errors = (rows: any[]): string => rows.filter(row => row.isApiErrorMessage).map(row => JSON.stringify(row.message.content)).join('\n')
try {
  configure('llamacpp')
  state.vision = false
  const endpoint = compatModelEndpoint(model)!.endpoint
  const reading = await inspectCompatServer(endpoint)
  assert.equal(reading.capabilities?.[f.model]?.images, false, 'the probe must report /props modalities.vision=false')
  const missing = await validate()
  assert.equal(missing.result, false)
  assert.match((missing as any).message, /this server runs .* without its vision projector/)
  assert.match((missing as any).message, /rent it again/)
  assert.doesNotMatch((missing as any).message, /model.*receives text only/)
  const propsBeforeText = state.propsRequests
  assert.equal(errors(await f.run(model)), '')
  assert.equal(errors(await f.run(model)), '')
  assert.equal(state.propsRequests, propsBeforeText, 'text-only turns keep the existing /props slot cache')
  assert.equal(errors(await f.run(model, image())), '')
  assert.equal(hasImage(), false, 'known projector-less server receives a text marker, not rejected image bytes')
  state.vision = true
  assert.equal(errors(await f.run(model, image())), '')
  assert.equal(hasImage(), true, 'same endpoint gains a projector without a model switch or Computer call')
  assert.equal((await validate()).result, true)
  console.log('PASS /props reports the projector; Computer names setup and recovers after the same server loads one')

  state.vision = undefined
  await inspectCompatServer(endpoint)
  clearImageRefusal()
  assert.equal((await validate()).result, true, 'missing metadata means unknown, try')
  state.mode = 'reject-image'
  const refusal = errors(await f.run(model, image()))
  assert.equal(hasImage(), true)
  assert.match(refusal, /without its vision projector/)
  assert.match(refusal, /mmproj/)
  state.mode = 'reply'
  state.vision = true
  assert.equal((await validate()).result, true, 'positive live projector reading overrides the earlier refusal latch')
  assert.equal(errors(await f.run(model, image())), '')
  assert.equal(hasImage(), true)
  console.log('PASS unknown tries images; mmproj wire refusal names setup; restored projector retries image bytes')

  for (const dialect of ['vllm', 'sglang']) {
    configure(dialect)
    state.dialect = dialect
    for (const modalities of [undefined, ['text'], ['text', 'image']]) {
      state.inputModalities = modalities
      await inspectCompatServer(compatModelEndpoint(model)!.endpoint)
      clearImageRefusal()
      const verdict = await validate()
      assert.equal(verdict.result, modalities === undefined || modalities.includes('image'))
      if (!verdict.result) assert.match(verdict.message, /this model receives text only/)
      assert.equal(errors(await f.run(model, image())), '')
      assert.equal(hasImage(), modalities === undefined || modalities.includes('image'))
    }
  }
  console.log('PASS vLLM and SGLang use declared model input modalities; absent declarations remain unknown and permissive')
} finally { f.close() }
