#!/usr/bin/env bun
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'floor-words-')))
const before = process.cwd()
mkdirSync(join(scratch, 'run'))
process.chdir(join(scratch, 'run'))
process.env.MERCURY_CONFIG_DIR = join(scratch, 'home')
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const { getEmptyToolPermissionContext } = await import('../../src/Tool.js')
const { bashToolHasPermission } = await import('../../src/tools/BashTool/bashPermissions.js')
const { parseCommandRaw, PARSE_ABORTED } = await import('../../src/utils/bash/parser.js')
const { analyzeCommand } = await import('../../src/utils/bash/treeSitterAnalysis.js')
const context = { ...getEmptyToolPermissionContext(), mode: 'default' } as never
let failures = 0
function check(label: string, ok: boolean, detail = ''): void {
  if (!ok) failures++
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${label}${ok || !detail ? '' : ` — ${detail}`}`)
}
const rows: Array<[string, RegExp]> = [
  ['rm -rf $(cat x)', /command substitution/i],
  ['cat >(cat)', /process substitution/i],
  ['rm -rf $HOME/cache', /variable|expansion/i],
  ["echo 'unclosed", /parse|syntax|quote/i],
  ['echo ' + 'x'.repeat(9996), /10,?000|length|size/i],
]
for (const [command, construct] of rows) {
  const result = await bashToolHasPermission({ command }, context)
  const message = 'message' in result ? result.message : ''
  check(`ask identifies ${JSON.stringify(command.slice(0, 50))}`, result.behavior === 'ask' && construct.test(message ?? ''), JSON.stringify(result))
  check('the floor sentence names the way through', /approve|approval/i.test(message ?? '') && /spell|literal|split|simpl|fix|short|run|retry/i.test(message ?? ''), message)
  check('the floor writes no opaque fallback words', !/MERCURY(?:nl|dq|sq|op|cp)[0-9a-f]+z|security risks|malformed syntax/.test(message ?? ''), message)
}
const continued = await bashToolHasPermission({ command: 'wc -l file |\n python3 -' }, context)
check('continuation refusal names the written command, not a marker', JSON.stringify(continued).includes('python3 -') && !/MERCURY(?:nl|dq|sq|op|cp)[0-9a-f]+z/.test(JSON.stringify(continued)), JSON.stringify(continued))
const { parseForSecurity } = await import('../../src/utils/permissions/decision/commandAnalysis.js')
const spaced = await parseForSecurity('echo "  "')
check('quoted whitespace is literal data, not an unproven command', spaced.kind === 'simple' && spaced.commands[0]?.argv[1] === '  ', JSON.stringify(spaced))
const short = await parseCommandRaw('echo é😀 | cat')
check('the packaged parser reports 14 UTF-16 units, not 17 bytes', short !== null && short !== PARSE_ABORTED && short.endIndex === 14)
const command = "echo é😀 '$(literal);' | cat"
const root = await parseCommandRaw(command)
check('the quote projection has a product tree', root !== null && root !== PARSE_ABORTED)
if (root && root !== PARSE_ABORTED) {
  const analysis = analyzeCommand(root, command)
  check('the UTF-16 projection removes exactly the quoted span', analysis.quoteContext.fullyUnquoted === 'echo é😀  | cat', JSON.stringify(analysis.quoteContext))
  check('literal substitution is not an executable node', !analysis.dangerousPatterns.hasCommandSubstitution)
}
process.chdir(before)
rmSync(scratch, { recursive: true, force: true })
console.log(failures ? `prove-floor-words: ${failures} FAILURE(S)` : 'prove-floor-words: ALL LAWS HOLD')
process.exit(failures ? 1 : 0)
