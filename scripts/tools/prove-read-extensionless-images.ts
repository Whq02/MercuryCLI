import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import sharp from 'sharp'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
process.env.MERCURY_BARE = '1'
const { FileReadTool } = await import('../../src/tools/FileReadTool/FileReadTool.ts')
const { createImageMetadataText } = await import('../../src/utils/imageResizer.ts')
const { getEmptyToolPermissionContext } = await import('../../src/Tool.ts')
const { createFileStateCacheWithSizeLimit } = await import('../../src/utils/fileStateCache.ts')
const { enableConfigs } = await import('../../src/utils/config/globalConfig.ts')
enableConfigs()
const dir = mkdtempSync(join(tmpdir(), 'extensionless-images-'))
const context = () => ({ readFileState: createFileStateCacheWithSizeLimit(100), abortController: new AbortController(), messages: [], getAppState: () => ({ toolPermissionContext: getEmptyToolPermissionContext() }) })
let failures = 0
async function check(label: string, body: () => void | Promise<void>): Promise<void> {
  try { await body(); console.log(`PASS ${label}`) } catch (error) { failures++; console.log(`FAIL ${label}: ${error}`) }
}
try {
  for (const format of ['png', 'jpeg', 'gif', 'webp'] as const) {
    await check(`extensionless ${format} routes to the image lane`, async () => {
      const path = join(dir, `capture-${format}`)
      writeFileSync(path, await sharp({ create: { width: 8, height: 4, channels: 3, background: { r: 10, g: 20, b: 30 } } }).toFormat(format).toBuffer())
      const input = { file_path: path }
      assert.equal((await FileReadTool.validateInput(input, context() as never)).result, true)
      const result = await FileReadTool.call(input, context() as never)
      assert.equal(result.data.type, 'image')
      const cropped = await FileReadTool.call({ file_path: path, crop: [2, 0, 6, 4] }, context() as never)
      assert.equal(cropped.data.type, 'image')
      assert(!JSON.stringify(cropped.newMessages).includes('crop ignored'))
      const mapped = FileReadTool.mapToolResultToToolResultBlockParam(cropped.data, 'image-proof')
      assert(Array.isArray(mapped.content) && mapped.content.some(block => block.type === 'image'))
    })
  }
  for (const text of ['ordinary text', 'GIF is not an image', 'RIFFxxxxWAVE', '']) {
    await check(`extensionless non-image stays text: ${JSON.stringify(text)}`, async () => {
      const path = join(dir, 'text')
      writeFileSync(path, text)
      assert.equal((await FileReadTool.call({ file_path: path }, context() as never)).data.type, 'text')
    })
  }
  await check('rounded axes have separate coordinate multipliers', () => {
    const note = createImageMetadataText({ originalWidth: 1000, originalHeight: 17, displayWidth: 333, displayHeight: 6 })!
    assert.match(note, /x coordinates.*3\.00.*y coordinates.*2\.83/)
  })
  await check('equal axes keep the single multiplier', () => {
    assert.match(createImageMetadataText({ originalWidth: 1000, originalHeight: 500, displayWidth: 500, displayHeight: 250 })!, /multiply any coordinates.*2\.00/)
  })
} finally { rmSync(dir, { recursive: true, force: true }) }
process.exitCode = failures ? 1 : 0
