#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'edit-composition-home-'))
process.env.MERCURY_BARE = '1'

const { FileEditTool } = await import('../../src/tools/FileEditTool/FileEditTool.ts')
const { getEmptyToolPermissionContext } = await import('../../src/Tool.ts')

let failures = 0
let checks = 0
function check(label: string, ok: boolean, detail = ''): void {
  checks++
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
}

const fixtures = mkdtempSync(join(tmpdir(), 'edit-composition-'))
function makeContext(path: string, content: string) {
  return {
    readFileState: new Map([[path, { content, timestamp: Date.now() + 60_000, offset: undefined, limit: undefined }]]),
    userModified: false,
    updateFileHistoryState: () => {},
    dynamicSkillDirTriggers: new Set<string>(),
    nestedMemoryAttachmentTriggers: new Set<string>(),
    abortController: new AbortController(),
    getAppState: () => ({ toolPermissionContext: getEmptyToolPermissionContext() }),
  } as never
}
async function validate(input: Record<string, unknown>, ctx: unknown): Promise<string> {
  const verdict = await (FileEditTool as { validateInput: Function }).validateInput(input, ctx)
  return verdict.result === false ? String(verdict.message) : '(accepted)'
}

const DECOMPOSED = 'decomposed o: o\u0308 here\ncafe\u0301 au lait\nplain line\n'
const nfd = join(fixtures, 'nfd.txt')
writeFileSync(nfd, DECOMPOSED)
const HINT = 'The file spells this text with another Unicode composition of the same letters'

console.log('── a precomposed old_string against a decomposed file ──')
const composed = await validate({ file_path: nfd, old_string: 'decomposed o: \u00f6 here', new_string: 'decomposed o: OE here' }, makeContext(nfd, DECOMPOSED))
check('the refusal names the composition difference and sends the model to the Read\'s own spelling (RED on the base: a bare "not found" that looked wrong beside an identical-looking line)', composed.startsWith('The old_string was not found in the file.') && composed.includes(HINT) && composed.includes('a Read of the lines carries the file\'s own spelling'), composed.slice(0, 300))
const accent = await validate({ file_path: nfd, old_string: 'caf\u00e9 au lait', new_string: 'latte' }, makeContext(nfd, DECOMPOSED))
check('the same for a precomposed é against a decomposed one', accent.includes(HINT), accent.slice(0, 300))

console.log('── an ordinary absent old_string gets no such hint ──')
const absent = await validate({ file_path: nfd, old_string: 'nowhere at all', new_string: 'x' }, makeContext(nfd, DECOMPOSED))
check('a string the file does not hold in any composition is refused plainly', absent.startsWith('The old_string was not found in the file.\nString: nowhere at all'), absent.slice(0, 300))

console.log('── a near miss names the closest lines read this session, whether new_string already stands, and a whitespace or escaping difference ──')
const FOUR = ['export function run(items: string[]): number {', '    let total = 0', '    for (const item of items) {', '        if (item.length > 0) {', '            total += item.length', '        }', '    }', '    return total', '}', ''].join('\n')
const four = join(fixtures, 'four.ts')
writeFileSync(four, FOUR)
const drift = await validate({ file_path: four, old_string: '    return total * 2', new_string: '    return total * 3' }, makeContext(four, FOUR))
check('the refusal keeps its first sentence, then names the closest lines with their numbers and range anchor, then the string (RED on the base: the bare sentence and the string)', drift.startsWith('The old_string was not found in the file.\nThe lines read this session closest to old_string, numbered with their anchor:\n5\t') && /\n8\t    return total\n9\t\}\n\(anchor: ra:[0-9a-f]+:L5\+5\)\nString:     return total \* 2$/.test(drift), drift)
const landed = await validate({ file_path: four, old_string: '    return total * 2', new_string: '    return total' }, makeContext(four, FOUR))
check('a new_string the file already holds is named with its line, before the closest lines', landed.startsWith('The old_string was not found in the file.\nnew_string already stands at line 8 — the edit may have landed on an earlier call.\nThe lines read this session closest to old_string'), landed)
const spaced = await validate({ file_path: four, old_string: '            total  +=  item.length', new_string: '            total += 1' }, makeContext(four, FOUR))
const escaped = await validate({ file_path: four, old_string: 'export function run(items: string[]): number {\\n\\tlet total = 0', new_string: 'y' }, makeContext(four, FOUR))
check('a line that differs only in whitespace is shown beside old_string with tabs and spaces made visible, and a \\n \\t drift is named as escaping', spaced.includes("Of these, line 5 differs from old_string only in whitespace; the file's spelling, then old_string's (→ tab, · space):\n5 file: ············total·+=·item.length\n5 old_string: ············total··+=··item.length\nString:") && escaped.includes('Of these, line 2 differs from old_string only in whitespace and escaping — old_string spells backslash sequences') && escaped.includes('\n2 file: ····let·total·=·0\n2 old_string: →let·total·=·0\n'), `${spaced}\n---\n${escaped}`)

console.log('── the decomposed spelling itself edits ──')
const exact = await validate({ file_path: nfd, old_string: 'decomposed o: o\u0308 here', new_string: 'decomposed o: OE here' }, makeContext(nfd, DECOMPOSED))
check('the file\'s own spelling is accepted', exact === '(accepted)', exact.slice(0, 200))

console.log(`\n${failures === 0 ? `ALL GREEN (${checks} checks)` : `${failures} FAILURE(S) of ${checks}`}`)
process.exit(failures === 0 ? 0 : 1)
