#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'edit-not-unique-home-'))
process.env.MERCURY_BARE = '1'
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.ANTHROPIC_API_KEY = 'proof-key-ci-gate-not-a-real-key'
process.env.ANTHROPIC_BASE_URL = 'http://127.0.0.1:9'
process.env.BROWSER = '/usr/bin/true'
delete process.env.MERCURY_EDIT_HUNKS
delete process.env.MERCURY_CHANGE_RECEIPTS
delete process.env.MERCURY_EDIT_STALE_RECOVERY
delete process.env.MERCURY_EDIT_LEDGER
delete process.env.NODE_ENV

const { _resetSeenLinesForTesting } = await import('../../src/services/changeTransaction/seenLines.ts')
const { editOutcomeRows } = await import('../../src/services/changeTransaction/editOutcomeLedger.ts')
const { ownerFromToolUseContext } = await import('../../src/services/run/resolveOwner.ts')
const { runToolUse } = await import('../../src/services/tools/toolExecution.ts')
const { FileEditTool } = await import('../../src/tools/FileEditTool/FileEditTool.ts')
const { FileReadTool } = await import('../../src/tools/FileReadTool/FileReadTool.ts')
const { getEmptyToolPermissionContext } = await import('../../src/Tool.ts')

let failures = 0
let checks = 0
function check(label: string, cond: boolean, detail = ''): void {
  checks++
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail.length > 900 ? `${detail.slice(0, 900)}…` : detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t)
}
const guard = setTimeout(() => {
  console.log('\nTIMEOUT — the not-unique proof exceeded 120s')
  process.exit(1)
}, 120_000)
guard.unref?.()

const fixtures = mkdtempSync(join(tmpdir(), 'edit-not-unique-fixture-'))
type Entry = { content: string; timestamp: number; offset?: number; limit?: number; isPartialView?: boolean }
type Ctx = { readFileState: Map<string, Entry> }
function makeContext(): Ctx {
  return {
    readFileState: new Map<string, Entry>(),
    userModified: false,
    updateFileHistoryState: () => {},
    dynamicSkillDirTriggers: new Set<string>(),
    nestedMemoryAttachmentTriggers: new Set<string>(),
    abortController: new AbortController(),
    getAppState: () => ({ toolPermissionContext: getEmptyToolPermissionContext() }),
  } as never as Ctx
}
const PARENT = { uuid: '00000000-0000-0000-0000-000000000032', message: { id: 'msg_fixture' } }
type Verdict = { ok: true; text: string } | { ok: false; message: string; code?: number; meta?: Record<string, string> }
async function run(tool: unknown, input: Record<string, unknown>, ctx: Ctx, id: string): Promise<Verdict> {
  const t = tool as { validateInput?: Function; call: Function; mapToolResultToToolResultBlockParam: Function }
  if (t.validateInput) {
    const verdict = await t.validateInput(input, ctx)
    if (verdict.result === false) return { ok: false, message: String(verdict.message), code: verdict.errorCode, meta: verdict.meta }
  }
  try {
    const out = await t.call(input, ctx, null, PARENT)
    const block = t.mapToolResultToToolResultBlockParam(out.data, id)
    return { ok: true, text: typeof block.content === 'string' ? block.content : '' }
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) }
  }
}
const edit = (input: Record<string, unknown>, ctx: Ctx): Promise<Verdict> => run(FileEditTool, input, ctx, 'toolu_edit')
const read = (input: Record<string, unknown>, ctx: Ctx): Promise<Verdict> => run(FileReadTool, input, ctx, 'toolu_read')
const textOf = (v: Verdict): string => (v.ok ? v.text : v.message)
const codeOf = (v: Verdict): number | undefined => (v.ok ? undefined : v.code)
const rowsOf = (text: string): string[] => text.split('\n').filter(line => /^\d+\t/.test(line))
const BENCH_CLASS = /matches of the string to replace|is not unique|Found \d+ matches/i

const CONFIG = 'TIMEOUT = 30\nRETRIES = 3\n\ndef load():\n    timeout = TIMEOUT\n    return timeout\n\ndef save():\n    timeout = TIMEOUT\n    return timeout\n'
const J = [
  '"""Connection helpers for the drive."""',
  '',
  '',
  'def connect(host):',
  '    retries = 3',
  '    return open_socket(host, retries)',
  '',
  '',
  'def reconnect(host, wait):',
  '    if wait:',
  '        retries = 3',
  '        return open_socket(host, retries)',
  '    return None',
  '',
  '',
  'def open_socket(host, retries):',
  '    return (host, retries)',
  '',
].join('\n')
const DIFFERING = 'def a():\n    if x:\n        y()\n\ndef b():\n  if x:\n      y()\n'

const EXPECTED_NU_A = [
  'Found 2 matches of the string to replace, but replace_all is false, so nothing was written. The matches are at lines 5, 9; Read(offset: 2, limit: 7) shows the first with its neighbours. To change one, send old_string again with a neighbouring line that differs between them; to change every match, set replace_all to true.',
  '',
  'String:     timeout = TIMEOUT',
].join('\n')
const EXPECTED_NU_J = [
  'Found 2 matches of the string to replace, but replace_all is false, so nothing was written. The matches are at lines 5, 11; Read(offset: 2, limit: 7) shows the first with its neighbours. To change one, send old_string again with a neighbouring line that differs between them; to change every match, set replace_all to true.',
  '',
  'String:     retries = 3',
].join('\n')
const EXPECTED_NU_DIFF = [
  'Found 2 matches of the string to replace, but they differ from each other in whitespace or characters; nothing was written. The matches (found after ignoring indentation) are at lines 2-3, 6-7; Read(offset: 1, limit: 6) shows the first with its neighbours. Send old_string spelled as the file spells the one you mean, with a neighbouring line if that spelling occurs more than once.',
  '',
  'String: \tif x:',
  '\t\ty()',
].join('\n')

const texts: string[] = []

section('N1-N2. (a\u2032) the file read in full: the refusal names both lines and the Read that shows the first, never the lines themselves; the next call lands with no Read')
_resetSeenLinesForTesting()
mkdirSync(join(fixtures, 'a_three'))
const aPath = join(fixtures, 'a_three', 'config.py')
writeFileSync(aPath, CONFIG)
const aCtx = makeContext()
await read({ file_path: aPath }, aCtx)
const n1 = await edit({ file_path: aPath, old_string: '    timeout = TIMEOUT', new_string: '    timeout = TIMEOUT * 2' }, aCtx)
texts.push(textOf(n1))
check('N1 the refusal is the specification\'s a\u2032 text byte for byte, code 9: the lines named, the Read that shows the first, no row of the file', !n1.ok && n1.message === EXPECTED_NU_A && codeOf(n1) === 9 && rowsOf(n1.message).length === 0, textOf(n1))
check('N1b nothing was written', readFileSync(aPath, 'utf8') === CONFIG)
check('N1c meta keeps oldString and actualOldString and adds matchLines', !n1.ok && n1.meta?.oldString === '    timeout = TIMEOUT' && n1.meta?.actualOldString === '    timeout = TIMEOUT' && n1.meta?.matchLines === '5, 9', JSON.stringify(n1.ok ? null : n1.meta))
const n2 = await edit({ file_path: aPath, old_string: 'def save():\n    timeout = TIMEOUT', new_string: 'def save():\n    timeout = TIMEOUT * 2' }, aCtx)
check('N2 with a neighbouring line and no Read between, the edit lands and HEAD ends "1 occurrence replaced; changed line 9 (the file has 10 lines)."', n2.ok && (n2.text.split('\n')[0] ?? '').endsWith('1 occurrence replaced; changed line 9 (the file has 10 lines).'), textOf(n2))

section('N3. the file never read: the read law answers first with nothing of the file — no match count, no line numbers, no rows; after a Read the matches are named')
_resetSeenLinesForTesting()
const unreadPath = join(fixtures, 'a_three', 'unread.py')
writeFileSync(unreadPath, CONFIG)
const unreadCtx = makeContext()
const n3 = await edit({ file_path: unreadPath, old_string: '    timeout = TIMEOUT', new_string: '    timeout = TIMEOUT * 2' }, unreadCtx)
check('N3 the first answer is the read law, code 6, with no match count, no line numbers and no row of the file (RED on the base: code 9, "Found 2 matches" and rows 2-10 of a file never read)', !n3.ok && codeOf(n3) === 6 && n3.message.startsWith('Read the file before editing it — it exists and was not read in this session') && !/Found \d+ matches/.test(n3.message) && !/lines 5, 9/.test(n3.message) && rowsOf(n3.message).length === 0, `code ${codeOf(n3)}: ${textOf(n3)}`)
const n3b = await edit({ file_path: unreadPath, old_string: 'def save():\n    timeout = TIMEOUT', new_string: 'def save():\n    timeout = TIMEOUT * 2' }, unreadCtx)
check('N3b the next call without a Read is refused the same way: the refusal recorded nothing (RED on the base: the edit landed)', !n3b.ok && codeOf(n3b) === 6 && readFileSync(unreadPath, 'utf8') === CONFIG, textOf(n3b))
await read({ file_path: unreadPath }, unreadCtx)
const n3c = await edit({ file_path: unreadPath, old_string: '    timeout = TIMEOUT', new_string: '    timeout = TIMEOUT * 2' }, unreadCtx)
texts.push(textOf(n3c))
check('N3c after a Read the same call gets the not-unique refusal naming lines 5 and 9, code 9', !n3c.ok && codeOf(n3c) === 9 && n3c.message.includes('The matches are at lines 5, 9;'), textOf(n3c))
const n3d = await edit({ file_path: unreadPath, old_string: 'def save():\n    timeout = TIMEOUT', new_string: 'def save():\n    timeout = TIMEOUT * 2' }, unreadCtx)
check('N3d …and the widened old_string lands', n3d.ok && readFileSync(unreadPath, 'utf8').includes('def save():\n    timeout = TIMEOUT * 2\n'), textOf(n3d))

section('N4. (j) the four-space trap: the refusal names the lines and the Read that shows the eight spaces the model needs')
_resetSeenLinesForTesting()
const jPath = join(fixtures, 'j_net.py')
writeFileSync(jPath, J)
const jCtx = makeContext()
await read({ file_path: jPath }, jCtx)
const n4 = await edit({ file_path: jPath, old_string: '    retries = 3', new_string: '    retries = 5' }, jCtx)
texts.push(textOf(n4))
check('N4 the refusal is the specification\'s j text byte for byte', !n4.ok && n4.message === EXPECTED_NU_J, textOf(n4))
const n4b = await edit({ file_path: jPath, old_string: '        retries = 3', new_string: '        retries = 5' }, jCtx)
check('N4b the eight-space old_string lands with HEAD "… 1 occurrence replaced; changed line 11 (the file has 17 lines)."', n4b.ok && (n4b.text.split('\n')[0] ?? '') === `The file ${jPath} has been updated successfully: 1 occurrence replaced; changed line 11 (the file has 17 lines).`, textOf(n4b))

section('N5-N6. the differing pair: the spellings differ, so replace_all is not advised; with replace_all the refusal says why')
_resetSeenLinesForTesting()
const dPath = join(fixtures, 'differing.py')
writeFileSync(dPath, DIFFERING)
const dCtx = makeContext()
await read({ file_path: dPath }, dCtx)
const n5 = await edit({ file_path: dPath, old_string: '\tif x:\n\t\ty()', new_string: '\tif x:\n\t\tz()' }, dCtx)
texts.push(textOf(n5))
check('N5 the refusal is the specification\'s differing-pair text byte for byte (RED on .28: "set replace_all to true", advice that only meets the replace_all refusal)', !n5.ok && n5.message === EXPECTED_NU_DIFF && codeOf(n5) === 9, textOf(n5))
const n6 = await edit({ file_path: dPath, old_string: '\tif x:\n\t\ty()', new_string: '\tif x:\n\t\tz()', replace_all: true }, dCtx)
texts.push(textOf(n6))
check('N6 with replace_all the message opens with the replace_all clause and names lines 2-3, 6-7', !n6.ok && n6.message.startsWith('Found 2 matches of the string to replace, but they differ from each other in whitespace or characters, so replace_all cannot rewrite them as one string; nothing was written.') && n6.message.includes('are at lines 2-3, 6-7'), textOf(n6))
check('N6b nothing was written by either call', readFileSync(dPath, 'utf8') === DIFFERING)

section('N7. the cap: thirty identical lines name twenty ranges, show no row and point the Read at the first')
_resetSeenLinesForTesting()
{
  const path = join(fixtures, 'cap.py')
  const lines = Array.from({ length: 120 }, (_, i) => ((i % 4) === 1 ? 'pass' : `step_${i + 1}()`))
  writeFileSync(path, lines.join('\n') + '\n')
  const ctx = makeContext()
  await read({ file_path: path }, ctx)
  const n7 = await edit({ file_path: path, old_string: 'pass', new_string: 'return' }, ctx)
  texts.push(textOf(n7))
  const named = /are at lines ([^;]*?), and (\d+) more;/.exec(textOf(n7))
  check('N7 L names 20 ranges, then ", and 10 more"', !n7.ok && n7.message.startsWith('Found 30 matches of the string to replace, but replace_all is false, so nothing was written.') && named !== null && named[1]!.split(', ').length === 20 && named[2] === '10', textOf(n7).split('\n')[0] ?? '')
  const rows = rowsOf(textOf(n7))
  check('N7b no row of the file is shown (RED on the base: up to 60 rows)', rows.length === 0, `${rows.length} rows`)
  check('N7c the words name the Read(offset, limit) that shows the first match with its neighbours', textOf(n7).includes('Read(offset: 1, limit: 5) shows the first with its neighbours.'), textOf(n7).split('\n')[0] ?? '')
}

section('N8. the bench\'s own error class matches every text, and the chokepoint counts error-9 in the edit-outcome ledger')
{
  check('N8 every not-unique text matches /matches of the string to replace|is not unique|Found \\d+ matches/i', texts.length === 6 && texts.every(text => BENCH_CLASS.test(text)), texts.map(text => text.split('\n')[0]).join(' | '))
  check('N8a no not-unique text carries a row of the file', texts.every(text => rowsOf(text).length === 0), texts.map(text => String(rowsOf(text).length)).join(','))
  _resetSeenLinesForTesting()
  const path = join(fixtures, 'ledger.py')
  writeFileSync(path, CONFIG)
  const toolPermissionContext = getEmptyToolPermissionContext()
  const appState = { toolPermissionContext, sessionHooks: new Map(), mcp: { clients: [], tools: [], commands: [], resources: {} } }
  const ctx = {
    abortController: new AbortController(),
    getAppState: () => appState,
    setAppState: () => {},
    messages: [],
    agentType: undefined,
    agentId: undefined,
    toolDecisions: new Map(),
    readFileState: new Map([[path, { content: CONFIG, timestamp: Date.now() + 60_000, offset: undefined, limit: undefined }]]),
    userModified: false,
    updateFileHistoryState: () => {},
    dynamicSkillDirTriggers: new Set<string>(),
    nestedMemoryAttachmentTriggers: new Set<string>(),
    options: { tools: [FileEditTool], mcpClients: [], isNonInteractiveSession: true, engineModel: 'proof-model-not-unique' },
  }
  const allow = async (_t: unknown, input: unknown) => ({ behavior: 'allow', updatedInput: input })
  const updates: unknown[] = []
  for await (const update of runToolUse(
    { type: 'tool_use', id: 'toolu_nu8', name: 'Edit', input: { file_path: path, old_string: '    timeout = TIMEOUT', new_string: '    timeout = TIMEOUT * 2' } } as never,
    { uuid: 'uuid-nu8', requestId: 'req_nu8', message: { id: 'msg_nu8' } } as never,
    allow as never,
    ctx as never,
  )) {
    updates.push(update)
  }
  const first = (updates[0] as { message?: { message?: { content?: Array<{ content?: unknown; is_error?: boolean }> } } } | undefined)?.message?.message?.content?.[0]
  const content = String(first?.content ?? '')
  check('N8b through the real tool-call road, on a file read in full, the refusal is a tool_use_error that matches the bench class, names the lines and shows no row', first?.is_error === true && content.startsWith('<tool_use_error>Found 2 matches of the string to replace') && content.includes('are at lines 5, 9;') && BENCH_CLASS.test(content) && rowsOf(content).length === 0, content.slice(0, 300))
  const rows = editOutcomeRows(ownerFromToolUseContext(ctx as never))
  const row = rows.find(r => r.model === 'proof-model-not-unique' && r.surface === 'edit')
  check('N8c the edit-outcome ledger records error-9 for it (a file read in full; an unread file answers error-6, the read law, before any match is counted)', row !== undefined && row.outcome === 'error-9' && row.count === 1, JSON.stringify(rows))
}

console.log(`\n${failures === 0 ? `ALL GREEN (${checks} checks)` : `${failures} FAILURE(S) of ${checks}`}`)
process.exit(failures === 0 ? 0 : 1)
