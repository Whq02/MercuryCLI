#!/usr/bin/env bun
import { proofHome } from '../lib/hermetic.ts'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dir, '..', '..')
let failures = 0
const RECORD_FIXES: Array<[string, string]> = [
  ['(1)', 'change systemShellRecord in src/platform/shell/shellRecord.ts, or the provider getShellConfig returns in src/platform/shell/shellExec.ts'],
  ['(2)', 'change shellRecordWords and describeShellRecord in src/platform/shell/shellRecord.ts, or the Shell line of computeEnvInfo and computeSimpleEnvInfo in src/engine/system-prompt/defaultSystemPrompt.ts, or getSimplePrompt in src/tools/shell/prompt.ts'],
  ['(3)', 'change completionDialect in src/platform/shell/shellRecord.ts, or createAndSaveSnapshot in src/platform/shell/bash/shellSnapshot.ts (the snapshot must be taken with the shell the record names)'],
  ['(4)', 'change OLD_BASH_SENTENCE in src/platform/shell/shellRecord.ts'],
  ['(5)', 'change restrictReviewerTools in src/tools/crewmate/reviewerPolicy.ts (the shell that runs the wrapped line)'],
]
let recordFix = ''
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  const shown = [detail, recordFix].filter(part => part !== '').join(' | ')
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && shown ? ` — ${shown}` : ''}`)
}
const section = (title: string): void => {
  recordFix = RECORD_FIXES.find(([prefix]) => title.startsWith(prefix))?.[1] ?? ''
  console.log(`\n${title}`)
}

const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'shell-record-')))
const userHome = join(scratch, 'user-home')
mkdirSync(userHome)
writeFileSync(join(userHome, '.bashrc'), "alias from_bashrc_alias='echo alias-from-bashrc'\nfrom_bashrc_fn() { echo fn-from-bashrc; }\nshopt -s nullglob\n")
writeFileSync(join(userHome, '.zshrc'), "alias from_zshrc_alias='echo alias-from-zshrc'\n")
process.env.HOME = userHome
process.env.SHELL = '/bin/zsh'
delete process.env.MERCURY_SHELL_ENGINE
delete process.env.MERCURY_SHELL_PREFIX
delete process.env.MERCURY_WINDOWS_SHELL_ROAD
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

const record = await import('../../src/platform/shell/shellRecord.ts')
if (process.argv.includes('--snapshot-leg')) {
  const { createAndSaveSnapshot: take } = await import('../../src/platform/shell/bash/shellSnapshot.ts')
  const taken = await take(await record.systemShellRecord())
  console.log(`SNAPSHOT ${JSON.stringify({ path: taken ?? null, text: taken === undefined ? '' : readFileSync(taken, 'utf8') })}`)
  process.exit(0)
}
const { resolveBashPackDir } = await import('../../src/platform/shell/bashPack.ts')
const { computeEnvInfo, computeSimpleEnvInfo } = await import('../../src/engine/system-prompt/defaultSystemPrompt.ts')
const { getSimplePrompt } = await import('../../src/tools/shell/prompt.ts')
const { getShellCompletions } = await import('../../src/platform/shell/bash/shellCompletion.ts')
const { exec, getShellConfig, setCwd } = await import('../../src/platform/shell/shellExec.ts')
setCwd(scratch)

type Lock = { version: string }
const bashLock = JSON.parse(readFileSync(join(ROOT, 'vendor', 'bash.lock.json'), 'utf8')) as Lock
const brushLock = JSON.parse(readFileSync(join(ROOT, 'vendor', 'brush.lock.json'), 'utf8')) as Lock
const PINNED = `${bashLock.version}(1)-release`

console.log('============================================================')
console.log(' One record of the shell that runs a command, and every asker reads it')
console.log('============================================================')

if (process.platform === 'win32') {
  console.log('  [SKIP] this proof reads the macOS and Linux road; the Windows road has its own proofs')
  process.exit(0)
}

section('(1) the record: path, dialect, version, where it came from')
const pack = resolveBashPackDir()
const road = await record.systemShellRecord()
check('the record carries a path, a dialect, a version and an origin', typeof road.path === 'string' && road.dialect === 'bash' && typeof road.version === 'string' && ['shipped', 'system', 'engine'].includes(road.origin), JSON.stringify(road))
if (pack.state === 'ok') {
  check(`with the pack present the road is the shipped bash at its pinned version, whatever $SHELL names (here /bin/zsh)`, road.origin === 'shipped' && road.path === pack.binaryPath && road.version === PINNED, JSON.stringify(road))
} else {
  check('with no pack the road is the system bash, or the engine where none starts, and never the shell $SHELL names', road.origin !== 'shipped' && basename(road.path) !== 'zsh', `${JSON.stringify(road)} · ${pack.note}`)
}
check('the record the session asks for is the same one', JSON.stringify(await record.shellRecord()) === JSON.stringify(road) && JSON.stringify(record.shellRecordNow()) === JSON.stringify(road))
check('the provider the Bash tool spawns runs that path', (await getShellConfig()).provider.shellPath === road.path)
{
  const probe = ['echo', '"ran:$BASH_VERSION:${ZSH_VERSION:-none}:${BASH:-none}:$SHELL"'].join(' ')
  const handle = await exec(probe, new AbortController().signal, 'bash', { timeout: 30_000, preventCwdChanges: true })
  const result = await handle.result
  handle.cleanup()
  const line = result.stdout.split('\n').find(text => text.startsWith('ran:')) ?? ''
  check('a command through the road runs in that shell ($BASH names it), and its $SHELL is the one the launcher had, not rewritten', road.origin === 'engine' ? line.endsWith(`:${road.path}`) : line === `ran:${road.version}:none:${road.path}:/bin/zsh`, JSON.stringify(result.stdout.slice(0, 200)))
}

section('(2) the words the prompt and the tool read from the record')
const words = record.shellRecordWords
const shipped = { path: '/x/vendor/bash/darwin-arm64/bash', dialect: 'bash' as const, version: PINNED, origin: 'shipped' as const }
const old = { path: '/bin/bash', dialect: 'bash' as const, version: '3.2.57(1)-release', origin: 'system' as const }
const modern = { path: '/usr/bin/bash', dialect: 'bash' as const, version: '5.2.21(1)-release', origin: 'system' as const }
const engine = { path: '/x/vendor/brush/darwin-arm64/brush', dialect: 'bash' as const, version: brushLock.version, origin: 'engine' as const }
check('the shipped bash is named with its version', words(shipped) === `bash ${bashLock.version}`, words(shipped))
check('a system bash of 4 or later is named with its version and nothing more', words(modern) === 'bash 5.2.21' && words({ ...modern, version: '4.0.44(1)-release' }) === 'bash 4.0.44', words(modern))
check('a system bash before 4.0 is named with its version and the one sentence', words(old) === `bash 3.2.57 — ${record.OLD_BASH_SENTENCE}`, words(old))
check('the engine is named as the engine', words(engine) === `brush ${brushLock.version} (bash-compatible)`, words(engine))
check('a shell whose version is not known is named bash', words({ ...modern, version: '' }) === 'bash')
{
  const expected = `Shell: ${words(road)}`
  const env = await computeEnvInfo('claude-opus-4-8')
  const simple = await computeSimpleEnvInfo('claude-opus-4-8')
  const lineOf = (text: string): string => text.split('\n').map(line => line.trim().replace(/^- /, '')).find(line => line.startsWith('Shell: ')) ?? ''
  check("the prompt's shell line names the shell the record names, not the one $SHELL names", lineOf(env) === expected && lineOf(simple) === expected, `${lineOf(env)} · ${lineOf(simple)}`)
  const description = getSimplePrompt(null)
  check("the Bash tool's description names the record's dialect", road.origin === 'engine' ? description.includes('One shell session serves the whole conversation') : description.includes('each call starts from your profile (bash).') && !description.includes('zsh'), description.slice(-120))
  const described = record.describeShellRecord(road)
  check('the line offered to the health check says which shell runs and where it came from', described.includes(road.path) && (road.origin === 'shipped' ? described.includes('the bash Mercury ships') : road.origin === 'system' ? described.includes("the system's bash") : described.includes('engine')), described)
}

section('(3) the other askers')
check('completion asks the record for its dialect and no longer reads $SHELL', record.completionDialect() === 'bash')
{
  const completions = await getShellCompletions('ech', 3, new AbortController().signal)
  check('a completion comes back from the shell the road runs, with $SHELL naming zsh', road.origin === 'engine' || completions.some(item => item.displayText === 'echo'), JSON.stringify(completions.slice(0, 4).map(item => item.displayText)))
}
if (road.origin !== 'engine') {
  const leg = spawnSync(process.execPath, [import.meta.path, '--snapshot-leg'], { encoding: 'utf8', env: { ...process.env, HOME: userHome, SHELL: '/bin/zsh' } })
  const answer = (leg.stdout ?? '').split('\n').find(line => line.startsWith('SNAPSHOT '))
  const taken = answer === undefined ? { path: null, text: '' } : (JSON.parse(answer.slice(9)) as { path: string | null; text: string })
  const snapshot = taken.path ?? undefined
  const text = taken.text
  if (snapshot !== undefined) writeFileSync(join(scratch, 'snapshot.sh'), text)
  check('the snapshot is taken with the shell the record names and reads the user\'s bash files', snapshot !== undefined && basename(snapshot).startsWith('snapshot-bash-') && text.includes('alias -- from_bashrc_alias=') && text.includes('shopt -s nullglob') && text.includes('shopt -s expand_aliases'), text.slice(0, 300))
  check('…and nothing the user wrote for zsh: no alias of ~/.zshrc, no option of zsh', !text.includes('from_zshrc_alias') && !text.includes('setopt'), text.split('\n').filter(line => line.includes('zsh')).join(' | '))
  const ran = spawnSync(road.path, ['-c', `source '${join(scratch, 'snapshot.sh')}' && eval 'from_bashrc_alias; from_bashrc_fn'`], { encoding: 'utf8', env: { PATH: '/usr/bin:/bin', HOME: userHome } })
  check('a command that sources it runs the alias and the function of ~/.bashrc', ran.stdout === 'alias-from-bashrc\nfn-from-bashrc\n', `${JSON.stringify(ran.stdout)} ${ran.stderr.slice(0, 200)}`)
}

section('(4) the sentence a bash before 4.0 is given, held to what that bash does')
{
  const sentence = record.OLD_BASH_SENTENCE
  const texts: Array<[string, string, string]> = [
    ['an unpaired apostrophe', "fix: it's the guard", 'quote'],
    ['an unpaired double quote', 'a 5" disk', 'quote'],
    ['an unpaired backquote', 'the ` key', 'backquote'],
    ['an opening parenthesis alone', 'fix (the guard', 'parenthesis'],
    ['a closing parenthesis alone', 'fix the guard) now', 'parenthesis'],
    ['a line ending in a backslash', 'ends with a backslash \\', 'backslash'],
  ]
  const inSubstitution = (body: string): string => `msg="$(cat <<'EOF'\n${body}\nEOF\n)"; printf '%s\\n' "$msg"`
  const onStandardInput = (body: string): string => `cat <<'EOF'\n${body}\nEOF`
  const run = (shell: string, script: string): { ok: (body: string) => boolean; told: string } => {
    const ran = spawnSync(shell, ['--norc', '--noprofile', '-c', script], { encoding: 'utf8', env: { PATH: '/usr/bin:/bin', HOME: userHome } })
    return { ok: body => ran.status === 0 && ran.stdout === `${body}\n`, told: `status ${String(ran.status)} ${JSON.stringify(ran.stdout.slice(0, 60))} ${ran.stderr.split('\n')[0]?.slice(0, 100) ?? ''}` }
  }
  check('the sentence is one sentence, names the form that fails and the form that works', !/[.!?]\s/.test(sentence) && sentence.includes('here-document inside $( )') && sentence.includes('standard input') && sentence.includes("git commit -F - <<'EOF'"), sentence)
  for (const [, , word] of texts) check(`the sentence names the ${word}`, sentence.includes(word))
  if (pack.state === 'ok') {
    for (const [name, body] of texts) {
      const now = run(pack.binaryPath, inSubstitution(body))
      check(`the shipped bash prints a here-document inside $( ) that holds ${name}`, now.ok(body), now.told)
    }
  }
  const candidates = ['/bin/bash', '/usr/bin/bash'].filter(path => existsSync(path))
  const oldBash = candidates.find(path => {
    const asked = spawnSync(path, ['--norc', '--noprofile', '-c', 'printf %s "${BASH_VERSINFO[0]}"'], { encoding: 'utf8' })
    return asked.status === 0 && Number(asked.stdout) < 4
  })
  if (oldBash === undefined) {
    console.log('  [SKIP] no bash before 4.0 stands on this machine (a Mac ships 3.2.57 as /bin/bash): the legs that run it are skipped here')
  } else {
    for (const [name, body] of texts) {
      const fails = run(oldBash, inSubstitution(body))
      check(`${oldBash}: a here-document inside $( ) that holds ${name} does not print its text`, !fails.ok(body), fails.told)
      const works = run(oldBash, onStandardInput(body))
      check(`${oldBash}: the same text given on standard input prints whole`, works.ok(body), works.told)
    }
    const repo = join(scratch, 'repo')
    mkdirSync(repo)
    const git = (args: string[]): string => spawnSync('git', args, { cwd: repo, encoding: 'utf8', env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: userHome, GIT_AUTHOR_NAME: 'proof', GIT_AUTHOR_EMAIL: 'proof@mercury.invalid', GIT_COMMITTER_NAME: 'proof', GIT_COMMITTER_EMAIL: 'proof@mercury.invalid', GIT_CONFIG_NOSYSTEM: '1' } }).stdout ?? ''
    git(['init', '-q'])
    const committed = spawnSync(oldBash, ['--norc', '--noprofile', '-c', "git commit -q --allow-empty -F - <<'EOF'\nfix: it's the reader's guard (one\nEOF"], { cwd: repo, encoding: 'utf8', env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: userHome, GIT_AUTHOR_NAME: 'proof', GIT_AUTHOR_EMAIL: 'proof@mercury.invalid', GIT_COMMITTER_NAME: 'proof', GIT_COMMITTER_EMAIL: 'proof@mercury.invalid', GIT_CONFIG_NOSYSTEM: '1' } })
    const subject = git(['log', '-1', '--format=%s']).trim()
    check(`${oldBash}: the command the sentence gives commits the message whole`, committed.status === 0 && subject === "fix: it's the reader's guard (one", `status ${String(committed.status)} ${committed.stderr.slice(0, 160)} subject ${JSON.stringify(subject)}`)
  }
}

section("(5) a reviewer's verification command is wrapped with the shell that runs it")
{
  const { canonicalReviewerReceipt, restrictReviewerTools } = await import('../../src/tools/crewmate/reviewerPolicy.ts')
  const { BASH_TOOL_NAME } = await import('../../src/tools/kit/names/bash.ts')
  const frozen = join(scratch, 'frozen')
  mkdirSync(join(frozen, 'scripts', 'checks'), { recursive: true })
  writeFileSync(join(frozen, 'scripts', 'checks', 'prove-read.ts'), 'console.log("review proof ran")\n')
  const report = join(scratch, 'report.md')
  writeFileSync(report, '# Report\n\n## Review\npending\n')
  let handed = ''
  const standIn = { name: BASH_TOOL_NAME, isReadOnly: () => false, call: async (input: { command: string }) => { handed = input.command; return { data: {} } } }
  const wrapped = restrictReviewerTools([standIn] as never, canonicalReviewerReceipt(report, frozen), frozen)[0] as unknown as { call: (input: { command: string }, context: unknown) => Promise<unknown> }
  let refused = ''
  try {
    await wrapped.call({ command: ['bun', 'scripts/checks/prove-read.ts'].join(' ') }, {})
  } catch (error) {
    refused = error instanceof Error ? error.message : String(error)
  }
  if (/confinement/.test(refused)) console.log(`  [SKIP] this host has no confinement for a reviewer's command (${refused})`)
  else {
    check(
      'the line handed to the Bash tool starts, inside the confinement, "${BASH:-/bin/bash}" -c: the shell that runs the line, whose $BASH section (1) holds to the record\'s path, and not /bin/bash by its name',
      handed.includes(' "${BASH:-/bin/bash}" -c ') && !handed.includes(' /bin/bash -c '),
      `${refused} ${JSON.stringify(handed.slice(0, 220))}`,
    )
  }
}

rmSync(scratch, { recursive: true, force: true })
void proofHome
console.log(failures === 0 ? '\nprove-shell-record: ALL LAWS HOLD' : `\nprove-shell-record: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
