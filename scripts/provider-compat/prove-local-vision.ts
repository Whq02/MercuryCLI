import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const home = mkdtempSync(join(tmpdir(), 'local-vision-'))
process.env.MERCURY_CONFIG_DIR = home
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
delete process.env.MERCURY_HOME
delete process.env.MERCURY_LOCAL_BASE_URL
delete process.env.MERCURY_LOCAL_API_KEY
const { enableConfigs } = await import('../../src/utils/config.ts')
enableConfigs()
const { refreshLocalDiscovery } = await import('../../src/services/providers/local/localDiscovery.ts')
const { modelReceivesImageBlocks } = await import('../../src/utils/model/capabilities.ts')
const { BrowserTool } = await import('../../src/tools/BrowserTool/BrowserTool.ts')
const imagePath = join(home, 'capture.png')
writeFileSync(imagePath, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==', 'base64'))
let kind = 'llamacpp'
let vision: boolean | undefined
const server = createServer((req, res) => {
  const url = req.url
  let value: unknown
  if (kind === 'llamacpp' && url === '/props') value = { default_generation_settings: { n_ctx: 262144 }, modalities: vision === undefined ? {} : { vision } }
  if (kind === 'llamacpp' && url === '/v1/models') value = { data: [{ id: 'fixture', meta: {} }] }
  if (kind === 'ollama' && url === '/api/tags') value = { models: [{ name: 'fixture' }] }
  if (kind === 'ollama' && url === '/api/version') value = { version: 'fixture' }
  if (kind === 'ollama' && url === '/api/ps') value = { models: [] }
  if (kind === 'ollama' && url === '/api/show') value = vision === undefined ? {} : { capabilities: ['completion', ...(vision ? ['vision'] : [])] }
  if (kind === 'lmstudio' && url === '/api/v1/models') value = { models: [{ key: 'fixture', type: 'llm', capabilities: vision === undefined ? {} : { vision } }] }
  res.writeHead(value === undefined ? 404 : 200, { 'content-type': 'application/json' })
  res.end(JSON.stringify(value ?? {}))
})
await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
const port = (server.address() as { port: number }).port
let checks = 0
try {
  for (kind of ['llamacpp', 'ollama', 'lmstudio']) {
    for (vision of [false, true, undefined]) {
      await refreshLocalDiscovery({ force: true, env: { MERCURY_LOCAL_PROBE_TARGETS: `${kind}=http://127.0.0.1:${port}` } })
      process.env.MERCURY_MODEL = 'local/fixture'
      const supported = vision === true
      assert.equal(modelReceivesImageBlocks('local/fixture'), supported, `${kind} vision=${vision}`)
      const pathLine = `screenshot: ${imagePath} (https://example.test, 1280x800)`
      const result = BrowserTool.mapToolResultToToolResultBlockParam({ result: pathLine, outcome: 'completed', imagePath } as never, 'shot')
      assert.equal(Array.isArray(result.content), supported, `${kind} Browser result shape`)
      if (Array.isArray(result.content)) {
        assert.equal(result.content[0]?.type, 'text')
        assert.equal(result.content[1]?.type, 'image')
      } else {
        assert.equal(result.content, `${pathLine}\n(image not inlined — this model takes no image input; open the file to view it)`)
      }
      checks++
    }
  }
  await refreshLocalDiscovery({ force: true, env: { MERCURY_LOCAL_PROBE_TARGETS: 'none' } })
  assert.equal(modelReceivesImageBlocks('local/never-listed'), false)
  assert.equal(modelReceivesImageBlocks('future-hosted-engine'), true)
  console.log(`${checks + 2} local vision and Browser shape checks passed`)
} finally {
  await new Promise<void>(resolve => server.close(() => resolve()))
  rmSync(home, { recursive: true, force: true })
}
