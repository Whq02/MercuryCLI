#!/usr/bin/env bun
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getCachedPowerShellPath } from '../../src/utils/shell/powershellDetection.ts'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const root = mkdtempSync(join(tmpdir(), 'hook-command-runner-'))
const home = join(root, 'home')
const cwd = join(root, 'cwd')
mkdirSync(home, { recursive: true })
mkdirSync(cwd, { recursive: true })
process.env.MERCURY_CONFIG_DIR = home
process.env.MERCURY_CREDENTIAL_STORE = 'file'
delete process.env.MERCURY_HOME
delete process.env.MERCURY_SHELL_PREFIX

let failures = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  if (!ok) failures++
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
}
const watchdog = setTimeout(() => {
  console.log('FAIL — the command runner wedged past 90s')
  process.exit(1)
}, 90_000)
watchdog.unref?.()

const { startCommandHook, winShHookCommand, HOOK_OUTPUT_MAX_BYTES, HOOK_STREAM_SETTLE_GRACE_MS } = await import('../../src/utils/hooks/commandRunner.ts')
const { withHookRunContext } = await import('../../src/utils/hooks/hookEvents.ts')
const { hookEndingSentence } = await import('../../src/rows/vocabulary.ts')

const base = { shell: 'bash' as const, name: 'probe', index: 0, payloadJson: '{"event":"turn.start"}', timeoutMs: 20_000, source: { kind: 'settings' as const }, cwd }
const run = (over: Partial<Parameters<typeof startCommandHook>[0]> & { command: string }) => startCommandHook({ ...base, event: 'turn.start', ...over })

{
  const pidFile = join(root, 'sleeper.pid')
  const started = Date.now()
  const process_ = await run({ command: `echo the-verdict-line; sleep 300 & echo $! > ${JSON.stringify(pidFile)}; exit 0` })
  const end = await process_.result
  const took = Date.now() - started
  check('a hook whose forked child holds the pipes settles at exit plus the stream grace, with everything read so far', end.kind === 'exited' && end.code === 0 && end.stdout.trim() === 'the-verdict-line' && took < HOOK_STREAM_SETTLE_GRACE_MS + 5_000, `kind ${end.kind} took ${took}ms stdout ${JSON.stringify(end.stdout)}`)
  if (existsSync(pidFile)) {
    const pid = Number(readFileSync(pidFile, 'utf8').trim())
    if (Number.isFinite(pid) && pid > 1) try { process.kill(pid, 'SIGKILL') } catch {}
  }
}

{
  const started = Date.now()
  const process_ = await run({ command: 'echo partial; sleep 25; echo never', timeoutMs: 1_000 })
  const end = await process_.result
  const took = Date.now() - started
  check('one clock: the timed-out hook is killed by its own clock and ends timed_out, never cancelled', end.kind === 'ended' && end.ending.class === 'timed_out' && end.ending.detail === '1s' && took < 6_000, `kind ${end.kind} ${end.kind === 'ended' ? end.ending.class : ''} took ${took}ms`)
  check('the output read before the clock ran out rides the ending', end.stdout.trim() === 'partial', JSON.stringify(end.stdout))
  const line = end.kind === 'ended' ? hookEndingSentence(end.ending, { name: 'probe', event: 'turn.start' }) : ''
  check('the timed-out ending reads as one sentence naming the hook, the event and the budget', line.includes('probe') && line.includes('turn.start') && line.includes('1s'), line)
}

{
  const controller = new AbortController()
  const process_ = await run({ command: 'sleep 25', signal: controller.signal })
  setTimeout(() => controller.abort(), 200)
  const end = await process_.result
  check('a cancelled signal ends the hook cancelled, told apart from a timeout', end.kind === 'ended' && end.ending.class === 'cancelled', end.kind === 'ended' ? end.ending.class : end.kind)
  const aborted = new AbortController()
  aborted.abort()
  const never = await run({ command: 'echo ran > ' + JSON.stringify(join(root, 'never')), signal: aborted.signal })
  const neverEnd = await never.result
  check('an already-cancelled signal spawns nothing', neverEnd.kind === 'ended' && neverEnd.ending.class === 'cancelled' && !existsSync(join(root, 'never')))
}

{
  const process_ = await run({ command: 'exit 7' })
  const end = await process_.result
  check('a non-zero exit comes back as the code, with the words left on stderr', end.kind === 'exited' && end.code === 7)
  const shouting = await run({ command: 'echo loud >&2; exit 3' })
  const shoutEnd = await shouting.result
  check('stderr is read whole on a non-zero exit', shoutEnd.kind === 'exited' && shoutEnd.code === 3 && shoutEnd.stderr.trim() === 'loud')
}

{
  const envFile = join(root, 'env.json')
  const process_ = await withHookRunContext({ sessionId: 'daemon-session-9', cwd, transcriptPath: join(root, 't.jsonl') }, () => run({ command: `node -e 'process.stdout.write(JSON.stringify({ env: process.env, cwd: process.cwd(), stdin: require("fs").readFileSync(0, "utf8") }))' > ${JSON.stringify(envFile)}`, payloadJson: '{"event":"turn.start","turn_id":"t-1"}' }))
  const end = await process_.result
  const seen = JSON.parse(readFileSync(envFile, 'utf8')) as { env: Record<string, string>; cwd: string; stdin: string }
  check('the hook reads the payload as one JSON line on stdin', end.kind === 'exited' && end.code === 0 && seen.stdin === '{"event":"turn.start","turn_id":"t-1"}\n', JSON.stringify(seen.stdin))
  check('the hook gets MERCURY_HOOK_EVENT, MERCURY_SESSION_ID and MERCURY_PROJECT_DIR in its environment', seen.env.MERCURY_HOOK_EVENT === 'turn.start' && seen.env.MERCURY_SESSION_ID === 'daemon-session-9' && typeof seen.env.MERCURY_PROJECT_DIR === 'string' && seen.env.MERCURY_PROJECT_DIR.length > 0, `${seen.env.MERCURY_HOOK_EVENT} ${seen.env.MERCURY_SESSION_ID}`)
  check('the run context (the daemon road) names the session id the hook sees', seen.env.MERCURY_SESSION_ID === 'daemon-session-9')
  check('the hook runs in the cwd it was given', seen.cwd === cwd, seen.cwd)
  check('a turn.start hook gets no MERCURY_ENV_FILE', seen.env.MERCURY_ENV_FILE === undefined)
  check('no extension variable leaks into a settings hook', seen.env.MERCURY_EXTENSION_ROOT === undefined && seen.env.MERCURY_EXTENSION_DATA === undefined)
  for (const event of ['session.start', 'file.changed'] as const) {
    const envFile2 = join(root, `env-${event}.json`)
    const process2 = await run({ event, command: `node -e 'process.stdout.write(JSON.stringify(process.env))' > ${JSON.stringify(envFile2)}` })
    await process2.result
    const env2 = JSON.parse(readFileSync(envFile2, 'utf8')) as Record<string, string>
    check(`a ${event} hook gets MERCURY_ENV_FILE, a fragment path named for the event`, typeof env2.MERCURY_ENV_FILE === 'string' && /session-start-hook-0\.sh$|file-changed-hook-0\.sh$/.test(env2.MERCURY_ENV_FILE), String(env2.MERCURY_ENV_FILE))
  }
  const skillEnv = join(root, 'env-skill.json')
  const skillRoot = join(root, 'skill')
  mkdirSync(skillRoot)
  const process3 = await run({ command: `node -e 'process.stdout.write(JSON.stringify(process.env))' > ${JSON.stringify(skillEnv)}`, source: { kind: 'skill', root: skillRoot } })
  await process3.result
  check('a skill hook gets MERCURY_EXTENSION_ROOT = the skill folder', (JSON.parse(readFileSync(skillEnv, 'utf8')) as Record<string, string>).MERCURY_EXTENSION_ROOT === skillRoot)
}

{
  const process_ = await run({ command: 'cat > /dev/null; cd /', cwd: join(root, 'gone-cwd') })
  const end = await process_.result
  check('a cwd that is gone falls back instead of failing the hook', end.kind === 'exited' && end.code === 0, end.kind === 'ended' ? end.ending.class : String(end.code))
}

{
  const process_ = await run({ command: 'head -c 11000000 /dev/zero | tr "\\0" a; echo; echo tail-after-bound' })
  const end = await process_.result
  check('output is bounded at 10 MB with the truncation note, and the hook still settles', end.kind === 'exited' && end.stdout.length <= HOOK_OUTPUT_MAX_BYTES + 64 && end.stdout.endsWith('[hook output truncated at 10MB]'), `len ${end.stdout.length}`)
}

{
  const marks: Array<{ stdout: string; stderr: string }> = []
  const process_ = await run({ command: 'echo one; echo two >&2; echo three', onOutput: snapshot => { marks.push(snapshot) } })
  const end = await process_.result
  check('the runner reports each output chunk as it arrives (the progress road)', marks.length >= 2 && end.kind === 'exited' && end.stdout.includes('three') && end.stderr.includes('two'), `${marks.length} marks`)
}

{
  const process_ = await startCommandHook({ ...base, event: 'turn.start', command: 'echo hi', shell: 'powershell' })
  const end = await process_.result
  const pwsh = (await getCachedPowerShellPath()) !== null
  check(pwsh ? 'a powershell hook runs under pwsh' : 'a powershell hook on a box without pwsh ends spawn with the one sentence naming the fix', pwsh ? end.kind === 'exited' : end.kind === 'ended' && end.ending.class === 'spawn' && String(end.ending.detail).includes('No PowerShell on PATH'), end.kind === 'ended' ? String(end.ending.detail) : end.kind)
}

{
  check('winShHookCommand: a non-.sh command stays untouched', winShHookCommand('echo hi') === 'echo hi')
  check('winShHookCommand: a bare .sh script gets bash in front', winShHookCommand('hook.sh') === 'bash hook.sh')
  check('winShHookCommand: a .sh with arguments keeps them', winShHookCommand('hook.sh --fast') === 'bash hook.sh --fast')
  check('winShHookCommand: an already-bash command stays untouched', winShHookCommand('bash hook.sh') === 'bash hook.sh')
  check('winShHookCommand: a backslashed path is forwarded and single-quoted', winShHookCommand('C:\\hooks\\run.sh') === "bash 'C:/hooks/run.sh'")
  check('winShHookCommand: a quoted backslashed path is requoted whole', winShHookCommand('"C:\\my hooks\\run.sh" arg') === "bash 'C:/my hooks/run.sh' arg")
  check("winShHookCommand: a path holding a single quote takes double quotes", winShHookCommand("C:\\it's\\run.sh") === 'bash "C:/it\'s/run.sh"')
  check('winShHookCommand: a .sh deeper in the command is left alone', winShHookCommand('node run.sh') === 'node run.sh')
}

{
  const prefixed = join(root, 'prefix.log')
  writeFileSync(join(root, 'prefix.sh'), `#!/bin/bash\nprintf '%s\\n' "$*" >> ${JSON.stringify(prefixed)}\nexec bash -c "$1"\n`, { mode: 0o755 })
  process.env.MERCURY_SHELL_PREFIX = join(root, 'prefix.sh')
  const process_ = await run({ command: 'echo prefixed-run' })
  const end = await process_.result
  delete process.env.MERCURY_SHELL_PREFIX
  check('MERCURY_SHELL_PREFIX wraps a bash hook like any other command', end.kind === 'exited' && existsSync(prefixed) && readFileSync(prefixed, 'utf8').includes('prefixed-run'), end.kind)
}

{
  writeFileSync(join(root, 'closer.sh'), 'exec 0<&-\nsleep 0.3\necho closed-stdin\n')
  const process_ = await run({ command: `bash ${JSON.stringify(join(root, 'closer.sh'))}` })
  const end = await process_.result
  check('a hook that never reads its stdin still settles (closed_pipe or a clean exit, never a wedge)', (end.kind === 'exited' && end.code === 0) || (end.kind === 'ended' && end.ending.class === 'closed_pipe'), end.kind === 'ended' ? end.ending.class : String(end.code))
}

clearTimeout(watchdog)
rmSync(root, { recursive: true, force: true })
console.log(failures === 0 ? 'HOOK COMMAND RUNNER GREEN' : `${failures} HOOK COMMAND RUNNER FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
