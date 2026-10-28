import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mock } from 'bun:test'
import { pdfFixture, textPage } from './fixtures.ts'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const root = mkdtempSync(join(tmpdir(), 'fetched-pdf-'))
process.env.MERCURY_CONFIG_DIR = root
process.env.MERCURY_BARE = '1'
process.env.MERCURY_CREDENTIAL_STORE = 'file'
const bytes = pdfFixture([textPage('First page research'), textPage('Second page evidence')])
const urls: string[] = []
const privateHost = { ...await import('../../src/tools/WebFetchTool/privateHost.ts') }
mock.module('../../src/tools/WebFetchTool/privateHost.ts', () => ({ ...privateHost, metadataSafeAddresses: async () => [{ address: '127.0.0.1', family: 4 }], metadataRefusal: async () => null }))
const transport = { ...await import('../../src/tools/WebFetchTool/fetchTransport.ts') }
mock.module('../../src/tools/WebFetchTool/fetchTransport.ts', () => ({
  ...transport,
  fetchPage: async (url: string) => { urls.push(url); return { status: 200, statusText: 'OK', headers: { 'content-type': 'application/pdf' }, data: Uint8Array.from(bytes).buffer, url } },
  permittedFetchRedirect: () => true,
}))
const axios = (await import('axios')).default
const originalGet = axios.get
axios.get = (async (url: string) => {
  assert.equal(url, 'https://export.arxiv.org/api/query?id_list=2601.12345v2')
  const xml = Buffer.from('<feed><entry><title>Research</title><summary>Abstract only</summary></entry></feed>')
  return { status: 200, statusText: 'OK', headers: { 'content-type': 'application/atom+xml' }, data: Uint8Array.from(xml).buffer }
}) as typeof axios.get
const { getURLMarkdownContent } = await import('../../src/tools/WebFetchTool/utils.ts')
const { WebFetchTool } = await import('../../src/tools/WebFetchTool/WebFetchTool.ts')
const { FileReadTool } = await import('../../src/tools/FileReadTool/FileReadTool.ts')
const { createFileStateCacheWithSizeLimit } = await import('../../src/utils/fileStateCache.ts')
const context = { options: { engineModel: 'glm-5.3' }, readFileState: createFileStateCacheWithSizeLimit(100), abortController: new AbortController(), messages: [], getAppState: () => ({}) } as never
try {
  const fetched = await getURLMarkdownContent('https://papers.example/paper.pdf', new AbortController())
  assert.ok('persistedPath' in fetched && fetched.persistedPath)
  assert.deepEqual(readFileSync(fetched.persistedPath), bytes)
  assert.match(fetched.content, /First page research/)
  assert.ok(!fetched.content.includes('Second page evidence'))
  const shown = await WebFetchTool.call({ url: 'https://papers.example/paper.pdf' }, context)
  assert.match(shown.data.result, /First page research/)
  assert.match(shown.data.result, /Read/)
  const next = await FileReadTool.call({ file_path: fetched.persistedPath, pages: '2' }, context)
  assert.equal(next.data.type, 'text')
  assert.match(next.data.file.content, /Second page evidence/)
  const abstract = await getURLMarkdownContent('https://arxiv.org/abs/2601.12345v2', new AbortController())
  assert.ok('content' in abstract)
  assert.match(abstract.content, /PDF: https:\/\/arxiv.org\/pdf\/2601.12345v2/)
  const arxiv = await getURLMarkdownContent('https://arxiv.org/pdf/2601.12345v2.pdf', new AbortController())
  assert.ok('persistedPath' in arxiv && arxiv.persistedPath)
  assert.match(arxiv.content, /First page research/)
  assert.equal(urls.at(-1), 'https://arxiv.org/pdf/2601.12345v2')
  console.log('PASS fetched PDF saved byte-for-byte, first-page preview, Read continuation and canonical arXiv paper link')
} finally { axios.get = originalGet; mock.restore(); rmSync(root, { recursive: true, force: true }) }
