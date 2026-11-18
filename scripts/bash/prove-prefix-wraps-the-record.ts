#!/usr/bin/env bun
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

type Ran = { code: number; text: string }

if (process.argv.includes('--under-the-prefix')) {
  ;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
  const { exec, setCwd } = await import('../../src/utils/Shell.ts')
  const { systemShellRecord } = await import('../../src/utils/shell/shellRecord.ts')
  setCwd(homedir())
  const run = async (command: string): Promise<Ran> => {
    const handle = await exec(command, new AbortController().signal, 'bash', { timeout: 30_000 })
    const result = await handle.result
    return { code: result.code, text: `${result.stdout ?? ''}${result.stderr ?? ''}`.trim() }
  }
  const answers = {
    record: (await systemShellRecord()).path,
    where: await run('echo "runs in zsh=${ZSH_VERSION:-no} bash=${BASH_VERSION:-no}"'),
    split: await run('X="a b"; printf "[%s]" $X; echo'),
    glob: await run(`echo /tmp/__no_such_dir_${process.pid}/*.yml`),
    equals: await run('echo =ls'),
    stays: await run('cd /tmp && pwd -P'),
    after: await run('pwd -P'),
    pattern: `/tmp/__no_such_dir_${process.pid}/*.yml`,
  }
  console.log(`ANSWERS ${JSON.stringify(answers)}`)
  process.exit(0)
}

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}

console.log('============================================================')
console.log(' A shell prefix is handed one line that starts the record\'s shell on the command')
console.log('============================================================')

if (process.platform === 'win32') {
  console.log('  [SKIP] this proof drives the macOS and Linux road; the Windows road has its own proofs')
  process.exit(0)
}

const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'prefix-wraps-the-record-')))
const userHome = join(scratch, 'user-home')
mkdirSync(userHome)
const other = existsSync('/bin/zsh') ? '/bin/zsh' : '/bin/sh'
const log = join(scratch, 'handed')
const wrapper = join(scratch, 'wrapper')
writeFileSync(wrapper, `#!/bin/sh\nprintf '%s\\n' "$#" >> ${JSON.stringify(`${log}.counts`)}\nprintf '%s' "$2" > ${JSON.stringify(`${log}.line`)}\nexec ${other} "$@"\n`)
chmodSync(wrapper, 0o755)

try {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined || /^(?:BASH_ENV|ENV|MERCURY_SHELL_ENGINE|MERCURY_WINDOWS_SHELL_ROAD)$/.test(key)) continue
    env[key] = value
  }
  Object.assign(env, { HOME: userHome, SHELL: '/bin/zsh', MERCURY_CONFIG_DIR: join(scratch, 'config-home'), MERCURY_SHELL_PREFIX: `${wrapper} -c` })
  const child = spawnSync(process.execPath, [import.meta.path, '--under-the-prefix'], { encoding: 'utf8', env })
  const line = (child.stdout ?? '').split('\n').find(text => text.startsWith('ANSWERS '))
  const answers = line === undefined ? null : (JSON.parse(line.slice(8)) as { record: string; where: Ran; split: Ran; glob: Ran; equals: Ran; stays: Ran; after: Ran; pattern: string })
  const told = `${JSON.stringify(answers)} · exit ${String(child.status)} · ${JSON.stringify(String(child.stderr ?? '').slice(-300))}`

  console.log(`\n(1) the wrapper runs ${other}; the command is read by the record's shell`)
  check('the command runs in bash, not in the shell the wrapper starts', answers !== null && answers.where.code === 0 && /runs in zsh=no bash=\d/.test(answers.where.text), told)
  check('an unquoted expansion splits into words, as bash splits it', answers?.split.text === '[a][b]', told)
  check('a pattern that matches nothing is passed on as written, exit 0', answers !== null && answers.glob.code === 0 && answers.glob.text === answers.pattern, told)
  check('a word that begins with = is the word', answers?.equals.text === '=ls', told)
  check('the directory a command leaves is the next command\'s: the frame still writes it', answers !== null && answers.stays.code === 0 && answers.after.text === answers.stays.text && answers.after.text.endsWith('/tmp'), told)

  console.log('\n(2) what the wrapper was handed')
  const counts = existsSync(`${log}.counts`) ? readFileSync(`${log}.counts`, 'utf8').trim().split('\n') : []
  const handed = existsSync(`${log}.line`) ? readFileSync(`${log}.line`, 'utf8') : ''
  check('the wrapper is started once for each command, with its flag and one line', counts.length === 6 && counts.every(count => count === '2'), JSON.stringify(counts))
  const { tryParseShellCommand } = await import('../../src/utils/bash/shellQuote.ts')
  const parsed = tryParseShellCommand(handed)
  const words = parsed.success ? parsed.tokens : []
  check(
    'that line is three words: the record\'s shell by its path, -c, and the frame — whichever shell the wrapper runs reads no word of the command',
    answers !== null && words.length === 3 && words[0] === answers.record && words[1] === '-c' && typeof words[2] === 'string' && words[2].includes("eval 'pwd -P'"),
    JSON.stringify(handed.slice(0, 400)),
  )
  check('the line is quoted with single quotes alone, which sh, bash and zsh read alike', handed.startsWith(`'${answers?.record ?? ''}' -c '`) && handed.endsWith("'") && !handed.includes('"$'), JSON.stringify(handed.slice(0, 200)))

  console.log('\n(3) the prefix\'s other users are handed what they were: a hook\'s command and an MCP server\'s go through formatShellPrefixCommand as before')
  const { formatShellPrefixCommand } = await import('../../src/utils/bash/shellPrefix.ts')
  const SAME: Array<[string, string, string]> = [
    ['/bin/zsh -c', 'echo hi', "/bin/zsh -c 'echo hi'"],
    ['/usr/local/bin/trace', 'echo hi', "/usr/local/bin/trace 'echo hi'"],
    ['/opt/my tools/wrap --flag -c', 'ls -la', "'/opt/my tools/wrap --flag' -c 'ls -la'"],
  ]
  for (const [prefix, command, want] of SAME) {
    const got = formatShellPrefixCommand(prefix, command)
    check(`formatShellPrefixCommand(${JSON.stringify(prefix)}, ${JSON.stringify(command)}) is ${JSON.stringify(want)}`, got === want, JSON.stringify(got))
  }
} finally {
  rmSync(scratch, { recursive: true, force: true })
}

console.log(failures === 0 ? '\nprove-prefix-wraps-the-record: ALL LAWS HOLD' : `\nprove-prefix-wraps-the-record: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
