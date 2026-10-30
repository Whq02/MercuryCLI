#!/usr/bin/env bun
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { makeTally } from '../daemon/dupline-world.ts'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const SRC = process.env.PROVE_SRC ?? join(import.meta.dir, '../../src')
process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'read-description-home-'))
process.env.MERCURY_BARE = '1'
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.ANTHROPIC_API_KEY = 'proof-key-ci-gate-not-a-real-key'
delete process.env.NODE_ENV

const { FileReadTool } = await import(`${SRC}/tools/FileReadTool/FileReadTool.ts`)
const { readTargetsEnabled } = await import(`${SRC}/tools/FileReadTool/readTarget.ts`)
const { zodToJsonSchema } = await import(`${SRC}/utils/zodToJsonSchema.ts`)

if (process.argv.includes('--record')) {
  const schema = JSON.stringify(zodToJsonSchema((FileReadTool as { inputSchema: never }).inputSchema))
  writeFileSync(join(import.meta.dir, 'fixtures', 'read-input-schema-28.json'), `${schema}\n`)
  console.log(`Read schema: ${Buffer.byteLength(schema)} bytes; prompt: ${Buffer.byteLength(await FileReadTool.prompt({ model: 'claude-sonnet-5-5' }))} bytes`)
  process.exit(0)
}
const tally = makeTally('prove-read-description')

const LINE = '- With no window parameters the read returns up to 2000 lines from the top of the file. A result that is not the whole file closes its numbered lines with `[lines 1-2000 of 3000 — Read(offset: 2001, limit: 1000) continues from there]` or `[lines 2001-3000 of 3000 — the end of the file]`; without that line it is the whole file'
const OLD_LINE = '- With no window parameters the read returns up to 2000 lines from the top of the file\n'
const NEXT_LINE = '- An optional line offset and limit narrow the window.'

tally.section('4.2 — the description: each fact once, 2,642 bytes with read targets on for a PDF- and image-capable model')
{
  const prompt: string = await FileReadTool.prompt({ model: 'claude-sonnet-5-5' })
  tally.check('read targets are on for this rendering', readTargetsEnabled() === true)
  tally.check('the line stands once, exactly, followed by the unchanged offset-and-limit line', prompt.split(LINE).length === 2 && prompt.includes(`${LINE}\n${NEXT_LINE}\n`), prompt)
  tally.check('.28\'s bare line is gone', !prompt.includes(OLD_LINE), prompt)
  tally.check('the 256 KB sentence stays off (FORK 5 side B)', !prompt.includes('256KB') && !prompt.includes('256 KB'), prompt)
  tally.check('the default window, the PDF per-request maximum and the line_anchors explanation are said once, in the offset and limit fields, the pages field and the line_anchors field, and not again in the description', !prompt.includes('Leaving them out') && !prompt.includes('handy for very long') && !prompt.includes('pages per request') && !prompt.includes('e.g. "1-5"') && !prompt.includes('line_anchors'), prompt)
  tally.check('the description names the archive, SQLite (<db>:<table>), document, negative offset and ranges lanes', prompt.includes('<archive>:<entry>') && prompt.includes('<db>:<table>') && prompt.includes('offset: -N') && prompt.includes('ranges'), prompt)
  tally.check('the description is 2,642 bytes (including the archive, SQLite, document, tail-offset and ranges sentence)', Buffer.byteLength(prompt) === 2642, `${Buffer.byteLength(prompt)} bytes`)
  const lines = prompt.split('\n')
  tally.check('the other lines: the opener, the clipping line, the prefix line, the media lines, the target lines, the empty-file line', lines[0] === 'Read the contents of a local file: any file on the machine, and a path that does not exist returns an error.' && lines[5] === '- Individual lines are cut off past 2000 characters; use `lossless: true` with `offset` + `limit` or `ranges` to show them completely within the same total budget. A clipped line does not authorise replacing its unseen text.' && lines[6] === '- Every returned line carries a prefix — a line number followed by a tab, then the line content — with numbering starting at 1' && lines[7] === '- Image files (PNG, JPG, and similar) are shown as the picture itself; `ocr: true` returns recognised text instead.' && lines.at(-1) === '- A file that exists but is empty produces a system-reminder note in place of content.' && lines.length === 16, JSON.stringify(lines))
  const noMedia: string = await FileReadTool.prompt({ model: 'glm-5.3' })
  tally.check('a rendering for a model without PDF or image input (glm-5.3) changes in the same one line only', noMedia.includes(`${LINE}\n${NEXT_LINE}\n`) && !noMedia.includes(OLD_LINE) && !noMedia.includes('This tool can read PDF files') && noMedia.includes('return recognised text through an installed OCR engine') && noMedia.includes('PDFs open as numbered text'), noMedia)
}

tally.section('5 — the input schema matches its recorded copy')
{
  const schema = JSON.stringify(zodToJsonSchema((FileReadTool as { inputSchema: never }).inputSchema))
  const stored = readFileSync(join(import.meta.dir, 'fixtures', 'read-input-schema-28.json'), 'utf8').replace(/\n$/, '')
  tally.check('the JSON Schema of inputSchema() equals fixtures/read-input-schema-28.json byte for byte', schema === stored, `${schema.length} vs ${stored.length}`)
  tally.check('it is 2,156 bytes with lossless ranges, outline, negative offset, image crop, scale and OCR', Buffer.byteLength(schema) === 2156, `${Buffer.byteLength(schema)} bytes`)
  tally.check('the tool keeps its name', FileReadTool.name === 'Read')
}

tally.finish()
