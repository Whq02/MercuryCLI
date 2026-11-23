import { spawn, spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { cannotStart, mustStart } from './readViewMcp.js'

const script = fileURLToPath(import.meta.url)
const given = process.env.READ_BUILT_PROOF_HOME
if (!given) {
  const base = process.env.RP_SCRATCH ?? process.env.MERCURY_TMPDIR ?? process.env.MERCURY_CONFIG_DIR
  if (!base) throw new Error('The proof needs its scratch root')
  const home = realpathSync(mkdtempSync(join(base, 'json-built-')))
  try {
    const run = spawnSync(process.execPath, [script], { stdio: 'inherit', timeout: 90000, killSignal: 'SIGKILL', env: { ...process.env, HOME: home, USERPROFILE: home, READ_BUILT_PROOF_HOME: home, MERCURY_CONFIG_DIR: join(home, '.mercury') } })
    process.exitCode = run.status ?? 1
  } finally { rmSync(home, { recursive: true, force: true }) }
} else {
  if (homedir() !== given) throw new Error('The runtime did not take the proof home')
  const root = resolve(dirname(script), '../..')
  const dist = process.env.PROVE_DIST ?? join(root, 'dist')
  mustStart(join(dist, 'vendor/node', process.platform === 'win32' ? 'node.exe' : 'bin/node'))
  const payload = join(given, 'payload')
  const project = join(given, 'project')
  const config = join(given, '.mercury')
  const emptyPath = join(given, 'empty-bin')
  for (const folder of [payload, project, config, emptyPath, join(config, 'tmp')]) mkdirSync(folder, { recursive: true })
  cpSync(join(dist, 'mercury.mjs'), join(payload, 'mercury.mjs'))
  cpSync(join(dist, 'manifest.json'), join(payload, 'manifest.json'))
  cpSync(join(dist, 'vendor/node'), join(payload, 'vendor/node'), { recursive: true })
  cpSync(join(dist, 'vendor/json-query'), join(payload, 'vendor/json-query'), { recursive: true })
  const source = join(project, 'records.jsonl')
  writeFileSync(source, '{"n":1}\n{"n":9007199254740993123456789}\n{"n":3}\n')
  const { startFixtureApi } = await import('../lib/fixtureApi.ts')
  const { seedFirstRun } = await import('../lib/firstRunSeed.ts')
  process.env.ANTHROPIC_API_KEY = 'fixture-key-000'
  process.env.PATH = emptyPath
  seedFirstRun(config, [project])
  const fixture = await startFixtureApi([
    { kind: 'tool_use', name: 'Read', input: { file_path: `${source}#read?limit=2&compact=1&q=select(.n > 1) | {n}` } },
    { kind: 'text', text: 'The selected records are returned.' },
  ])
  const node = join(payload, 'vendor/node', process.platform === 'win32' ? 'node.exe' : 'bin/node')
  const env = { PATH: emptyPath, HOME: given, USERPROFILE: given, TERM: 'dumb', MERCURY_CONFIG_DIR: config, MERCURY_TMPDIR: join(config, 'tmp'), MERCURY_DAEMON_DIR: join(given, 'daemon'), MERCURY_LOCAL_PROBE_TARGETS: 'none', MERCURY_CREDENTIAL_STORE: 'file', ANTHROPIC_API_KEY: 'fixture-key-000', ANTHROPIC_BASE_URL: fixture.url, ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}), ...(process.env.WINDIR ? { WINDIR: process.env.WINDIR } : {}) }
  let passed = 0, failed = 0
  const check = (name: string, ok: boolean, detail = '') => { ok ? passed++ : failed++; console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}${ok ? '' : ` ${detail.slice(0, 1000)}`}`) }
  try {
    check('the isolated payload has no repository or node_modules', !existsSync(join(payload, '.git')) && !existsSync(join(payload, 'node_modules')), 'The payload copy must carry only mercury.mjs, manifest.json, vendor/node and vendor/json-query; look at the cpSync lines above in this proof')
    const jq = spawnSync('jq', ['--version'], { env, encoding: 'utf8' })
    check('there is no jq on the product process PATH', (jq.error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT', 'jq was found on the emptied PATH; the proof must run with PATH set to the empty-bin folder so the Read query uses only the shipped vendor/json-query engine')
    const child = spawn(node, [join(payload, 'mercury.mjs'), 'run', '--model', 'claude-opus-4-8', '--format', 'json', 'Query the JSONL records.'], { cwd: project, env, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = '', stderr = ''
    child.once('error', cause => cannotStart(node, cause))
    child.stdout.on('data', chunk => { stdout += String(chunk) })
    child.stderr.on('data', chunk => { stderr += String(chunk) })
    const code = await new Promise<number | null>(resolve => {
      const timer = setTimeout(() => child.kill('SIGKILL'), 60000)
      child.once('close', code => { clearTimeout(timer); resolve(code) })
    })
    const requests = fixture.messageRequests()
    const second = requests[1]?.body as { messages?: Array<{ content?: unknown }> } | undefined
    const results = (second?.messages ?? []).flatMap(message => Array.isArray(message.content) ? message.content : []).filter((block: any) => block.type === 'tool_result') as Array<{ content: unknown; is_error?: boolean }>
    const body = results.map(result => typeof result.content === 'string' ? result.content : JSON.stringify(result.content)).join('\n')
    check('release Node completes the Read query through the real tool loop', code === 0 && requests.length >= 2 && results.some(result => !result.is_error), `The built dist run did not return a successful Read tool_result; read the output below, then check readJson in src/tools/read/readJson.ts and rebuild with bun run build.ts. ${code} ${stderr} ${stdout}`)
    check('the installed engine preserves the large number and correct projection', body.includes('{"n":9007199254740993123456789}') && body.includes('{"n":3}'), `The query result lost the large number or the projection; check readJson in src/tools/read/readJson.ts and the engine under vendor/json-query. ${body}`)
    check('the built query is explicitly generated output without a source anchor', body.includes("A query's result, not the file's bytes") && !body.includes('(anchor:'), `The result must carry the PROVENANCE sentence and no edit anchor; check PROVENANCE and readJson in src/tools/read/readJson.ts. ${body}`)
    check('the shipped worker gives the same source-line bracket', body.includes('[source lines of values 1-2, in order (- = no single line): 2, 3]'), `The shipped worker must print the source-line bracket from originLine in readJson in src/tools/read/readJson.ts; rebuild dist/vendor/json-query if it is stale. ${body}`)
    const endless = await startFixtureApi([
      { kind: 'tool_use', name: 'Read', input: { file_path: `${source}#read?q=last(range(1e11))` } },
      { kind: 'tool_use', name: 'Read', input: { file_path: `${source}#read?limit=2&q=range(1e12)` } },
      { kind: 'text', text: 'The run went on.' },
    ])
    try {
      const bounded = spawn(node, [join(payload, 'mercury.mjs'), 'run', '--model', 'claude-opus-4-8', '--format', 'json', 'Query without an end.'], { cwd: project, env: { ...env, ANTHROPIC_BASE_URL: endless.url, MERCURY_JSON_QUERY_BOUND_MS: '1500' }, stdio: ['ignore', 'pipe', 'pipe'] })
      let boundedOut = ''
      bounded.once('error', cause => cannotStart(node, cause))
      bounded.stdout.on('data', chunk => { boundedOut += String(chunk) })
      bounded.stderr.on('data', chunk => { boundedOut += String(chunk) })
      const boundedCode = await new Promise<number | null>(resolve => {
        const timer = setTimeout(() => bounded.kill('SIGKILL'), 60000)
        bounded.once('close', code => { clearTimeout(timer); resolve(code) })
      })
      const last = endless.messageRequests().at(-1)?.body as { messages?: Array<{ content?: unknown }> } | undefined
      const answers = (last?.messages ?? []).flatMap(message => Array.isArray(message.content) ? message.content : []).filter((block: any) => block.type === 'tool_result').map((block: any) => ({ error: block.is_error === true, text: typeof block.content === 'string' ? block.content : JSON.stringify(block.content) }))
      check('a query that does not end is ended at the bound with a sentence that names it', answers.length === 2 && answers[0]!.error && answers[0]!.text.includes('The query did not finish within 0.025 minutes and was ended. Narrow the filter, or run jq in Bash with a timeout of its own.'), `The endless query must end at the bound with that sentence; check the bound and the timeout error in runJsonQuery in src/tools/read/jsonQueryRuntime.ts (MERCURY_JSON_QUERY_BOUND_MS). ${boundedCode} ${boundedOut} ${JSON.stringify(answers)}`)
      check('the bound ends the tool call and not the run, and a query that pages is untouched', boundedCode === 0 && answers.length === 2 && !answers[1]!.error && answers[1]!.text.includes('\n0\n1\n') && answers[1]!.text.includes('state: page'), `The bound must end only the tool call, not the run, and the paged query must still answer; check runJsonQuery in src/tools/read/jsonQueryRuntime.ts and readJson in src/tools/read/readJson.ts. ${boundedCode} ${JSON.stringify(answers)}`)
      const processes = process.platform === 'win32' ? '' : (spawnSync('/bin/ps', ['-axo', 'command='], { encoding: 'utf8' }).stdout ?? '')
      const folders = readdirSync(join(config, 'tmp'), { recursive: true }).map(String).filter(name => /json-queries[\\/]read-/.test(name))
      check('the ended query leaves no child process and no private folder', !processes.split('\n').some(line => line.includes(payload) && line.includes('jsonQueryProcess')) && folders.length === 0, `A query child or a json-queries/read- folder outlived the ended query; check the kill and cleanup in runJsonQuery in src/tools/read/jsonQueryRuntime.ts. ${folders.join(' ')}`)
    } finally { await endless.close() }
    console.log(`${passed}/${passed + failed} checks`)
    process.exitCode = failed ? 1 : 0
  } finally { await fixture.close() }
}
