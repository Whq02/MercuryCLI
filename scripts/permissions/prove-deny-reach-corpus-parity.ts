#!/usr/bin/env bun
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { z } from 'zod/v4'
import { removeScratch } from '../lib/removeScratch.ts'

const FIXTURE = join(import.meta.dir, 'fixtures', 'deny-reach-corpus.json')
const SELF = 'scripts/permissions/prove-deny-reach-corpus-parity.ts'
const RECORD = process.argv.includes('--record')
const TRACED = process.argv.includes('--traces') ? process.argv[process.argv.indexOf('--traces') + 1] : undefined
const SHOWN = 12
const OWN = '\\u0001'
const LONG = 1500

if (!process.env.REACH_CORPUS_ROOT) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'deny-reach-corpus-')))
  const home = join(root, 'home')
  const config = join(root, 'config')
  mkdirSync(home)
  mkdirSync(config)
  const child = Bun.spawnSync([process.execPath, ...process.argv.slice(1)], {
    env: { ...Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('GIT_'))), HOME: home, USERPROFILE: home, REACH_CORPUS_ROOT: root, MERCURY_CONFIG_DIR: config, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: join(root, 'no-git-config') },
    stdio: ['inherit', 'inherit', 'inherit'],
  })
  removeScratch(root)
  process.exit(child.exitCode ?? 99)
}

const ROOT = process.env.REACH_CORPUS_ROOT
const HOME = join(ROOT, 'home')
const CONFIG = join(ROOT, 'config')
const RUN = join(ROOT, 'outer', 'middle', 'run')
const WIDE = 520
const PAD = ` #${'x'.repeat(10_050)}`
const LONG_NAME = 'n'.repeat(300)

function put(path: string, text: string): void {
  mkdirSync(dirname(join(RUN, path)), { recursive: true })
  writeFileSync(join(RUN, path), text)
}
for (const folder of ['sub', 'plain', 'wide', 'big', 'secrets/deep', '.mercury']) mkdirSync(join(RUN, folder), { recursive: true })
for (const file of ['x', 'notes.txt', 'a.txt', 'b.txt', 'plan.txt', 'p.diff', 'a.tar', 'a.zip', 'list']) put(file, `${file}\n`)
for (const file of ['hidden.key', 'sub/hidden.key', 'sub/notes.txt', 'plain/notes.txt', 'secrets/k.txt', 'secrets/deep/inner.txt', '.mercury/settings.local.json']) put(file, 'K\n')
for (const name of ['f1', 'f2', 'f3', 'f4', 'f5']) put(`big/${name}`, 'K\n')
for (let at = 0; at < WIDE; at++) put(`wide/w${String(at).padStart(3, '0')}.txt`, '')
mkdirSync(join(HOME, 'vault'), { recursive: true })
writeFileSync(join(HOME, 'vault', 'k.txt'), 'K\n')
if (process.platform !== 'win32') {
  symlinkSync(join(RUN, 'secrets', 'k.txt'), join(RUN, 'link-to-k'))
  symlinkSync(join(RUN, 'secrets'), join(RUN, 'link-to-dir'))
}
const TEMPLATE = join(ROOT, 'git-template')
mkdirSync(TEMPLATE)
const WHO = { GIT_AUTHOR_NAME: 'proof', GIT_AUTHOR_EMAIL: 'proof@example.invalid', GIT_COMMITTER_NAME: 'proof', GIT_COMMITTER_EMAIL: 'proof@example.invalid', GIT_AUTHOR_DATE: '2026-01-01T00:00:00Z', GIT_COMMITTER_DATE: '2026-01-01T00:00:00Z' }
const git = (...args: string[]): string =>
  execFileSync('git', ['-c', 'user.name=proof', '-c', 'user.email=proof@example.invalid', '-c', 'commit.gpgsign=false', '-c', 'gc.auto=0', '-c', 'maintenance.auto=false', '-c', 'core.logAllRefUpdates=true', ...args], {
    cwd: RUN,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, ...WHO },
  })
git('init', '-q', '-b', 'main', '--object-format=sha1', '--template', TEMPLATE, '.')
git('add', 'notes.txt', 'secrets/k.txt', 'plain/notes.txt', 'sub/notes.txt')
git('commit', '-q', '-m', 'first: the secret arrives')
put('notes.txt', 'notes\nmore\n')
git('commit', '-q', '-am', 'second: plain')
put('secrets/k.txt', 'K\nK2\n')
git('commit', '-q', '-am', 'third: touches the secret')
put('secrets/k.txt', 'K\nK2\nunstaged\n')
put('plain/notes.txt', 'K\nstaged\n')
git('add', 'plain/notes.txt')

process.chdir(RUN)
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
process.env.NODE_ENV = 'test'
for (const key of ['MERCURY_HOME', 'MERCURY_SKIP_PERMISSIONS', 'MERCURY_WARDS', 'MERCURY_TREE_SCAN_CEILING']) delete process.env[key]
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

const { getEmptyToolPermissionContext } = await import('../../src/Tool.ts')
const { decideToolPermissionWithModes } = await import('../../src/utils/permissions/decision/wrapper.ts')
const { getDenyRules } = await import('../../src/utils/permissions/decision/rules.ts')
const { bashToolHasPermission } = await import('../../src/tools/BashTool/bashPermissions.ts')
const { denyRuleReach, startedProgramIsShell } = await import('../../src/tools/BashTool/denyRuleReach.ts')
const { enableConfigs } = await import('../../src/utils/config.ts')
const { setOriginalCwd, setCwdState, setProjectRoot, setSessionTrustAccepted } = await import('../../src/bootstrap/state.ts')
setSessionTrustAccepted(true)
enableConfigs()
setOriginalCwd(RUN)
setCwdState(RUN)
setProjectRoot(RUN)

type Budget = { left: number; unsettled?: boolean }
type Reach = Awaited<ReturnType<typeof denyRuleReach>>
type Rule = ReturnType<typeof getDenyRules>[number]
type Setting = { name: string; deny: string[]; estate?: true; reasons?: true; left?: number; depth?: number; ceiling?: string; folder?: string }
type Door = { name: string; mode: string; deny: string[] }
type Row = [command: string, reached: number[], runs: string, decided: number[], shell: number]
type Fixture = { platform: string; settings: string[]; doors: string[]; readings: unknown[]; rows: Row[] }
type Run = { left: number; unsettled: boolean; calls: string[] }
type Readings = { reached: string[]; runs: Run[]; decided: string[]; shell: number }

const BASH = ['Bash(rm *)', 'Bash(git push *)']
const READ = ['Read(secrets/**)', 'Read(**/hidden.key)', 'Read(~/vault/**)']
const EDIT = ['Edit(secrets/**)', 'Edit(~/vault/**)']
const ALL = [...BASH, ...READ, ...EDIT]
const SETTINGS: Setting[] = [
  { name: 'bash rules', deny: BASH },
  { name: 'read rules', deny: READ },
  { name: 'edit rules', deny: EDIT },
  { name: 'every rule', deny: ALL },
  { name: 'the estate alone', deny: [], estate: true },
  { name: 'every rule, two commands left', deny: ALL, left: 2 },
  { name: 'every rule, at depth four', deny: ALL, depth: 4 },
  { name: 'every rule, a tree of three entries read', deny: ALL, ceiling: '3' },
  { name: 'every rule, from the folder sub', deny: ALL, folder: 'sub' },
  { name: 'every rule, each with its reason', deny: ALL, reasons: true },
]
const DOORS: Door[] = [
  { name: 'default, every rule', mode: 'default', deny: ALL },
  { name: 'sovereign, every rule', mode: 'sovereign', deny: ALL },
  { name: 'flow, every rule', mode: 'flow', deny: ALL },
  { name: 'flow, no rule', mode: 'flow', deny: [] },
]
const WRITE_OPTIONS: Record<string, readonly string[]> = { curl: ['-o', '--output'], wget: ['-O', '--output-document'], tar: ['-C', '--directory'], unzip: ['-d'] }
const PORT_THROWS = '--the-port-throws'
const REASONS = Object.fromEntries(ALL.map(rule => [rule, `the reason given for ${rule}`]))
const LEAVES_AS_IT_WAS = /^(?:cat|ls|grep|rg|head|tail|wc|stat|file|diff|git (?:status|log|diff|show|grep|blame|cat-file))(?:\s|$)/
const PLAIN_WORDS = /^[\w./=:@%+,-]+(?: [\w./=:@%+,-]+)*$/

let failures = 0
let checks = 0
function check(label: string, ok: boolean, detail = ''): void {
  checks++
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
}
const section = (title: string): void => console.log(`\n${'─'.repeat(76)}\n${title}`)

const NAMED: Array<[string, string]> = ([[RUN, '<root>'], [HOME, '<home>'], [CONFIG, '<config>'], [ROOT, '<scratch>']] as Array<[string, string]>).flatMap(([path, word]) => (path.toLowerCase() === path ? [[path, word]] : [[path, word], [path.toLowerCase(), word]]))
const named = (text: string): string => NAMED.reduce((out, [path, word]) => out.replaceAll(path, word), text)
const filled = (command: string): string => command.replaceAll('<PAD>', PAD).replaceAll('<LONG>', LONG_NAME)
const mapsAsLists = (_key: string, value: unknown): unknown => (value instanceof Map ? { entries: [...value] } : value)
const digest = (text: string): string => createHash('sha256').update(text).digest('hex').slice(0, 16)

function folded(text: string, command: string): string {
  const shown = named(text).replaceAll(JSON.stringify(PAD).slice(1, -1), '<PAD>')
  const own = named(JSON.stringify(command).slice(1, -1)).replaceAll(JSON.stringify(PAD).slice(1, -1), '<PAD>')
  const short = own.length < 6 ? shown : shown.replaceAll(own, OWN)
  return short.length <= LONG ? short : JSON.stringify({ long: short.length, sha256: digest(short), opens: short.slice(0, 200) })
}

function contextOf(mode: string, deny: string[], reasons = false): ReturnType<typeof getEmptyToolPermissionContext> {
  return { ...getEmptyToolPermissionContext(), mode, isBypassPermissionsModeAvailable: mode === 'sovereign', alwaysDenyRules: deny.length > 0 ? { localSettings: deny } : {}, alwaysAllowRules: {}, alwaysAskRules: {}, ...(reasons ? { ruleReasons: { localSettings: REASONS } } : {}) } as never
}

function bashRuleFor(rules: readonly Rule[], candidate: string): Rule | null {
  for (const rule of rules) {
    const content = rule.ruleValue.ruleContent
    if (rule.ruleValue.toolName !== 'Bash' || content === undefined) continue
    const prefix = content.replace(/ \*$/, '')
    if (candidate === prefix || candidate.startsWith(`${prefix} `)) return rule
  }
  return null
}

async function reached(command: string, setting: Setting): Promise<{ reading: string; run: Run }> {
  const context = contextOf('default', setting.deny, setting.reasons === true)
  const rules = getDenyRules(context as never)
  const trace: string[] = []
  const estates = [join(RUN, '.mercury'), join(HOME, '.mercury')]
  const run = (text: string, folder: string, depth: number, budget: Budget): Promise<Reach> =>
    denyRuleReach(text, folder, context as never, {
      judge: async (inner, at, left) => {
        trace.push(`judge at depth ${depth + 1} with ${left.left} left${left.unsettled ? ', unsettled' : ''} in ${named(at)}: ${named(inner)}`)
        const refused = bashRuleFor(rules, inner)
        if (refused !== null) return { denied: { behavior: 'deny', message: `the judge refuses ${named(inner)}`, decisionReason: { type: 'rule', rule: refused } } as never, hidden: null }
        const below = await run(inner, at, depth + 1, left)
        if (below.denied !== null) return { denied: below.denied, hidden: null }
        if (setting.estate && below.hidden !== null) return { denied: { behavior: 'deny', message: `the judge names ${below.hidden.why}`, decisionReason: { type: 'other', reason: below.hidden.why } } as never, hidden: null }
        return { denied: null, hidden: below.hidden, unread: below.unread ?? null }
      },
      bashDenyRule: candidate => {
        const rule = setting.estate ? null : bashRuleFor(rules, candidate)
        trace.push(`bashDenyRule ${named(candidate)} → ${rule === null ? 'none' : rule.ruleValue.ruleContent}`)
        return rule
      },
      optionNamedWrites: argv => {
        if (argv.includes(PORT_THROWS)) throw new Error('the port that names option writes threw')
        const options = WRITE_OPTIONS[basename(argv[0] ?? '')] ?? []
        const writes = argv.flatMap((word, at) => (options.includes(word) && argv[at + 1] !== undefined ? [argv[at + 1] as string] : []))
        trace.push(`optionNamedWrites ${named(JSON.stringify(argv))} → ${named(JSON.stringify(writes))}`)
        return writes
      },
      ...(setting.estate
        ? {
            estate: (path: string): boolean => {
              const inside = estates.some(estate => path === estate || path.startsWith(`${estate}/`))
              trace.push(`estate ${named(path)} → ${inside}`)
              return inside
            },
          }
        : {
            readOnly: async (text: string, at: string): Promise<boolean> => {
              const leaves = LEAVES_AS_IT_WAS.test(text)
              trace.push(`readOnly in ${named(at)}: ${named(text)} → ${leaves}`)
              return leaves
            },
          }),
    }, depth, budget)
  const budget: Budget = { left: setting.left ?? 96 }
  if (setting.ceiling !== undefined) process.env.MERCURY_TREE_SCAN_CEILING = setting.ceiling
  let result: Reach | { threw: string }
  try {
    result = await run(command, setting.folder === undefined ? RUN : join(RUN, setting.folder), setting.depth ?? 0, budget)
  } catch (error) {
    result = { threw: error instanceof Error ? error.message : String(error) }
  } finally {
    delete process.env.MERCURY_TREE_SCAN_CEILING
  }
  return { reading: folded(JSON.stringify(result, mapsAsLists), command), run: { left: budget.left, unsettled: budget.unsettled === true, calls: trace } }
}

const bash = {
  name: 'Bash',
  inputSchema: z.object({ command: z.string() }),
  checkPermissions: (input: { command: string }, context: { getAppState: () => { toolPermissionContext: unknown } }) => bashToolHasPermission(input, context.getAppState().toolPermissionContext as never),
} as never

async function decided(command: string, door: Door): Promise<string> {
  const state = { toolPermissionContext: contextOf(door.mode, door.deny) }
  const context = { abortController: new AbortController(), getAppState: () => state, setAppState: () => {}, messages: [], options: {} } as never
  let decision: unknown
  try {
    decision = (await decideToolPermissionWithModes(bash, { command }, context, { message: { id: 'reach-corpus' } } as never, 'reach-corpus')).decision
  } catch (error) {
    decision = { threw: error instanceof Error ? error.message : String(error) }
  }
  return folded(JSON.stringify(decision, mapsAsLists), command)
}

function shellOf(command: string): number {
  if (!PLAIN_WORDS.test(command)) return -1
  const [program, ...args] = command.split(' ')
  return startedProgramIsShell(program, args) ? 1 : 0
}

async function readingsOf(spelled: string): Promise<Readings> {
  const command = filled(spelled)
  const direct: string[] = []
  const runs: Run[] = []
  for (const setting of SETTINGS) {
    const now = await reached(command, setting)
    direct.push(now.reading)
    runs.push(now.run)
  }
  const doors: string[] = []
  for (const door of DOORS) doors.push(await decided(command, door))
  return { reached: direct, runs, decided: doors, shell: shellOf(command) }
}

function commandsOf(path: string): string[] {
  const value = JSON.parse(readFileSync(path, 'utf8')) as unknown
  if (!Array.isArray(value)) throw new Error(`${path} is not a JSON array of commands`)
  return value.map(entry => (typeof entry === 'string' ? entry : (entry as { command: string }).command))
}

console.log('============================================================')
console.log(' deny rules through the shell — corpus parity (what each command reaches)')
console.log('============================================================')

const fixture: Fixture = existsSync(FIXTURE) ? (JSON.parse(readFileSync(FIXTURE, 'utf8')) as Fixture) : { platform: process.platform, settings: [], doors: [], readings: [], rows: [] }
const recorded = fixture.readings.map(reading => JSON.stringify(reading))

if (RECORD) {
  const added = process.argv.slice(process.argv.indexOf('--record') + 1).filter(word => !word.startsWith('--') && word !== TRACED).flatMap(commandsOf)
  const corpus = [...new Set([...fixture.rows.map(row => row[0]), ...added])].sort()
  const readings: string[] = []
  const index = new Map<string, number>()
  const intern = (text: string): number => {
    const known = index.get(text)
    if (known !== undefined) return known
    readings.push(text)
    index.set(text, readings.length - 1)
    return readings.length - 1
  }
  const rows: Row[] = []
  const traced: string[] = []
  for (const spelled of corpus) {
    const now = await readingsOf(spelled)
    rows.push([spelled, now.reached.map(intern), digest(JSON.stringify(now.runs)), now.decided.map(intern), now.shell])
    if (TRACED !== undefined) traced.push(JSON.stringify({ command: spelled, ...now }))
  }
  const head = JSON.stringify({ platform: process.platform, settings: SETTINGS.map(setting => setting.name), doors: DOORS.map(door => door.name) }).slice(1, -1)
  writeFileSync(FIXTURE, `{${head},\n"readings":[\n${readings.join(',\n')}\n],\n"rows":[\n${rows.map(row => JSON.stringify(row)).join(',\n')}\n]}\n`)
  if (TRACED !== undefined) writeFileSync(TRACED, `${traced.join('\n')}\n`)
  console.log(`\n  [RECORDED] ${rows.length} commands, ${SETTINGS.length} settings and ${DOORS.length} doors each, ${readings.length} distinct readings → ${FIXTURE}`)
} else if (fixture.platform !== process.platform) {
  console.log(`\n  [SKIP] the recording was taken on ${fixture.platform} and reads a scratch tree as that platform lists and spells it; on ${process.platform} nothing of it is compared`)
} else {
  section(`(1) the corpus — ${fixture.rows.length} commands, ${fixture.readings.length} distinct readings`)
  check('the recorded corpus exists beside the proof', fixture.rows.length > 0, FIXTURE)
  check('the settings and the doors are the recorded ones, in their order', JSON.stringify(fixture.settings) === JSON.stringify(SETTINGS.map(setting => setting.name)) && JSON.stringify(fixture.doors) === JSON.stringify(DOORS.map(door => door.name)), `${JSON.stringify(fixture.settings)} ${JSON.stringify(fixture.doors)}`)
  const moved: string[] = []
  const traced: string[] = []
  const outcomes = new Map<string, number>()
  let quiet = 0
  let read = 0
  for (const [spelled, reachedAt, runs, decidedAt, shell] of fixture.rows) {
    if (moved.length > SHOWN) break
    read++
    const now = await readingsOf(spelled)
    if (TRACED !== undefined) traced.push(JSON.stringify({ command: spelled, ...now }))
    SETTINGS.forEach((setting, at) => {
      const want = recorded[reachedAt[at] ?? -1] ?? ''
      const got = now.reached[at] as string
      const outcome = got.includes('"denied":{') ? 'denied' : got.includes('"hidden":{') ? 'hidden' : got.includes('"unread":{') ? 'unread' : 'nothing'
      outcomes.set(outcome, (outcomes.get(outcome) ?? 0) + 1)
      if (got !== want) moved.push(`${JSON.stringify(spelled)} — the reach, ${setting.name}\n      recorded: ${want}\n      now:      ${got}`)
    })
    if (digest(JSON.stringify(now.runs)) !== runs) moved.push(`${JSON.stringify(spelled)} — the budget left, the unsettled mark or the port calls of one of the ${SETTINGS.length} settings (recorded as the digest ${runs}; \`--traces <file>\` writes every call of every command)\n      now, setting by setting: ${JSON.stringify(now.runs).slice(0, 2400)}`)
    DOORS.forEach((door, at) => {
      const want = recorded[decidedAt[at] ?? -1] ?? ''
      const got = now.decided[at] as string
      if (got !== want) moved.push(`${JSON.stringify(spelled)} — the decision, ${door.name}\n      recorded: ${want}\n      now:      ${got}`)
    })
    if (now.shell !== shell) moved.push(`${JSON.stringify(spelled)} — whether the started program is a shell\n      recorded: ${shell}\n      now:      ${now.shell}`)
    const nothing = await denyRuleReach(filled(spelled), RUN, contextOf('default', []) as never, { judge: async () => ({ denied: null, hidden: null }), bashDenyRule: () => null, optionNamedWrites: () => [] })
    if (nothing.denied === null && nothing.hidden === null && nothing.unread === undefined) quiet++
  }
  if (TRACED !== undefined) writeFileSync(TRACED, `${traced.join('\n')}\n`)
  for (const [outcome, count] of [...outcomes.entries()].sort()) console.log(`    the reach answers ${outcome}: ${count}`)
  check(
    `every command reaches what was recorded: the answer of denyRuleReach, the budget it leaves and its port calls in ${SETTINGS.length} settings, the whole decision at ${DOORS.length} doors, byte for byte (${fixture.rows.length} commands)`,
    moved.length === 0,
    `${read < fixture.rows.length ? `${moved.length} moved among the first ${read} commands, and the run stopped there` : `${moved.length} moved`}. If a decision was meant to change, record again with \`bun ${SELF} --record\` and read the diff of scripts/permissions/fixtures/deny-reach-corpus.json; if it was not, the change to src/tools/BashTool/denyRuleReach.ts or to what it reads altered what a deny rule reaches`,
  )
  for (const line of moved.slice(0, SHOWN)) console.log(`    ${line}`)
  check('with no deny rule and no estate the reach answers nothing, for every command read', quiet === read, `${read - quiet} commands were answered`)
  check('no program and an empty program name are no shell', !startedProgramIsShell(undefined) && !startedProgramIsShell('', ['-c', 'sh']))
  check('the corpus reaches a denial, a hidden rule, an unread rule and nothing', read < fixture.rows.length || ['denied', 'hidden', 'unread', 'nothing'].every(outcome => (outcomes.get(outcome) ?? 0) > 0), [...outcomes.keys()].join(','))
}

console.log('\n============================================================')
if (failures === 0) {
  console.log(RECORD ? ' CORPUS RECORDED' : ` DENY REACH CORPUS PARITY GREEN (${checks} checks)`)
  process.exit(0)
}
console.log(` ${failures} DENY REACH CORPUS PARITY FAILURE(S)`)
process.exit(1)
