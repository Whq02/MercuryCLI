#!/usr/bin/env bun
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = join(HERE, '..', '..')
const DIST = join(REPO, 'dist', 'mercury.mjs')
if (!existsSync(DIST)) {
  console.error('✗ dist/mercury.mjs missing — run `bun run build.ts` first')
  process.exit(1)
}

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const work = realpathSync(mkdtempSync(join(tmpdir(), 'session-temp-')))
const ownRoot = join(work, 'own-temp')
mkdirSync(ownRoot, { recursive: true })
process.env.MERCURY_TMPDIR = ownRoot
delete process.env.MERCURY_CONCOURSE_WORKER

const { getMercuryTempDir } = await import('../../src/utils/permissions/filesystem.ts')
const { scratchpadDirFor, sweepScratchpadDir } = await import('../../src/utils/scratchpad.ts')
const { startFixtureApi, handoffTurn } = await import('../lib/fixtureApi.ts')
const { FIXTURE_API_KEY } = await import('../lib/firstRunSeed.ts')

let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
const section = (title: string): void => console.log(`\n${'─'.repeat(76)}\n${title}`)

const walk = (dir: string, base = dir): string[] => {
  if (!existsSync(dir)) return []
  const out: string[] = []
  for (const name of readdirSync(dir).sort()) {
    const full = join(dir, name)
    const isDir = statSync(full).isDirectory()
    out.push(relative(base, full) + (isDir ? '/' : ''))
    if (isDir) out.push(...walk(full, base))
  }
  return out
}

console.log('============================================================')
console.log(' a session removes the temp directories it made')
console.log('============================================================')

section('§1 the sweep takes the scratchpad and the folders that held only it')
const tempRoot = getMercuryTempDir()
{
  const alone = scratchpadDirFor('/proof/alone', 'session-a')
  mkdirSync(alone, { recursive: true })
  writeFileSync(join(alone, 'helper.sh'), 'echo hi\n')
  const project = dirname(dirname(alone))
  const swept = sweepScratchpadDir(alone)
  check('a settled session with nothing but its scratchpad: the scratchpad, its session folder and its project folder are gone', swept.swept === true && !existsSync(project), walk(project).join(' '))
  check('the temp root itself stands', existsSync(tempRoot))
}
{
  const first = scratchpadDirFor('/proof/shared', 'session-a')
  const second = scratchpadDirFor('/proof/shared', 'session-b')
  const project = dirname(dirname(first))
  mkdirSync(first, { recursive: true })
  mkdirSync(second, { recursive: true })
  sweepScratchpadDir(first)
  check("a second session of the same project keeps its own folder and the project's", !existsSync(dirname(first)) && existsSync(second), walk(project).join(' '))
  sweepScratchpadDir(second)
  check('the last session out takes the project folder', !existsSync(project), walk(project).join(' '))
}
{
  const kept = scratchpadDirFor('/proof/ledger', 'session-a')
  mkdirSync(kept, { recursive: true })
  writeFileSync(join(kept, 'capture.txt'), 'x\n')
  writeFileSync(join(dirname(kept), 'created-paths.txt'), '/proof/ledger/made-here\n')
  mkdirSync(join(dirname(kept), 'tasks'))
  sweepScratchpadDir(kept)
  const left = walk(dirname(kept))
  check("a session folder that holds another file keeps it: the sweep takes the scratchpad alone (the ledger and the sibling folder stand)", !existsSync(kept) && left.join(' ') === 'created-paths.txt tasks/', left.join(' '))
  rmSync(dirname(dirname(kept)), { recursive: true, force: true })
}
{
  const shallow = join(tempRoot, 'scratchpad')
  const oneDeep = join(tempRoot, 'lone', 'scratchpad')
  mkdirSync(shallow, { recursive: true })
  mkdirSync(oneDeep, { recursive: true })
  sweepScratchpadDir(shallow)
  sweepScratchpadDir(oneDeep)
  check('a scratchpad that is not two folders under the temp root takes nothing above it: the root and the lone folder stand', !existsSync(shallow) && !existsSync(oneDeep) && existsSync(tempRoot) && existsSync(join(tempRoot, 'lone')), walk(tempRoot).join(' '))
  rmSync(join(tempRoot, 'lone'), { recursive: true, force: true })
}

type Turn = Parameters<typeof startFixtureApi>[0][number]
type Run = { code: number | null; left: string[]; said: string; err: string }
async function runOnce(tag: string, turns: (world: { temp: string; session: string }) => Turn[]): Promise<Run> {
  const world = join(work, tag)
  const home = join(world, 'home')
  const configDir = join(home, '.mercury')
  const temp = join(world, 'temp')
  const cwd = join(world, 'cwd')
  for (const dir of [configDir, temp, cwd]) mkdirSync(dir, { recursive: true })
  const realCwd = realpathSync(cwd)
  const session = randomUUID()
  writeFileSync(join(configDir, '.config.json'), JSON.stringify({
    theme: 'dark',
    hasCompletedOnboarding: true,
    customApiKeyResponses: { approved: [FIXTURE_API_KEY.slice(-20)] },
    projects: { [realCwd]: { hasTrustDialogAccepted: true, hasCompletedProjectOnboarding: true } },
  }))
  const api = await startFixtureApi([...turns({ temp, session }), handoffTurn(), handoffTurn()])
  const child = spawn('node', [DIST, 'run', '--format', 'rows', '--sovereign', '--session-id', session, '--', 'go'], {
    cwd: realCwd,
    env: {
      HOME: home,
      PATH: `/usr/bin:/bin:${dirname(process.execPath)}:${process.env.PATH ?? ''}`,
      TERM: 'xterm-256color',
      TMPDIR: temp,
      MERCURY_TMPDIR: temp,
      MERCURY_CONFIG_DIR: configDir,
      MERCURY_CREDENTIAL_STORE: 'file',
      MERCURY_LOCAL_PROBE_TARGETS: 'none',
      MERCURY_DAEMON_DIR: join(home, 'daemon'),
      ANTHROPIC_API_KEY: FIXTURE_API_KEY,
      ANTHROPIC_BASE_URL: api.url,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  let out = ''
  let err = ''
  child.stdout.on('data', d => (out += d))
  child.stderr.on('data', d => (err += d))
  child.stdin.end()
  const killer = setTimeout(() => child.kill('SIGKILL'), 90_000)
  const code = await new Promise<number | null>(resolve => child.on('exit', c => { clearTimeout(killer); resolve(c) }))
  const said = api.messageRequests().map(request => request.raw).join('\n')
  await api.close()
  const roots = readdirSync(temp).filter(name => name.startsWith('mercury'))
  const left = roots.flatMap(name => walk(join(temp, name)))
  return { code, left, said, err: `${err.slice(-200)} ${out.slice(-200)}` }
}

section('§2 the built bundle, one run to its own exit: nothing is left under the temp root')
{
  const run = await runOnce('words', () => [{ kind: 'text', text: 'Hello.' }])
  check('a turn of words only ends 0 and leaves no folder', run.code === 0 && run.left.length === 0, `exit ${run.code} · left ${run.left.join(' ')} · ${run.err}`)
}
{
  const run = await runOnce('shell', () => [{ kind: 'tool_use', name: 'Bash', input: { command: 'echo shell-ran', description: 'say a word' } }, { kind: 'text', text: 'Done.' }])
  check('the shell command ran', run.said.includes('shell-ran'), run.err)
  check('a turn that ran a shell command ends 0 and leaves no folder (the empty task-output folder goes too)', run.code === 0 && run.left.length === 0, `exit ${run.code} · left ${run.left.join(' ')}`)
}
{
  const run = await runOnce('scratch', ({ temp, session }) => [
    { kind: 'tool_use', name: 'Bash', input: { command: `for pad in '${temp}'/mercury*/*/${session}/scratchpad; do echo kept > "$pad/note.txt"; ls "$pad"; done`, description: 'write a scratch file' } },
    { kind: 'text', text: 'Done.' },
  ])
  check('the session wrote a file into its scratchpad', run.said.includes('note.txt'), run.err)
  check('a scratchpad that held a file is swept at the exit and its folders go with it', run.code === 0 && run.left.length === 0, `exit ${run.code} · left ${run.left.join(' ')}`)
}

section('§3 what holds a file stays: only empty folders go')
{
  const run = await runOnce('ledger', () => [{ kind: 'tool_use', name: 'Bash', input: { command: 'mkdir made-here && echo made', description: 'make a folder' } }, { kind: 'text', text: 'Done.' }])
  const files = run.left.filter(entry => !entry.endsWith('/'))
  check('the session made a folder in its project', run.said.includes('made'), run.err)
  check("the record of the paths the session created stands alone in its session folder (a resumed session reads it)", run.code === 0 && files.length === 1 && files[0]!.endsWith('created-paths.txt') && run.left.length === 3, `exit ${run.code} · left ${run.left.join(' ')}`)
}
{
  const run = await runOnce('background', () => [
    { kind: 'tool_use', name: 'Bash', input: { command: 'echo background-word; sleep 1', description: 'a background word', run_in_background: true } },
    { kind: 'tool_use', name: 'Bash', input: { command: 'sleep 2; echo waited', description: 'wait' } },
    { kind: 'text', text: 'Done.' },
  ])
  const files = run.left.filter(entry => !entry.endsWith('/'))
  check("a background command's output file stands with its folders, and nothing else", run.code === 0 && files.length === 1 && /tasks\/[^/]+\.output$/.test(files[0]!) && run.left.length === 4, `exit ${run.code} · left ${run.left.join(' ')}`)
}

rmSync(work, { recursive: true, force: true })
console.log(`\n${'─'.repeat(76)}`)
console.log(failures === 0 ? '  ALL PASS' : `  ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
