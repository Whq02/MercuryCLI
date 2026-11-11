#!/usr/bin/env bun
import { check, decide, fill, finish, note, pageText, said, section, shown, type Rules } from './floorsKit.ts'

type Mode = 'default' | 'implement' | 'apollo' | 'dontAsk' | 'flow' | 'sovereign'
type Shape = { label: string; argv: string[]; bashModes: Mode[]; rules?: Rules }

const service = (argv: string[]) => ({ op: 'start', name: 'probe', command: argv[0], args: argv.slice(1) })
const journey = (argv: string[]) => ({ op: 'run', objective: 'probe', steps: [{ kind: 'command.run', command: argv[0], args: argv.slice(1) }] })
const journeyService = (argv: string[]) => ({ op: 'run', objective: 'probe', steps: [{ kind: 'service.start', name: 'probe', command: argv[0], args: argv.slice(1) }] })
const debug = (argv: string[]) => ({ op: 'launch', program: argv[0], args: argv.slice(1) })
const quoted = (argv: string[]): string => argv.map(word => (/^[\w@%+=:,./-]+$/.test(word) ? word : `'${word.replaceAll("'", "'\\''")}'`)).join(' ')
const ROADS = [['Service', service, 'start'], ['Journey', journey, 'run'], ['Debug', debug, 'launch']] as const

const shapes: Shape[] = [
  { label: "floor 2, Mercury's own stored credentials", argv: ['cat', '<CONFIG>/.credentials.json'], bashModes: ['flow', 'sovereign'] },
  { label: 'floor 4, a kill of the daemon', argv: ['kill', '-9', '<DAEMON_PID>'], bashModes: ['flow', 'sovereign'] },
  { label: 'floor 4, the runtime deleted', argv: ['rm', '-rf', '<CONFIG>/runtime'], bashModes: ['flow', 'sovereign'] },
  { label: "Flow's five, git that publishes history", argv: ['git', 'push', 'origin', 'main'], bashModes: ['flow'] },
  { label: "Flow's five, publishing a package", argv: ['npm', 'publish'], bashModes: ['flow'] },
  { label: 'a deny rule Bash(rm *)', argv: ['rm', '-rf', 'build'], bashModes: ['flow', 'sovereign'], rules: { deny: ['Bash(rm *)'] } },
]

section('the page, docs/TRUST.md')
const page = pageText()
check('the floors hold alongside the permission modes and wards', /Five safety floors hold alongside the permission modes and wards/.test(page))
check('Flow asks before a push in any form', /git that publishes or rewrites history \(`git push` in any form/.test(page))
check('deny rules still win over an ask or an allow', /Deny rules still win over an ask or an allow; file restrictions still apply/.test(page))

section('§1 the same program and arguments through Bash (control), Service start, a Journey command.run step, and Debug launch')
for (const shape of shapes) {
  const argv = shape.argv.map(fill)
  for (const mode of shape.bashModes) {
    const viaBash = await decide('Bash', { command: quoted(argv) }, mode, shape.rules ?? {})
    check(`control · ${mode} · ${shape.label} · Bash ${shown(quoted(argv))} is refused or asked about`, viaBash.behavior !== 'allow', said(viaBash))
    for (const [tool, input, verb] of ROADS) {
      const decision = await decide(tool, input(argv) as Record<string, unknown>, mode, shape.rules ?? {})
      check(`${mode} · ${shape.label} · ${tool} ${verb} of ${shown(quoted(argv))} is not approved outright`, decision.behavior !== 'allow', `${tool}: ${said(decision)} — Bash: ${said(viaBash)}`)
    }
  }
}

section('§2 in the modes that ask, each of these tools still shows its own card for a command the Bash layer does not refuse')
for (const mode of ['default', 'implement', 'apollo'] as const) {
  for (const [tool, input, verb] of ROADS) {
    const decision = await decide(tool, input(['node', 'server.js']) as Record<string, unknown>, mode)
    check(`${mode} · ${tool} ${verb} of "node server.js" asks with its own card`, decision.behavior === 'ask' && new RegExp(`^${tool === 'Journey' ? 'Journey run' : `${tool} ${verb}`}`).test(decision.message ?? ''), said(decision))
  }
}

section('§3 what the Bash layer refuses is refused through each of them in every mode, with the Bash layer\'s own sentence')
const FLOORED: Array<[string, string[], Rules]> = [
  ["floor 2, Mercury's own stored credentials", ['cat', '<CONFIG>/.credentials.json'], {}],
  ['floor 4, a kill of the daemon', ['kill', '-9', '<DAEMON_PID>'], {}],
  ['floor 4, the runtime deleted', ['rm', '-rf', '<CONFIG>/runtime'], {}],
  ['a deny rule Bash(rm *)', ['rm', '-rf', 'build'], { deny: ['Bash(rm *)'] }],
  ['a deny rule Read(secrets/**)', ['cat', 'secrets/k.txt'], { deny: ['Read(secrets/**)'] }],
]
for (const mode of ['default', 'implement', 'apollo', 'dontAsk', 'flow', 'sovereign'] as const) {
  for (const [label, words, rules] of FLOORED) {
    const argv = words.map(fill)
    const viaBash = await decide('Bash', { command: quoted(argv) }, mode, rules)
    const differing: string[] = []
    for (const [tool, input] of [...ROADS, ['Journey', journeyService, 'run'] as const]) {
      const decision = await decide(tool, input(argv) as Record<string, unknown>, mode, rules)
      if (decision.behavior !== 'deny' || decision.message !== viaBash.message) differing.push(`${tool}: ${said(decision)}`)
    }
    check(`${mode} · ${label} · Bash refuses ${shown(quoted(argv))}, and so do Service start, both Journey steps and Debug launch`, viaBash.behavior === 'deny' && differing.length === 0, `Bash: ${said(viaBash)} ‖ ${differing.join(' ‖ ')}`)
  }
}

section('§4 Flow keeps its five and Sovereign asks nothing')
for (const [tool, input, verb] of ROADS) {
  for (const argv of [['git', 'push', 'origin', 'main'], ['npm', 'publish']]) {
    const flow = await decide(tool, input(argv) as Record<string, unknown>, 'flow')
    check(`flow · ${tool} ${verb} of ${shown(quoted(argv))} asks first`, flow.behavior === 'ask', said(flow))
    const sovereign = await decide(tool, input(argv) as Record<string, unknown>, 'sovereign')
    check(`sovereign · ${tool} ${verb} of ${shown(quoted(argv))} asks nothing`, sovereign.behavior === 'allow', said(sovereign))
  }
  const plain = await decide(tool, input(['node', 'server.js']) as Record<string, unknown>, 'flow')
  check(`flow · ${tool} ${verb} of "node server.js" is none of the five and runs unasked`, plain.behavior === 'allow', said(plain))
  const asked = await decide(tool, input(['make', 'deploy']) as Record<string, unknown>, 'default', { ask: ['Bash(make deploy *)'] })
  check(`default · ${tool} ${verb} of "make deploy" under an ask rule Bash(make deploy *) names the rule on its card`, asked.behavior === 'ask' && String(asked.message).includes('Bash(make deploy *)'), said(asked))
  const stoodDown = await decide(tool, input(['make', 'deploy']) as Record<string, unknown>, 'sovereign', { ask: ['Bash(make deploy *)'] })
  check(`sovereign · the same ask rule asks nothing`, stoodDown.behavior === 'allow', said(stoodDown))
}

section('§5 a debugger attached to Mercury\'s own process')
for (const mode of ['default', 'implement', 'flow', 'sovereign'] as const) {
  const daemon = await decide('Debug', { op: 'attach', pid: Number(fill('<DAEMON_PID>')) }, mode)
  check(`${mode} · Debug attach to the daemon's pid is refused by the floor`, daemon.behavior === 'deny' && /is refused: it is Mercury’s own process or daemon/.test(daemon.message ?? ''), said(daemon))
  const own = await decide('Debug', { op: 'attach', pid: Number(fill('<OWN_PID>')) }, mode)
  check(`${mode} · Debug attach to the session's own pid is refused by the floor`, own.behavior === 'deny', said(own))
}
{
  const other = await decide('Debug', { op: 'attach', pid: 1 }, 'default')
  check('default · Debug attach to another process still asks with its own card', other.behavior === 'ask' && /^Debug attach: pid 1/.test(other.message ?? ''), said(other))
  const sovereign = await decide('Debug', { op: 'attach', pid: 1 }, 'sovereign')
  check('sovereign · Debug attach to another process asks nothing', sovereign.behavior === 'allow', said(sovereign))
}
note('nothing in this proof is executed: tool inputs handed to the decision function with the real tools; the daemon is a stand-in process of this proof')
finish('prove-started-command-decision')
