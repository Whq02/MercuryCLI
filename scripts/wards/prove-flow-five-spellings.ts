#!/usr/bin/env bun

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

let failures = 0
let checks = 0
function check(label: string, ok: boolean, detail = ''): void {
  checks += 1
  if (!ok) failures += 1
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail.slice(0, 600)}` : ''}`)
}
function section(title: string): void {
  console.log(`\n${'─'.repeat(76)}\n${title}`)
}
function note(text: string): void {
  console.log(`  [NOTE] ${text}`)
}

const ROOT = join(import.meta.dir, '..', '..')
const SRC = join(ROOT, 'src')
const RUN_ROOT = process.env.FLOW_SPELLINGS_ROOT ?? realpathSync(mkdtempSync(join(tmpdir(), 'flow-five-spellings-')))
const FAKE_USER = 'operator'
const CONFIG_HOME = join(RUN_ROOT, 'config')
const OWN_HOME = join(RUN_ROOT, 'work', 'fake-home', 'Users', FAKE_USER)
const PROJECT = join(RUN_ROOT, 'work', 'floors-project')
if (process.env.FLOW_SPELLINGS_ROOT === undefined) {
  mkdirSync(join(CONFIG_HOME, 'tmp'), { recursive: true })
  mkdirSync(OWN_HOME, { recursive: true })
  const child = Bun.spawnSync([process.execPath, ...process.argv.slice(1)], {
    env: { ...process.env, HOME: OWN_HOME, USERPROFILE: OWN_HOME, USER: FAKE_USER, LOGNAME: FAKE_USER, FLOW_SPELLINGS_ROOT: RUN_ROOT, MERCURY_CONFIG_DIR: CONFIG_HOME, MERCURY_TMPDIR: join(CONFIG_HOME, 'tmp') },
    stdio: ['inherit', 'inherit', 'inherit'],
  })
  process.exit(child.exitCode ?? 99)
}
if (homedir() !== OWN_HOME) {
  process.stderr.write(`prove-flow-five-spellings: the scratch home did not take (os.homedir() is ${homedir()}, wanted ${OWN_HOME})\n`)
  process.exit(98)
}
delete process.env.MERCURY_HOME
process.env.MERCURY_CREDENTIAL_STORE ??= 'file'
process.env.MERCURY_LOCAL_PROBE_TARGETS ??= 'none'
process.env.MERCURY_DESKTOP_DRIVER ??= 'none'
process.env.MERCURY_DAEMON_DIR = join(CONFIG_HOME, 'daemon')
process.env.BROWSER = '/usr/bin/true'
for (const key of ['ANTHROPIC_BASE_URL', 'ANTHROPIC_AUTH_TOKEN', 'MERCURY_SKIP_PERMISSIONS', 'MERCURY_WARDS', 'MERCURY_SPAWNED_BY']) delete process.env[key]

mkdirSync(PROJECT, { recursive: true })
for (const dir of ['.ssh', '.aws', 'Documents']) mkdirSync(join(OWN_HOME, dir), { recursive: true })
writeFileSync(join(OWN_HOME, '.ssh', 'authorized_keys'), 'ssh-ed25519 AAAA stand-in\n')
writeFileSync(join(OWN_HOME, '.aws', 'credentials'), '[default]\naws_secret_access_key = STAND-IN\n')
for (const file of ['.credentials.json', '.provider-secrets.json', 'mcp-auth.json', 'browser-secrets.json']) writeFileSync(join(CONFIG_HOME, file), '{"secret":"CANARY-MERCURY-SECRET-2207"}\n')
writeFileSync(join(CONFIG_HOME, 'notes.md'), 'a plain file of the config home\n')
mkdirSync(join(CONFIG_HOME, 'runtime', 'current'), { recursive: true })
mkdirSync(join(CONFIG_HOME, 'daemon'), { recursive: true })
writeFileSync(join(CONFIG_HOME, 'runtime', 'current', 'mercury.mjs'), 'export {}\n')
mkdirSync(join(PROJECT, '.git'), { recursive: true })
mkdirSync(join(PROJECT, 'docs'), { recursive: true })
mkdirSync(join(PROJECT, 'build'), { recursive: true })
writeFileSync(join(PROJECT, '.env'), 'SECRET=CANARY-DOTENV-3318\n')
writeFileSync(join(PROJECT, 'MERCURY.md'), '# instructions\n')
writeFileSync(join(PROJECT, 'AGENTS.md'), '# agents\n')
writeFileSync(join(PROJECT, 'docs', 'plain.md'), 'a plain document\n')
writeFileSync(join(PROJECT, 'notes.txt'), 'notes\n')
process.chdir(PROJECT)

const standIn = spawn('/bin/sleep', ['600'], { stdio: 'ignore' })
const DAEMON_PID = standIn.pid ?? 0
process.on('exit', () => {
  try {
    standIn.kill('SIGTERM')
  } catch {}
})

const { z } = (await import(Bun.resolveSync('zod/v4', ROOT))) as typeof import('zod/v4')
const { getEmptyToolPermissionContext } = await import(join(SRC, 'Tool.ts'))
const { decideToolPermissionWithModes } = await import(join(SRC, 'utils/permissions/decision/wrapper.ts'))
const { bashToolHasPermission } = await import(join(SRC, 'tools/BashTool/bashPermissions.ts'))
const { enableConfigs } = await import(join(SRC, 'utils/config.ts'))
const { daemonStatePath } = await import(join(SRC, 'daemon/controlSocket.ts'))
const { FileReadTool } = await import(join(SRC, 'tools/FileReadTool/FileReadTool.ts'))
const { FileWriteTool } = await import(join(SRC, 'tools/FileWriteTool/FileWriteTool.ts'))
const { FileEditTool } = await import(join(SRC, 'tools/FileEditTool/FileEditTool.ts'))
const { EvalTool } = await import(join(SRC, 'tools/EvalTool/EvalTool.ts'))
const keychain = await import(join(SRC, 'utils/secureStorage/macOsKeychainHelpers.ts'))
const { flagEnv } = await import(join(SRC, 'substrate/flagRegistry.ts'))
enableConfigs()
const bootstrap = await import(join(SRC, 'bootstrap/state.ts'))
bootstrap.setOriginalCwd(PROJECT)
bootstrap.setCwdState(PROJECT)
bootstrap.setProjectRoot(PROJECT)
writeFileSync(daemonStatePath(), JSON.stringify({ pid: DAEMON_PID, startedAt: Date.now(), script: join(CONFIG_HOME, 'runtime', 'current', 'mercury.mjs') }))

type Decision = { behavior: string; message?: string }
type Rules = { deny?: string[]; allow?: string[]; ask?: string[] }
type Mode = 'default' | 'implement' | 'apollo' | 'flow' | 'sovereign'
type Call = { tool?: string; command?: string; input?: Record<string, unknown>; why?: string; rules?: Rules }
const bashTool = {
  name: 'Bash',
  inputSchema: z.object({ command: z.string() }),
  checkPermissions: (input: { command: string }, context: { getAppState: () => { toolPermissionContext: unknown } }) => bashToolHasPermission(input, context.getAppState().toolPermissionContext as never),
} as never
const TOOLS: Record<string, unknown> = { Bash: bashTool, Read: FileReadTool, Write: FileWriteTool, Edit: FileEditTool, Eval: EvalTool }

async function decide(tool: string, input: Record<string, unknown>, mode: string, rules: Rules = {}, extra: Record<string, unknown> = {}): Promise<Decision> {
  const state = {
    toolPermissionContext: {
      ...getEmptyToolPermissionContext(),
      mode,
      isBypassPermissionsModeAvailable: mode === 'sovereign',
      alwaysDenyRules: rules.deny ? { localSettings: rules.deny } : {},
      alwaysAllowRules: rules.allow ? { localSettings: rules.allow } : {},
      alwaysAskRules: rules.ask ? { localSettings: rules.ask } : {},
      ...extra,
    },
  }
  const context = { abortController: new AbortController(), getAppState: () => state, setAppState: () => {}, messages: [], options: { tools: [] }, readFileState: new Map() } as never
  try {
    const outcome = await decideToolPermissionWithModes(TOOLS[tool] as never, input, context, { message: { id: 'flow-five-spellings' } } as never, 'flow-five-spellings')
    return outcome.decision as Decision
  } catch (error) {
    return { behavior: 'threw', message: error instanceof Error ? error.message : String(error) }
  }
}

const fill = (text: string): string => text.replaceAll('<HOME>', OWN_HOME).replaceAll('<USER>', FAKE_USER).replaceAll('<CONFIG>', CONFIG_HOME).replaceAll('<PROJECT>', PROJECT).replaceAll('<DAEMON_PID>', String(DAEMON_PID)).replaceAll('<OWN_PID>', String(process.pid))
const shown = (text: string): string => JSON.stringify(text.replaceAll(OWN_HOME, '<home>').replaceAll(CONFIG_HOME, '<config>').replaceAll(PROJECT, '<project>').replaceAll(String(DAEMON_PID), '<daemon pid>').replaceAll(String(process.pid), '<own pid>'))
const said = (decision: Decision): string => `${decision.behavior}${decision.message ? `: ${decision.message.replaceAll('\n', ' ').replaceAll(OWN_HOME, '<home>').replaceAll(CONFIG_HOME, '<config>').replaceAll(PROJECT, '<project>').slice(0, 160)}` : ''}`
const bash = (command: string, why?: string, rules?: Rules): Call => ({ command, why, rules })
const call = (tool: string, input: Record<string, unknown>, why?: string, rules?: Rules): Call => ({ tool, input, why, rules })
const wanted = process.argv.slice(2).filter(arg => !arg.startsWith('--'))
const runs = (id: string): boolean => wanted.length === 0 || wanted.includes(id)

async function reading(item: Call, mode: Mode): Promise<{ decision: Decision; what: string }> {
  const tool = item.tool ?? 'Bash'
  const input = item.input ? (JSON.parse(fill(JSON.stringify(item.input))) as Record<string, unknown>) : { command: fill(item.command ?? '') }
  const decision = await decide(tool, input, mode, item.rules ?? {})
  const what = tool === 'Bash' ? shown(String(input.command)) : `${tool} ${shown(JSON.stringify(input)).slice(0, 150)}`
  return { decision, what }
}
async function expect(id: string, item: Call, modes: Mode[], good: (decision: Decision) => boolean, claim: string): Promise<void> {
  for (const mode of modes) {
    const { decision, what } = await reading(item, mode)
    check(`${id} · ${mode} · ${what}${item.why ? ` (${item.why})` : ''} · ${claim}`, good(decision), said(decision))
  }
}
const notAllowed = (decision: Decision): boolean => decision.behavior !== 'allow'
const refused = (decision: Decision): boolean => decision.behavior === 'deny'
const asked = (decision: Decision): boolean => decision.behavior === 'ask'
const allowed = (decision: Decision): boolean => decision.behavior === 'allow'
const notRefused = (decision: Decision): boolean => decision.behavior !== 'deny' && decision.behavior !== 'threw'
const refusedAsSecret = (decision: Decision): boolean => decision.behavior === 'deny' && /holds? Mercury's own credentials/.test(decision.message ?? '')

function pageSays(pattern: RegExp): boolean {
  return pattern.test(
    readFileSync(join(ROOT, 'docs', 'TRUST.md'), 'utf8')
      .split('\n')
      .map(line => line.trim())
      .join(' '),
  )
}

const O = '/Users/<USER>/Documents/keep'
const flow = (command: string, rules: Rules = {}, extra: Record<string, unknown> = {}): Promise<Decision> => decide('Bash', { command: fill(command) }, 'flow', rules, extra)

async function asks(id: string, command: string, why = ''): Promise<void> {
  const decision = await flow(command)
  check(`${id} · ${shown(fill(command))}${why ? ` (${why})` : ''} · Flow asks`, decision.behavior === 'ask' && /^Flow asks before /.test(decision.message ?? ''), said(decision))
}
async function free(command: string, why: string): Promise<void> {
  const decision = await flow(command)
  check(`free · ${shown(fill(command))} (${why}) · runs with no ask`, decision.behavior === 'allow', said(decision))
}

section('the page, docs/TRUST.md')
check('Flow runs everything Sovereign runs except five things, which ask', pageSays(/\*\*Flow mode\*\* runs everything Sovereign runs except five things, which ask/))
check('sudo and any other privilege escalation', pageSays(/`sudo` and any other privilege escalation/))
check('git that publishes or rewrites history: a push in any form', pageSays(/git that publishes or rewrites history \(`git push` in any form, `reset --hard`, `clean -f`, `branch -D`, `filter-branch`, and `gh pr merge`, `gh release create` and their kin\)/))
check('publishing and deploying, and the rest of that table', pageSays(/publishing and deploying \(`npm publish`, `docker push`, `wrangler deploy`, `terraform apply`, `kubectl apply` and the rest of that table\)/))
check('deleting or overwriting a path outside the project', pageSays(/deleting or overwriting a path outside the project, its worktrees, this run's scratch and the temp folders \(reads are free everywhere\)/))
check('with no host, a call one of the five names is refused with the same sentence', pageSays(/With no host, a call one of the five names is refused with the same sentence; everything else runs/))

section("controls: the five, each asked in the page's own words; what the page says is free")
for (const [command, sentence] of [
  ['doas true', /^Flow asks before doas: /],
  ['su -c true', /^Flow asks before su: /],
  ['git push origin main', /^Flow asks before git push: it publishes history\.$/],
  ['git -C sub push origin main', /^Flow asks before git push: it publishes history\.$/],
  ['env GIT_SSH_COMMAND=x /usr/bin/git --no-pager push', /^Flow asks before git push: /],
  ['bash -c "git push"', /^Flow asks before git push: /],
  ['git reset --hard HEAD~1', /^Flow asks before git reset --hard: it rewrites history\.$/],
  ['git clean -fdx', /^Flow asks before git clean -f: /],
  ['git branch -D x', /^Flow asks before git branch -D: /],
  ['git filter-branch --tree-filter x HEAD', /^Flow asks before git filter-branch: /],
  ['gh pr merge 12', /^Flow asks before gh pr merge: /],
  ['gh release create v1', /^Flow asks before gh release create: /],
  ['npm publish', /^Flow asks before npm publish: it publishes a package\.$/],
  ['docker push x/y:1', /^Flow asks before docker push: /],
  ['wrangler deploy', /^Flow asks before wrangler deploy: /],
  ['terraform apply -auto-approve', /^Flow asks before terraform apply: /],
  ['kubectl apply -f k.yml', /^Flow asks before kubectl apply: /],
  [`rm -rf ${O}`, /^Flow asks before rm -rf .*: it deletes .*, outside the project\.$/],
  [`echo x > ${O}/a.txt`, /^Flow asks before .*: it writes .*, outside the project\.$/],
  [`cp notes.txt ${O}/a.txt`, /^Flow asks before cp .*: it overwrites .*, outside the project\.$/],
  [`find ${O} -type f -exec rm {} +`, /^Flow asks before find .*: it deletes under .*, outside the project\.$/],
  [`cd ${O} && rm -rf *`, /^Flow asks before rm -rf \*: it deletes .*, outside the project\.$/],
] as const) {
  const decision = await flow(command)
  check(`control · ${shown(fill(command))} · asked in one sentence`, decision.behavior === 'ask' && sentence.test(decision.message ?? ''), said(decision))
}
await free('git stash push', 'not a publish')
await free('git clean -n', 'a dry run')
await free(`cat ${O}/a.txt`, 'a read outside the project')
await free('rm notes.txt', 'a delete inside the project')
await free('rm /tmp/scratch-x', 'a temp folder')
await free('npm install left-pad', 'none of the five')
{
  const denied = await flow('git push origin main', { deny: ['Bash(git push *)'] })
  check('a deny rule refuses the push outright', denied.behavior === 'deny', said(denied))
  const allowedPush = await flow('git push origin main', { allow: ['Bash(git push *)'] })
  check('Bash(git push *) in the allow rules decides the push before any ask', allowedPush.behavior === 'allow', said(allowedPush))
  const hostless = await flow('git push origin main', {}, { shouldAvoidPermissionPrompts: true })
  check('with no host the push is refused with the same sentence', hostless.behavior === 'deny' && /Flow asks before git push: it publishes history\./.test(hostless.message ?? ''), said(hostless))
  const hostlessAlias = await flow('git -c alias.p=push p origin main', {}, { shouldAvoidPermissionPrompts: true })
  check('with no host a push behind an alias is refused with the same sentence', hostlessAlias.behavior === 'deny' && /Flow asks before git push: it publishes history\./.test(hostlessAlias.message ?? ''), said(hostlessAlias))
  const sovereign = await decide('Bash', { command: 'git -c alias.p=push p origin main' }, 'sovereign')
  check('under Sovereign none of this asks', sovereign.behavior === 'allow', said(sovereign))
}

if (runs('T-7.1')) {
  section('T-7.1 "sudo and any other privilege escalation": tools that hand out root')
  for (const [command, why] of [['run0 true', "systemd's replacement for sudo"], ['sudo-rs true', 'sudo by another program name'], ['please true', 'a sudo alternative'], ['machinectl shell root@ /bin/true', 'a root shell through systemd']] as const) await asks('T-7.1', command, why)
}

if (runs('T-7.2')) {
  section('T-7.2 "git push in any form", and reset --hard, in the forms a shell runs')
  for (const [command, why] of [
    ['git -c alias.p=push p origin main', 'an alias made on the line'],
    ['git config alias.p push && git p origin main', 'an alias made one command earlier'],
    ['git send-pack origin main', 'the plumbing a push runs'],
    ['git-push origin main', 'the dashed program'],
    ['git subtree push --prefix=x origin main', ''],
    ['git lfs push origin main', ''],
    ['git pu\\sh origin main', 'a backslash the shell drops'],
    ['G=git; $G push origin main', 'the program in a variable'],
    ['S=push; git $S origin main', 'the verb in a variable'],
    ['git $(echo push) origin main', 'the verb from a substitution'],
    ["sh <<'EOF'\ngit push origin main\nEOF", 'a heredoc fed to a shell'],
    ["echo 'git push origin main' | sh", 'a shell fed by a pipe'],
    ['git -c alias.r="reset --hard" r HEAD~1', 'reset --hard behind an alias'],
    ['git reset --har HEAD~1', 'the long option abbreviated, as git accepts'],
  ] as const) await asks('T-7.2', command, why)
}

if (runs('T-7.4')) {
  section('T-7.4 an entry of the table with a global option in front of its verb')
  for (const command of ['kubectl --context prod apply -f k.yml', 'kubectl -n prod delete pod x', 'helm -n prod upgrade r chart', 'aws --profile prod s3 rm s3://bucket/key', 'gcloud --project p run deploy svc', 'gh -R o/r pr merge 12', 'docker --context prod push x/y:1', 'npm --registry https://r.example.invalid publish']) await asks('T-7.4', command)
}

if (runs('T-7.5')) {
  section('T-7.5 a delete or an overwrite outside the project in the forms a shell runs')
  for (const [command, why] of [
    [`D=${O}; rm -rf $D`, 'the path in a variable'],
    [`rm -rf "$(dirname ${O}/a.txt)"`, 'the path computed at run time'],
    [`find ${O} -type f | xargs rm`, 'the paths piped in'],
    ['rm /Users/<USER>/Documents/*.txt', 'a glob outside'],
    [`tar -xf a.tar -C ${O}`, 'an archive extracted over it'],
    [`unzip -o a.zip -d ${O}`, ''],
    [`git -C ${O} checkout -- .`, 'files there overwritten by git'],
    [`patch ${O}/a.txt < p.diff`, ''],
    [`python3 -c "import os; os.remove('${O}/a.txt')"`, 'another language, the path spelled out'],
    [`node -e "require('fs').rmSync('${O}', {recursive: true})"`, ''],
  ] as const) await asks('T-7.5', command, why)
}

if (runs('FREE')) {
  section('FREE · the same programs doing none of the five run with no ask')
  for (const [command, why] of [
    ['kubectl -n prod get pods', 'a read behind a global option'],
    ['kubectl --context prod describe pod x', 'a read behind a global option'],
    ['helm -n prod list', 'a listing'],
    ['aws --profile prod s3 ls', 'a listing'],
    ['gh -R o/r pr view 12', 'a read'],
    ['docker --context prod ps', 'a listing'],
    ['npm --loglevel verbose install left-pad', 'an install'],
    ['git -c alias.st=status st', 'an alias of a read'],
    ['git config alias.co checkout && git co main', 'an alias of a checkout in the project'],
    ['git -C sub checkout -- .', 'git writing inside the project'],
    ['git lfs pull', 'not a push'],
    ['tar -xf a.tar -C build', 'an archive extracted into the project'],
    ['unzip -o a.zip -d build', ''],
    ['patch notes.txt < p.diff', 'a patch inside the project'],
    ['find build -type f | xargs rm', 'a listing of a project folder piped to a delete'],
    ['D=build; rm -rf $D', 'a project folder in a variable'],
    ["python3 -c \"import os; os.remove('build/a.txt')\"", 'another language, a path in the project'],
    ['machinectl list', 'a listing'],
  ] as const) await free(command, why)
}

if (runs('notes')) {
  section('notes: git that rewrites history and is not on the page\'s list stays as it is (no check)')
  for (const command of ['git rebase -i HEAD~3', 'git commit --amend -m x', 'git branch -f main HEAD~3', 'git update-ref -d refs/heads/x', 'git checkout -B main HEAD~3']) note(`${shown(command)}: ${said(await flow(command)).slice(0, 80)}`)
}

console.log(`\nprove-flow-five-spellings: ${checks} checks, ${failures} failed`)
process.exit(failures === 0 ? 0 : 1)
