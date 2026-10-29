#!/usr/bin/env bun

import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { slashed } from '../lib/platformPath.ts'

const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'flagged-file-operands-')))
const root = join(scratch, 'run')
mkdirSync(root)
mkdirSync(join(root, 'sub'))
mkdirSync(join(scratch, 'outside'))
mkdirSync(join(scratch, 'home'))
writeFileSync(join(root, 'README'), 'hello alpha\n')
writeFileSync(join(root, 'list'), 'README\n')
writeFileSync(join(root, 'sub', 'inner.txt'), 'alpha\n')
const outsideDir = join(scratch, 'outside')
const outside = join(outsideDir, 'words')
writeFileSync(outside, 'outside marker\n')
const ownSecret = join(scratch, 'home', '.credentials.json')
writeFileSync(ownSecret, '{"value":"fixture-placeholder"}\n')
const previousCwd = process.cwd()
process.chdir(root)
process.env.MERCURY_CONFIG_DIR = join(scratch, 'home')
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
process.env.NODE_ENV = 'test'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

const { bashToolHasPermission } = await import('../../src/tools/BashTool/bashPermissions.js')
const { PATH_EXTRACTORS, COMMAND_OPERATION_TYPE } = await import('../../src/tools/BashTool/pathValidation.js')
const { LISTED_WORDS } = await import('../../src/utils/shell/readOnlyCommandValidation.js')
const { binaryName } = await import('../../src/utils/config/derived.js')
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
const O = slashed(outside)
const OD = slashed(outsideDir)
const outsideAsk = (verb: string, path = outside): string => `Mercury needs permission to ${verb} ${path}, outside the starting folder ('${root}').`

console.log('prove-flagged-file-operands — a file a read-only command takes through a flag is an operand of the path check')

console.log('\n1. the extractor table')
{
  const rows: Array<[keyof typeof PATH_EXTRACTORS, string[], string[]]> = [
    ['xargs', ['-a', 'list', 'echo'], ['list']],
    ['xargs', ['--arg-file', 'list', 'echo'], ['list']],
    ['xargs', ['--arg-file=list', 'echo'], ['list']],
    ['xargs', ['-0a', 'list', 'echo'], ['list']],
    ['xargs', ['-alist', 'echo'], ['list']],
    ['xargs', ['-n1', 'echo'], []],
    ['xargs', ['-I', '{}', 'cat', '{}'], []],
    ['xargs', ['echo'], []],
    ['grep', ['-f', 'pats', 'README'], ['pats', 'README']],
    ['grep', ['--file=pats', 'README'], ['pats', 'README']],
    ['grep', ['--file', 'pats', 'README'], ['pats', 'README']],
    ['grep', ['-rf', 'pats', '.'], ['pats', '.']],
    ['grep', ['-fpats', 'README'], ['pats', 'README']],
    ['grep', ['-f', '-', 'README'], ['README']],
    ['grep', ['--exclude-from=skip', 'x', 'README'], ['skip', 'README']],
    ['grep', ['-rn', 'x'], ['.']],
    ['grep', ['-R', 'x'], ['.']],
    ['grep', ['-e', 'x', '-A3', 'README'], ['README']],
    ['grep', ['x', 'a', 'b'], ['a', 'b']],
    ['grep', ['--include=*.ts', '-rn', 'x', 'src/'], ['src/']],
    ['grep', ['x'], []],
    ['rg', ['-f', 'pats', 'README'], ['pats', 'README']],
    ['rg', ['--ignore-file', 'ig', 'x'], ['ig', '.']],
    ['rg', ['--ignore-file=ig', 'x', 'sub'], ['ig', 'sub']],
    ['rg', ['--files', 'sub'], ['sub']],
    ['rg', ['-g', '*.ts', 'x'], ['.']],
    ['rg', ['-L', 'x', 'sub'], ['sub']],
    ['rg', ['x'], ['.']],
    ['tree', ['-L', '1', 'sub'], ['sub']],
    ['tree', [], ['.']],
    ['tree', ['-a'], ['.']],
    ['tree', ['--gitfile=.gi', 'sub'], ['.gi', 'sub']],
    ['fd', ['.', 'sub'], ['sub']],
    ['fd', ['-e', 'ts'], ['.']],
    ['fd', ['pat'], ['.']],
    ['fd', ['--search-path', 'sub', 'pat'], ['sub']],
    ['fd', ['-t', 'f', '.', 'a', 'b'], ['a', 'b']],
    ['fdfind', ['.', 'sub'], ['sub']],
    ['du', ['-sh', '.'], ['.']],
    ['du', ['-d', '1'], ['.']],
    ['du', ['-X', 'skip', 'sub'], ['skip', 'sub']],
    ['du', ['--exclude-from=skip', 'sub'], ['skip', 'sub']],
    ['diff', ['-u', 'a', 'b'], ['a', 'b']],
    ['diff', ['--from-file=base', 'x', 'y'], ['base', 'x', 'y']],
    ['diff', ['--to-file', 'base', 'x'], ['base', 'x']],
    ['diff', ['-r', '--exclude=*.o', 'a', 'b'], ['a', 'b']],
    ['diff', ['-U', '3', 'a', 'b'], ['a', 'b']],
    ['info', ['-f', 'f.info', 'node'], ['f.info']],
    ['info', ['ls'], []],
    ['info', ['./f.info'], ['./f.info']],
    ['man', ['ls'], []],
    ['man', ['1', 'ls'], []],
    ['man', ['./x.1'], ['./x.1']],
    ['man', ['-l', 'x.1'], ['x.1']],
    ['date', ['-r', 'f'], ['f']],
    ['date', ['--reference=f', '+%s'], ['f']],
    ['date', ['+%s'], []],
    ['date', ['-d', 'now'], []],
    ['pyright', ['x.py'], ['x.py']],
    ['pyright', ['-p', 'proj', 'x.py'], ['proj', 'x.py']],
    ['pyright', ['--outputjson', 'x.py'], ['x.py']],
    ['test', ['-f', 'x'], ['x']],
    ['test', ['-n', 'x'], []],
    ['test', ['a', '-nt', 'b'], ['a', 'b']],
    ['test', ['-d', 'x', '-a', '-r', 'y'], ['x', 'y']],
    ['jq', ['.', 'f.json'], ['f.json']],
    ['jq', ['-f', 'prog.jq', 'f.json'], ['prog.jq', 'f.json']],
    ['jq', ['--slurpfile', 'n', 's.json', '.', 'f'], ['s.json', 'f']],
    ['jq', ['--rawfile', 'n', 'r.txt', '.'], ['r.txt']],
    ['jq', ['-L', 'lib', '.', 'f'], ['lib', 'f']],
    ['jq', ['-r', '.a'], []],
    ['jq', ['-n', '$ARGS', '--args', 'a', 'b'], []],
    ['comm', ['-12', 'a', 'b'], ['a', 'b']],
    ['cmp', ['a', 'b'], ['a', 'b']],
    ['tac', ['f'], ['f']],
    ['realpath', ['f'], ['f']],
    ['readlink', ['-f', 'f'], ['f']],
  ]
  for (const [command, args, want] of rows) {
    const extract = PATH_EXTRACTORS[command] as ((args: string[]) => string[]) | undefined
    const got = extract === undefined ? null : extract(args)
    check(`${command}(${j(args)}) → ${j(want)}`, j(got) === j(want), j(got))
  }
}

console.log('\n2. an operand outside the starting folder asks with the read words, as cat does')
{
  const rows: Array<[string, string]> = [
    [`xargs -a ${O} echo`, outsideAsk('read')],
    [`xargs --arg-file ${O} echo`, outsideAsk('read')],
    [`xargs --arg-file=${O} echo`, outsideAsk('read')],
    [`xargs -a ${O} -d '\\n' printf '%s\\n'`, outsideAsk('read')],
    [`grep -f ${O} -n README`, outsideAsk('search')],
    [`grep --file=${O} README`, outsideAsk('search')],
    [`grep -rf ${O} .`, outsideAsk('search')],
    [`rg -f ${O} README`, outsideAsk('search')],
    [`rg --ignore-file ${O} alpha`, outsideAsk('search')],
    [`tree -L 1 ${OD}`, outsideAsk('list', outsideDir)],
    [`fd . ${OD}`, outsideAsk('search', outsideDir)],
    [`fdfind . ${OD}`, outsideAsk('search', outsideDir)],
    [`du ${OD}`, outsideAsk('inspect', outsideDir)],
    [`du -X ${O} .`, outsideAsk('inspect')],
    [`comm ${O} README`, outsideAsk('compare')],
    [`cmp ${O} README`, outsideAsk('compare')],
    [`diff --from-file=${O} README`, outsideAsk('compare')],
    [`tac ${O}`, outsideAsk('read')],
    [`rev ${O}`, outsideAsk('read')],
    [`fold ${O}`, outsideAsk('read')],
    [`fmt ${O}`, outsideAsk('read')],
    [`pr ${O}`, outsideAsk('read')],
    [`expand ${O}`, outsideAsk('read')],
    [`unexpand ${O}`, outsideAsk('read')],
    [`tsort ${O}`, outsideAsk('read')],
    [`realpath ${O}`, outsideAsk('inspect')],
    [`readlink ${O}`, outsideAsk('inspect')],
    [`info -f ${O}`, outsideAsk('read')],
    [`man ${O}`, outsideAsk('read')],
    [`date -r ${O}`, outsideAsk('inspect')],
    [`pyright ${O}`, outsideAsk('read')],
    [`test -f ${O}`, outsideAsk('inspect')],
    [`cat ${O}`, outsideAsk('read')],
  ]
  for (const [command, want] of rows) {
    const v = await decide(command)
    check(`${command.replace(outside, '<outside>').replace(outsideDir, '<outside-dir>')} → ask`, v.behavior === 'ask' && v.message === want, shown(v))
  }
}

console.log('\n3. a relative operand that leaves the starting folder is outside too')
{
  const rows: Array<[string, string]> = [
    ['xargs -a ../outside/words echo', outsideAsk('read')],
    ['grep -f ../outside/words README', outsideAsk('search')],
    ['tree ../outside', outsideAsk('list', outsideDir)],
    ['fd . ../outside', outsideAsk('search', outsideDir)],
    ['du ../outside', outsideAsk('inspect', outsideDir)],
    ['cmp ../outside/words README', outsideAsk('compare')],
  ]
  for (const [command, want] of rows) {
    const v = await decide(command)
    check(`${command} → ask`, v.behavior === 'ask' && v.message === want, shown(v))
  }
}

console.log('\n4. the same shapes inside the starting folder stay read-only and unprompted')
{
  for (const command of [
    'xargs -a ./list echo', 'xargs --arg-file=list echo', 'xargs -a list -d \'\\n\' printf \'%s\\n\'', 'grep -f ./list README', 'grep -f list -n README',
    'tree -L 1 .', 'tree -L 1 sub', 'fd . sub', 'fdfind . .', 'du -sh .', 'du sub', 'comm README README', 'cmp README list', 'diff README list', 'tac README', 'rev README', 'fold README',
    'fmt README', 'pr README', 'expand README', 'unexpand README', 'tsort list', 'realpath README', 'readlink README', 'info -f README', 'man ./README', 'date -r README', 'test -f README', 'cat README',
  ]) {
    const v = await decide(command)
    check(`${command} → allow`, v.behavior === 'allow', shown(v))
  }
  for (const command of ['rg -f list README', 'rg --ignore-file list alpha', 'pyright README', 'grep --file=list README', 'grep -rf list .']) {
    const v = await decide(command)
    check(`${command} passes the path check (not an ask)`, v.behavior !== 'ask', shown(v))
  }
}

console.log('\n5. every read-only word that takes a path is a path command')
{
  const noPath = new Set([
    'alias', 'arch', 'basename', 'cal', 'df', 'dirname', 'docker', 'echo', 'env', 'expr', 'false', 'free', 'getconf', 'groups', 'help', 'history', 'hostname', 'id', 'ifconfig', 'ip', 'locale', 'lsof',
    binaryName(), 'netstat', 'nproc', 'numfmt', 'pgrep', 'printenv', 'ps', 'pwd', 'seq', 'sleep', 'ss', 'tput', 'true', 'type', 'uname', 'uptime', 'which', 'whoami',
  ])
  const unclassified = [...LISTED_WORDS].filter(word => !(word in COMMAND_OPERATION_TYPE) && !noPath.has(word)).sort()
  check('no listed read-only word is unclassified', unclassified.length === 0, unclassified.join(' '))
  const stale = [...noPath].filter(word => !LISTED_WORDS.has(word) || word in COMMAND_OPERATION_TYPE).sort()
  check('the no-path roster names only listed words that are not path commands', stale.length === 0, stale.join(' '))
  for (const command of ['xargs', 'tree', 'fd', 'fdfind', 'du', 'realpath', 'readlink', 'comm', 'cmp', 'tac', 'rev', 'fold', 'fmt', 'pr', 'expand', 'unexpand', 'tsort', 'info', 'man', 'date', 'pyright', 'test'] as const) {
    check(`${command} is a read path command`, COMMAND_OPERATION_TYPE[command] === 'read', String(COMMAND_OPERATION_TYPE[command]))
  }
}

console.log("\n6. Mercury's own credential file through a flag is refused as it is through cat")
{
  const S = slashed(ownSecret)
  for (const command of [`xargs -a ${S} echo`, `xargs --arg-file=${S} echo`, `grep --file=${S} README`, `grep -f${S} README`, `rg --ignore-file=${S} alpha`, `diff --from-file=${S} README`, `cat ${S}`]) {
    const v = await decide(command)
    check(`${command.replace(ownSecret, '<own-secret>')} → deny`, v.behavior === 'deny' && (v.message ?? '').startsWith('Reading ') && (v.message ?? '').includes("holds Mercury's own credentials"), shown(v))
  }
}

console.log('\n7. xargs with a reading target and no arg-file takes its paths from stdin, so it asks; the non-reading targets stay read-only')
{
  const piped: Array<[string, string]> = [
    ['echo README | xargs head', 'xargs head'],
    ['echo README | xargs wc -l', 'xargs wc -l'],
    ['echo README | xargs grep alpha', 'xargs grep alpha'],
    ['echo README | xargs tail', 'xargs tail'],
    ['cat list | xargs head', 'xargs head'],
    ['ls | xargs head', 'xargs head'],
    ['find . -name list | xargs head', 'xargs head'],
    ['echo README | xargs -n1 head', 'xargs -n1 head'],
    [`echo ${O} | xargs head`, 'xargs head'],
  ]
  for (const [command, part] of piped) {
    const v = await decide(command)
    check(`${command.replace(outside, '<outside>')} → needs approval naming the part (the engine resolves it to a card)`, v.behavior === 'passthrough' && v.message === `One part of this Bash command needs approval: ${part}`, shown(v))
  }
  const redirected = await decide('xargs head < list')
  check('xargs head < list → not allowed, with the read-only words', redirected.behavior !== 'allow' && redirected.message === '`xargs head < list` requires approval: it is not a read-only form of `xargs`.', shown(redirected))
  for (const command of ['echo README | xargs echo', "echo a b | xargs printf '%s\\n'", 'ls | xargs -n 1 echo', 'echo x | xargs -0 echo', 'xargs -a list head', 'xargs -a list wc -l', 'xargs -a list grep alpha', 'xargs --arg-file=list tail']) {
    const v = await decide(command)
    check(`${command} → allow`, v.behavior === 'allow', shown(v))
  }
  const outsideList = await decide(`xargs -a ${O} head`)
  check('xargs -a <outside> head → ask for the arg-file', outsideList.behavior === 'ask' && outsideList.message === outsideAsk('read'), shown(outsideList))
}

process.chdir(previousCwd)
rmSync(scratch, { recursive: true, force: true })
console.log(failures === 0 ? '\nprove-flagged-file-operands: ALL LAWS HOLD' : `\nprove-flagged-file-operands: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
