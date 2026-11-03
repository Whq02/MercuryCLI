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

tally.section('4.2 — one text: the description says what comes back, each fact once, and no manual rides behind it')
{
  const prompt: string = await FileReadTool.prompt({ model: 'claude-sonnet-5-5' })
  tally.check('read targets are on for this rendering', readTargetsEnabled() === true)
  tally.check('no wire/manual split: the description is the whole text the model ever reads for Read', (FileReadTool as { wireDescription?: unknown }).wireDescription === undefined)
  tally.check('the opener says the text, the window, the prefix and that the prefix is not content', prompt.startsWith('Reads a local file and returns its text with up to 2000 lines, each prefixed by a line number followed by a tab, then the line content; the prefix is not file content. A result that is not the whole file names the unread range.'), prompt)
  tally.check('the formats are said once: pictures or ocr, PDFs with pages, notebooks, office, archives (<archive>:<entry>), SQLite (<db>:<table>), audio and video', prompt.includes('Images are shown as pictures, or as recognised text with `ocr`.') && prompt.includes('PDFs open as numbered text with page markers, or as page pictures with `pages`') && prompt.includes('<archive>:<entry>') && prompt.includes('<db>:<table>') && prompt.includes('audio and video as timestamped transcripts'), prompt)
  tally.check('the targets are said once: a directory listing and mercury:// records, with mercury://seat named as this seat\'s own', prompt.includes('A directory path returns a bounded listing.') && prompt.includes("mercury://seat is this seat's own: the model, effort and posture this turn runs on."), prompt)
  tally.check('three paragraphs, under 900 bytes', prompt.split('\n\n').length === 3 && Buffer.byteLength(prompt) <= 900, `${prompt.split('\n\n').length} paragraphs, ${Buffer.byteLength(prompt)} bytes`)
  for (const gone of ['Usage:', 'Never edit', 'screenshot', 'ask which model', 'never from an earlier reply', 'WebFetch', 'Glob', 'Inspect', 'Bash', 'Whisper', 'ffmpeg', 'system-reminder', 'Full usage notes', 'continues from there', 'only when the whole file is too large']) {
    tally.check(`gone: "${gone}" (another tool, a rule, a repeat or a pre-empted result)`, !prompt.includes(gone))
  }
  const noMedia: string = await FileReadTool.prompt({ model: 'glm-5.3' })
  tally.check('a model without image input gets the OCR sentence in the same place and nothing else changes', noMedia.includes('Images return recognised text through an installed OCR engine, or the installation needed when none is available.') && !noMedia.includes('shown as pictures') && noMedia.replace('Images return recognised text through an installed OCR engine, or the installation needed when none is available.', 'Images are shown as pictures, or as recognised text with `ocr`.') === prompt, noMedia)
}

tally.section('5 — the input schema: shapes unchanged, prose carries each fact alone, and it matches its recorded copy')
{
  const schema = JSON.stringify(zodToJsonSchema((FileReadTool as { inputSchema: never }).inputSchema))
  const stored = readFileSync(join(import.meta.dir, 'fixtures', 'read-input-schema-28.json'), 'utf8').replace(/\n$/, '')
  tally.check('the JSON Schema of inputSchema() equals fixtures/read-input-schema-28.json byte for byte', schema === stored, `${schema.length} vs ${stored.length}`)
  tally.check('it is under 1,800 bytes with lossless ranges, outline, negative offset, image crop, scale and OCR', Buffer.byteLength(schema) <= 1800, `${Buffer.byteLength(schema)} bytes`)
  const parsed = JSON.parse(schema) as { properties: Record<string, { description?: string; type?: string }>; required?: string[] }
  tally.check('eleven fields in their order, file_path required', Object.keys(parsed.properties).join(',') === 'file_path,ocr,lossless,offset,limit,ranges,pages,scale,crop,outline,line_anchors' && JSON.stringify(parsed.required) === '["file_path"]', Object.keys(parsed.properties).join(','))
  const field = (name: string): string => parsed.properties[name]?.description ?? ''
  tally.check('the line clip lives in lossless alone', field('lossless').includes('a line is otherwise cut at 2000 characters') && field('lossless').includes('requires offset + limit or ranges, without outline'))
  tally.check('offset and limit carry no "only when the file is too large" rule', !field('offset').includes('too large') && !field('limit').includes('too large') && field('limit').includes('default 2000'))
  tally.check('the PDF page cap lives in pages alone', field('pages').includes('at most 20 pages per call'))
  tally.check('crop carries its box and no pre-empted refusal', field('crop') === 'For an image, a box [x1, y1, x2, y2] in original pixels, cut before any downscale.')
  tally.check('line_anchors names the anchor and what takes it', field('line_anchors').includes('"N#hhhh"') && field('line_anchors').includes('anchored Edit hunk'))
  tally.check('the tool keeps its name', FileReadTool.name === 'Read')
}

tally.finish()
