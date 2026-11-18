#!/usr/bin/env bun
import { spawn } from 'node:child_process'
import { copyFileSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { FIXTURE_API_KEY, seedFirstRun } from '../lib/firstRunSeed.ts'
import { startFixtureApi, type FixtureApi, type ScriptedTurn } from '../lib/fixtureApi.ts'
import { nodeBinPath } from '../lib/nodeBin.ts'

const ROOT = resolve(import.meta.dir, '..', '..')
const distAt = process.argv.indexOf('--dist')
const DIST = distAt === -1 ? join(ROOT, 'dist', 'mercury.mjs') : resolve(process.argv[distAt + 1]!)
const MODEL = 'claude-opus-4-8'
const ASK = 'recorded-shell-gone-probe'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}

function resultsOf(api: FixtureApi): string[] {
  const seen = new Map<string, string>()
  for (const request of api.messageRequests()) {
    const messages = (request.body as { messages?: Array<{ role?: string; content?: unknown }> } | null)?.messages ?? []
    for (const message of messages) {
      if (message.role !== 'user' || !Array.isArray(message.content)) continue
      for (const part of message.content as Array<{ type?: string; tool_use_id?: string; content?: unknown }>) {
        if (part.type !== 'tool_result') continue
        const text = typeof part.content === 'string' ? part.content : Array.isArray(part.content) ? (part.content as Array<{ type?: string; text?: string }>).map(inner => (inner.type === 'text' ? (inner.text ?? '') : '')).join('') : ''
        seen.set(part.tool_use_id ?? String(seen.size), text)
      }
    }
  }
  return [...seen.values()]
}

console.log('============================================================')
console.log(' A recorded shell whose file goes away: the result says so and what to do, and the record stays')
console.log('============================================================')
console.log(`build under proof: ${DIST}`)

const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'recorded-shell-gone-')))
try {
  const platform = `${process.platform === 'darwin' ? 'darwin' : 'linux'}-${process.arch === 'arm64' ? 'arm64' : 'x64'}`
  const from = dirname(DIST)
  if (process.platform === 'win32') console.log('  [SKIP] this proof drives the macOS and Linux road; the Windows road has its own proofs')
  else if (!existsSync(DIST)) check('the built bundle is present', false, `${DIST} is absent: run bun run build.ts, then this proof again`)
  else if (!existsSync(join(from, 'vendor', 'bash', platform, 'bash'))) check('the bundle under proof carries the bash pack', false, 'build the pack (bun run scripts/vendor/build-bash.ts), rebuild the bundle (bun run build.ts) and run this proof again')
  else {
    const view = join(scratch, 'bundle')
    mkdirSync(join(view, 'vendor'), { recursive: true })
    for (const name of readdirSync(from)) {
      if (name !== 'vendor' && lstatSync(join(from, name)).isFile()) copyFileSync(join(from, name), join(view, name))
    }
    for (const name of readdirSync(join(from, 'vendor'))) {
      if (name === 'bash') cpSync(join(from, 'vendor', name), join(view, 'vendor', name), { recursive: true })
      else symlinkSync(join(from, 'vendor', name), join(view, 'vendor', name))
    }
    const shell = join(view, 'vendor', 'bash', platform, 'bash')
    const userHome = join(scratch, 'user-home')
    const config = join(scratch, 'config-home')
    const cwd = join(scratch, 'work')
    for (const dir of [userHome, config, cwd]) mkdirSync(dir, { recursive: true })
    seedFirstRun(config, [cwd])
    const turns: ScriptedTurn[] = [
      { kind: 'tool_use', name: 'Bash', id: 'toolu_shell_present', input: { command: 'echo started > started; sleep 3; echo "before:$BASH"', description: 'a command that is running when the file goes' } },
      { kind: 'tool_use', name: 'Bash', id: 'toolu_shell_gone', input: { command: 'echo after', description: 'a command after the shell is gone' } },
      { kind: 'tool_use', name: 'Bash', id: 'toolu_shell_still_gone', input: { command: 'echo again', description: 'and one more' } },
      { kind: 'text', text: 'done' },
    ]
    const api = await startFixtureApi(turns)
    const inherited = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => /^(?:TMPDIR|NODE_COMPILE_CACHE|MERCURY_UPDATE_API_BASE_URL|MERCURY_[A-Z0-9_]+_BASE)$/.test(entry[0]) && entry[1] !== undefined))
    const env = {
      ...inherited,
      HOME: userHome,
      SHELL: '/bin/zsh',
      TERM: 'dumb',
      PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
      MERCURY_CONFIG_DIR: config,
      MERCURY_DAEMON_DIR: join(config, 'daemon'),
      MERCURY_CREDENTIAL_STORE: 'file',
      MERCURY_LOCAL_PROBE_TARGETS: 'none',
      ANTHROPIC_API_KEY: FIXTURE_API_KEY,
      ANTHROPIC_BASE_URL: api.url,
    }
    let why = ''
    try {
      const child = spawn(nodeBinPath(), [join(view, 'mercury.mjs'), 'run', '--mode', 'sovereign', '--model', MODEL, '--format', 'text', ASK], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] })
      let stderr = ''
      child.stderr.on('data', chunk => { stderr += String(chunk) })
      child.stdout.resume()
      const bound = setTimeout(() => child.kill('SIGKILL'), 120_000)
      const watch = setInterval(() => {
        if (!existsSync(join(cwd, 'started'))) return
        rmSync(shell, { force: true })
        clearInterval(watch)
      }, 50)
      const code = await new Promise<number | null>(done => { child.once('close', exit => done(exit)); child.once('error', () => done(null)) })
      clearTimeout(bound)
      clearInterval(watch)
      why = `exit ${String(code)} · stderr ${JSON.stringify(stderr.slice(-300))}`
    } finally {
      await api.close()
    }
    const results = resultsOf(api)
    const told = `${JSON.stringify(results.map(text => text.slice(0, 420)))} · ${why}`
    check('the first command runs in the bundle\'s own bash, and that file is removed while it runs', results.length === 3 && results[0]!.includes(`before:${shell}`) && !existsSync(shell), told)
    check('the bundle the proof was started from still holds its bash: only the copy was removed', existsSync(join(from, 'vendor', 'bash', platform, 'bash')))
    const gone = /The shell this session runs commands in is gone: the bash Mercury ships was at (\S+) and that file is no longer there\./
    check('the next command\'s result says the shipped bash is gone and where it was', gone.exec(results[1] ?? '')?.[1] === shell, told)
    check('it says what to do: restart Mercury, and the new session takes the next road', /restart Mercury and the new session takes the next road \(the system's bash, then the bundled engine\)/.test(results[1] ?? ''), told)
    check('it is not a bare errno', !/ENOENT|posix_spawn/.test(results[1] ?? ''), told)
    check('the record stays for the session\'s life: the command after it gets the same answer, and no other shell is tried', gone.exec(results[2] ?? '')?.[1] === shell && !/again\n?$/.test((results[2] ?? '').trim()), told)
  }
} finally {
  rmSync(scratch, { recursive: true, force: true })
}

console.log(failures === 0 ? '\nprove-recorded-shell-gone: ALL LAWS HOLD' : `\nprove-recorded-shell-gone: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
