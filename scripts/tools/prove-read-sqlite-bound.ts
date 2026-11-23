import { Database } from 'bun:sqlite'
import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { isolatedHome, readViewKit } from './readViewKit.js'
import { cannotStart, mustStart } from './readViewMcp.js'

const home = isolatedHome(import.meta.filename)
const kit = await readViewKit(home)
const root = join(import.meta.dir, '../..')
const dist = process.env.MERCURY_PROOF_DIST ?? join(root, 'dist/mercury.mjs')
const node = mustStart(join(dirname(dist), 'vendor/node', process.platform === 'win32' ? 'node.exe' : 'bin/node'))
const { startFixtureApi } = await import(join(root, 'scripts/lib/fixtureApi.ts'))
const { seedFirstRun } = await import(join(root, 'scripts/lib/firstRunSeed.ts'))
const project = join(home, 'project'), config = join(home, '.mercury')
mkdirSync(join(project, 'plain'), { recursive: true })
mkdirSync(join(project, 'logged'))
mkdirSync(join(config, 'tmp'), { recursive: true })
process.env.ANTHROPIC_API_KEY = 'fixture-key-000'
seedFirstRun(config, [project])
const plain = join(project, 'plain', 'rows.sqlite'), logged = join(project, 'logged', 'rows.sqlite')
const seed = new Database(plain)
seed.run("CREATE TABLE items(id INTEGER PRIMARY KEY, value TEXT); INSERT INTO items VALUES(1,'one'),(2,'two')")
seed.close()
const writer = new Database(logged)
writer.run("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE items(id INTEGER PRIMARY KEY, value TEXT); INSERT INTO items VALUES(1,'one'),(2,'in the log')")
const digest = (file: string): string => existsSync(file) ? createHash('sha256').update(readFileSync(file)).digest('hex') : 'absent'
const state = (file: string): string => JSON.stringify([readdirSync(dirname(file)).sort(), digest(file), digest(`${file}-wal`), existsSync(`${file}-shm`) ? statSync(`${file}-shm`).size : 'absent'])
const ENDLESS = 'WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM c) SELECT count(*) FROM c'
const children = (): number => process.platform === 'win32' ? 0 : spawnSync('/bin/ps', ['-axo', 'command='], { encoding: 'utf8' }).stdout.split('\n').filter(line => line.includes('--input-type=module') && line.includes('sqliteQueryChild')).length
const idle = children()
const before = { plain: state(plain), logged: state(logged) }
const fixture = await startFixtureApi([
  { kind: 'tool_use', name: 'Read', input: { file_path: `${plain}#read?sql=${ENDLESS}` } },
  { kind: 'tool_use', name: 'Read', input: { file_path: `${logged}#read?sql=${ENDLESS}` } },
  { kind: 'tool_use', name: 'Read', input: { file_path: `${plain}#read?limit=2&sql=WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM c) SELECT x FROM c` } },
  { kind: 'tool_use', name: 'Read', input: { file_path: `${logged}#read?sql=SELECT value FROM items ORDER BY id` } },
  { kind: 'text', text: 'The run went on.' },
])
try {
  const started = Date.now()
  const run = spawn(node, [dist, 'run', '--model', 'claude-opus-4-8', '--format', 'json', 'Count without an end.'], { cwd: project, env: { PATH: `/usr/bin:/bin:${dirname(node)}`, HOME: home, USERPROFILE: home, TERM: 'dumb', MERCURY_CONFIG_DIR: config, MERCURY_TMPDIR: join(config, 'tmp'), MERCURY_DAEMON_DIR: join(home, 'daemon'), MERCURY_LOCAL_PROBE_TARGETS: 'none', MERCURY_CREDENTIAL_STORE: 'file', ANTHROPIC_API_KEY: 'fixture-key-000', ANTHROPIC_BASE_URL: fixture.url, MERCURY_SQLITE_QUERY_BOUND_MS: '1500' }, stdio: ['ignore', 'pipe', 'pipe'] })
  let printed = ''
  run.once('error', cause => cannotStart(node, cause))
  run.stdout.on('data', chunk => { printed += String(chunk) })
  run.stderr.on('data', chunk => { printed += String(chunk) })
  const code = await new Promise<number | null>(resolve => {
    const timer = setTimeout(() => run.kill('SIGKILL'), 90000)
    run.once('close', status => { clearTimeout(timer); resolve(status) })
  })
  const last = fixture.messageRequests().at(-1)?.body as { messages?: Array<{ content?: unknown }> } | undefined
  const answers = (last?.messages ?? []).flatMap(message => Array.isArray(message.content) ? message.content : []).filter((block: { type?: string }) => block.type === 'tool_result').map((block: { is_error?: boolean; content?: unknown }) => ({ error: block.is_error === true, text: typeof block.content === 'string' ? block.content : JSON.stringify(block.content) }))
  const SENTENCE = 'The query did not finish within 0.025 minutes and was ended. Narrow the statement, or run sqlite3 in Bash with a timeout of its own.'
  kit.check('a statement that never ends is ended at the bound in a one-shot run with no time limit of its own', answers.length === 4 && answers[0]!.error && answers[0]!.text.includes(SENTENCE), `${code} ${printed.slice(-400)} ${JSON.stringify(answers).slice(0, 900)} | runSqliteQuery in src/tools/read/sqliteQueryProcess.ts must kill the query child after the bound (MERCURY_SQLITE_QUERY_BOUND_MS) and reject with the Narrow the statement sentence`)
  kit.check('the same on a database another connection holds open', answers.length === 4 && answers[1]!.error && answers[1]!.text.includes(SENTENCE), `${JSON.stringify(answers[1])} | the logged (WAL) database goes through the same bound in runSqliteQuery in src/tools/read/sqliteQueryProcess.ts; sqliteQuery.ts hands it a private snapshot copy when a log exists with no -shm`)
  kit.check('the bound ends the tool call and not the run, and a statement that pages returns at its page as before', code === 0 && answers.length === 4 && !answers[2]!.error && answers[2]!.text.includes('results: 1-2 · state: page') && answers[2]!.text.includes('\n1\t[1]\n2\t[2]\n') && Date.now() - started < 60000, `${code} ${JSON.stringify(answers[2])} | the bound must end only the Read tool call, not the run, and a statement that pages must still return its page from runSqliteQuery in src/tools/read/sqliteQueryProcess.ts`)
  kit.check('the read after a bounded end is clean and sees the log', answers.length === 4 && !answers[3]!.error && answers[3]!.text.includes('1\t["one"]\n2\t["in the log"]'), `${JSON.stringify(answers[3])} | a Read after a bounded end must open the logged database cleanly and see the log; check the snapshot handling in src/tools/read/sqliteQuery.ts`)
  kit.check('no query child is left', children() === idle, `${children()} | the bound path in src/tools/read/sqliteQueryProcess.ts must kill and reap the query child (sqliteQueryChild); idle count was ${idle}`)
  kit.check('the rollback database and its folder are as they were: no journal, no new file', state(plain) === before.plain && !existsSync(`${plain}-journal`), `${before.plain} → ${state(plain)} | the query in src/tools/read/sqliteQuery.ts must open a rollback-journal database immutable and leave no -journal or other file beside it`)
  kit.check('the logged database, its log and its folder are as they were', state(logged) === before.logged, `${before.logged} → ${state(logged)} | the query in src/tools/read/sqliteQuery.ts must read a logged database through a copy and leave its -wal, -shm and folder untouched`)
  writer.run("INSERT INTO items VALUES(3,'written after')")
  const checkpoint = writer.query('PRAGMA wal_checkpoint(TRUNCATE)').get() as { busy: number }
  kit.check('the ended reader holds nothing: the other connection writes and checkpoints its whole log', checkpoint.busy === 0 && statSync(`${logged}-wal`).size === 0, `${JSON.stringify(checkpoint)} | the ended query must release every handle on the logged database; check how sqliteQueryProcess.ts and sqliteQuery.ts open and close it`)
  kit.check('nothing of the ended queries is left in the temp folder', !readdirSync(join(config, 'tmp'), { recursive: true }).map(String).some(name => /sqlite-views[\\/]snapshot-|query-results[\\/]result-/.test(name)), `${readdirSync(join(config, 'tmp'), { recursive: true }).map(String).join(' ')} | an ended query must delete its sqlite-views snapshot and query-results file; see the cleanup in src/tools/read/sqliteQuery.ts`)
} finally { await fixture.close(); writer.close() }
const cancelled = new AbortController()
kit.context.abortController = cancelled
const began = Date.now()
setTimeout(() => cancelled.abort(new Error('the reader cancelled')), 300)
const stopped = await kit.read(`${plain}#read?sql=${ENDLESS}`)
kit.check("the abort signal's own road is unchanged: its own reason, at once, no child", stopped.includes('the reader cancelled') && !stopped.includes('did not finish') && Date.now() - began < 2500 && children() === idle, `${stopped} ${Date.now() - began} | an abort must reject with the signal's own reason at once and leave no child; see the signal.aborted handling in src/tools/read/sqliteQueryProcess.ts`)
kit.finish()
