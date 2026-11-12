#!/usr/bin/env bun
process.env.NODE_ENV = 'test'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
import { mock } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RANKED_FIXTURE_DESCRIPTION, writeRankedFixture } from './rankedFixture.ts'

const world = realpathSync(mkdtempSync(join(existsSync('/private/tmp/mw') ? '/private/tmp/mw' : tmpdir(), 'grep-ranked-mode-')))
const HOME = join(world, 'home')
const project = join(world, 'project')
mkdirSync(join(HOME, 'tmp'), { recursive: true })
process.env.MERCURY_CONFIG_DIR = HOME
process.env.MERCURY_TMPDIR = join(HOME, 'tmp')
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_GREP_RANKED = '1'
delete process.env.MERCURY_HOME

let failures = 0
let checks = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  checks++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ' — ' + detail : ''}`)
  if (!cond) failures++
}

type Call = { args: string[]; target: string; cwd?: string; timeoutMs?: number }
const calls: Call[] = []
const ripgrep = { ...(await import('../../src/utils/ripgrep.ts')) }
mock.module('../../src/utils/ripgrep.js', () => ({
  ...ripgrep,
  ripGrepAnswer: async (args: string[], target: string, signal: AbortSignal, options: { cwd?: string; timeoutMs?: number } = {}) => {
    calls.push({ args, target, ...options })
    return ripgrep.ripGrepAnswer(args, target, signal, options)
  },
}))

const { GrepTool } = await import('../../src/tools/GrepTool/GrepTool.ts')
const { getEmptyToolPermissionContext } = await import('../../src/Tool.ts')
const { runWithCwdOverride } = await import('../../src/utils/cwd.ts')
const { decideToolPermission } = await import('../../src/utils/permissions/decision/engine.ts')
type Verdict = { behavior: string; message?: string; decisionReason?: unknown }
const decide = async (input: Record<string, unknown>, cwd: string): Promise<Verdict> => (await runWithCwdOverride(cwd, () => decideToolPermission(GrepTool, input, context(getEmptyToolPermissionContext())))).decision as Verdict
const validate = async (input: Record<string, unknown>): Promise<{ result: boolean; message?: string }> => (await GrepTool.validateInput!(input as never)) as { result: boolean; message?: string }
const { zodToJsonSchema } = await import('../../src/utils/zodToJsonSchema.ts')

const fixture = writeRankedFixture(project)
type Permission = ReturnType<typeof getEmptyToolPermissionContext>
type Data = { numFiles: number; filenames: string[]; ranked?: string; mode?: string; incomplete?: string; withheld?: string }
const open = getEmptyToolPermissionContext()
const context = (permission: Permission, abortController = new AbortController()) =>
  ({ abortController, getAppState: () => ({ toolPermissionContext: permission, tasks: {}, sessionHooks: new Map() }), setAppState: () => {}, readFileState: new Map(), messages: [], options: { tools: [] } }) as never
const call = async (input: Record<string, unknown>, permission: Permission = open, cwd = project): Promise<Data> =>
  ((await runWithCwdOverride(cwd, () => GrepTool.call({ pattern: RANKED_FIXTURE_DESCRIPTION, output_mode: 'ranked', ...input } as never, context(permission)))) as { data: Data }).data
const said = (data: Data): string => GrepTool.mapToolResultToToolResultBlockParam(data as never, 'id').content as string
const ask = async (input: Record<string, unknown>, permission: Permission = open, cwd = project): Promise<string> => said(await call(input, permission, cwd))
const named = (text: string): string[] => text.split('\n').slice(1).filter(line => /:\d/.test(line)).map(line => line.slice(0, line.indexOf(':')))
const deny = (...rules: string[]): Permission => ({ ...open, alwaysDenyRules: { session: rules } })
const fixedStringsOf = (args: string[]): string[] => args.flatMap((arg, index) => (arg === '-e' ? [args[index + 1]!] : []))
const counts = (pass: Call): boolean => pass.args.includes('-c')
const filesOf = (pass: Call): string[] => (counts(pass) ? [] : [...pass.args.slice(pass.args.indexOf('--') + 1), pass.target])

console.log('the mode, with the switch set: a description finds the implementing file through the tool')
{
  const schema = zodToJsonSchema(GrepTool.inputSchema) as { properties: { output_mode: { enum: string[]; description: string } } }
  check('the schema takes output_mode "ranked"', JSON.stringify(schema.properties.output_mode.enum) === '["content","files_with_matches","count","ranked"]' && GrepTool.inputSchema.safeParse({ pattern: 'x', output_mode: 'ranked' }).success, JSON.stringify(schema.properties.output_mode.enum))
  check(
    'its clause says what the mode reads and returns',
    schema.properties.output_mode.description.endsWith('"count" tallies matches per file; "ranked" reads pattern as plain words, not a regex, and returns the files and line ranges that hold them most densely — the mode for finding where a behaviour is implemented before its names are known.'),
    schema.properties.output_mode.description,
  )
  const description = await GrepTool.prompt({ tools: [] } as never)
  check(
    'the description gains one sentence',
    description ===
      'Searches file contents with ripgrep and returns the matching paths, lines or counts. PDFs and office, EPUB and RTF documents are searched as their extracted text, with page or section labels. With output_mode "ranked", pattern is plain words that describe a behaviour, and the answer is the few files and line ranges that hold those words most densely.',
    description,
  )
  const data = await call({})
  const text = said(data)
  const files = named(text)
  check('the implementing file is the first of the files named, eight at most', files[0] === 'src/net/uploadQueue.ts' && files.length <= 8, files.join(' | '))
  const range = /^src\/net\/uploadQueue\.ts:(\d+)-(\d+)/.exec(text.split('\n')[1] ?? '')
  check('with its line range, inside the function that retries', range !== null && Number(range[1]) >= fixture.signature && Number(range[2]) <= fixture.signature + 13 && Number(range[1]) <= fixture.failure && Number(range[2]) >= fixture.failure, text.split('\n')[1])
  check('the answer opens by saying it ranked by words, how many files hold each and how many it searched', /^Ranked by words, not by meaning: 8 of 14 files holding retry \(6 files\), fail \(12\), upload \(6\), among 43 searched\.$/.test(text.split('\n')[0]!), text.split('\n')[0])
  check('and closes by saying what a word ranking cannot find', text.endsWith('\nA file that says it in other words is not listed: add the names it may go by to pattern.'), text.split('\n').at(-1))
  check('what the screen is given: a count of files and their rows, as a files listing has them', data.mode === undefined && data.numFiles === 8 && data.filenames[0] === 'src/net/uploadQueue.ts:31-38, 8' && GrepTool.outputSchema!.safeParse(data).success, JSON.stringify(data.filenames))
  check('the same question gives the same bytes', (await ask({})) === text)
  check('the folder may be named: the answer is the same', (await ask({ path: project })) === text)
  check('type narrows it as it narrows Grep', named(await ask({ type: 'md' })).join('|') === 'docs/CHANGELOG.md')
  const underSrc = named(await ask({ glob: 'src/**' }))
  check('glob narrows it as it narrows Grep', underSrc[0] === 'src/net/uploadQueue.ts' && underSrc.every(file => file.startsWith('src/')), underSrc.join(' | '))
  check('one file may be the whole search', (await ask({ path: join(project, 'src/net/uploadQueue.ts') })).split('\n')[0] === 'Ranked by words, not by meaning: 1 of 1 file holding retry (1 file), fail (1), upload (1), among 1 searched.')
  const nothing = await ask({ pattern: 'transmit the document again once the connection drops' })
  check('nothing found is said with the files searched and the limit', nothing === 'No file among 43 searched holds transmit, docu, once, connection or drop. This ranks by words only: add the names the behaviour may go by.', nothing)
  const document = await validate({ pattern: 'retry', output_mode: 'ranked', path: 'manual.pdf' })
  check('a document is not ranked, and the answer says how to search it', document.result === false && document.message === 'output_mode "ranked" ranks text files, and manual.pdf is a document: search its text with a pattern in another mode.', JSON.stringify(document))
}

console.log('the words are data, never syntax')
{
  calls.length = 0
  const hostile = '--files -e --pre=sh $(reboot) `id` ;rm -rf / .* (a|b)+ \\d{3} [z-a'
  const text = await ask({ pattern: hostile })
  const words = ['file', 'pre', 'reboot']
  const counting = calls.filter(counts)
  check('a pattern of flags, shell and regex syntax is counted as its three words, one pass each', counting.length === 3 && /holding file \(\d+ files\), pre \(0\), reboot \(0\), among 43 searched\.$/.test(text.split('\n')[0]!), `${counting.length} ${text.split('\n')[0]}`)
  check(
    'every pass is fixed strings: -F, each word behind -e, letters and digits only, nothing of the pattern anywhere else',
    calls.length > 0 && calls.every(pass => pass.args.includes('-F') && !pass.args.includes('-P') && !pass.args.includes('--pcre2') && fixedStringsOf(pass.args).length > 0 && fixedStringsOf(pass.args).every(spelling => /^[A-Za-z0-9]+$/.test(spelling) && words.includes(spelling.toLowerCase())) && !pass.args.some(arg => /reboot|--pre|--files|rm -rf/.test(arg) && !/^[A-Za-z0-9]+$/.test(arg))),
    JSON.stringify(calls.map(pass => pass.args)),
  )
  const refused: Array<[string, string, RegExp]> = [
    ['only glue words', 'where is the one that does this', /no word to count/],
    ['one letter', 'x', /no word to count/],
    ['5,000 words', Array.from({ length: 5000 }, (_, index) => `word${index}`).join(' '), /1000 characters at most/],
    ['bytes that are not text', 'retry\0\u0001\ufffd upload', /not text/],
  ]
  for (const [label, pattern, expected] of refused) {
    calls.length = 0
    const verdict = await validate({ pattern, output_mode: 'ranked' })
    let thrown = ''
    try {
      await call({ pattern })
    } catch (error) {
      thrown = error instanceof Error ? error.message : String(error)
    }
    check(`${label}: refused in a sentence at the door and inside the call, and no ripgrep is started`, verdict.result === false && expected.test(verdict.message ?? '') && thrown === verdict.message && calls.length === 0, JSON.stringify({ verdict, thrown, started: calls.length }))
  }
}

console.log('it shows nothing Grep would not')
{
  const before = await ask({})
  mkdirSync(join(project, 'private'), { recursive: true })
  writeFileSync(join(project, 'private/keys.ts'), 'export const retryUploadFailed = 1\nexport const uploadRetry = "retry a failed upload"\nexport const failedUploadRetry = 2\n')
  const exposed = await ask({})
  check('the control: a file dense with the words, with no rule on it, is named and moves the numbers', named(exposed).includes('private/keys.ts') && exposed.split('\n')[0] !== before.split('\n')[0], exposed.split('\n')[0])
  const callerGlobAt = (pass: Call): number => pass.args.findIndex((arg, index) => pass.args[index - 1] === '--glob' && !arg.startsWith('!'))
  const ruleGlobAt = (pass: Call): number => pass.args.findIndex((arg, index) => pass.args[index - 1] === '--iglob' && /private|keys\.ts/.test(arg))
  for (const [label, rule] of [['a rule relative to the folder', 'Read(private/**)'], ['a rule on the file name', 'Read(**/keys.ts)']] as const) {
    calls.length = 0
    const hidden = await ask({}, deny(rule))
    check(`a denied path (${label}): never named, and every number is what it was before the file existed`, hidden === before, hidden)
    check(`a denied path (${label}): three counting passes and one line pass, and the line pass does not name the file`, calls.filter(counts).length === 3 && calls.filter(pass => !counts(pass)).length === 1 && !calls.some(pass => filesOf(pass).some(file => file.endsWith('keys.ts'))), JSON.stringify(calls.map(filesOf)))
    calls.length = 0
    const widened = await ask({ glob: 'private/**' }, deny(rule))
    check(`a denied path (${label}): the caller's own glob cannot bring it back`, !widened.includes('keys.ts') && widened.startsWith('No file among 0 searched holds'), widened)
    check(`a denied path (${label}): its rule stands after the caller's glob in every pass, where ripgrep lets the last one win`, calls.length > 0 && calls.every(pass => callerGlobAt(pass) !== -1 && ruleGlobAt(pass) > callerGlobAt(pass)), JSON.stringify(calls[0]?.args.filter((arg, index, all) => all[index - 1] === '--glob' || all[index - 1] === '--iglob')))
  }
  for (const [label, rule] of [
    ['relative', 'Read(private/**)'],
    ['by file name', 'Read(**/keys.ts)'],
    ['from the root', 'Read(/private/**)'],
    ['absolute', `Read(//${project.replace(/^\/+/, '')}/private/**)`],
    ['under the home folder', 'Read(~/private/**)'],
  ] as const) {
    const listed = ((await runWithCwdOverride(project, () => GrepTool.call({ pattern: 'retry|retrie|fail|upload', '-i': true, output_mode: 'files_with_matches', head_limit: 0 } as never, context(deny(rule))))) as { data: Data }).data.filenames
    const ranked = named(await ask({}, deny(rule)))
    check(`whatever the spelling of the rule (${label}): it names the file only if Grep's own listing names it, and every file it names is in that listing`, ranked.includes('private/keys.ts') === listed.includes('private/keys.ts') && ranked.every(file => listed.includes(file)), JSON.stringify({ ranked: ranked.includes('private/keys.ts'), grep: listed.includes('private/keys.ts') }))
  }
  rmSync(join(project, 'private'), { recursive: true, force: true })

  writeFileSync(join(project, '.env'), 'UPLOAD_RETRY=retry a failed upload\nFAILED_UPLOADS=retry\n')
  const withEnv = await ask({})
  check('a .env the user would be asked about: withheld in Grep\'s own sentence, never ranked, out of every number', withEnv === `${before}\n(Withheld: .env — Mercury asks before reading a .env file; search it by name (path or glob) to be asked.)`, withEnv)
  const asked = await decide({ pattern: RANKED_FIXTURE_DESCRIPTION, output_mode: 'ranked', path: join(project, '.env') }, project)
  const askedFiles = await decide({ pattern: 'retry', output_mode: 'files_with_matches', path: join(project, '.env') }, project)
  check('searched by name, the .env is asked about exactly as Grep asks', asked.behavior === 'ask' && asked.behavior === askedFiles.behavior && asked.message === askedFiles.message, JSON.stringify([asked.behavior, asked.message, askedFiles.message]))
  rmSync(join(project, '.env'))

  const wide = await ask({}, open, world)
  for (const name of ['.credentials.json', '.provider-secrets.json', 'fixture-auth.json']) writeFileSync(join(HOME, name), JSON.stringify({ note: 'retry a failed upload, retry the upload that failed' }) + '\n', { mode: 0o600 })
  calls.length = 0
  const withSecrets = await ask({}, open, world)
  check('Mercury\'s own credential files under the folder searched: never named, and every number is what it was before they existed', withSecrets === wide && !withSecrets.includes('credentials') && !withSecrets.includes('auth.json'), withSecrets)
  check('no pass names one of them', !calls.some(pass => filesOf(pass).some(file => file.startsWith(HOME))), JSON.stringify(calls.at(-1)?.args.slice(-6)))
  const secret = await decide({ pattern: RANKED_FIXTURE_DESCRIPTION, output_mode: 'ranked', path: join(HOME, '.credentials.json') }, world)
  const secretFiles = await decide({ pattern: 'retry', output_mode: 'files_with_matches', path: join(HOME, '.credentials.json') }, world)
  check('named as the path, a credential file is refused exactly as Grep refuses it', secret.behavior === 'deny' && secret.behavior === secretFiles.behavior && secret.message === secretFiles.message, JSON.stringify([secret.behavior, secret.message]))

  const outside = realpathSync(mkdtempSync(join(tmpdir(), 'grep-ranked-outside-')))
  writeFileSync(join(outside, 'note.ts'), 'export const retryUpload = "retry a failed upload"\n')
  const far = await decide({ pattern: RANKED_FIXTURE_DESCRIPTION, output_mode: 'ranked', path: outside }, project)
  const farFiles = await decide({ pattern: 'retry', output_mode: 'files_with_matches', path: outside }, project)
  check('a path outside the working tree is judged exactly as Grep judges it: the same question in the same words', far.behavior === 'ask' && far.behavior === farFiles.behavior && far.message === farFiles.message && JSON.stringify(far.decisionReason) === JSON.stringify(farFiles.decisionReason), JSON.stringify([far.behavior, far.message, farFiles.behavior, farFiles.message]))
  const inside = await decide({ pattern: RANKED_FIXTURE_DESCRIPTION, output_mode: 'ranked' }, project)
  const insideFiles = await decide({ pattern: 'retry', output_mode: 'files_with_matches' }, project)
  check('and inside the working tree it is allowed as Grep is', inside.behavior === 'allow' && insideFiles.behavior === 'allow', JSON.stringify([inside.behavior, insideFiles.behavior]))
  rmSync(outside, { recursive: true, force: true })

  calls.length = 0
  await ask({})
  const counted = new Set<string>()
  for (const pass of calls.filter(counts)) for (const line of (await ripgrep.ripGrepAnswer(pass.args, pass.target, new AbortController().signal, { cwd: project })).lines) if (line.includes('\0')) counted.add(line.slice(0, line.indexOf('\0')))
  const reading = calls.filter(pass => !counts(pass))
  check('one line pass, and it names only files the counting passes returned', reading.length === 1 && filesOf(reading[0]!).length <= 24 && filesOf(reading[0]!).every(file => counted.has(file)), JSON.stringify(reading.map(filesOf)))
  check('every pass runs in the folder searched, as Grep does, so a rule is anchored where Grep anchors it', calls.every(pass => pass.cwd === project), JSON.stringify(calls.map(pass => pass.cwd)))
}

rmSync(world, { recursive: true, force: true })
if (failures > 0) {
  console.error(`\nprove-grep-ranked-mode: ${failures} of ${checks} FAILED`)
  process.exit(1)
}
console.log(`\nprove-grep-ranked-mode: all ${checks} green`)
