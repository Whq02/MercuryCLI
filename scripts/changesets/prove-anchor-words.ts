#!/usr/bin/env bun
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const ROOT = join(import.meta.dir, '..', '..')
const original = process.cwd()
const world = realpathSync(mkdtempSync(join(tmpdir(), 'anchor-words-')))
const project = join(world, 'project')
mkdirSync(join(project, 'tests'), { recursive: true })
process.env.MERCURY_CONFIG_DIR = join(world, 'home')
process.chdir(project)
const { checkAnchor, formatAnchorFailure, mintFileAnchor } = await import(join(ROOT, 'src/services/changeTransaction/snapshotAnchor.ts'))
const { planChangeSet } = await import(join(ROOT, 'src/services/changeTransaction/changeSetPlan.ts'))
const { FileReadTool } = await import(join(ROOT, 'src/tools/FileReadTool/FileReadTool.ts'))
const { getDefaultAppState } = await import(join(ROOT, 'src/state/AppStateStore.ts'))
const { FILE_UNCHANGED_STUB } = await import(join(ROOT, 'src/tools/FileReadTool/prompt.ts'))
const { matchExactEdit } = await import(join(ROOT, 'src/tools/FileEditTool/FileEditTool.ts'))

let failures = 0
function check(label: string, ok: boolean, detail = ''): void {
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
}

const content = 'line 1\nline 2\n'
const bare = mintFileAnchor(content)
const faults: Array<[string, string, RegExp]> = [
  [`${bare.slice(0, -1)}`, 'one hex character short (the evidence: fa:3d1cebfbc4e)', /has 11 hex characters after "fa:" where the digest has exactly 12/],
  [`${bare}0`, 'one hex character long', /has 13 hex characters after "fa:" where the digest has exactly 12/],
  [`${bare}:L1+2`, 'a whole-file anchor with a range tail', /carries ":L1\+2" after the 12-character digest; a whole-file anchor ends with the digest/],
  [`(anchor: ${bare})`, 'the decorated form a Read prints', /carries the "\(anchor: …\)" wrapper around the value; pass only the fa:… or ra:… value/],
  [`fa:3d0c41bfbc4g`, 'a non-hex character', /has a character outside 0-9 and a-f in its digest "3d0c41bfbc4g"/],
  [`xa:${bare.slice(3)}`, 'an unknown prefix', /starts with "xa:" where an anchor starts with "fa:" \(the whole file\) or "ra:" \(a line range\)/],
  [`ra:${bare.slice(3)}`, 'a range anchor without its range', /is missing its ":L<start>\+<count>" range after the digest/],
  [`ra:${bare.slice(3)}:L0+5`, 'a range anchor with a zero start', /has a range ":L0\+5" that is not ":L<start>\+<count>" with both counts above zero/],
  [` ${bare}`, 'surrounding whitespace', /carries surrounding whitespace/],
]
for (const [given, label, words] of faults) {
  const result = checkAnchor(given, content, '/tmp/f.txt')
  check(`${label} is refused as malformed`, !result.ok && result.reason === 'malformed', JSON.stringify(result))
  if (result.ok) continue
  check(`${label}: the refusal states exactly what did not match`, words.test(result.rereadHint), result.rereadHint)
  check(`${label}: the refusal says where the right value comes from`, /the value to pass is the one a Read of \/tmp\/f\.txt shows after "anchor:"/.test(result.rereadHint), result.rereadHint)
  check(`${label}: the refusal blames nothing else`, !/without the surrounding|bare fa:… or ra:… value in expected_anchor|is not a valid anchor/.test(result.rereadHint), result.rereadHint)
  const message = formatAnchorFailure(result, given)
  check(`${label}: the Edit refusal carries the same diagnosis`, message.startsWith('Malformed anchor: ') && words.test(message), message)
}
check('the bare value is accepted', checkAnchor(bare, content, '/tmp/f.txt').ok === true)
const stale = checkAnchor(mintFileAnchor('other\n'), content, '/tmp/f.txt')
check('a well-formed anchor that no longer matches is stale, not malformed', !stale.ok && stale.reason === 'stale', JSON.stringify(stale))

const target = join(project, 'tests', 'report.test.ts')
writeFileSync(target, "import test from 'node:test'\ntest('ownerId', () => {})\n")
const good = mintFileAnchor("import test from 'node:test'\ntest('ownerId', () => {})\n")
const plan = planChangeSet([{ file_path: target, expected_anchor: good.slice(0, -1), edits: [{ old_string: 'ownerId', new_string: 'owner' }] }] as never, { ownerKey: 'anchor-words', exactEdit: (member: { content: string }, edit: { old_string: string; new_string: string; replace_all?: boolean }) => matchExactEdit(member.content, edit) } as never)
const memberFault = (plan as { failures?: Array<{ code: string; message: string }> }).failures?.[0]
check('the ChangeSet preflight refusal names the member fault (11 of 12 hex characters), nothing else', memberFault?.code === 'malformed-anchor' && /has 11 hex characters after "fa:" where the digest has exactly 12/.test(memberFault.message) && !/without the surrounding|is invalid/.test(memberFault.message), JSON.stringify(memberFault))

let appState = getDefaultAppState()
const toolContext = {
  options: { engineModel: 'claude-sonnet-5', tools: [], commands: [], mcpClients: [], mcpResources: {} },
  readFileState: new Map(),
  getAppState: () => appState,
  setAppState: (update: (state: typeof appState) => typeof appState) => {
    appState = update(appState)
  },
  abortController: new AbortController(),
  toolUseId: 'anchor-words',
} as never
type Reader = { call: (input: never, context: never) => Promise<{ data: unknown }>; mapToolResultToToolResultBlockParam: (output: never, id: string) => { content: unknown } }
const first = await (FileReadTool as unknown as Reader).call({ file_path: target } as never, toolContext)
const firstText = String((FileReadTool as unknown as Reader).mapToolResultToToolResultBlockParam(first.data as never, 'r1').content)
const firstAnchor = /\(anchor: ([^)]+)\)/.exec(firstText)?.[1]
check('the first Read prints the file anchor', firstAnchor === good, firstText.slice(-80))
const again = await (FileReadTool as unknown as Reader).call({ file_path: target } as never, toolContext)
const againText = String((FileReadTool as unknown as Reader).mapToolResultToToolResultBlockParam(again.data as never, 'r2').content)
check('a repeat Read of the unchanged file still answers the short stub', againText.startsWith(FILE_UNCHANGED_STUB), againText.slice(0, 80))
check('and the stub carries the current anchor, so a re-read asked for the anchor is answered', againText.endsWith(`(anchor: ${good})`), againText.slice(-80))

process.chdir(original)
rmSync(world, { recursive: true, force: true })
console.log(failures === 0 ? 'PASS: the anchor refusal names what did not match' : `FAIL: ${failures} check(s) failed`)
process.exit(failures === 0 ? 0 : 1)
