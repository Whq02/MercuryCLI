#!/usr/bin/env bun
import { mkdirSync, mkdtempSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod/v4'
import { removeScratch } from '../lib/removeScratch.ts'

const launchDir = process.cwd()
const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'ssh-path-rules-')))
const HOME = join(scratch, 'home')
const PROJ = join(scratch, 'proj')
mkdirSync(HOME, { recursive: true })
mkdirSync(PROJ, { recursive: true })
process.env.MERCURY_CONFIG_DIR = HOME
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.NODE_ENV = 'test'
for (const key of ['MERCURY_HOME', 'MERCURY_SKIP_PERMISSIONS', 'MERCURY_WARDS']) delete process.env[key]
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
process.chdir(PROJ)

const { getEmptyToolPermissionContext } = await import('../../src/Tool.ts')
const { decideToolPermissionWithModes } = await import('../../src/utils/permissions/decision/wrapper.ts')
const { enableConfigs } = await import('../../src/utils/config.ts')
const { setOriginalCwd, setCwdState, setSessionTrustAccepted } = await import('../../src/bootstrap/state.ts')
const {
  checkReadPermissionForTool,
  checkWritePermissionForTool,
  generateSuggestions,
  getFileReadIgnorePatterns,
  matchingRuleForInput,
  pathMatchesRulePattern,
  readDenialFilter,
} = await import('../../src/utils/permissions/filesystem.ts')
const { noteResolvedAuthority } = await import('../../src/services/remoteFiles/target.ts')
setSessionTrustAccepted(true)
enableConfigs()
setOriginalCwd(PROJ)
setCwdState(PROJ)

type Ctx = import('../../src/Tool.ts').ToolPermissionContext
type Rules = { deny?: string[]; allow?: string[]; ask?: string[] }
type Decision = { behavior: string; message?: string; decisionReason?: { type?: string; mode?: string; rule?: { ruleValue?: { toolName?: string; ruleContent?: string } } }; suggestions?: Array<{ type: string; mode?: string; destination?: string; behavior?: string; rules?: Array<{ toolName: string; ruleContent?: string }> }> }

let failures = 0
let checks = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  checks++
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail.slice(0, 700)}` : ''}`)
}
const section = (title: string): void => console.log(`\n${'─'.repeat(76)}\n${title}`)

const context = (rules: Rules = {}, mode = 'default', source = 'userSettings'): Ctx =>
  ({
    ...getEmptyToolPermissionContext(),
    mode,
    isBypassPermissionsModeAvailable: mode === 'sovereign',
    alwaysDenyRules: rules.deny ? { [source]: rules.deny } : {},
    alwaysAllowRules: rules.allow ? { [source]: rules.allow } : {},
    alwaysAskRules: rules.ask ? { [source]: rules.ask } : {},
  }) as unknown as Ctx

const tool = (name: string) => ({ name, getPath: (input: { file_path?: string; path?: string }) => input.file_path ?? input.path })
const read = (name: string, path: string, ctx: Ctx): Decision => checkReadPermissionForTool(tool(name), { file_path: path }, ctx) as unknown as Decision
const write = (name: string, path: string, ctx: Ctx): Decision => checkWritePermissionForTool(tool(name), { file_path: path }, ctx) as unknown as Decision
const said = (decision: Decision): string => `${decision.behavior}: ${decision.message ?? ''} ${JSON.stringify(decision.suggestions ?? [])}`
const grants = (decision: Decision): string[] => (decision.suggestions ?? []).flatMap(update => (update.type === 'addRules' ? (update.rules ?? []).map(rule => `${update.behavior} ${update.destination} ${rule.toolName}(${rule.ruleContent})`) : [`${update.type} ${update.mode}`]))

const HOSTS = 'ssh://web1/etc/hosts'

section('§1 the matcher: a rule beginning ssh:// and a remote path')
{
  const deny = context({ deny: ['Read(ssh://web1/**)'] })
  check('a Read rule for the host matches a file on the host', matchingRuleForInput(HOSTS, deny, 'read', 'deny') !== null)
  check('it matches no other host', matchingRuleForInput('ssh://web2/etc/hosts', deny, 'read', 'deny') === null)
  check('it does not match an edit', matchingRuleForInput(HOSTS, deny, 'edit', 'deny') === null)
  check('it matches no local path, not even one spelled like it under the working folder', matchingRuleForInput(join(PROJ, 'ssh:', 'web1', 'etc', 'hosts'), deny, 'read', 'deny') === null && matchingRuleForInput('/etc/hosts', deny, 'read', 'deny') === null)
  const local = context({ deny: ['Read(.env)', 'Read(**/secrets/**)', 'Read(//etc/**)', 'Read(~/**)', 'Read(/**)'] })
  check('a local rule matches no remote path: a bare name, a glob, the root, the home, the settings folder', ['ssh://web1/app/.env', 'ssh://web1/srv/secrets/k', 'ssh://web1/etc/hosts', 'ssh://web1/~/x'].every(path => matchingRuleForInput(path, local, 'read', 'deny') === null), ['ssh://web1/app/.env', 'ssh://web1/srv/secrets/k', 'ssh://web1/etc/hosts', 'ssh://web1/~/x'].map(path => `${path}: ${matchingRuleForInput(path, local, 'read', 'deny')?.ruleValue.ruleContent ?? 'none'}`).join(' · '))
  check('the same local rules still match local paths', matchingRuleForInput(join(PROJ, '.env'), local, 'read', 'deny') !== null && matchingRuleForInput('/etc/hosts', local, 'read', 'deny') !== null)
  const folder = context({ deny: ['Edit(ssh://web1/srv/**)', 'Read(ssh://*/**/.env)'] })
  check('a folder rule covers the folder only', matchingRuleForInput('ssh://web1/srv/app/x', folder, 'edit', 'deny') !== null && matchingRuleForInput('ssh://web1/etc/x', folder, 'edit', 'deny') === null)
  check('a rule for any host covers a name on every host', matchingRuleForInput('ssh://web9/a/b/.env', folder, 'read', 'deny') !== null && matchingRuleForInput('ssh://web9/a/b/env', folder, 'read', 'deny') === null)
  check('a Glob or Write rule is of the same family as locally', matchingRuleForInput(HOSTS, context({ deny: ['Glob(ssh://web1/**)'] }), 'read', 'deny') !== null && matchingRuleForInput(HOSTS, context({ deny: ['Write(ssh://web1/**)'] }), 'edit', 'deny') !== null)
  check('a path with .. is denied where it lands and allowed by no rule', matchingRuleForInput('ssh://web1/srv/../etc/hosts', context({ deny: ['Read(ssh://web1/etc/**)'] }), 'read', 'deny') !== null && matchingRuleForInput('ssh://web1/srv/app/../../etc/hosts', context({ allow: ['Read(ssh://web1/srv/**)'] }), 'read', 'allow') === null)
  check('pathMatchesRulePattern reads the two kinds apart', pathMatchesRulePattern('ssh://web1/etc/x', 'ssh://web1/etc/**') && !pathMatchesRulePattern('ssh://web1/etc/x', '**/x') && !pathMatchesRulePattern(join(PROJ, 'etc', 'x'), 'ssh://web1/etc/**') && pathMatchesRulePattern(join(PROJ, 'etc', 'x'), 'etc/**'))
  const globs = [...getFileReadIgnorePatterns(context({ deny: ['Read(ssh://web1/**)', 'Read(hidden/**)'] })).entries()].flatMap(([root, patterns]) => patterns.map(pattern => `${root}|${pattern}`))
  check('a remote rule is not handed to a local search as a glob', globs.some(row => row.endsWith('|hidden/**')) && !globs.some(row => row.includes('web1')), JSON.stringify(globs))
}

section('§2 reading: Read, Grep and Glob on a remote path')
for (const name of ['Read', 'Grep', 'Glob']) {
  const denied = read(name, HOSTS, context({ deny: ['Read(ssh://web1/**)'] }))
  check(`${name}: a deny rule denies, in the rule's own sentence`, denied.behavior === 'deny' && denied.message === 'Reading ssh://web1/etc/hosts is denied by the rule Read(ssh://web1/**) in your user settings.', said(denied))
  const asked = read(name, HOSTS, context({ ask: ['Read(ssh://web1/etc/**)'] }))
  check(`${name}: an ask rule asks`, asked.behavior === 'ask' && asked.message === 'Reading ssh://web1/etc/hosts asks first — the rule Read(ssh://web1/etc/**) in your user settings.', said(asked))
  const allowed = read(name, HOSTS, context({ allow: ['Read(ssh://web1/**)'] }))
  check(`${name}: an allow rule allows`, allowed.behavior === 'allow' && allowed.decisionReason?.type === 'rule', said(allowed))
  const byEdit = read(name, HOSTS, context({ allow: ['Edit(ssh://web1/**)'] }))
  check(`${name}: a rule that allows the edit allows the read`, byEdit.behavior === 'allow', said(byEdit))
  const both = read(name, HOSTS, context({ allow: ['Read(ssh://web1/**)'], deny: ['Read(ssh://web1/etc/**)'] }))
  check(`${name}: deny outranks allow`, both.behavior === 'deny', said(both))
  const plain = read(name, HOSTS, context())
  check(`${name}: with no rule it is the ordinary ask, in today's sentence`, plain.behavior === 'ask' && plain.message === 'Permission to read from ssh://web1/etc/hosts has not been granted.' && plain.decisionReason?.type === 'workingDir', said(plain))
  check(`${name}: the ask offers the host for the session and nothing else`, JSON.stringify(grants(plain)) === JSON.stringify(['allow session Read(ssh://web1/**)']), JSON.stringify(grants(plain)))
  const other = read(name, 'ssh://web2/etc/hosts', context({ allow: ['Read(ssh://web1/**)'] }))
  check(`${name}: a rule for one host says nothing of another`, other.behavior === 'ask', said(other))
}

section('§3 writing: Edit and Write on a remote path')
for (const name of ['Edit', 'Write']) {
  const denied = write(name, HOSTS, context({ deny: ['Edit(ssh://web1/etc/**)'] }))
  check(`${name}: a deny rule denies, in the rule's own sentence`, denied.behavior === 'deny' && denied.message === 'Editing ssh://web1/etc/hosts is denied by the rule Edit(ssh://web1/etc/**) in your user settings.', said(denied))
  const asked = write(name, HOSTS, context({ ask: ['Edit(ssh://web1/**)'], allow: ['Edit(ssh://web1/**)'] }))
  check(`${name}: an ask rule asks before an allow rule allows`, asked.behavior === 'ask' && asked.decisionReason?.type === 'rule', said(asked))
  const allowed = write(name, HOSTS, context({ allow: ['Edit(ssh://web1/**)'] }))
  check(`${name}: an allow rule allows`, allowed.behavior === 'allow', said(allowed))
  const readOnly = write(name, HOSTS, context({ allow: ['Read(ssh://web1/**)'] }))
  check(`${name}: a rule that allows the read does not allow the edit`, readOnly.behavior === 'ask', said(readOnly))
  const plain = write(name, HOSTS, context())
  check(`${name}: with no rule it is the ordinary ask, in today's sentence`, plain.behavior === 'ask' && plain.message === 'Permission to write to ssh://web1/etc/hosts has not been granted.', said(plain))
  check(`${name}: the ask offers what an edit outside the folder offers, for the host`, JSON.stringify(grants(plain)) === JSON.stringify(['setMode implement', 'allow session Edit(ssh://web1/**)']), JSON.stringify(grants(plain)))
  const implement = write(name, HOSTS, context({}, 'implement'))
  check(`${name}: the mode that accepts edits in the folder still asks for another machine`, implement.behavior === 'ask' && JSON.stringify(grants(implement)) === JSON.stringify(['allow session Edit(ssh://web1/**)']), said(implement))
  const apollo = write(name, HOSTS, context({ allow: ['Edit(ssh://web1/**)'] }, 'apollo'))
  check(`${name}: Apollo Mode refuses the write as it refuses any outside the spec files`, apollo.behavior === 'deny' && /^Apollo Mode refused writing ssh:\/\/web1\/etc\/hosts:/.test(apollo.message ?? ''), said(apollo))
}

section('§4 a tool that does not take a remote path is judged as before')
for (const name of ['NotebookEdit', 'AstSearch', 'AstEdit', 'ChangeSet', 'LspRead']) {
  const before = read(name, HOSTS, context())
  check(`${name}: a path that begins ssh:// is still the local path it was`, before.behavior === 'allow' && before.message === undefined, said(before))
}

section('§5 a configuration name and the host it resolves to')
{
  const byName = context({ deny: ['Read(ssh://web1/**)'] })
  const byAddress = context({ deny: ['Read(ssh://10.0.0.5/etc/**)'] })
  check('unresolved, the address is not covered by the rule for the name', read('Read', 'ssh://10.0.0.5/etc/hosts', byName).behavior === 'ask')
  noteResolvedAuthority({ host: 'web1' }, { hostname: '10.0.0.5', user: 'deploy', port: 22 })
  noteResolvedAuthority({ host: '10.0.0.5' }, { hostname: '10.0.0.5', user: 'me', port: 22 })
  check('resolved, a deny for the name denies the address', read('Read', 'ssh://10.0.0.5/etc/hosts', byName).behavior === 'deny', said(read('Read', 'ssh://10.0.0.5/etc/hosts', byName)))
  check('and a deny for the address denies the name', read('Read', HOSTS, byAddress).behavior === 'deny' && read('Read', 'ssh://web1/srv/x', byAddress).behavior === 'ask')
  check('a rule naming a user covers the user the configuration gives', read('Read', HOSTS, context({ deny: ['Read(ssh://deploy@web1/**)'] })).behavior === 'deny' && read('Read', HOSTS, context({ deny: ['Read(ssh://root@web1/**)'] })).behavior === 'ask')
  const listed = readDenialFilter(context({ deny: ['Read(ssh://web1/srv/secret/**)', 'Read(ssh://web1/**/*.pem)'] }), 'ssh://web1/srv')
  check('a search answer under a deny is filtered, the rest is kept', listed('ssh://web1/srv/secret/k.txt') && listed('ssh://web1/srv/app/tls/site.pem') && !listed('ssh://web1/srv/app/main.py') && !listed('ssh://web1/srv'))
}

section('§6 the decision, mode by mode')
const fake = (name: string, kind: 'read' | 'edit') =>
  ({
    name,
    inputSchema: z.object({ file_path: z.string() }),
    isReadOnly: () => kind === 'read',
    checkPermissions: (input: { file_path: string }, ctx: { getAppState: () => { toolPermissionContext: Ctx } }) =>
      (kind === 'read' ? checkReadPermissionForTool : checkWritePermissionForTool)(tool(name), input, ctx.getAppState().toolPermissionContext),
  }) as never
const decide = async (name: string, kind: 'read' | 'edit', mode: string, rules: Rules = {}): Promise<Decision> => {
  const state = { toolPermissionContext: context(rules, mode, 'localSettings') }
  const ctx = { abortController: new AbortController(), getAppState: () => state, setAppState: () => {}, messages: [], options: {} } as never
  const outcome = await decideToolPermissionWithModes(fake(name, kind), { file_path: HOSTS }, ctx, { message: { id: 'ssh-path-rules' } } as never, 'ssh-path-rules')
  return outcome.decision as Decision
}
for (const [name, kind] of [['Read', 'read'], ['Edit', 'edit']] as const) {
  const sovereign = await decide(name, kind, 'sovereign')
  check(`${name} in the mode that asks nothing: allowed, nothing asked`, sovereign.behavior === 'allow', said(sovereign))
  const sovereignDenied = await decide(name, kind, 'sovereign', { deny: [`${name}(ssh://web1/**)`] })
  check(`${name} in the mode that asks nothing: a deny rule still denies`, sovereignDenied.behavior === 'deny', said(sovereignDenied))
  const plain = await decide(name, kind, 'default')
  check(`${name} in the default mode: one ask`, plain.behavior === 'ask', said(plain))
  const allowed = await decide(name, kind, 'default', { allow: [`${name}(ssh://web1/**)`] })
  check(`${name} in the default mode with the host allowed: no ask`, allowed.behavior === 'allow', said(allowed))
  const dontAsk = await decide(name, kind, 'dontAsk')
  check(`${name} in the mode that does not ask: denied, as any unapproved path is`, dontAsk.behavior === 'deny', said(dontAsk))
}

section('§7 what the ask offers')
{
  const readOffer = generateSuggestions('ssh://deploy@web1:2222/~/x', 'read', context()) as unknown as Decision['suggestions']
  check('a read offers the authority as written', JSON.stringify(grants({ behavior: 'ask', suggestions: readOffer })) === JSON.stringify(['allow session Read(ssh://deploy@web1:2222/**)']))
  const kept = read('Read', 'ssh://deploy@web1:2222/~/x', context({ allow: ['Read(ssh://deploy@web1:2222/**)'] }, 'default', 'session'))
  check('and the offered rule, once in the session, allows the next read on the host', kept.behavior === 'allow', said(kept))
  const localOffer = generateSuggestions(join(scratch, 'elsewhere', 'x.txt'), 'read', context()) as unknown as Decision['suggestions']
  check('a local path outside the folder is offered its folder as before', (localOffer ?? []).length > 0 && grants({ behavior: 'ask', suggestions: localOffer }).every(row => row.startsWith('allow session Read(//') && row.endsWith('/elsewhere/**)')), JSON.stringify(localOffer))
}

console.log(`\nssh path rules: ${checks - failures} of ${checks} ${failures === 0 ? 'PASS' : 'FAIL'}`)
process.chdir(launchDir)
removeScratch(scratch)
process.exit(failures === 0 ? 0 : 1)
