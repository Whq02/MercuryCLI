#!/usr/bin/env bun
// gate-watch: src/utils/bash/ast.ts src/tools/BashTool/bashPermissions.ts src/tools/BashTool/readOnlyValidation.ts src/utils/permissions/decision/engine.ts
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod/v4'

const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'rule-answers-wildcard-')))
const before = process.cwd()
mkdirSync(join(scratch, 'run', 'src'), { recursive: true })
process.chdir(join(scratch, 'run'))
process.env.MERCURY_CONFIG_DIR = join(scratch, 'home')
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const { enableConfigs } = await import('../../src/utils/config.js')
enableConfigs()
const { getEmptyToolPermissionContext } = await import('../../src/Tool.js')
const { decideToolPermissionWithModes } = await import('../../src/utils/permissions/decision/wrapper.js')
const { bashToolHasPermission } = await import('../../src/tools/BashTool/bashPermissions.js')
const { checkReadOnlyConstraints } = await import('../../src/tools/BashTool/readOnlyValidation.js')

const WILDCARD_ASK = 'an unquoted wildcard expands to paths at runtime; quote it as text or spell out the paths, or approve'
type Rules = { allow?: string[]; deny?: string[]; ask?: string[]; source?: string }
type Verdict = { behavior: string; message?: string; decisionReason?: Record<string, unknown> }

let failures = 0
function check(label: string, ok: boolean, detail = ''): void {
  if (!ok) failures++
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${label}${ok || !detail ? '' : ` — ${detail}`}`)
}
function section(title: string): void {
  console.log(`\n── ${title}`)
}
function contextFor(mode: string, rules: Rules): Record<string, unknown> {
  const source = rules.source ?? 'localSettings'
  return {
    ...getEmptyToolPermissionContext(),
    mode,
    alwaysAllowRules: { [source]: rules.allow ?? [] },
    alwaysDenyRules: { [source]: rules.deny ?? [] },
    alwaysAskRules: { [source]: rules.ask ?? [] },
    isBypassPermissionsModeAvailable: mode === 'sovereign',
  }
}
async function floor(command: string, mode: string, rules: Rules = {}): Promise<Verdict> {
  return (await bashToolHasPermission({ command }, contextFor(mode, rules) as never)) as Verdict
}
const bash = {
  name: 'Bash',
  inputSchema: z.object({ command: z.string() }),
  checkPermissions: (input: { command: string }, context: { getAppState: () => { toolPermissionContext: unknown } }) =>
    bashToolHasPermission(input, context.getAppState().toolPermissionContext as never),
}
async function decision(command: string, mode: string, rules: Rules = {}): Promise<Verdict> {
  const state = { toolPermissionContext: contextFor(mode, rules), tasks: {} }
  const context = { getAppState: () => state, setAppState: () => {}, abortController: new AbortController(), messages: [], options: {} }
  const outcome = await decideToolPermissionWithModes(bash as never, { command }, context as never, { message: { id: 'rule-answers-wildcard' } } as never, 'toolu_rule_answers_wildcard')
  return outcome.decision as Verdict
}
function asksWithTodaysWords(verdict: Verdict): boolean {
  const reason = verdict.decisionReason ?? {}
  return verdict.behavior === 'ask' && verdict.message === WILDCARD_ASK && reason.type === 'safetyCheck' && reason.operatorOnly === false && !('floor' in reason)
}
const show = (verdict: Verdict): string => JSON.stringify({ behavior: verdict.behavior, message: verdict.message, reason: verdict.decisionReason?.type })

const LIST = 'ls *.ts'
const PIPE = 'cat src/*.js | wc -l'
const TABLE_RULES = { allow: ['Bash(ls *)', 'Bash(cat *)', 'Bash(wc *)'] }

section('(1) the measured table: the rule wins')
for (const command of [LIST, PIPE]) {
  check(`Default with no rule asks about ${command} with today's words`, asksWithTodaysWords(await floor(command, 'default')), show(await floor(command, 'default')))
  check(`Default with the operator's saved allow rules runs ${command}`, (await floor(command, 'default', TABLE_RULES)).behavior === 'allow', show(await floor(command, 'default', TABLE_RULES)))
  check(`Flow with no rule runs ${command} as a listed read`, (await floor(command, 'flow')).behavior === 'allow', show(await floor(command, 'flow')))
  check(`the whole decision in Flow runs ${command}`, (await decision(command, 'flow')).behavior === 'allow', show(await decision(command, 'flow')))
  check(`Sovereign answers the floor's ordinary ask and runs ${command}`, (await decision(command, 'sovereign')).behavior === 'allow', show(await decision(command, 'sovereign')))
  check(`the floor itself still asks under Sovereign for ${command}; the mode answers`, asksWithTodaysWords(await floor(command, 'sovereign')), show(await floor(command, 'sovereign')))
}
for (const command of ['cat src/a.js src/b.js | wc -l', 'cat "src/*.js" | wc -l', 'ls src']) {
  for (const mode of ['default', 'flow']) {
    check(`${command} without a wildcard doubt runs in ${mode} with no rule`, (await floor(command, mode)).behavior === 'allow', show(await floor(command, mode)))
  }
}

section('(2) every stage of a pipeline is answered on its own')
check('the cat stage answered by its rule and the wc stage by the read-only road run the pipeline', (await floor(PIPE, 'default', { allow: ['Bash(cat *)'] })).behavior === 'allow', show(await floor(PIPE, 'default', { allow: ['Bash(cat *)'] })))
check('a rule naming only the stage without the wildcard leaves the wildcard doubt unanswered', asksWithTodaysWords(await floor(PIPE, 'default', { allow: ['Bash(wc *)'] })), show(await floor(PIPE, 'default', { allow: ['Bash(wc *)'] })))
check('a wildcard in a later stage needs its own answer', asksWithTodaysWords(await floor('echo hi | grep -l hi *.ts', 'default', { allow: ['Bash(echo *)'] })), show(await floor('echo hi | grep -l hi *.ts', 'default', { allow: ['Bash(echo *)'] })))
check('…and gets it from a rule naming that stage', (await floor('echo hi | grep -l hi *.ts', 'default', { allow: ['Bash(echo *)', 'Bash(grep *)'] })).behavior === 'allow', show(await floor('echo hi | grep -l hi *.ts', 'default', { allow: ['Bash(echo *)', 'Bash(grep *)'] })))

section('(3) any allow source answers the doubt; an exact rule too')
for (const source of ['cliArg', 'localSettings', 'userSettings', 'projectSettings', 'session']) {
  const verdict = await floor(LIST, 'default', { allow: ['Bash(ls *)'], source })
  check(`a prefix rule from ${source} runs ${LIST}`, verdict.behavior === 'allow', show(verdict))
}
const exact = await floor('ls [ab].ts', 'default', { allow: ['Bash(ls [ab].ts)'] })
check('an exact rule over the resolved command text answers a bracket wildcard', exact.behavior === 'allow', show(exact))
const quotedSpelling = await floor('ls "src/"*.ts', 'default', { allow: ['Bash(ls *)'] })
check('a wildcard beside a quoted part of the same operand is answered the same way', quotedSpelling.behavior === 'allow', show(quotedSpelling))

section('(4) what must not move')
check('no rule in Default: the same ask with the same words', asksWithTodaysWords(await floor(LIST, 'default')), show(await floor(LIST, 'default')))
check('no rule in implement mode: the same ask', asksWithTodaysWords(await floor(LIST, 'implement')), show(await floor(LIST, 'implement')))
check('a rule naming another command does not answer the doubt', asksWithTodaysWords(await floor('foo *.ts', 'default', TABLE_RULES)), show(await floor('foo *.ts', 'default', TABLE_RULES)))
check('Flow does not run an unlisted command with a wildcard operand', asksWithTodaysWords(await floor('foo *.ts', 'flow')), show(await floor('foo *.ts', 'flow')))
check('a wildcard in the command-name position stays a refusal even under a matching allow rule', asksWithTodaysWords(await floor('*.sh', 'default', { allow: ['Bash(*.sh)'] })), show(await floor('*.sh', 'default', { allow: ['Bash(*.sh)'] })))
check('a wildcard in the command-name position stays a refusal in Flow', asksWithTodaysWords(await floor('*.sh', 'flow')), show(await floor('*.sh', 'flow')))
const redirectGlob = await floor('cat < *.txt', 'default', TABLE_RULES)
check('a wildcard in a redirect target keeps its own refusal', redirectGlob.behavior === 'ask' && redirectGlob.message === 'the redirect target contains an unquoted path expansion; spell out the path, or approve', show(redirectGlob))
const denied = await floor(LIST, 'default', { allow: ['Bash(ls *)'], deny: ['Bash(ls *)'] })
check('a deny rule naming the command beats the allow rule with the wildcard', denied.behavior === 'deny' && denied.decisionReason?.type === 'rule', show(denied))
const deniedDecision = await decision(LIST, 'default', { allow: ['Bash(ls *)'], deny: ['Bash(ls *)'] })
check('…through the whole decision too', deniedDecision.behavior === 'deny', show(deniedDecision))
const askedByRule = await floor(LIST, 'default', { allow: ['Bash(ls *)'], ask: ['Bash(ls *)'] })
check('an ask rule naming the command still asks after the allow rule answered the doubt', askedByRule.behavior === 'ask' && askedByRule.decisionReason?.type === 'rule', show(askedByRule))
const pipeDenied = await floor(PIPE, 'default', { allow: ['Bash(cat *)', 'Bash(wc *)'], deny: ['Bash(cat *)'] })
check('a deny on one stage denies the pipeline', pipeDenied.behavior === 'deny', show(pipeDenied))
const directoryDenied = await floor('cat src/*.js', 'default', { allow: ['Bash(cat *)'], deny: [`Read(/${join(process.cwd(), 'src')})`] })
check('a read deny on the directory a wildcard reads from beats the allow rule', directoryDenied.behavior === 'deny' && /is denied by the rule Read\(/.test(directoryDenied.message ?? ''), show(directoryDenied))
const unproven = await floor('ls $DIR/*.ts', 'default', TABLE_RULES)
check('the yield is for the wildcard doubt alone: an unknown variable beside it still asks', unproven.behavior === 'ask' && unproven.message !== WILDCARD_ASK, show(unproven))

section('(5) the read-only road')
check('a listed read-only command with a wildcard operand reads as read-only', (await checkReadOnlyConstraints({ command: LIST }, false)).behavior === 'allow')
check('a pipeline of listed reads with a wildcard operand reads as read-only', (await checkReadOnlyConstraints({ command: PIPE }, false)).behavior === 'allow')
const unlisted = await checkReadOnlyConstraints({ command: 'foo *.ts' }, false)
check('an unlisted command with a wildcard operand keeps today\'s screen', unlisted.behavior === 'passthrough' && unlisted.notReadOnly?.kind === 'screen' && unlisted.notReadOnly.detail === WILDCARD_ASK, JSON.stringify(unlisted))
const namedByGlob = await checkReadOnlyConstraints({ command: '*.sh' }, false)
check('a wildcard in the command-name position keeps today\'s screen', namedByGlob.behavior === 'passthrough' && namedByGlob.notReadOnly?.kind === 'screen' && namedByGlob.notReadOnly.detail === WILDCARD_ASK, JSON.stringify(namedByGlob))
const writes = await checkReadOnlyConstraints({ command: 'ls *.ts > out.txt' }, false)
check('a listed read with a wildcard operand that writes its output is not read-only', writes.behavior === 'passthrough' && writes.notReadOnly?.kind === 'writes', JSON.stringify(writes))

process.chdir(before)
rmSync(scratch, { recursive: true, force: true })
console.log(failures ? `prove-rule-answers-wildcard: ${failures} FAILURE(S)` : 'prove-rule-answers-wildcard: ALL LAWS HOLD')
process.exit(failures ? 1 : 0)
