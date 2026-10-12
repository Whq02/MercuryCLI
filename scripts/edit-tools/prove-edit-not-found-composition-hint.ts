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

console.log('── the decomposed spelling itself edits ──')
const exact = await validate({ file_path: nfd, old_string: 'decomposed o: o\u0308 here', new_string: 'decomposed o: OE here' }, makeContext(nfd, DECOMPOSED))
check('the file\'s own spelling is accepted', exact === '(accepted)', exact.slice(0, 200))

console.log(`\n${failures === 0 ? `ALL GREEN (${checks} checks)` : `${failures} FAILURE(S) of ${checks}`}`)
process.exit(failures === 0 ? 0 : 1)
