import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { llmhostFixture } from '../providers/lib/llmhostFixture.ts'
import { pinSourceRef } from '../lib/settingsPopupHarness.ts'

pinSourceRef()
const { toolContext } = await import('../computer/computerToolKit.ts')

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
  assert.equal(state.propsRequests, propsBeforeText + 1, 'the first dispatch reads the cold capability catalogue once')
  assert.equal(errors(await f.run(model)), '')
  assert.equal(state.propsRequests, propsBeforeText + 1, 'warm text-only turns reuse the catalogue and /props slot cache')
  const unseenHistory = image()
  const unseen = await f.run(model, unseenHistory)
  assert.equal(errors(unseen), '')
  assert.equal(hasImage(), false, 'known projector-less server receives a text marker, not rejected image bytes')
  assert.match(JSON.stringify(unseen.map(row => row.message.content)), /Image content was not sent.*without its vision projector/)
  const continued = await f.run(model, [...unseenHistory, ...unseen, f.createUserMessage({ content: 'continue with text only' })])
  assert.doesNotMatch(JSON.stringify(continued.map(row => row.message.content)), /Image content was not sent/, 'old unsupported images do not repeat the notice on every text turn')
  const { createAssistantMessage } = await import('../../src/utils/messages.ts')
  const imageResult = [f.createUserMessage({ content: 'read a picture' }), createAssistantMessage({ content: [{ type: 'tool_use', id: 'image-result', name: 'FixtureEcho', input: { text: 'picture' } }] as never }), f.createUserMessage({ content: [{ type: 'tool_result', tool_use_id: 'image-result', content: image()[0]!.message.content }] as never })]
  const unseenResult = await f.run(model, imageResult)
  assert.match(JSON.stringify(unseenResult.map(row => row.message.content)), /Image content was not sent.*without its vision projector/)
  assert.ok(f.captures.at(-1)!.body.messages.some((row: any) => row.role === 'tool' && row.tool_call_id === 'image-result'))
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
      const rows = await f.run(model, image())
      assert.equal(errors(rows), '')
      assert.equal(JSON.stringify(rows.map(row => row.message.content)).includes('Image content was not sent'), modalities !== undefined && !modalities.includes('image'))
      assert.equal(hasImage(), modalities === undefined || modalities.includes('image'))
    }
  }
  console.log('PASS vLLM and SGLang use declared model input modalities; absent declarations remain unknown and permissive')
} finally { f.close() }
