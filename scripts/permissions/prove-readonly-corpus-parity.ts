#!/usr/bin/env bun
// gate-watch: src/tools/BashTool/readOnlyValidation.ts src/utils/shell/readOnlyCommandValidation.ts src/tools/BashTool/bashPermissions.ts
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dir, '..', '..')
const FIXTURE = join(ROOT, 'scripts', 'permissions', 'fixtures', 'readonly-corpus.json')
const RECORD = process.argv.includes('--record')
const SHOWN = 12

const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'readonly-corpus-')))
const plain = join(scratch, 'plain')
const bareShaped = join(scratch, 'bare')
mkdirSync(plain)
mkdirSync(bareShaped)
writeFileSync(join(bareShaped, 'HEAD'), 'ref: refs/heads/main\n')
mkdirSync(join(scratch, 'home'))
const previousCwd = process.cwd()
process.chdir(plain)
process.env.MERCURY_CONFIG_DIR = join(scratch, 'home')
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
process.env.NODE_ENV = 'test'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

const { checkReadOnlyConstraints, cutPart, describeBashNotReadOnly, notReadOnlyClause } = await import('../../src/tools/BashTool/readOnlyValidation.js')

type Fixture = { verdicts: string[]; rows: Array<[string, number, number, number, number]> }
const SAME = -1
const OWN_TEXT = '"\u0001"'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}

function stable(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'undefined'
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`
  const record = value as Record<string, unknown>
  return `{${Object.keys(record).sort().filter(key => record[key] !== undefined).map(key => `${JSON.stringify(key)}:${stable(record[key])}`).join(',')}}`
}

async function verdictOf(command: string, cd: boolean): Promise<string> {
  const verdict = await checkReadOnlyConstraints({ command }, cd) as Record<string, unknown>
  const { updatedInput: _input, ...rest } = verdict
  return stable(rest)
}

async function describedOf(command: string): Promise<string> {
  const reason = await describeBashNotReadOnly(command)
  return stable(reason === null ? null : { reason, clause: notReadOnlyClause(reason) })
}

async function readings(command: string): Promise<[string, string, string, string]> {
  const own = JSON.stringify(cutPart(command))
  const fold = (reading: string): string => reading.replaceAll(own, OWN_TEXT)
  process.chdir(plain)
  const atPlain = [fold(await verdictOf(command, false)), fold(await verdictOf(command, true)), fold(await describedOf(command))] as const
  let atBareShape = ''
  if (/git/.test(command)) {
    process.chdir(bareShaped)
    atBareShape = fold(`${await verdictOf(command, false)}|${await describedOf(command)}`)
    process.chdir(plain)
    if (atBareShape === `${atPlain[0]}|${atPlain[2]}`) atBareShape = ''
  }
  return [atPlain[0], atPlain[1] === atPlain[0] ? '' : atPlain[1], atPlain[2], atBareShape]
}

const bindingRepins = new Map<string, [string, string, string, string]>()
for (const command of ['echo a | (read x; echo "got $x")', 'read x; rc=$?; echo "[$x] rc=$rc"']) {
  const reason = { kind: 'not-on-list', part: 'read x', word: 'read' }
  const clause = '`read` is not a command Mercury can verify as read-only'
  bindingRepins.set(command, [stable({ behavior: 'passthrough', message: clause, notReadOnly: reason }), '', stable({ reason, clause }), ''])
}
const localDetail = 'local changes whether later variable assignments take effect; use a plain assignment in this command, or approve'
const localReason = { kind: 'screen', part: '\u0001', detail: localDetail }
const localClause = `the command could not be verified as read-only — ${localDetail}`
bindingRepins.set('local', [stable({ behavior: 'passthrough', message: localClause, notReadOnly: localReason }).replaceAll(JSON.stringify('\u0001'), OWN_TEXT), '', stable({ reason: localReason, clause: localClause }).replaceAll(JSON.stringify('\u0001'), OWN_TEXT), ''])

const GLOB_SHAPES = ['*.ts', '?.ts', '[ab].ts']
const CD_GUARD = 'A cd combined with git is not auto-allowed.'
const cdGuardReading = stable({ behavior: 'passthrough', message: CD_GUARD, notReadOnly: { kind: 'git-guard', part: '\u0001', detail: CD_GUARD } }).replaceAll(JSON.stringify('\u0001'), OWN_TEXT)
function pinGlobOperandRead(command: string): void {
  bindingRepins.set(command, [stable({ behavior: 'allow' }), command.startsWith('git ') ? cdGuardReading : '', 'null', ''])
}
const GLOB_OPERAND_READS = [
  'base64', 'basename', 'cal', 'cat', 'cd', 'cmp', 'column', 'comm', 'cut', 'df', 'diff', 'dirname', 'docker images', 'docker inspect', 'docker logs', 'docker ps',
  'du', 'echo', 'expand', 'expr', 'false', 'fd', 'fdfind', 'file', 'find', 'fmt', 'fold', 'free', 'getconf', 'grep', 'grep x', 'groups', 'head', 'help', 'hexdump',
  'id', 'info', 'jq', 'locale', 'ls', 'lsof', 'man', 'md5sum', 'netstat', 'nl', 'nproc', 'numfmt', 'od', 'paste', 'pgrep', 'pr', 'ps', 'pyright', 'readlink',
  'realpath', 'rev', 'seq', 'sha1sum', 'sha256sum', 'sleep', 'sort', 'ss', 'stat', 'strings', 'tac', 'tail', 'test', 'tput', 'tr', 'tree', 'true', 'tsort', 'type',
  'uname', 'unexpand', 'uptime', 'wc', 'which',
  'git blame', 'git cat-file', 'git config --get', 'git describe', 'git diff', 'git for-each-ref', 'git grep', 'git log', 'git ls-files', 'git ls-remote',
  'git merge-base', 'git reflog', 'git rev-list', 'git rev-parse', 'git shortlog', 'git show', 'git stash list', 'git stash show', 'git status', 'git worktree list',
]
for (const words of GLOB_OPERAND_READS) for (const shape of GLOB_SHAPES) pinGlobOperandRead(`${words} ${shape}`)
for (const command of [
  'cat scripts/journey-*/members.txt', 'cd *', 'cd ?', 'cd [ab]', 'du -sh *', 'echo \\e[31m', 'echo a*', 'echo a?', 'echo a[b]', 'find . -name *.ts',
  'git status *', 'grep --include=*.ts x .', 'ls *', 'ls -d */', 'ls /tmp/a/*.txt | head -1', 'ls ?', 'ls [', 'ls "/tmp/a b/"*.txt | head -1', 'ls a[0]',
  'tail view unexpectedly complete — spill semantics changed?', 'tr [:upper:] [:lower:]', 'wc -l *.ts',
]) pinGlobOperandRead(command)

const fixture: Fixture = existsSync(FIXTURE) ? (JSON.parse(readFileSync(FIXTURE, 'utf8')) as Fixture) : { verdicts: [], rows: [] }

if (RECORD) {
  const corpusPath = process.argv[process.argv.indexOf('--record') + 1]
  if (!corpusPath) throw new Error('--record needs the corpus path (a JSON array of commands)')
  const commands = [...new Set(JSON.parse(readFileSync(corpusPath, 'utf8')) as string[])].sort()
  const verdicts: string[] = []
  const index = new Map<string, number>()
  const intern = (text: string): number => {
    const known = index.get(text)
    if (known !== undefined) return known
    verdicts.push(text)
    index.set(text, verdicts.length - 1)
    return verdicts.length - 1
  }
  const rows: Fixture['rows'] = []
  for (const command of commands) {
    const [a, b, c, d] = await readings(command)
    rows.push([command, intern(a), b === '' ? SAME : intern(b), intern(c), d === '' ? SAME : intern(d)])
  }
  mkdirSync(join(ROOT, 'scripts', 'permissions', 'fixtures'), { recursive: true })
  writeFileSync(FIXTURE, `${JSON.stringify({ verdicts, rows })}\n`)
  console.log(`recorded ${rows.length} commands with ${verdicts.length} distinct readings into ${FIXTURE}`)
} else {
  check('the recorded corpus exists', fixture.rows.length > 0, FIXTURE)
  const readOnly = fixture.rows.filter(row => fixture.verdicts[row[1]]!.includes('"behavior":"allow"')).length
  console.log(`  corpus: ${fixture.rows.length} commands, ${fixture.verdicts.length} distinct readings, ${readOnly} read-only at cd=false`)
  const mismatches: string[] = []
  for (const [command, a, b, c, d] of fixture.rows) {
    const now = await readings(command)
    const expected = bindingRepins.get(command) ?? [fixture.verdicts[a]!, b === SAME ? '' : fixture.verdicts[b]!, fixture.verdicts[c]!, d === SAME ? '' : fixture.verdicts[d]!]
    const labels = ['verdict at cd=false', 'verdict at cd=true (where it differs)', 'reason and clause', 'verdict beside a bare-shaped folder (where it differs)']
    for (let i = 0; i < 4; i++) {
      if (now[i] !== expected[i]) mismatches.push(`${JSON.stringify(command)} — ${labels[i]}\n      recorded: ${expected[i]}\n      now:      ${now[i]}`)
    }
  }
  check('each binding re-pin names an existing corpus command', [...bindingRepins.keys()].every(command => fixture.rows.some(row => row[0] === command)))
  check(`every reading of the ${fixture.rows.length} commands matches its exact pin (${bindingRepins.size} binding fixes)`, mismatches.length === 0, `${mismatches.length} moved`)
  for (const line of mismatches.slice(0, SHOWN)) console.log(`    ${line}`)
  if (mismatches.length > SHOWN) console.log(`    … ${mismatches.length - SHOWN} more`)
}

process.chdir(previousCwd)
rmSync(scratch, { recursive: true, force: true })
console.log(failures === 0 ? '\nprove-readonly-corpus-parity: ALL LAWS HOLD' : `\nprove-readonly-corpus-parity: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
