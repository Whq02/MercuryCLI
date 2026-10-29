#!/usr/bin/env bun
// gate-watch: src/tools/BashTool/bashPermissions.ts src/tools/BashTool/pathValidation.ts src/Tool.ts
// gate-watch: src/tools/GrepTool/GrepTool.ts src/utils/verification/scanCeiling.ts
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'followed-links-')))
const root = join(scratch, 'run')
mkdirSync(join(root, 'sub'), { recursive: true })
mkdirSync(join(root, 'sub2'))
mkdirSync(join(scratch, 'outside'))
mkdirSync(join(scratch, 'home'))
const MARKER = 'outside marker alpha'
const outside = join(scratch, 'outside', 'words')
writeFileSync(outside, `${MARKER}\n`)
writeFileSync(join(root, 'README'), 'hello alpha\n')
writeFileSync(join(root, 'sub', 'a.txt'), 'alpha\n')
const linkOut = join(root, 'sub', 'link-out')
symlinkSync(outside, linkOut)
symlinkSync(join(root, 'sub'), join(root, 'sub2', 'link-in'))
const previousCwd = process.cwd()
process.chdir(root)
process.env.MERCURY_CONFIG_DIR = join(scratch, 'home')
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
process.env.NODE_ENV = 'test'
delete process.env.MERCURY_TREE_SCAN_CEILING
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

const { bashToolHasPermission } = await import('../../src/tools/BashTool/bashPermissions.js')
const { GrepTool } = await import('../../src/tools/GrepTool/GrepTool.js')
const { DEFAULT_SCAN_CEILING, scanCeiling } = await import('../../src/utils/verification/scanCeiling.js')
const { getEmptyToolPermissionContext } = await import('../../src/Tool.js')

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
const j = (v: unknown): string => JSON.stringify(v)
type Verdict = { behavior: string; message?: string }
const context = (extra: Record<string, unknown> = {}) => ({ ...getEmptyToolPermissionContext(), mode: 'default', ...extra })
const decide = async (command: string, extra: Record<string, unknown> = {}): Promise<Verdict> =>
  (await bashToolHasPermission({ command } as never, context(extra) as never)) as Verdict
const shown = (v: Verdict): string => `${v.behavior}: ${v.message ?? ''}`
const linkAsk = (verb: string): string => `Mercury needs permission to ${verb} ${outside}, outside the starting folder ('${root}').`
const RG_RULE = { alwaysAllowRules: { userSettings: ['Bash(rg *)'] } }
const FD_RULE = { alwaysAllowRules: { userSettings: ['Bash(fd *)'] } }

console.log('prove-followed-links-ask — a read-only command that follows links asks when a link under its tree leaves the starting folder')

console.log('\n1. grep -R over a tree with a link to an outside file asks naming the file the link reaches; grep -r does not follow it')
{
  const rows: Array<[string, string | null]> = [
    ['grep -R alpha .', linkAsk('search')],
    ['grep -Rn alpha sub', linkAsk('search')],
    ['grep --dereference-recursive alpha sub', linkAsk('search')],
    ['grep -R alpha sub2', linkAsk('search')],
    ['grep -r alpha .', null],
    ['grep -rn alpha sub', null],
    ['grep -R alpha README', null],
    ['grep -R alpha sub/a.txt', null],
  ]
  for (const [command, want] of rows) {
    const v = await decide(command)
    if (want === null) check(`${command} → allow`, v.behavior === 'allow', shown(v))
    else check(`${command} → ask`, v.behavior === 'ask' && v.message === want, shown(v))
  }
}

console.log('\n2. the other link-following shapes ask the same way; their plain forms stay read-only')
{
  const rows: Array<[string, string | null, Record<string, unknown>]> = [
    ['find -L . -name x', linkAsk('search'), {}],
    ['find -L sub -type f', linkAsk('search'), {}],
    ['find . -name x', null, {}],
    ['du -L .', linkAsk('inspect'), {}],
    ['du -sh .', null, {}],
    ['ls -LR .', linkAsk('list'), {}],
    ['ls -lLR sub', linkAsk('list'), {}],
    ['ls -R .', null, {}],
    ['ls -L .', null, {}],
    ['tree -l .', linkAsk('list'), {}],
    ['tree .', null, {}],
    ['diff -r sub sub2', linkAsk('compare'), {}],
    ['diff -r --no-dereference sub sub2', null, {}],
    ['diff sub/a.txt README', null, {}],
    ['rg -L alpha .', linkAsk('search'), RG_RULE],
    ['rg --follow alpha sub', linkAsk('search'), RG_RULE],
    ['rg alpha .', null, RG_RULE],
    ['fd -L . .', linkAsk('search'), FD_RULE],
    ['fd --follow . sub', linkAsk('search'), FD_RULE],
    ['fd . .', null, FD_RULE],
  ]
  for (const [command, want, extra] of rows) {
    const v = await decide(command, extra)
    if (want === null) check(`${command} → allow`, v.behavior === 'allow', shown(v))
    else check(`${command} → ask`, v.behavior === 'ask' && v.message === want, shown(v))
  }
  const bare = await decide('rg -L alpha .')
  check('rg -L without a rule is not auto-allowed (rg is not on the read-only list)', bare.behavior !== 'allow', shown(bare))
}

console.log('\n3. a link that stays inside the starting folder is followed without an ask')
{
  const v = await decide('grep -R hello sub2')
  check('grep -R over a tree whose link reaches a folder inside asks only for the outside link under it', v.behavior === 'ask' && v.message === linkAsk('search'), shown(v))
  unlinkSync(linkOut)
  const inside = await decide('grep -R hello sub2')
  check('with the outside link gone, the inside link alone is read-only', inside.behavior === 'allow', shown(inside))
  symlinkSync(outside, linkOut)
}

console.log('\n4. the Grep tool does not follow the link')
{
  const toolContext = { abortController: new AbortController(), getAppState: () => ({ toolPermissionContext: getEmptyToolPermissionContext() }) } as never
  type Answer = { data: { numFiles: number; filenames: string[] } }
  const marker = (await GrepTool.call({ pattern: 'outside marker', path: root } as never, toolContext)) as Answer
  check('a search for the outside words under the root finds nothing', marker.data.numFiles === 0, j(marker.data))
  const alpha = (await GrepTool.call({ pattern: 'alpha', path: root } as never, toolContext)) as Answer
  check('the control: the in-folder file is found and the link is not', alpha.data.numFiles === 2 && alpha.data.filenames.every(name => !name.includes('link-out') && !name.startsWith(outside)), j(alpha.data))
}

console.log('\n5. the walk is bounded by the tree-fingerprint ceiling; past it the command asks')
{
  check(`the default ceiling is ${DEFAULT_SCAN_CEILING} entries`, scanCeiling() === DEFAULT_SCAN_CEILING, String(scanCeiling()))
  process.env.MERCURY_TREE_SCAN_CEILING = '2'
  const over = await decide('grep -R alpha .')
  check('over the ceiling, grep -R asks', over.behavior === 'ask' && over.message === `grep follows links under ${root}, a tree of more than 2 entries; narrow the search, or approve`, shown(over))
  const plain = await decide('grep -r alpha .')
  check('grep -r is untouched by the ceiling', plain.behavior === 'allow', shown(plain))
  delete process.env.MERCURY_TREE_SCAN_CEILING
  const back = await decide('grep -R alpha sub')
  check('with the ceiling back, the link is what asks', back.behavior === 'ask' && back.message === linkAsk('search'), shown(back))
}

console.log('\n6. flow mode: reads roam, so the walk does not run')
{
  const v = await decide('grep -R alpha .', { mode: 'flow' })
  check('grep -R in flow mode is allowed', v.behavior === 'allow', shown(v))
}

console.log('\n7. with the link removed, every shape is read-only again')
{
  unlinkSync(linkOut)
  for (const command of ['grep -R alpha .', 'grep -r alpha .', 'find -L . -name x', 'du -L .', 'ls -LR .', 'tree -l .', 'diff -r sub sub2']) {
    const v = await decide(command)
    check(`${command} → allow`, v.behavior === 'allow', shown(v))
  }
}

process.chdir(previousCwd)
rmSync(scratch, { recursive: true, force: true })
console.log(failures === 0 ? '\nprove-followed-links-ask: ALL LAWS HOLD' : `\nprove-followed-links-ask: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
