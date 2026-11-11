#!/usr/bin/env bun
import { check, decide, fill, finish, note, pageText, said, section, shown, sourceText, type Rules } from './floorsKit.ts'

const MODES = ['default', 'implement', 'apollo', 'dontAsk', 'flow', 'sovereign'] as const
type Mode = (typeof MODES)[number]
const monitor = (command: string, mode: Mode, rules: Rules = {}) => decide('Monitor', { command: fill(command), description: 'watch' }, mode, rules)
const bash = (command: string, mode: Mode, rules: Rules = {}) => decide('Bash', { command: fill(command) }, mode, rules)

async function pair(label: string, command: string, mode: Mode, rules: Rules = {}): Promise<void> {
  const viaBash = await bash(command, mode, rules)
  const viaMonitor = await monitor(command, mode, rules)
  check(`${mode} · ${label} · ${shown(fill(command))} · Bash: ${viaBash.behavior} · through Monitor it is not approved outright`, viaMonitor.behavior !== 'allow', `Monitor: ${said(viaMonitor)} — Bash: ${said(viaBash)}`)
}

section('the page, docs/TRUST.md')
const page = pageText()
check('Default mode asks for writes and edits in either place unless a permission rule already allows them', /\*\*Default mode\*\* asks for writes and edits in either place unless a permission rule already allows them/.test(page))
check('deny rules still win over an ask or an allow; file restrictions still apply', /Deny rules still win over an ask or an allow; file restrictions still apply/.test(page))
check('Flow asks before git that publishes or rewrites history, a push in any form', /git that publishes or rewrites history \(`git push` in any form/.test(page))
check('a hostless run denies a call that still needs approval after its rules and mode are applied', /A hostless `mercury run` denies a call that still needs approval after its rules and mode are applied/.test(page))
check('five safety floors hold alongside the permission modes and wards', /Five safety floors hold alongside the permission modes and wards/.test(page))

section('§0 the tool: Monitor runs its command through the shell')
const monitorSource = sourceText('src/tools/MonitorTool/MonitorTool.ts')
note(`src/tools/MonitorTool/MonitorTool.ts: checkPermissions ${/checkPermissions/.test(monitorSource) ? 'is declared' : 'is not declared'}; its call hands the command to exec(command, …, 'bash', …) ${/exec\(command, abortController\.signal, 'bash'/.test(monitorSource) ? '(line found)' : '(line not found)'}`)

section('§1 the modes: what Bash asks about or refuses, Monitor must not run unasked')
await pair('a write in the starting folder', 'echo x > notes.txt', 'default')
await pair('a delete in the starting folder', 'rm -rf build', 'default')
await pair('an install', 'npm install left-pad', 'default')
await pair('a file sent to another machine', 'curl -s https://example.invalid/x -d @notes.txt', 'default')
await pair('a write outside the starting folder', 'echo x > /Users/<USER>/Documents/out.txt', 'implement')
await pair('a delete while planning', 'rm -rf build', 'apollo')
await pair('a delete where nothing may ask', 'rm -rf build', 'dontAsk')

section('§2 rules: a deny rule and an ask rule on the command')
await pair('deny Bash(rm *)', 'rm -rf build', 'default', { deny: ['Bash(rm *)'] })
await pair('deny Bash(rm *)', 'rm -rf build', 'sovereign', { deny: ['Bash(rm *)'] })
await pair('deny Read(secrets/**)', 'cat secrets/k.txt', 'sovereign', { deny: ['Read(secrets/**)'] })
await pair('ask Bash(rm *)', 'rm -rf build', 'default', { ask: ['Bash(rm *)'] })

section('§3 Flow: three of the five it asks about')
await pair('git that publishes history', 'git push origin main', 'flow')
await pair('publishing a package', 'npm publish', 'flow')
await pair('git that rewrites history', 'git reset --hard HEAD~3', 'flow')

section('§4 the safety floors, in every mode')
for (const mode of MODES) await pair("floor 2, Mercury's own stored credentials", 'cat <CONFIG>/.credentials.json', mode)
for (const mode of MODES) await pair('floor 4, a kill of the daemon', 'kill <DAEMON_PID>', mode)
for (const mode of MODES) await pair('floor 4, the runtime deleted', 'rm -rf <CONFIG>/runtime', mode)
for (const mode of ['default', 'implement', 'apollo', 'dontAsk', 'flow'] as const) await pair('floor 1, a write to a credential store', 'echo x >> /Users/<USER>/.ssh/authorized_keys', mode)
for (const mode of ['default', 'implement', 'apollo'] as const) await pair('floor 5, a .env file read', 'cat .env', mode)
for (const mode of ['default', 'implement', 'apollo'] as const) await pair('floor 5, an instruction file written', 'echo x >> MERCURY.md', mode)

section('§5 controls: what does stop a Monitor call')
for (const mode of MODES) {
  const denied = await monitor('rm -rf build', mode, { deny: ['Monitor'] })
  check(`${mode} · a deny rule on the whole tool (Monitor) refuses the call`, denied.behavior === 'deny', said(denied))
}

section('§6 the same decision as Bash: a watch that only reads runs where Bash runs it, and nothing else differs')
const PARITY = ['git status', 'cat notes.txt', 'tail -n 5 notes.txt', 'ls sub', 'echo x > notes.txt', 'rm -rf build', 'npm install left-pad', 'cat secrets/k.txt', 'cat <CONFIG>/.credentials.json', 'cat .env', 'git push origin main']
for (const mode of MODES) {
  const differing: string[] = []
  for (const command of PARITY) {
    const viaBash = await bash(command, mode, { deny: ['Read(secrets/**)'] })
    const viaMonitor = await monitor(command, mode, { deny: ['Read(secrets/**)'] })
    if (viaBash.behavior !== viaMonitor.behavior || (viaBash.behavior === 'deny' && viaBash.message !== viaMonitor.message?.replace('Permission to use Monitor', 'Permission to use Bash'))) differing.push(`${shown(fill(command))}: Bash ${said(viaBash)} · Monitor ${said(viaMonitor)}`)
  }
  check(`${mode} · ${PARITY.length} commands get through Monitor the answer Bash gives them`, differing.length === 0, differing.join(' ‖ '))
}
for (const command of ['git status', 'cat notes.txt', 'tail -n 5 notes.txt']) {
  const viaMonitor = await monitor(command, 'default')
  check(`default · a watch that only reads runs without a card · ${shown(command)}`, viaMonitor.behavior === 'allow', said(viaMonitor))
}
{
  const allowed = await monitor('npm test', 'default', { allow: ['Bash(npm test *)'] })
  check('default · an allow rule written for Bash allows the same command through Monitor', allowed.behavior === 'allow', said(allowed))
  check('the allowed call keeps the watch as it was asked for', allowed.updatedInput?.command === 'npm test' && allowed.updatedInput?.description === 'watch', JSON.stringify(allowed.updatedInput))
  const asked = await monitor('npm test', 'default', { ask: ['Bash(npm test *)'] })
  check('default · an ask rule written for Bash asks through Monitor and names the rule', asked.behavior === 'ask' && String(asked.message).includes('Bash(npm test *)'), said(asked))
  const wholeDeny = await monitor('git status', 'default', { deny: ['Bash'] })
  check('default · a deny rule on the whole of Bash refuses a Monitor call', wholeDeny.behavior === 'deny' && String(wholeDeny.message).includes('the rule Bash '), said(wholeDeny))
  const wholeAllow = await monitor('npm test', 'default', { allow: ['Bash'] })
  check('default · an allow rule on the whole of Bash allows a Monitor call', wholeAllow.behavior === 'allow', said(wholeAllow))
  const wholeAllowFloor = await monitor('cat <CONFIG>/.credentials.json', 'default', { allow: ['Bash'] })
  check('default · that allow rule does not open the floor', wholeAllowFloor.behavior === 'deny', said(wholeAllowFloor))
}

section('§6b the rule a Monitor ask offers to remember is the command\'s own, never the whole tool')
for (const [command, content] of [['npm install left-pad', 'npm install *'], ['npm test', 'npm test *'], ['cat $FILE', undefined], ['./deploy.sh staging', './deploy.sh *']] as const) {
  const asked = await monitor(command, 'default')
  const rules = (asked.suggestions ?? []).flatMap(suggestion => suggestion.rules ?? [])
  const offered = rules.map(rule => `${rule.toolName}(${rule.ruleContent ?? ''})`).join(', ')
  check(`default · Monitor ${shown(command)} asks and hands the card ${content === undefined ? 'no rule it could not name exactly' : `the rule Bash(${content})`}`, asked.behavior === 'ask' && asked.suggestions !== undefined && rules.every(rule => rule.ruleContent !== undefined && rule.ruleContent !== '') && (content === undefined || rules.some(rule => rule.toolName === 'Bash' && rule.ruleContent === content)), `${said(asked)} · offered: ${offered || '(none)'}`)
}

section('§7 a rule written for Monitor is honoured as a rule written for Bash is')
{
  const denied = await monitor('rm -rf build', 'default', { deny: ['Monitor(rm *)'] })
  check('deny Monitor(rm *) refuses the watch and names the rule as it was written', denied.behavior === 'deny' && String(denied.message).includes('the rule Monitor(rm *)') && denied.decisionReason?.rule?.ruleValue?.toolName === 'Monitor', said(denied))
  const sovereign = await monitor('rm -rf build', 'sovereign', { deny: ['Monitor(rm *)'] })
  check('deny Monitor(rm *) refuses under Sovereign mode', sovereign.behavior === 'deny', said(sovereign))
  const bashUntouched = await bash('rm -rf build', 'default', { deny: ['Monitor(rm *)'] })
  check('a Monitor rule does not reach a Bash call', bashUntouched.behavior === 'ask', said(bashUntouched))
  const allowed = await monitor('npm test', 'default', { allow: ['Monitor(npm test *)'] })
  check('allow Monitor(npm test *) allows the watch', allowed.behavior === 'allow', said(allowed))
  const asked = await monitor('git status', 'default', { ask: ['Monitor(git status *)'] })
  check('ask Monitor(git status *) asks first and names the rule as it was written', asked.behavior === 'ask' && String(asked.message).includes('Monitor(git status *)'), said(asked))
  const both = await monitor('rm -rf build', 'default', { deny: ['Monitor(rm *)', 'Bash(rm *)'] })
  check('with both rules written the Bash rule is the one named', both.behavior === 'deny' && String(both.message).includes('the rule Bash(rm *)'), said(both))
}
note('nothing in this proof is executed: each line is one command string handed to the decision function with the real MonitorTool; the daemon is a stand-in process of this proof, the credential files and the runtime are dummies under the run scratch')
finish('prove-monitor-command-decision')
