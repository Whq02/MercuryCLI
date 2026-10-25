import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const SCRATCH = mkdtempSync(join(tmpdir(), 'mcp-structured-'))
process.env.MERCURY_CONFIG_DIR = join(SCRATCH, 'home')
mkdirSync(process.env.MERCURY_CONFIG_DIR, { recursive: true })
process.env.MERCURY_CREDENTIAL_STORE = 'file'
delete process.env.MERCURY_HOME

const SRC = process.env.PROVE_SRC ?? join(import.meta.dir, '../../src')
const { transformMCPResult } = await import(join(SRC, 'services/mcp/client.ts'))

let failures = 0
let checks = 0
function check(label: string, cond: boolean, detail = ''): void {
  checks++
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
type Block = { type?: string; text?: string; source?: { data?: string } }
const texts = (content: unknown): string[] => (Array.isArray(content) ? (content as Block[]).filter(b => b.type === 'text').map(b => b.text ?? '') : [])
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='

console.log('structured results: the content blocks beside structuredContent survive')

const structured = { ok: true, count: 2, items: ['a', 'b'] }
const serialized = JSON.stringify(structured)

const restated = await transformMCPResult({ content: [{ type: 'text', text: '{"items":["a","b"],"count":2,"ok":true}' }], structuredContent: structured }, 'list', 'srv')
check('a text block that merely restates the structured value (any key order) collapses to the one JSON string', restated.type === 'structuredContent' && restated.content === serialized, JSON.stringify(restated))

const bare = await transformMCPResult({ structuredContent: structured }, 'list', 'srv')
check('no content array at all: the JSON string as before', bare.type === 'structuredContent' && bare.content === serialized && bare.schema === '{ok: boolean, count: number, items: [string]}', JSON.stringify(bare))

const withText = await transformMCPResult({ content: [{ type: 'text', text: 'Warning: two items were skipped.' }, { type: 'text', text: serialized }], structuredContent: structured }, 'list', 'srv')
check('an extra text block is kept and the structured JSON rides once at the end', Array.isArray(withText.content) && texts(withText.content).length === 2 && texts(withText.content)[0] === 'Warning: two items were skipped.' && texts(withText.content)[1] === serialized, JSON.stringify(withText.content))
check('the structured type and schema still name the shape', withText.type === 'structuredContent' && withText.schema === '{ok: boolean, count: number, items: [string]}', JSON.stringify(withText))

const withImage = await transformMCPResult({ content: [{ type: 'image', data: PNG, mimeType: 'image/png' }], structuredContent: { width: 1, height: 1 } }, 'shot', 'srv')
check('an image block beside structured content is kept as an image', Array.isArray(withImage.content) && (withImage.content as Block[]).some(b => b.type === 'image') && withImage.isImage === true, JSON.stringify(withImage.content).slice(0, 200))
check('and the structured JSON follows it as text', texts(withImage.content).includes('{"width":1,"height":1}'), JSON.stringify(texts(withImage.content)))

const withResource = await transformMCPResult({ content: [{ type: 'resource', resource: { uri: 'file:///notes.txt', text: 'hello', mimeType: 'text/plain' } }], structuredContent: { saved: true } }, 'save', 'srv')
check('a resource block beside structured content is kept with its marker', texts(withResource.content).some(t => t.startsWith('Resource from srv at file:///notes.txt:') && t.endsWith('hello')) && texts(withResource.content).includes('{"saved":true}'), JSON.stringify(texts(withResource.content)))

const plain = await transformMCPResult({ content: [{ type: 'text', text: 'just text' }] }, 'say', 'srv')
check('a result without structured content is untouched: the content array road', plain.type === 'contentArray' && texts(plain.content)[0] === 'just text', JSON.stringify(plain))

console.log(failures === 0 ? `\nSTRUCTURED CONTENT BLOCKS GREEN (${checks} checks)` : `\n${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
