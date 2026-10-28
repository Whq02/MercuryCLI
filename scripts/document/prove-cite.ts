import { proofHome } from '../lib/hermetic.ts'
import assert from 'node:assert/strict'
import { readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import mammoth from 'mammoth'

;(globalThis as any).MACRO = { VERSION: '1.0.0' }
const { citeDocument, parseBibtex, formatReferences, resolveDois } = await import('../../src/tools/DocumentTool/cite.ts')
const io = { read: async (path: string) => readFileSync(path), signal: new AbortController().signal }
const bibtex = '@string{journal = "Nature Physics"}\n@article{measurement, author={Aspelmeyer, Markus}, title={Measured {measurement}}, year={2009}, journal=journal, volume={5}, number={1}, pages={11--12}, doi={10.1038/nphys1170}}'
const liveFetch = globalThis.fetch
try {
  const refs = parseBibtex(bibtex)
  assert.equal(refs[0]!.container, 'Nature Physics')
  assert.equal(refs[0]!.title, 'Measured measurement')
  assert.equal(refs[0]!.authors[0]!.given, 'Markus')
  const apa = formatReferences(refs, 'apa')
  assert.equal(apa.markdown, 'Aspelmeyer, M. (2009). Measured measurement. *Nature Physics, 5*(1), 11–12. https://doi.org/10.1038/nphys1170\n')
  assert.equal(apa.keys[0]!.inText, '(Aspelmeyer, 2009)')
  const ieee = formatReferences(refs, 'ieee')
  assert.equal(ieee.keys[0]!.inText, '[1]')
  assert.match(ieee.markdown, /\[1\] M\. Aspelmeyer, “Measured measurement,” \*Nature Physics\*, vol\. 5, no\. 1, pp\. 11–12, 2009\./)
  assert.equal(formatReferences(refs, 'chicago').keys[0]!.inText, '(Aspelmeyer 2009)')
  assert.match(formatReferences(refs, 'harvard').markdown, /Aspelmeyer, M\. \(2009\)/)
  const collision = formatReferences([refs[0]!, { ...refs[0]!, id: 'other', title: 'Other measurement' }], 'apa')
  assert.deepEqual(collision.keys.map(k => k.inText), ['(Aspelmeyer, 2009a)', '(Aspelmeyer, 2009b)'])
  assert.throws(() => formatReferences([refs[0]!, refs[0]!], 'apa'), /duplicate/)
  const many = formatReferences(Array.from({ length: 28 }, (_, i) => ({ ...refs[0]!, id: String(i), title: `Study ${String(i).padStart(2, '0')}` })), 'apa')
  assert.equal(many.keys.at(-1)!.inText, '(Aspelmeyer, 2009ab)')
  assert.throws(() => parseBibtex('@article{broken,title={open'), /Unclosed/)
  assert.throws(() => parseBibtex('@article{broken,title=unknown}'), /Unknown BibTeX string/)
  const corporate = parseBibtex('@book{x,author={{Research and Development Group} and Ludwig van der Waals},title={Book},year=2026}')
  assert.equal(corporate[0]!.authors.length, 2)
  assert.equal(corporate[0]!.authors[1]!.family, 'van der Waals')
  let calls = 0
  globalThis.fetch = (async (url: string | URL | Request, options: RequestInit) => {
    calls++
    assert.equal(String(url), 'https://api.crossref.org/works/10.1038%2Fnphys1170')
    assert.equal(options.redirect, 'error')
    assert.ok(options.signal)
    return Response.json({ message: { title: ['Measured measurement'], author: [{ given: 'Markus', family: 'Aspelmeyer' }], issued: { 'date-parts': [[2009, 1]] }, 'container-title': ['Nature Physics'], volume: '5', issue: '1', page: '11-12' } })
  }) as typeof fetch
  for (const style of ['apa', 'ieee', 'chicago', 'harvard'] as const) for (const ext of ['md', 'html', 'docx']) {
    const product = await citeDocument({ op: 'cite', bibtex, style, output: join(proofHome, `${style}.${ext}`) }, io)
    const bytes = Buffer.from(product.files[0]!.bytes)
    assert.match(ext === 'docx' ? (await mammoth.extractRawText({ buffer: bytes })).value : bytes.toString(), /Aspelmeyer/)
  }
  assert.equal(calls, 0)
  const resolved = await citeDocument({ op: 'cite', dois: ['10.1038/nphys1170'] }, io)
  assert.equal(calls, 1)
  assert.match(JSON.stringify(resolved.detail), /publicly available/)
  assert.match(JSON.stringify(resolved.detail), /Measured measurement/)
  await assert.rejects(resolveDois(['file:///secret'], io.signal), /Invalid DOI/)
  assert.equal(calls, 1)
  globalThis.fetch = (async () => new Response('rate limited', { status: 429, headers: { 'Retry-After': '120' } })) as typeof fetch
  await assert.rejects(resolveDois(['10.1038/nphys1170'], io.signal), /Crossref 429.*retry after 120/)
  console.log('PASS cite: nested BibTeX/macros/names, four local style formats and in-text keys, three outputs, explicit Crossref-only requests and no retry on rate limits')
} finally { globalThis.fetch = liveFetch; rmSync(proofHome, { recursive: true, force: true }) }
