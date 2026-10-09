#!/usr/bin/env bun
import { mkdtempSync, readFileSync } from 'node:fs'
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

const tally = makeTally('prove-read-description')

const LINE = '- With no window parameters the read returns up to 2000 lines from the top of the file. A result that is not the whole file closes its numbered lines with `[lines 1-2000 of 3000 — Read(offset: 2001, limit: 1000) continues from there]` or `[lines 2001-3000 of 3000 — the end of the file]`; without that line it is the whole file'
const OLD_LINE = '- With no window parameters the read returns up to 2000 lines from the top of the file\n'
const NEXT_LINE = '- An optional line offset and limit narrow the window (handy for very long files). Leaving them out and taking the whole file is the default unless the file is huge.'

tally.section('4.2 — the description: each fact once, 1,888 bytes with read targets on for a PDF- and image-capable model')
{
  const prompt: string = await FileReadTool.prompt({ model: 'claude-sonnet-5-5' })
  tally.check('read targets are on for this rendering', readTargetsEnabled() === true)
  tally.check('the line stands once, exactly, followed by the unchanged offset-and-limit line', prompt.split(LINE).length === 2 && prompt.includes(`${LINE}\n${NEXT_LINE}\n`), prompt)
  tally.check('.28\'s bare line is gone', !prompt.includes(OLD_LINE), prompt)
  tally.check('the 256 KB sentence stays off (FORK 5 side B)', !prompt.includes('256KB') && !prompt.includes('256 KB'), prompt)
  tally.check('the description is 1,888 bytes (the opener folds the path facts; the absolute-path line, the second whole-file sentence and the capitals are gone)', Buffer.byteLength(prompt) === 1888, `${Buffer.byteLength(prompt)} bytes`)
  const lines = prompt.split('\n')
  tally.check('the other lines: the opener, the clipping line, the prefix line, the media lines, the target lines, the empty-file line', lines[0] === 'Read the contents of a local file: any file on the machine, and a path that does not exist returns an error.' && lines[5] === '- Individual lines are cut off past 2000 characters' && lines[6]!.startsWith('- Every returned line carries a prefix — a line number followed by a tab, then the line content; with `line_anchors: true`') && lines[7] === '- Image files (PNG, JPG, and similar) are shown as the picture itself.' && lines.at(-1) === '- A file that exists but is empty produces a system-reminder note in place of content.' && lines.length === 15, JSON.stringify(lines))
  const noMedia: string = await FileReadTool.prompt({ model: 'glm-5.3' })
  tally.check('a rendering for a model without PDF or image input (glm-5.3) changes in the same one line only', noMedia.includes(`${LINE}\n${NEXT_LINE}\n`) && !noMedia.includes(OLD_LINE) && !noMedia.includes('This tool can read PDF files') && noMedia.includes('cannot be shown to the current model'), noMedia)
}

tally.section('5 — the input schema is byte-identical to its .28 copy')
{
  const schema = JSON.stringify(zodToJsonSchema((FileReadTool as { inputSchema: never }).inputSchema))
  const stored = readFileSync(join(import.meta.dir, 'fixtures', 'read-input-schema-28.json'), 'utf8').replace(/\n$/, '')
  tally.check('the JSON Schema of inputSchema() equals fixtures/read-input-schema-28.json byte for byte', schema === stored, `${schema.length} vs ${stored.length}`)
  tally.check('it is 936 bytes, the study\'s measured figure', Buffer.byteLength(schema) === 936, `${Buffer.byteLength(schema)} bytes`)
  tally.check('the tool keeps its name', FileReadTool.name === 'Read')
}

tally.finish()
