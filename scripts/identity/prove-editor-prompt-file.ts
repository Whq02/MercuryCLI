#!/usr/bin/env bun
// gate-watch: src/utils/tempfile.ts src/utils/promptEditor.ts
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'

const REPO = resolve(import.meta.dir, '..', '..')
let failures = 0
let checks = 0
function check(label: string, cond: boolean, detail = ''): void {
  checks++
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}

console.log('the external editor opens a mercury-prompt file')

const { generateTempFilePath } = await import('../../src/utils/tempfile.ts')

const random = generateTempFilePath()
check('the default file lives in the temp dir', dirname(random) === tmpdir(), random)
check("the default file name is Mercury's: mercury-prompt-<uuid>.md", /^mercury-prompt-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.md$/.test(basename(random)), basename(random))
check('two calls never collide', generateTempFilePath() !== random)
const stable = generateTempFilePath(undefined, undefined, { contentHash: 'the same content' })
check('a content-stable path keeps the same name and a 16-hex identifier', /^mercury-prompt-[0-9a-f]{16}\.md$/.test(basename(stable)) && generateTempFilePath(undefined, undefined, { contentHash: 'the same content' }) === stable, basename(stable))
check("a caller's own prefix and extension pass through", basename(generateTempFilePath('mercury-note', '.txt')).startsWith('mercury-note-') && generateTempFilePath('mercury-note', '.txt').endsWith('.txt'))
check("the name opens with Mercury's own word", basename(random).startsWith('mercury-'), basename(random))

const editor = readFileSync(join(REPO, 'src/utils/promptEditor.ts'), 'utf8')
check('the prompt editor writes the file it opens through the default name', /const tempFilePath = generateTempFilePath\(\)\n\s+writeFileSync\(tempFilePath, textForFile/.test(editor))
const tempfile = readFileSync(join(REPO, 'src/utils/tempfile.ts'), 'utf8')
check('the default is spelled once, in the one helper', (tempfile.match(/'mercury-prompt'/g) ?? []).length === 1 && /prefix: string = 'mercury-prompt'/.test(tempfile))

console.log('\n============================================================')
if (failures === 0) {
  console.log(` ✅ EDITOR PROMPT FILE GREEN (${checks} checks)`)
  process.exit(0)
}
console.log(` ❌ EDITOR PROMPT FILE RED (${failures} of ${checks} checks failed)`)
process.exit(1)
