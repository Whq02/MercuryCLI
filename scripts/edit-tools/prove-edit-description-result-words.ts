#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'edit-description-words-home-'))
process.env.MERCURY_BARE = '1'
process.env.MERCURY_PROJECT_INTEL = '0'
delete process.env.MERCURY_EDIT_HUNKS
delete process.env.MERCURY_CHANGE_RECEIPTS
delete process.env.NODE_ENV

const { getEditToolDescription } = await import('../../src/tools/FileEditTool/prompt.ts')
const { FileEditTool } = await import('../../src/tools/FileEditTool/FileEditTool.ts')
const { zodToJsonSchema } = await import('../../src/utils/zodToJsonSchema.ts')

let failures = 0
let checks = 0
function check(label: string, cond: boolean, detail = ''): void {
  checks++
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail.length > 600 ? `${detail.slice(0, 600)}…` : detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t)
}

const NOT_UNIQUE_BULLET = '- A non-unique `old_string` writes nothing; the error names and shows every match with its neighbouring lines: widen it with a line that differs, or pass `replace_all` to rewrite every occurrence at once (the right tool for bulk substitutions, such as renaming an identifier throughout the file).'
const LANDED_BULLET = '- A landed edit shows the changed lines as read back after the write, numbered as Read numbers them, with three lines of context; they count as read, so checking the edit needs no Read.'
const OLD_BULLET = '- A non-unique `old_string` makes the edit fail outright: widen it with more of the surrounding lines, or pass `replace_all` to rewrite every occurrence at once (the right tool for bulk substitutions, such as renaming an identifier throughout the file).'
const STEERING = '\n- Semantic shortcut: cross-file renames belong to the LSP rename operation; repetitive structural JS/TS changes belong to the Structure tool (preview-first, stale-safe).'

section('W1. the two bullets, byte for byte, in place of .28\'s non-unique bullet')
const description = getEditToolDescription(null)
check('W1 the description carries the non-unique bullet and the landed-edit bullet, in that order, each once', description.split(NOT_UNIQUE_BULLET).length === 2 && description.split(LANDED_BULLET).length === 2 && description.includes(`${NOT_UNIQUE_BULLET}\n${LANDED_BULLET}\n- \`append\` adds text`), description)
check('W1b .28\'s non-unique bullet is gone', !description.includes(OLD_BULLET) && !description.includes('makes the edit fail outright'), description)
check('W1c every other line stands: the opener, the four usage bullets before, the append and carry bullets after', description.startsWith('Swap one exact string for another inside a file.\n\nUsage:\n- An edit lands only after `Read` has read the file somewhere in this conversation — editing unread files errors.\n') && description.includes('\n- Keep emoji out of file content unless the user has specifically asked for them.\n') && description.includes('\n- An edit that touches lines you have not read still lands in one call'), description)

section('W2. the size: 1,986 bytes with the measured runs\' steering line (.28: 1,757)')
const withSteering = description + STEERING
check('W2 the description with the LSP-and-Structure steering line is 1,986 bytes', Buffer.byteLength(withSteering) === 1986, `${Buffer.byteLength(withSteering)} bytes`)
check('W2b the template alone is 1,816 bytes (.28: 1,587; +229)', Buffer.byteLength(description) === 1816, `${Buffer.byteLength(description)} bytes`)

section('W3. the input schema is byte-identical to .28\'s stored copy')
const schema = JSON.stringify(zodToJsonSchema((FileEditTool as { inputSchema: never }).inputSchema))
const stored = readFileSync(join(import.meta.dirname, 'fixtures', 'edit-input-schema-28.json'), 'utf8').replace(/\n$/, '')
check('W3 the JSON Schema of inputSchema() equals fixtures/edit-input-schema-28.json byte for byte', schema === stored, `${schema.length} vs ${stored.length} bytes`)
check('W3b it is 2,833 bytes, the study\'s measured figure', Buffer.byteLength(schema) === 2833, `${Buffer.byteLength(schema)} bytes`)

console.log(`\n${failures === 0 ? `ALL GREEN (${checks} checks)` : `${failures} FAILURE(S) of ${checks}`}`)
process.exit(failures === 0 ? 0 : 1)
