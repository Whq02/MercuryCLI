#!/usr/bin/env bun

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let failures = 0
let checks = 0
function check(label: string, cond: boolean, detail = ''): void {
  checks++
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}

type PendingToolCall = import('../../src/utils/wards/wards.js').PendingToolCall
type WardVerdict = import('../../src/utils/wards/wards.js').WardVerdict
const { AUTONOMOUS_WARDS, BUILTIN_WARDS, REFUSAL_WARDS, evaluateWards } = await import('../../src/utils/wards/wards.js')
const { deleteWardActive, WARDS_HOOK_ID, registerWardsGuard, resetWardsEngagedSessionsForTest } = await import('../../src/guards/wardsGuard.js')
const { deleteFlagEnv, setFlagEnv } = await import('../../src/substrate/flagRegistry.js')
const { getDestructiveCommandWarning } = await import('../../src/tools/BashTool/destructiveCommandWarning.js')
const { judgeToolCall } = await import('../../src/guards/guards.js')
const { runWithCwdOverride } = await import('../../src/utils/cwd.js')

const RULE = 'no-destructive-git-unattended'
const bash = (command: string): PendingToolCall => ({ toolName: 'Bash', input: { command }, shellCommand: command })
const autonomous = (command: string): WardVerdict => evaluateWards(AUTONOMOUS_WARDS, bash(command))
const wordsOf = (verdict: WardVerdict): string => (verdict.allow ? 'ALLOWED (hole!)' : `denied by ${verdict.rule.name}`)
const wardedByGit = (verdict: WardVerdict): boolean => !verdict.allow && verdict.rule.name === RULE

const DISCARDS = [
  'git reset --hard',
  'git reset --hard HEAD~1',
  'git reset --hard origin/main',
  'git -C /Users/someone/project reset --hard',
  'git checkout .',
  'git checkout -- .',
  'git checkout HEAD -- .',
  'git checkout -- ./',
  'git restore .',
  'git restore --worktree --staged .',
  'git clean -f',
  'git clean -fd',
  'git clean -xdf',
  'git clean -d --force',
  'git branch -D topic',
  'git branch --delete --force topic',
  'git branch -d --force topic',
  'git push --force origin topic',
  'git push -f',
  'git push --force-with-lease origin topic',
  'git push origin +main',
  'cd /tmp/x && git reset --hard',
  'git stash; git clean -fd && bun test',
  "bash -c 'cd /tmp/x && git reset --hard'",
  'sh -c "git clean -fd"',
  "bash -lc 'git checkout -- .'",
  "zsh -c 'git push --force origin main'",
  'git branch -df topic',
  'git branch -fd topic',
  'git branch -Df topic',
  'git push -fu origin topic',
  'git push -nf origin topic',
  'git reset "--hard"',
  "git reset '--hard' HEAD~1",
  'git checkout -- "."',
  "git restore '.'",
  'git restore "./"',
  'git clean "-fd"',
  'git branch "-D" topic',
  'git push "--force" origin topic',
  'git push "-f"',
  "bash -c 'git branch -df topic'",
  "bash -c 'git push -fu origin topic'",
  "bash -c 'git reset \"--hard\"'",
]

const KEPT_FREE = [
  'git status',
  'git reset HEAD~1',
  'git reset --soft HEAD~1',
  'git reset -- src/a.ts',
  'git checkout main',
  'git checkout -b topic',
  'git checkout -- src/a.ts',
  'git restore --staged .',
  'git restore -S .',
  'git restore src/a.ts',
  'git clean -n',
  'git clean -fdn',
  'git clean --dry-run -d',
  'git branch -d topic',
  'git branch -D',
  'git branch --delete topic',
  'git push',
  'git push origin topic',
  'git push --set-upstream origin topic',
  'git push origin HEAD:refs/heads/topic',
  'git log --oneline -5',
  'git diff --stat HEAD~1',
  'git commit -m "never git reset --hard here; stash instead"',
  'git commit -m "git clean -fd is the operator\'s to run"',
  "git commit -m 'git push --force stays with the operator'",
  'echo "git push --force is refused for crewmates"',
  'grep -rn "git checkout -- ." docs/',
  'git log --grep "reset --hard"',
  'git branch -dr origin/topic',
  'git branch -f topic abc',
  'git branch -m a b',
  'git push -u origin topic',
  'git push -q origin topic',
  'git push -4 origin topic',
  'git restore --staged "."',
  'git restore "--staged" "."',
  'git clean -n "-f"',
  'git clean "-n" "-f"',
  'rm -rf node_modules',
]

try {
  setFlagEnv('MERCURY_SPAWNED_BY', 'proof:destructive-git#1')
  section('§1 a spawned session arms the autonomous wards')
  check('MERCURY_SPAWNED_BY set: the autonomous wards ride the session', deleteWardActive())
  check('the destructive-git rule sits in the autonomous list three times (the plain form, the inline-shell form, the quoted-flag form)', AUTONOMOUS_WARDS.filter(rule => rule.name === RULE).length === 3)
  check('the rule names its compliant alternative', AUTONOMOUS_WARDS.some(rule => rule.name === RULE && /explicit ask/.test(rule.teach) && /say so in your reply/.test(rule.teach)))
  check('the rule is data (JSON round-trips intact)', JSON.stringify(JSON.parse(JSON.stringify(AUTONOMOUS_WARDS))) === JSON.stringify(AUTONOMOUS_WARDS))

  section('§2 the discards are refused with the rule named')
  for (const command of DISCARDS) check(command, wardedByGit(autonomous(command)), wordsOf(autonomous(command)))

  section('§3 what stays free: reads, soft resets, dry runs, single paths, unstaging, safe deletes, quoted mentions')
  for (const command of KEPT_FREE) check(command, autonomous(command).allow, wordsOf(autonomous(command)))

  section('§4 the hook road: a spawned session refuses through the guard, naming the rule')
  const project = realpathSync(mkdtempSync(join(tmpdir(), 'git-ward-proof-')))
  const store = { state: { sessionHooks: new Map() }, set(fn: (p: never) => never) { this.state = fn(this.state) } }
  const judge = async (session: string, command: string, asksAnswerable = false): Promise<string | true> => {
    const verdict = await judgeToolCall(session, {
      tool: 'Bash',
      input: { command },
      callId: `git-ward-${session}-${command.length}-${command.charCodeAt(command.length - 1)}`,
      messages: [],
      toolRef: { name: 'Bash', shellCommandOf: (value: { command?: unknown }) => (typeof value.command === 'string' ? value.command : undefined) } as never,
      asksAnswerable,
    })
    return verdict.refused ? verdict.reason : true
  }
  const shown = (verdict: string | true): string => (verdict === true ? 'ALLOWED (hole!)' : verdict.slice(0, 120))
  try {
    resetWardsEngagedSessionsForTest()
    const armed = await runWithCwdOverride(project, () => registerWardsGuard(store.set as never, 'git-ward-spawned'))
    check('the wards guard registered for the spawned session', armed === WARDS_HOOK_ID)
    const hard = await judge('git-ward-spawned', 'git reset --hard')
    check('git reset --hard is refused by the guard, the rule named', typeof hard === 'string' && hard.includes(`Ward '${RULE}'`), shown(hard))
    const inline = await judge('git-ward-spawned', "bash -c 'cd /tmp/x && git clean -fd'")
    check('the inline-shell form is refused the same way', typeof inline === 'string' && inline.includes(`Ward '${RULE}'`), shown(inline))
    const bundled = await judge('git-ward-spawned', 'git branch -df topic')
    check('a bundled short-flag delete is refused through the guard', typeof bundled === 'string' && bundled.includes(`Ward '${RULE}'`), shown(bundled))
    const quotedFlag = await judge('git-ward-spawned', 'git reset "--hard"')
    check('a quoted flag is refused through the guard', typeof quotedFlag === 'string' && quotedFlag.includes(`Ward '${RULE}'`), shown(quotedFlag))
    const free = await judge('git-ward-spawned', 'git status')
    check('git status passes the guard', free === true, shown(free))
    const mention = await judge('git-ward-spawned', 'git commit -m "no git reset --hard here"')
    check('a commit message mentioning the phrase passes the guard', mention === true, shown(mention))

    section('§5 an operator session carries no spawn stamp: the ward is not armed and the permission card asks instead')
    deleteFlagEnv('MERCURY_SPAWNED_BY')
    check('without MERCURY_SPAWNED_BY the autonomous wards are off', !deleteWardActive())
    resetWardsEngagedSessionsForTest()
    const ordinary = await runWithCwdOverride(project, () => registerWardsGuard(store.set as never, 'git-ward-operator'))
    check('the wards guard registered for the operator session', ordinary === WARDS_HOOK_ID)
    const operatorHard = await judge('git-ward-operator', 'git reset --hard')
    check('the operator session\'s guard leaves git reset --hard to the permission card', operatorHard === true, shown(operatorHard))
    check('the refusal list (every session) does not refuse it either', evaluateWards(REFUSAL_WARDS, bash('git reset --hard')).allow && evaluateWards(BUILTIN_WARDS, bash('git reset --hard')).allow)
    const asks = ['git reset --hard', 'git checkout -- .', 'git clean -fd', 'git branch -D topic', 'git push --force origin topic']
    check('the permission card marks each discard destructive, so ordinary mode asks', asks.every(command => getDestructiveCommandWarning(command) !== null), asks.map(command => `${command}: ${getDestructiveCommandWarning(command) ?? 'no warning'}`).join(' · '))

    section('§6 the cockpit: a daemon-spawned seat whose asks reach the operator is not refused — the card asks in default, sovereign runs; the home-delete ward still stands; nobody-can-answer shapes stay refused')
    check('every destructive-git entry is marked unattended-only; the home-delete ward is not', AUTONOMOUS_WARDS.every(rule => (rule.name === RULE) === (rule.unattendedOnly === true)))
    const execution = readFileSync(join(import.meta.dir, '..', '..', 'src/services/tools/toolExecution.ts'), 'utf8')
    check("the call site derives the fact from the permission system's own seams: canAnswerAsks() and the prompt-less context", /const asksAnswerable =\s*\n?\s*canAnswerAsks\(\) && toolUseContext\.getAppState\(\)\.toolPermissionContext\.shouldAvoidPermissionPrompts !== true/.test(execution) && /toolRef: tool, asksAnswerable \}/.test(execution))
    setFlagEnv('MERCURY_SPAWNED_BY', 'daemon-mercury_concourse_worker:concourse-w58@concourse#19909')
    check('the cockpit worker carries the spawn stamp (the Air\'s 1D-85 ledger row)', deleteWardActive())
    resetWardsEngagedSessionsForTest()
    const cockpit = await runWithCwdOverride(project, () => registerWardsGuard(store.set as never, 'git-ward-cockpit'))
    check('the wards guard registered for the cockpit seat', cockpit === WARDS_HOOK_ID)
    const cockpitHard = await judge('git-ward-cockpit', 'git reset --hard', true)
    check('operator door open (a host holds the asks): git reset --hard is left to the permission card / the sovereign posture', cockpitHard === true, shown(cockpitHard))
    const cockpitClean = await judge('git-ward-cockpit', 'git clean -fd', true)
    check('…git clean -fd likewise', cockpitClean === true, shown(cockpitClean))
    const cockpitPush = await judge('git-ward-cockpit', 'git push --force origin scratch-branch', true)
    check('…a force push to a topic branch likewise', cockpitPush === true, shown(cockpitPush))
    const cockpitHome = await judge('git-ward-cockpit', 'rm -rf ~/Projects/scratch', true)
    check('the home-delete ward is NOT weakened: the same cockpit seat still refuses a recursive delete in the home', typeof cockpitHome === 'string' && cockpitHome.includes("Ward 'no-home-recursive-delete'"), shown(cockpitHome))
    const crewmateHard = await judge('git-ward-cockpit', 'git reset --hard', false)
    check('a prompt-less crewmate of the same seat (shouldAvoidPermissionPrompts): refused, the rule named', typeof crewmateHard === 'string' && crewmateHard.includes(`Ward '${RULE}'`), shown(crewmateHard))
    for (const [shape, stamp] of [['a fired schedule (daemon-fire one-shot)', 'daemon-fire:1d86-schedule#25031'], ['a headless daemon dispatch', 'daemon-fire:w12#19909'], ['a crewmate worker', 'crewmate:lane-x#4242']] as const) {
      setFlagEnv('MERCURY_SPAWNED_BY', stamp)
      resetWardsEngagedSessionsForTest()
      const session = `git-ward-${stamp.replace(/[^a-z0-9]/gi, '')}`
      await runWithCwdOverride(project, () => registerWardsGuard(store.set as never, session))
      const closedHard = await judge(session, 'git reset --hard', false)
      check(`${shape}: nobody can answer an ask — git reset --hard stays refused`, typeof closedHard === 'string' && closedHard.includes(`Ward '${RULE}'`), shown(closedHard))
      const closedPush = await judge(session, 'git push --force origin topic', false)
      check(`${shape}: a force push stays refused`, typeof closedPush === 'string' && closedPush.includes(`Ward '${RULE}'`), shown(closedPush))
      const closedFree = await judge(session, 'git restore --staged .', false)
      check(`${shape}: unstaging stays free`, closedFree === true, shown(closedFree))
    }
    const unsaid = await judgeToolCall('git-ward-cockpit', { tool: 'Bash', input: { command: 'git reset --hard' }, callId: 'git-ward-unsaid', messages: [], toolRef: { name: 'Bash', shellCommandOf: (value: { command?: unknown }) => (typeof value.command === 'string' ? value.command : undefined) } as never })
    check('a call that does not say whether its asks reach anyone is judged as unattended (fail closed)', unsaid.refused && unsaid.reason.includes(`Ward '${RULE}'`), unsaid.refused ? unsaid.reason.slice(0, 120) : 'ALLOWED (hole!)')
  } finally {
    rmSync(project, { recursive: true, force: true })
  }
} finally {
  deleteFlagEnv('MERCURY_SPAWNED_BY')
}

console.log(`\n${failures === 0 ? 'PASS' : 'FAIL'} — prove-destructive-git-ward (${checks} checks, ${failures} failures)`)
process.exit(failures === 0 ? 0 : 1)
