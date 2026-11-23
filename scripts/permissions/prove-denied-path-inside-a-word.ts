#!/usr/bin/env bun
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod/v4'

const world = realpathSync(mkdtempSync(join(tmpdir(), 'path-inside-a-word-')))
const config = join(world, 'config')
const run = join(world, 'run')
mkdirSync(config)
mkdirSync(join(run, 'secrets'), { recursive: true })
mkdirSync(join(run, 'sub'))
writeFileSync(join(run, 'secrets', 'k.txt'), 'K\n')
writeFileSync(join(run, 'sub', 'hidden.key'), 'K\n')
writeFileSync(join(run, 'notes.txt'), 'notes\n')
const startedIn = process.cwd()
process.chdir(run)
process.env.MERCURY_CONFIG_DIR = config
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
process.env.NODE_ENV = 'test'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const { getEmptyToolPermissionContext } = await import('../../src/tools/kit/tool.ts')
const { decideToolPermissionWithModes } = await import('../../src/permissions/rules/decision/wrapper.ts')
const { bashToolHasPermission } = await import('../../src/tools/shell/bashPermissions.ts')
const { enableConfigs } = await import('../../src/platform/settings/config.ts')
const { setOriginalCwd, setCwdState, setProjectRoot, setSessionTrustAccepted } = await import('../../src/boot/process-state/processState.ts')
setSessionTrustAccepted(true)
enableConfigs()
setOriginalCwd(run)
setCwdState(run)
setProjectRoot(run)

let checks = 0
let failures = 0
const insideAWordHint = 'change denyRuleReach (the hide calls for a program Mercury cannot follow), hiddenDenyRuleAsk and hiddenDenyRuleRefusal in src/tools/shell/denyRuleReach.ts, which decideToolPermissionWithModes in src/permissions/rules/decision/wrapper.ts reaches through bashToolHasPermission'
function check(label: string, ok: boolean, detail = ''): void {
  checks++
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail.slice(0, 520)}` : ''}${ok ? '' : ` — ${insideAWordHint}`}`)
}
const section = (title: string): void => console.log(`\n${title}`)
const shown = (text: string): string => text.replaceAll(world, '<world>')

type Decision = { behavior: string; message?: string; decisionReason?: { type?: string; reason?: string; operatorOnly?: boolean }; suggestions?: unknown[] }
const bash = {
  name: 'Bash',
  inputSchema: z.object({ command: z.string() }),
  checkPermissions: (input: { command: string }, context: { getAppState: () => { toolPermissionContext: unknown } }) => bashToolHasPermission(input, context.getAppState().toolPermissionContext as never),
} as never
async function door(command: string, mode: string, deny: string[]): Promise<Decision> {
  const state = { toolPermissionContext: { ...getEmptyToolPermissionContext(), mode, isBypassPermissionsModeAvailable: mode === 'sovereign', alwaysDenyRules: deny.length > 0 ? { localSettings: deny } : {}, alwaysAllowRules: {}, alwaysAskRules: {} } }
  const context = { abortController: new AbortController(), getAppState: () => state, setAppState: () => {}, messages: [], options: {} } as never
  return (await decideToolPermissionWithModes(bash, { command }, context, { message: { id: 'inside-a-word' } } as never, 'inside-a-word')).decision as Decision
}

const READ = ['Read(secrets/**)', 'Read(**/hidden.key)']
const KEPT = join(run, 'secrets', 'k.txt')

async function refusedUnderBoth(label: string, command: string, program: string, path: string, rule: string, deny: string[] = READ): Promise<void> {
  for (const mode of ['sovereign', 'flow']) {
    const decision = await door(command, mode, deny)
    const said = decision.message ?? ''
    check(
      `${mode} · ${label}: ${command} is refused, with the path and the rule`,
      decision.behavior === 'deny' && said.includes(`its effect could not be established (${program} is not a command Mercury can follow and it names ${path})`) && said.includes(`the rule ${rule}`) && said.includes('denies what it may do'),
      shown(JSON.stringify(decision)),
    )
  }
  const asked = await door(command, 'default', deny)
  check(
    `default · ${label}: the question names the path and the rule, and offers no rule to allow it by`,
    asked.behavior === 'ask' && asked.message === `${program} is not a command Mercury can follow and it names ${path}, and the rule ${rule} in the project local settings denies what it may do; spell it out as plain commands with literal paths, or approve` && asked.decisionReason?.type === 'safetyCheck' && asked.decisionReason.reason === asked.message && asked.suggestions === undefined,
    shown(JSON.stringify(asked)),
  )
}
async function leftToTheMode(label: string, command: string, deny: string[] = READ): Promise<void> {
  const plain = await door(command, 'default', deny)
  const sovereign = await door(command, 'sovereign', deny)
  const flow = await door(command, 'flow', deny)
  check(`${label}: ${command} is no rule's business (default ${plain.behavior}, sovereign ${sovereign.behavior}, flow ${flow.behavior})`, plain.behavior === 'ask' && !(plain.message ?? '').includes('denies what it may do') && sovereign.behavior === 'allow' && flow.behavior === 'allow', shown(JSON.stringify({ plain, sovereign, flow })))
}

try {
  section('§1 the read spelled plainly, and through a shell Mercury follows, is denied in every mode')
  for (const command of ['cat secrets/k.txt', "sh -c 'cat secrets/k.txt'", "bash -c 'cat secrets/k.txt'"]) {
    for (const mode of ['default', 'sovereign', 'flow']) {
      const decision = await door(command, mode, READ)
      check(`${mode} · ${command}: denied`, decision.behavior === 'deny', shown(JSON.stringify(decision)))
    }
  }

  section('§2 the same read as one quoted word of a program Mercury cannot follow')
  const spellings: Array<[string, string, string]> = [
    ['cmd, the command string in single quotes', "cmd //c 'type secrets\\k.txt'", 'cmd'],
    ['cmd, in double quotes', 'cmd //c "type secrets\\k.txt"', 'cmd'],
    ['cmd, another reader', "cmd //c 'more secrets\\k.txt'", 'cmd'],
    ['cmd.exe', "cmd.exe //c 'type secrets\\k.txt'", 'cmd.exe'],
    ['cmd, the path with a forward slash', "cmd //c 'type secrets/k.txt'", 'cmd'],
    ['cmd, the path a word of its own with a backslash', "cmd //c type 'secrets\\k.txt'", 'cmd'],
    ['pwsh -c', "pwsh -NoProfile -c 'Get-Content secrets/k.txt'", 'pwsh'],
    ['powershell -c', "powershell -c 'type secrets/k.txt'", 'powershell'],
    ['powershell.exe -Command', "powershell.exe -NoProfile -Command 'Get-Content secrets/k.txt'", 'powershell.exe'],
    ['pwsh, a pattern inside the word', "pwsh -c 'Get-Content secrets/*'", 'pwsh'],
    ['python3, a shell line inside a string', `python3 -c 'import os; os.system("cat secrets/k.txt")'`, 'python3'],
    ['node, a shell line inside a string', `node -e 'require("child_process").execSync("cat secrets/k.txt")'`, 'node'],
    ['perl, the path behind its open mode', `perl -e 'open(F, "<secrets/k.txt"); print <F>'`, 'perl'],
    ['perl, backticks', "perl -e 'print `cat secrets/k.txt`'", 'perl'],
    ['ruby, a shell line inside a string', `ruby -e 'system "cat secrets/k.txt"'`, 'ruby'],
    ['osascript, a shell line inside a string', `osascript -e 'do shell script "cat secrets/k.txt"'`, 'osascript'],
    ['a shell Mercury does not follow', "fish -c 'cat secrets/k.txt'", 'fish'],
  ]
  for (const [label, command, program] of spellings) await refusedUnderBoth(label, command, program, KEPT, 'Read(secrets/**)')
  await refusedUnderBoth('a file name the rule denies wherever it stands', "pwsh -c 'Get-Content sub/hidden.key -Raw'", 'pwsh', join(run, 'sub', 'hidden.key'), 'Read(**/hidden.key)')
  await refusedUnderBoth('a write rule, a write inside the word', "pwsh -c 'Set-Content secrets/new.txt x'", 'pwsh', join(run, 'secrets', 'new.txt'), 'Edit(secrets/**)', ['Edit(secrets/**)'])

  section('§3 the path as a word of its own was refused before; its default-mode question now names the rule too')
  await refusedUnderBoth('cmd, the path a word of its own', 'cmd /c type secrets/k.txt', 'cmd', KEPT, 'Read(secrets/**)')
  await refusedUnderBoth('python3, the path a quoted string of its code', `python3 -c 'print(open("secrets/k.txt").read())'`, 'python3', KEPT, 'Read(secrets/**)')

  section('§4 a word that names no denied path stays the mode\'s to answer')
  await leftToTheMode('a word of prose', "mytool --note 'nothing here'")
  await leftToTheMode('a folder\'s name in prose, with no path around it', "mytool --note 'rotate the secrets today'")
  await leftToTheMode('a read of a file no rule names', "pwsh -c 'Get-Content notes.txt'")
  await leftToTheMode('the same through cmd', "cmd //c 'type notes.txt'")
  await leftToTheMode('with no rule in force, the denied spelling itself', "cmd //c 'type secrets\\k.txt'", [])

  section('§5 refused now though the word only mentions the path: an unfollowed program may do anything with its words')
  for (const [label, command, program] of [
    ['a search for the text', "ag 'see secrets/k.txt' notes.txt", 'ag'],
    ['a note', "mytool --note 'see secrets/k.txt for the key'", 'mytool'],
    ['an issue\'s body', "gh issue create --body 'the file secrets/k.txt moved'", 'gh'],
  ] as const) await refusedUnderBoth(label, command, program, KEPT, 'Read(secrets/**)')
} finally {
  process.chdir(startedIn)
  rmSync(world, { recursive: true, force: true })
}

console.log(`\nprove-denied-path-inside-a-word: ${checks - failures}/${checks}${failures ? ` — ${failures} FAILURE(S)` : ' — ALL LAWS HOLD'}`)
process.exit(failures ? 1 : 0)
