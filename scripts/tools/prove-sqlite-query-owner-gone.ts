import { Database } from 'bun:sqlite'
import { fork, spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { cannotStart, mustStart } from './readViewMcp.js'

const script = fileURLToPath(import.meta.url)
const tree = resolve(dirname(script), '../..')
const src = process.env.PROVE_SRC ?? join(tree, 'src')
const dist = process.env.MERCURY_PROOF_DIST ?? join(tree, 'dist/mercury.mjs')
const node = join(dirname(dist), 'vendor/node', process.platform === 'win32' ? 'node.exe' : 'bin/node')
const ENDLESS = 'WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM c) SELECT count(*) FROM c'
const sleep = (ms: number): Promise<void> => new Promise(done => setTimeout(done, ms))
const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true } catch { return false } }
const end = (pid: number | undefined): void => { if (pid !== undefined) { try { process.kill(pid, 'SIGKILL') } catch {} } }
const ended = (pid: number): boolean => {
  if (!alive(pid)) return true
  if (process.platform === 'win32') return false
  const state = (spawnSync('ps', ['-p', String(pid), '-o', 'stat='], { encoding: 'utf8' }).stdout ?? '').trim()
  return state === '' || state.startsWith('Z')
}

type Row = { pid: number; ppid: number; command: string }
function listedRows(listed: string): Row[] {
  const rows: Row[] = []
  for (const line of listed.split(/\r?\n/)) {
    const cut = /^(\d+)\t(\d+)\t(.*)$/.exec(line)
    if (cut) rows.push({ pid: Number(cut[1]), ppid: Number(cut[2]), command: cut[3]! })
    else if (rows.length > 0) rows[rows.length - 1]!.command += `\n${line}`
  }
  return rows
}
function processTable(): Row[] {
  if (process.platform === 'win32') {
    const listed = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId)`t$($_.ParentProcessId)`t$($_.CommandLine)" }'], { encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1024 * 1024 })
    return listedRows(listed.stdout ?? '')
  }
  const listed = spawnSync('ps', ['-A', '-o', 'pid=,ppid=,args='], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  return (listed.stdout ?? '').split('\n').flatMap(line => { const cut = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line); return cut ? [{ pid: Number(cut[1]), ppid: Number(cut[2]), command: cut[3]! }] : [] })
}
function under(rows: Row[], root: number): Row[] {
  const found: Row[] = []
  let frontier = [root]
  while (frontier.length > 0) {
    const next = rows.filter(row => frontier.includes(row.ppid) && !found.includes(row))
    found.push(...next)
    frontier = next.map(row => row.pid)
  }
  return found
}
const isQueryChild = (row: Row): boolean => row.command.includes('--input-type=module') && row.command.includes('node:sqlite')
let listedUnder: Row[] = []
const unseen = (): string => `no query child was seen under the owner (listed under it: ${listedUnder.length === 0 ? 'nothing' : listedUnder.map(row => JSON.stringify(row.command.slice(0, 120))).join(' · ')})`
async function queryChildUnder(root: number, withinMs: number): Promise<{ child: Row; family: Row[] } | null> {
  const until = Date.now() + withinMs
  while (Date.now() < until) {
    const family = under(processTable(), root)
    listedUnder = family
    const child = family.find(isQueryChild)
    if (child) return { child, family }
    await sleep(100)
  }
  return null
}
async function goneWithin(pid: number, ms: number): Promise<number> {
  const began = Date.now()
  while (Date.now() - began < ms) {
    if (ended(pid)) return Date.now() - began
    await sleep(25)
  }
  return -1
}

if (process.argv[2] === '--owner') {
  const [scenario, file, artifactDirectory] = process.argv.slice(3) as [string, string, string]
  ;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
  const { runSqliteQuery } = (await import(join(src, 'tools/FileReadTool/sqliteQueryProcess.ts'))) as { runSqliteQuery: (job: Record<string, unknown>, signal: AbortSignal) => Promise<{ rows: string[] }> }
  const job = { file, immutable: false, sql: scenario === 'answer' ? 'SELECT value FROM items ORDER BY id' : ENDLESS, offset: 0, limit: 10, room: 10_000, artifactDirectory }
  const running = runSqliteQuery(job, new AbortController().signal).then(page => ({ rows: page.rows }), error => ({ error: String((error as Error)?.message ?? error) }))
  if (scenario === 'answer') {
    const answered = await running
    process.send?.({ answered }, () => process.exit(0))
  } else {
    process.on('message', message => { if ((message as { leave?: boolean }).leave) process.exit(0) })
    process.send?.({ started: true })
    await running
  }
} else {
  mustStart(node)
  let passed = 0, failed = 0
  const check = (name: string, ok: boolean, detail = ''): void => { ok ? passed++ : failed++; console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${name}${ok ? '' : ` — ${detail}`}`) }
  const base = process.env.RP_SCRATCH ?? process.env.MERCURY_TMPDIR ?? process.env.MERCURY_CONFIG_DIR
  if (!base) throw new Error('The proof needs its scratch root')
  mkdirSync(base, { recursive: true })
  const home = realpathSync(mkdtempSync(join(base, 'query-owner-')))
  const project = join(home, 'project'), config = join(home, '.mercury')
  mkdirSync(project, { recursive: true })
  mkdirSync(join(config, 'tmp'), { recursive: true })
  const file = join(project, 'rows.sqlite')
  const seed = new Database(file)
  seed.run("CREATE TABLE items(id INTEGER PRIMARY KEY, value TEXT); INSERT INTO items VALUES(1,'one'),(2,'two')")
  seed.close()
  const ready = existsSync(dist) && existsSync(node)
  check('the built bundle and its release Node are there to read', ready, `${dist} or ${node} is missing — run bun run build.ts first`)
  const asWindowsLists = listedRows('4\t0\t\r\n700\t4\tC:\\tools\\bun.exe prove-sqlite-query-owner-gone.ts --owner endless\r\n812\t700\t"C:\\dist\\vendor\\node\\node.exe" --input-type=module -e "(async function sqliteQueryChild(work) {\n  const load = Function(\\"name\\", \\"return import(name)\\");\n})(\\"await load(\\\\\\"node:sqlite\\\\\\")\\")"\r\n900\t812\tconhost.exe 0x4\r\n')
  check('a command line that spans lines, as Windows lists the query child of the source road, is read as one row with its whole command and the child is seen under its owner (the Windows box read its first line alone and saw no query child)', asWindowsLists.length === 4 && under(asWindowsLists, 700).length === 2 && under(asWindowsLists, 700).filter(isQueryChild).map(row => row.pid).join() === '812', JSON.stringify(asWindowsLists))
  const owner = (scenario: string, extra: Record<string, string> = {}): ChildProcess =>
    fork(script, ['--owner', scenario, file, join(config, 'tmp', 'query-results')], { execPath: process.execPath, execArgv: [], stdio: ['ignore', 'ignore', 'pipe', 'ipc'], env: { ...process.env, HOME: home, USERPROFILE: home, MERCURY_CONFIG_DIR: config, MERCURY_TMPDIR: join(config, 'tmp'), ...extra } })
  const told = (proc: ChildProcess, key: string, withinMs: number): Promise<Record<string, unknown> | null> =>
    new Promise(resolvePromise => {
      const timer = setTimeout(() => resolvePromise(null), withinMs)
      proc.on('message', message => { if ((message as Record<string, unknown>)[key] !== undefined) { clearTimeout(timer); resolvePromise(message as Record<string, unknown>) } })
      proc.once('exit', () => { clearTimeout(timer); resolvePromise(null) })
    })
  if (ready) {
    console.log('\nS1 the query through the source, the proof’s own runtime as the Mercury that asks')
    {
      const proc = owner('answer')
      let stderr = ''
      proc.stderr?.on('data', chunk => { stderr += String(chunk) })
      const said = await told(proc, 'answered', 20_000)
      const answered = said?.answered as { rows?: string[]; error?: string } | undefined
      check('control: a statement that ends answers its rows through the child as before (holds on the parent)', answered?.rows?.join('|') === '1\t["one"]|2\t["two"]', `${JSON.stringify(said)} ${stderr.slice(-400)}`)
      end(proc.pid)
    }
    {
      const proc = owner('endless')
      const started = await told(proc, 'started', 20_000)
      const seen = started === null || proc.pid === undefined ? null : await queryChildUnder(proc.pid, 8000)
      end(proc.pid)
      const gone = seen === null ? -1 : await goneWithin(seen.child.pid, 3000)
      check('a Mercury ended hard in mid-statement leaves no query child: it is gone within three seconds (RED on the parent: the child ran on with no parent)', seen !== null && gone !== -1, seen === null ? unseen() : `child ${seen.child.pid} still runs three seconds after its parent was ended`)
      if (seen !== null && gone === -1) end(seen.child.pid)
    }
    {
      const proc = owner('endless')
      const started = await told(proc, 'started', 20_000)
      const seen = started === null || proc.pid === undefined ? null : await queryChildUnder(proc.pid, 8000)
      proc.send({ leave: true })
      await new Promise<void>(done => { const timer = setTimeout(done, 5000); proc.once('exit', () => { clearTimeout(timer); done() }) })
      const gone = seen === null ? -1 : await goneWithin(seen.child.pid, 3000)
      check('control: an orderly exit in mid-statement leaves no query child (holds on the parent)', seen !== null && gone !== -1, seen === null ? unseen() : `child ${seen.child.pid} still runs`)
      end(proc.pid)
      if (seen !== null && gone === -1) end(seen.child.pid)
    }
    if (process.platform === 'win32') console.log('  [SKIP] a stopped Mercury: this platform has no signal that stops a process without ending it')
    else {
      const proc = owner('endless', { MERCURY_SQLITE_QUERY_BOUND_MS: '3000' })
      const started = await told(proc, 'started', 20_000)
      const seen = started === null || proc.pid === undefined ? null : await queryChildUnder(proc.pid, 2000)
      await sleep(1000)
      if (proc.pid !== undefined) { try { process.kill(proc.pid, 'SIGSTOP') } catch {} }
      const gone = seen === null ? -1 : await goneWithin(seen.child.pid, 12_000)
      check('a Mercury that is stopped in mid-statement, neither ended nor able to end its child, cannot keep the statement past its bound: the child ends itself (RED on the parent)', seen !== null && gone !== -1, seen === null ? unseen() : `child ${seen.child.pid} still runs twelve seconds after its owner was stopped, under a bound of three`)
      if (proc.pid !== undefined) { try { process.kill(proc.pid, 'SIGCONT') } catch {} }
      end(proc.pid)
      if (seen !== null && gone === -1) end(seen.child.pid)
    }

    console.log('\nS2 the built bundle on its release Node: a one-shot run ended hard while its statement runs')
    const { startFixtureApi } = (await import(join(tree, 'scripts/lib/fixtureApi.ts'))) as { startFixtureApi: (script: unknown[]) => Promise<{ url: string; close: () => Promise<void> }> }
    const { seedFirstRun } = (await import(join(tree, 'scripts/lib/firstRunSeed.ts'))) as { seedFirstRun: (home: string, trusted: string[]) => void }
    process.env.ANTHROPIC_API_KEY = 'fixture-key-000'
    seedFirstRun(config, [project])
    const fixture = await startFixtureApi([
      { kind: 'tool_use', name: 'Read', input: { file_path: `${file}#read?sql=${ENDLESS}` } },
      { kind: 'text', text: 'Counted.' },
    ])
    try {
      const platformEnv: Record<string, string> = process.platform === 'win32'
        ? { PATH: process.env.PATH ?? '', ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}), ...(process.env.WINDIR ? { WINDIR: process.env.WINDIR } : {}) }
        : { PATH: `/usr/bin:/bin:${dirname(node)}` }
      const run = spawn(node, [dist, 'run', '--model', 'claude-opus-4-8', '--format', 'json', 'Count without an end.'], { cwd: project, env: { ...platformEnv, HOME: home, USERPROFILE: home, TERM: 'dumb', MERCURY_CONFIG_DIR: config, MERCURY_TMPDIR: join(config, 'tmp'), MERCURY_DAEMON_DIR: join(home, 'daemon'), MERCURY_LOCAL_PROBE_TARGETS: 'none', MERCURY_CREDENTIAL_STORE: 'file', ANTHROPIC_API_KEY: 'fixture-key-000', ANTHROPIC_BASE_URL: fixture.url }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
      let printed = ''
      run.once('error', cause => cannotStart(node, cause))
      run.stdout?.on('data', chunk => { printed = (printed + String(chunk)).slice(-2000) })
      run.stderr?.on('data', chunk => { printed = (printed + String(chunk)).slice(-2000) })
      const seen = run.pid === undefined ? null : await queryChildUnder(run.pid, 60_000)
      if (seen !== null) end(seen.child.ppid)
      const gone = seen === null ? -1 : await goneWithin(seen.child.pid, 3000)
      check('the run’s process ended hard in mid-statement leaves no query child (RED on the parent)', seen !== null && gone !== -1, seen === null ? `no query child was seen under the run: ${printed.slice(-600)}` : `child ${seen.child.pid} still runs three seconds after pid ${seen.child.ppid} was ended`)
      if (seen !== null && gone === -1) end(seen.child.pid)
      end(run.pid)
      for (const row of seen?.family ?? []) if (row.pid !== seen!.child.pid) end(row.pid)
      await new Promise<void>(done => { const timer = setTimeout(done, 5000); run.once('close', () => { clearTimeout(timer); done() }) })
    } finally { await fixture.close() }
  }
  rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  console.log(`\n${passed + failed} checks, ${failed} failures`)
  console.log(failed === 0 ? 'prove-sqlite-query-owner-gone: ALL HOLD' : `prove-sqlite-query-owner-gone: ${failed} FAILURE(S)`)
  process.exitCode = failed === 0 ? 0 : 1
}
