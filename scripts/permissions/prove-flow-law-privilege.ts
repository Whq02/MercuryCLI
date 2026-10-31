#!/usr/bin/env bun
import { ROADS, allowedByFlow, asksWith, check, finish, j, openKit, refusedWith, section, sentence } from './flowLawKit.ts'

const kit = await openKit('flow-law-privilege')
const ELEVATED = (verb: string): string => `Flow asks before ${verb}: it runs with elevated rights.`

try {
  section('§1 item 1 asks: sudo and every other privilege escalation, in every spelling, on every road')
  const asks: Array<[string, string]> = [
    ['sudo apt-get install -y jq', 'sudo'],
    ['sudo -n true', 'sudo'],
    ['sudo make install', 'sudo'],
    ['doas pkg_add jq', 'doas'],
    ['su - root -c id', 'su'],
    ['pkexec visudo', 'pkexec'],
    ['runas /user:admin cmd', 'runas'],
    ['gsudo id', 'gsudo'],
    ['env -i sudo id', 'sudo'],
    ['nohup sudo make install', 'sudo'],
    ['bash -c "sudo id"', 'sudo'],
    ['echo `sudo id`', 'sudo'],
    ['ls | xargs sudo rm', 'sudo'],
    ['find . -name core -exec sudo rm {} \\;', 'sudo'],
    ['git status && sudo systemctl restart nginx', 'sudo'],
    ['osascript -e \'do shell script "id" with administrator privileges\'', 'osascript with administrator privileges'],
  ]
  for (const [command, verb] of asks) {
    for (const road of ROADS) {
      const outcome = await kit.decide(command, { road })
      const words = ELEVATED(verb)
      const ok = road === 'prompt-less' ? refusedWith(outcome, words) : asksWith(outcome, words) && outcome.wrapper.decidedBy === 'flowLaw'
      check(`${road}: ${command} → ${road === 'prompt-less' ? 'refused with' : 'asks'} "${words}"`, ok, j(outcome.decision))
    }
  }
  const { z } = await import('zod/v4')
  const powershell = { name: 'PowerShell', inputSchema: z.object({ command: z.string() }), isReadOnly: () => false, checkPermissions: async () => ({ behavior: 'ask', message: 'plain ask' }) }
  const elevated = await kit.decideTool(powershell, { command: 'Start-Process cmd -Verb RunAs' })
  check('PowerShell: Start-Process -Verb RunAs asks as item 1', asksWith(elevated, ELEVATED('Start-Process -Verb RunAs')), j(elevated.decision))
  const listing = await kit.decideTool(powershell, { command: 'Get-ChildItem -Recurse src | Measure-Object' })
  check('PowerShell: a listing runs without a question', allowedByFlow(listing), j(listing.decision))

  section('§2 the neighbour that is not the item runs without a question')
  for (const command of ['echo sudo', 'grep -rn sudo docs/', 'cat sudoers.md', 'make install', 'npm install -g typescript', 'man sudo', './sudo-wrapper.sh', 'brew install jq', 'pip install requests', 'systemctl --user status', 'id -u']) {
    for (const road of ROADS) {
      const outcome = await kit.decide(command, { road })
      check(`${road}: ${command} runs`, allowedByFlow(outcome), j(outcome.decision))
    }
  }

  section('§3 the operator\'s own rules outrank the item')
  const allowed = await kit.decide('sudo -n true', { rules: { allow: ['Bash(sudo -n true)'] } })
  check('an exact allow rule runs sudo -n true without a question', allowed.decision.behavior === 'allow' && allowed.wrapper.decidedBy === 'engine', j(allowed.decision))
  const denied = await kit.decide('sudo -n true', { rules: { deny: ['Bash(sudo *)'] } })
  check('a deny rule refuses sudo outright', denied.decision.behavior === 'deny' && denied.decision.decisionReason?.type === 'rule', j(denied.decision))
  const asked = await kit.decide('id -u', { rules: { ask: ['Bash(id *)'] } })
  check('an ask rule on a free command still asks, in the rule\'s words', asked.decision.behavior === 'ask' && asked.decision.decisionReason?.type === 'rule' && asked.wrapper.decidedBy === 'flowFloors', j(asked.decision))

  section('§4 the item is Flow\'s alone: Sovereign runs it, Default asks as it always did')
  const sovereign = await kit.decide('sudo -n true', { mode: 'sovereign' })
  check('sovereign runs sudo -n true', sovereign.decision.behavior === 'allow', j(sovereign.decision))
  const byDefault = await kit.decide('sudo -n true', { mode: 'default' })
  check('default asks and its words are not Flow\'s', byDefault.decision.behavior === 'ask' && !sentence(byDefault).startsWith('Flow asks'), j(byDefault.decision))

  section('§5 the shipped table names the verbs the proof exercised')
  const table = kit.FLOW_LAW[1] as { commands: readonly string[] }
  check('item 1 lists sudo, sudoedit, doas, pkexec, su, runas, gsudo', ['sudo', 'sudoedit', 'doas', 'pkexec', 'su', 'runas', 'gsudo'].every(name => table.commands.includes(name)), j(table.commands))
} finally {
  kit.close()
}
finish('prove-flow-law-privilege')
