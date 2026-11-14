#!/usr/bin/env bun
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { handoffTurn, isHandoffRequest, startFixtureApi, type ScriptedTurn } from '../lib/fixtureApi.ts'
import { FIXTURE_API_KEY, seedFirstRun } from '../lib/firstRunSeed.ts'

const at = process.argv.indexOf('--dist')
const dist = resolve(at < 0 ? join(import.meta.dir, '../../dist/mercury.mjs') : process.argv[at + 1]!)
if (!existsSync(dist)) { console.error(`FAIL run bundle exists: ${dist}`); process.exit(1) }
const node = Bun.which('node') ?? 'node'

let failures = 0
let checks = 0
const check = (label: string, ok: boolean, detail = ''): void => { checks++; console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${ok || !detail ? '' : `: ${detail.slice(0, 900)}`}`); if (!ok) failures++ }

const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'run-reads-other-tools-')))
type World = { home: string; cwd: string; env: Record<string, string> }
function world(name: string, files: Record<string, string>, options: { untrusted?: boolean; settings?: object; env?: Record<string, string> } = {}): World {
  const home = join(scratch, name, 'home')
  const cwd = join(scratch, name, 'project')
  mkdirSync(join(home, 'tmp'), { recursive: true })
  mkdirSync(cwd, { recursive: true })
  seedFirstRun(home, options.untrusted ? [] : [cwd])
  if (options.settings) writeFileSync(join(home, 'settings.json'), JSON.stringify(options.settings))
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(dirname(join(cwd, file)), { recursive: true })
    writeFileSync(join(cwd, file), text)
  }
  return { home, cwd, env: { HOME: home, PATH: process.env.PATH ?? '', TERM: 'dumb', TMPDIR: join(home, 'tmp'), MERCURY_TMPDIR: join(home, 'tmp'), MERCURY_CONFIG_DIR: home, MERCURY_CREDENTIAL_STORE: 'file', MERCURY_LOCAL_PROBE_TARGETS: 'none', MERCURY_DAEMON_DIR: join(home, 'daemon'), ANTHROPIC_API_KEY: FIXTURE_API_KEY, ...options.env } }
}

type Ran = { code: number | null; stderr: string; asks: string[] }
async function run(w: World, turns: ScriptedTurn[]): Promise<Ran> {
  const seen = spawnSync(node, ['-e', "process.stdout.write(require('node:os').homedir())"], { env: w.env, encoding: 'utf8' }).stdout
  if (seen !== w.home) throw new Error(`the home folder of the run is ${seen}, not the scratch home of this proof`)
  const api = await startFixtureApi([...turns, handoffTurn(), handoffTurn()])
  try {
    const child = spawn(node, [dist, 'run', 'go on', '--model', 'claude-opus-4-8'], { cwd: w.cwd, env: { ...w.env, ANTHROPIC_BASE_URL: api.url }, stdio: ['ignore', 'pipe', 'pipe'] })
    let stderr = ''
    child.stdout.on('data', () => {})
    child.stderr.on('data', chunk => (stderr += String(chunk)))
    const guard = setTimeout(() => child.kill('SIGKILL'), 120_000)
    const code = await new Promise<number | null>(done => child.on('close', exit => { clearTimeout(guard); done(exit) }))
    const asks = api.requests.filter(request => request.path.includes('/v1/messages') && !request.path.includes('count_tokens') && !isHandoffRequest(request)).map(request => JSON.stringify(request.body))
    return { code, stderr, asks }
  } finally {
    await api.close()
  }
}

const esc = (text: string): string => JSON.stringify(text).slice(1, -1)
const times = (text: string, needle: string): number => text.split(needle).length - 1
const read = (w: World, file: string): ScriptedTurn => ({ kind: 'tool_use', name: 'Read', input: { file_path: join(w.cwd, file) } })
const done: ScriptedTurn = { kind: 'text', text: 'done' }
const contents = (w: World, file: string, body: string): string => esc(`Contents of ${join(w.cwd, file)} (project instructions, checked into the codebase):\n\n${body}`)
const governs = (w: World, file: string, patterns: string): string => esc(`Instruction file ${join(w.cwd, file)} (it governs files matching ${patterns}):`)
const offered = (w: World, file: string, description: string): string => esc(`Rule files offered by description (not loaded; Read one when its description fits the work):\n- ${join(w.cwd, file)}: ${description}`)

const PROJECT = {
  'AGENTS.md': 'agents-needle\n',
  'GEMINI.md': 'gemini-needle\n',
  '.github/copilot-instructions.md': 'copilot-needle\n',
  '.github/instructions/py.instructions.md': '---\napplyTo: "**/*.py"\n---\npython-needle\n',
  '.cursor/rules/always.mdc': '---\nalwaysApply: true\n---\ncursor-always-needle\n',
  '.cursor/rules/example.mdc': '---\nglobs: src/**/*.ts\nalwaysApply: false\n---\ntypescript-needle\n',
  '.cursor/rules/migrations.mdc': '---\ndescription: How to write a database migration\nalwaysApply: false\n---\noffered-body-needle\n',
  '.cursor/rules/manual.mdc': '---\nalwaysApply: false\n---\nmanual-needle\n',
  '.windsurf/rules/docs.md': '---\ntrigger: glob\nglobs: docs/**\n---\ndocs-needle\n',
  '.clinerules': 'cline-needle\n',
  'src/app/main.ts': 'export const a = 1\n',
  'README.md': 'readme-text\n',
}
const ALWAYS = ['agents-needle', 'gemini-needle', 'copilot-needle', 'cursor-always-needle', 'cline-needle']
const LATER = ['typescript-needle', 'python-needle', 'docs-needle', 'offered-body-needle', 'manual-needle']
const absent = (text: string, needles: string[]): boolean => needles.every(needle => !text.includes(needle))
const present = (text: string, needles: string[]): string => needles.filter(needle => text.includes(needle)).join(', ')

try {
  console.log('§1 a trusted project where other tools left their files and no MERCURY.md stands')
  {
    const w = world('others', PROJECT)
    const ran = await run(w, [read(w, 'README.md'), read(w, 'src/app/missing.ts'), read(w, 'src/app/main.ts'), done])
    const [first = '', second = '', failed = '', third = ''] = ran.asks
    check('the run completed in four requests', ran.code === 0 && ran.asks.length === 4, `exit ${ran.code}, ${ran.asks.length} request(s) ${ran.stderr.slice(-300)}`)
    check('the first request carries every guide and every rule that always applies, each once', ALWAYS.every(needle => times(first, needle) === 1), ALWAYS.map(needle => `${needle} ${times(first, needle)}`).join(', '))
    check('a guide of another tool is told in the form a project guide has', first.includes(contents(w, 'GEMINI.md', 'gemini-needle')), first.slice(first.indexOf('gemini-needle') - 200, first.indexOf('gemini-needle') + 40))
    check('a rule offered by description is one line naming its file and its description', first.includes(offered(w, '.cursor/rules/migrations.mdc', 'How to write a database migration')), first.slice(first.indexOf('Rule files offered') - 40, first.indexOf('Rule files offered') + 300))
    check('the first request carries no scoped rule, no offered body and no manual rule', absent(first, LATER), present(first, LATER))
    check('after a file no rule governs is read, the next request still carries none', second.includes('readme-text') && absent(second, LATER), present(second, LATER))
    check('a read that failed, of a path the rule would govern, puts nothing in play: the next request carries no rule', failed.includes('missing.ts') && absent(failed, LATER), present(failed, LATER))
    check('after a matching file is read, the next request carries its rule once, saying what it governs', times(third, 'typescript-needle') === 1 && third.includes(governs(w, '.cursor/rules/example.mdc', 'src/**/*.ts')), `${times(third, 'typescript-needle')} time(s)`)
    check('the rules of the other scopes are still not sent', absent(third, ['python-needle', 'docs-needle', 'offered-body-needle', 'manual-needle']), present(third, LATER))
  }

  console.log('\n§2 the same project with a MERCURY.md: it decides')
  {
    const w = world('decided', { ...PROJECT, 'MERCURY.md': 'native-needle\n' })
    const ran = await run(w, [read(w, 'src/app/main.ts'), done])
    const all = ran.asks.join('\n')
    check('the run completed in two requests', ran.code === 0 && ran.asks.length === 2, `exit ${ran.code}, ${ran.asks.length} request(s) ${ran.stderr.slice(-300)}`)
    check('the first request carries MERCURY.md once', times(ran.asks[0] ?? '', 'native-needle') === 1)
    check('no file of another tool reaches any request, at the start or when a matching file is read', absent(all, [...ALWAYS, ...LATER]) && !all.includes('Rule files offered by description'), present(all, [...ALWAYS, ...LATER]))
  }

  console.log('\n§3 a MERCURY.md that imports a guide and a rules folder')
  {
    const w = world('imported', { ...PROJECT, 'MERCURY.md': '@GEMINI.md\n@.cursor/rules\nnative-needle\n' })
    const ran = await run(w, [read(w, 'src/app/main.ts'), done])
    const [first = '', second = ''] = ran.asks
    check('the run completed in two requests', ran.code === 0 && ran.asks.length === 2, `exit ${ran.code}, ${ran.asks.length} request(s) ${ran.stderr.slice(-300)}`)
    check('the first request carries MERCURY.md, the imported guide and the always rule of the imported folder, each once', ['native-needle', 'gemini-needle', 'cursor-always-needle'].every(needle => times(first, needle) === 1), ['native-needle', 'gemini-needle', 'cursor-always-needle'].map(needle => `${needle} ${times(first, needle)}`).join(', '))
    check('the offered rule of the imported folder stays one line', first.includes(offered(w, '.cursor/rules/migrations.mdc', 'How to write a database migration')) && !first.includes('offered-body-needle'))
    check('what MERCURY.md does not import stays out', absent(first, ['agents-needle', 'copilot-needle', 'cline-needle']), present(first, ['agents-needle', 'copilot-needle', 'cline-needle']))
    check('the scoped rule of the imported folder keeps its scope: absent at the start, attached once on a matching file', absent(first, ['typescript-needle']) && times(second, 'typescript-needle') === 1 && second.includes(governs(w, '.cursor/rules/example.mdc', 'src/**/*.ts')), `${times(first, 'typescript-needle')} then ${times(second, 'typescript-needle')}`)
    check('nothing outside the imports attaches', absent(second, ['python-needle', 'docs-needle', 'manual-needle', 'offered-body-needle']), present(second, LATER))
  }

  console.log('\n§4 the native profile and a folder never trusted')
  {
    const native = world('native', PROJECT, { settings: { briefs: { profile: 'native' } } })
    const ran = await run(native, [read(native, 'src/app/main.ts'), done])
    const all = ran.asks.join('\n')
    check('under the native profile the run completes and no file of another tool reaches a request', ran.code === 0 && ran.asks.length === 2 && absent(all, [...ALWAYS, ...LATER]) && !all.includes('Rule files offered by description'), `exit ${ran.code}, ${ran.asks.length} request(s): ${present(all, [...ALWAYS, ...LATER])}`)
    const untrusted = world('untrusted', PROJECT, { untrusted: true })
    const cold = await run(untrusted, [done])
    const sent = cold.asks.join('\n')
    check('in a folder never trusted a headless run sends its request with none of them', cold.asks.length >= 1 && absent(sent, [...ALWAYS, ...LATER]) && !sent.includes('Rule files offered by description'), `exit ${cold.code}, ${cold.asks.length} request(s): ${present(sent, [...ALWAYS, ...LATER])} ${cold.stderr.slice(-300)}`)
  }

  console.log('\n§5 hidden characters in the files of other tools are told as they are for AGENTS.md')
  {
    const w = world('hidden', { 'GEMINI.md': 'Keep it\u200B short\n', '.cursorrules': 'A plain\u202E rule\n', 'README.md': 'readme-text\n' })
    const ran = await run(w, [done])
    const lines = ran.stderr.split('\n').filter(line => line.includes('hidden character'))
    const said = (file: string, words: RegExp): boolean => lines.some(line => line.includes(`${file} carries`) && words.test(line))
    const shown = lines.map(line => line.replaceAll(w.cwd, '<folder>')).join(' | ')
    check('the guide is named on stderr with the line, the column and the class', said('GEMINI.md', /line 1, column 8: an invisible character \(U\+200B\)/), shown)
    check('the rule file that stands alone is named with its direction override', said('.cursorrules', /line 1, column 8: a direction override \(U\+202E\)/), shown)
    check('each is said once and each line says the file was loaded as written', lines.length === 2 && lines.every(line => line.includes('loaded as written, nothing changed')), `${lines.length} line(s): ${shown}`)
    check('the model is sent each file as written', ['Keep it\u200B short', 'A plain\u202E rule'].every(text => (ran.asks[0] ?? '').includes(text) || (ran.asks[0] ?? '').includes(esc(text)) || (ran.asks[0] ?? '').includes(esc(text).replace(/\\u[0-9A-Fa-f]{4}/g, code => code.toLowerCase()))), `${(ran.asks[0] ?? '').length} chars`)
  }

  console.log('\n§6 a crewmate is sent them as the lead is, and a file it reads attaches a rule to its own requests')
  {
    const w = world('crew', PROJECT)
    const CHILD = 'crew-child-ask: read the main file and say what it holds'
    const ran = await run(w, [
      { kind: 'tool_use', name: 'Crewmate', input: { description: 'the reader', prompt: CHILD } },
      read(w, 'src/app/main.ts'),
      { kind: 'text', text: 'child done' },
      done,
    ])
    const said = (words: string): string => JSON.stringify({ text: words }).slice(1, -1)
    const lead = ran.asks.filter(ask => ask.includes(said('go on')))
    const crew = ran.asks.filter(ask => !ask.includes(said('go on')) && ask.includes('crew-child-ask'))
    check('the run completed, the lead asking twice and the crewmate twice', ran.code === 0 && lead.length === 2 && crew.length === 2, `exit ${ran.code}, lead ${lead.length}, crewmate ${crew.length}, of ${ran.asks.length} ${ran.stderr.slice(-300)}`)
    const [first = '', second = ''] = crew
    check("the crewmate's first request carries each guide and always rule exactly as often as it carries AGENTS.md, once", ALWAYS.every(needle => times(first, needle) === 1), ALWAYS.map(needle => `${needle} ${times(first, needle)}`).join(', '))
    check('and the offered rule as its one line, with no scoped rule', first.includes(offered(w, '.cursor/rules/migrations.mdc', 'How to write a database migration')) && absent(first, LATER), present(first, LATER))
    check('after the crewmate read a matching file its next request carries the rule once', times(second, 'typescript-needle') === 1 && second.includes(governs(w, '.cursor/rules/example.mdc', 'src/**/*.ts')), `${times(second, 'typescript-needle')} time(s)`)
    check("the lead's own next request does not carry what its crewmate attached", lead.length === 2 && !lead[1]!.includes(governs(w, '.cursor/rules/example.mdc', 'src/**/*.ts')), String(lead.length))
  }

  console.log('\n§7 the folders the Copilot variable names')
  {
    const named = join(scratch, 'named-folder')
    mkdirSync(join(named, '.github', 'instructions'), { recursive: true })
    writeFileSync(join(named, 'AGENTS.md'), 'named-agents-needle\n')
    writeFileSync(join(named, '.github', 'instructions', 'ts.instructions.md'), '---\napplyTo: "src/**/*.ts"\n---\nnamed-scoped-needle\n')
    const env = { COPILOT_CUSTOM_INSTRUCTIONS_DIRS: named }
    const w = world('named', PROJECT, { env })
    const ran = await run(w, [read(w, 'src/app/main.ts'), done])
    const [first = '', second = ''] = ran.asks
    check('the run completed in two requests', ran.code === 0 && ran.asks.length === 2, `exit ${ran.code}, ${ran.asks.length} request(s) ${ran.stderr.slice(-300)}`)
    check("the first request carries the named folder's guide once, as the user's own, before the project's files", times(first, 'named-agents-needle') === 1 && first.includes(esc(`Contents of ${join(named, 'AGENTS.md')} (user's private global instructions for all projects):`)) && first.indexOf('named-agents-needle') >= 0 && first.indexOf('named-agents-needle') < first.indexOf('agents-needle\\n\\nContents'), `${times(first, 'named-agents-needle')} time(s)`)
    check('its scoped rule is absent at the start and attached once when a matching file is read', !first.includes('named-scoped-needle') && times(second, 'named-scoped-needle') === 1, `${times(first, 'named-scoped-needle')} then ${times(second, 'named-scoped-needle')}`)
    const decided = world('named-decided', { ...PROJECT, 'MERCURY.md': 'native-needle\n' }, { env })
    const under = await run(decided, [read(decided, 'src/app/main.ts'), done])
    check('under a MERCURY.md nothing of the named folder reaches any request', under.code === 0 && under.asks.length === 2 && absent(under.asks.join('\n'), ['named-agents-needle', 'named-scoped-needle']), present(under.asks.join('\n'), ['named-agents-needle', 'named-scoped-needle']))
    const bare = world('named-unset', { 'README.md': 'readme-text\n' })
    const empty = world('named-empty', { 'README.md': 'readme-text\n' }, { env: { COPILOT_CUSTOM_INSTRUCTIONS_DIRS: ' , ' } })
    const plain = (text: string, w: World): string => text.replaceAll(w.cwd, '<project>').replaceAll(w.home, '<home>').replaceAll(w.cwd.replace(/[^A-Za-z0-9]/g, '-'), '<slug>').replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, '<uuid>')
    const unsetAsk = (await run(bare, [done])).asks[0] ?? ''
    const emptyAsk = (await run(empty, [done])).asks[0] ?? 'none'
    check('an empty list sends the request an unset variable sends, byte for byte once the scratch folder is taken out', plain(unsetAsk, bare) === plain(emptyAsk, empty), `${plain(unsetAsk, bare).length} against ${plain(emptyAsk, empty).length} chars`)
  }
} finally {
  rmSync(scratch, { recursive: true, force: true })
}
console.log(`\n${failures ? 'FAIL' : 'PASS'} run-reads-other-tools-files: ${checks} checks, ${failures} failed`)
process.exit(failures ? 1 : 0)
