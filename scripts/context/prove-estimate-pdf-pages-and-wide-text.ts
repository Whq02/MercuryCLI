#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
process.env.NODE_ENV = 'test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { deflateSync } from 'node:zlib'
for (const key of ['MERCURY_MODEL', 'MERCURY_DISABLE_1M_CONTEXT']) delete process.env[key]
process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'prove-estimate-pdf-'))

const sourceArg = process.argv.indexOf('--source-root')
const root = sourceArg < 0 ? resolve(import.meta.dir, '../..') : resolve(process.argv[sourceArg + 1]!)
let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}

const est = await import(`${root}/src/services/tokenEstimation.ts`)
const autoCompact = await import(`${root}/src/services/compact/autoCompact.ts`)
const MODEL = 'claude-sonnet-4-6'

function plainPdf(pages: number): Buffer {
  const objects = [`<< /Type /Catalog /Pages 2 0 R >>`, `<< /Type /Pages /Kids [${Array.from({ length: pages }, (_, i) => `${i + 3} 0 R`).join(' ')}] /Count ${pages} >>`]
  for (let i = 0; i < pages; i++) objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents ${pages + 3 + i} 0 R >>`)
  for (let i = 0; i < pages; i++) objects.push(`<< /Length 44 >>\nstream\nBT /F1 12 Tf 72 720 Td (page ${i + 1}) Tj ET\nendstream`)
  let body = '%PDF-1.4\n'
  objects.forEach((o, i) => { body += `${i + 1} 0 obj\n${o}\nendobj\n` })
  body += 'trailer\n<< /Root 1 0 R >>\n%%EOF\n'
  return Buffer.from(body, 'latin1')
}
function objectStreamPdf(pages: number): Buffer {
  const inner = [`<< /Type /Catalog /Pages 2 0 R >>`, `<< /Type /Pages /Kids [${Array.from({ length: pages }, (_, i) => `${i + 3} 0 R`).join(' ')}] /Count ${pages} >>`]
  for (let i = 0; i < pages; i++) inner.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >>`)
  const offsets: string[] = []
  let data = ''
  inner.forEach((o, i) => { offsets.push(`${i + 1} ${data.length}`); data += `${o}\n` })
  const header = `${offsets.join(' ')}\n`
  const packed = deflateSync(Buffer.from(header + data, 'latin1'))
  let body = '%PDF-1.5\n'
  body += `99 0 obj\n<< /Type /ObjStm /N ${inner.length} /First ${header.length} /Length ${packed.length} /Filter /FlateDecode >>\nstream\n`
  const head = Buffer.from(body, 'latin1')
  const tail = Buffer.from('\nendstream\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n', 'latin1')
  return Buffer.concat([head, packed, tail])
}
const doc = (bytes: Buffer) => ({ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: bytes.toString('base64') } })
const tokensOf = (bytes: Buffer): number => est.estimateContentTokens([doc(bytes)], MODEL)

section('§1 a PDF is estimated by its pages (the provider reads every page as text and an image), not at one flat figure')
{
  const one = tokensOf(plainPdf(1))
  const twenty = tokensOf(plainPdf(20))
  check('a one-page PDF is estimated above the old flat 2000 (a page is text plus its image)', one > 2000 && one <= 6000, `${one}`)
  check('a twenty-page PDF is estimated at twenty times a page, not the same as one page', twenty >= 19 * one && twenty <= 21 * one && twenty >= 40_000, `one=${one} twenty=${twenty}`)
  const packed = tokensOf(objectStreamPdf(12))
  check('a PDF whose page objects sit in a compressed object stream (PDF 1.5+) is counted through the stream', packed >= 11 * one && packed <= 13 * one, `packed=${packed} one=${one}`)
  const unreadable = tokensOf(Buffer.alloc(3_000_000, 7))
  check('bytes that are not a readable PDF fall back to a size-based page estimate, never the flat figure and never above the inline page cap', unreadable > 2000 && unreadable <= 20 * 6000, `${unreadable}`)
  const img = est.estimateContentTokens([{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'x'.repeat(5_000_000) } }], MODEL)
  check('the image flat rate is unchanged (pinned elsewhere)', img === 2000, `${img}`)
}

section('§2 text that is not ASCII counts closer to its token cost: a CJK character about one token, not a quarter')
{
  const ascii = est.estimateContentTokens('x'.repeat(40_000))
  const cjk = est.estimateContentTokens('漢'.repeat(40_000))
  const emoji = est.estimateContentTokens('😀'.repeat(20_000))
  check('ASCII text keeps the four-characters-a-token estimate', ascii === 10_000, `${ascii}`)
  check('40k CJK characters estimate at about 40k tokens, not 10k', cjk >= 30_000 && cjk <= 50_000, `${cjk}`)
  check('20k emoji (surrogate pairs) estimate at one to two tokens each, not a quarter', emoji >= 20_000 && emoji <= 50_000, `${emoji}`)
  check('a text block and a bare string agree', est.estimateContentTokens([{ type: 'text', text: '漢'.repeat(1000) }]) === est.estimateContentTokens('漢'.repeat(1000)))
}

section('§3 the fixed-prefix read: three inline PDFs with a provider-measured 175k fill are no longer read as a 167k fixed prefix the fold cannot touch')
{
  const pdf = plainPdf(20)
  const user = (content: unknown, i: number) => ({ type: 'user', uuid: `u${i}`, message: { role: 'user', content } })
  const msgs: unknown[] = []
  for (let i = 0; i < 3; i++) msgs.push(user([{ type: 'text', text: `read doc ${i}` }, doc(pdf)], i))
  msgs.push({ type: 'assistant', uuid: 'a1', message: { id: 'm1', role: 'assistant', model: MODEL, stop_reason: 'end_turn', content: [{ type: 'text', text: 'ok' }], usage: { input_tokens: 175_000, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } })
  const verdict = autoCompact.detectFixedPrefixOverflow(msgs as never, MODEL, 0, 0) as { prefixTokens: number; thresholdTokens: number } | null
  check('no fixed-prefix overflow is read: the three PDFs account for most of the 175k, so the ordinary fold keeps its road', verdict === null, JSON.stringify(verdict))
}

console.log(failures === 0 ? '\nprove-estimate-pdf-pages-and-wide-text: all green' : `\nprove-estimate-pdf-pages-and-wide-text: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
