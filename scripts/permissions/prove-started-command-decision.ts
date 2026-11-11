#!/usr/bin/env bun
import { check, decide, fill, finish, note, pageText, said, section, shown, standInService, type Rules } from './floorsKit.ts'

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

section('§6 text sent to a started service: judged as the command it is when the program is a shell, by the floors\' readers otherwise')
standInService('shell', 'sh', [])
standInService('wrapped', 'env', ['FOO=1', '/bin/bash', '-i'])
standInService('nested', 'sh', ['-c', 'exec zsh'])
standInService('repl', 'python3', ['-i'])
standInService('server', 'node', ['server.js'])
const typed = (name: string, text: string, mode?: string) => ({ op: 'input', name, text, ...(mode ? { mode } : {}) })
const ALL_MODES = ['default', 'implement', 'apollo', 'dontAsk', 'flow', 'sovereign'] as const
for (const service of ['shell', 'wrapped', 'nested', 'never-started']) {
  for (const [label, text, rules] of [
    ["floor 2, Mercury's own stored credentials", 'cat <CONFIG>/.credentials.json', {}],
    ['floor 4, the runtime deleted', 'rm -rf <CONFIG>/runtime', {}],
    ['floor 1, a write to a credential store', 'echo x >> ~/.ssh/authorized_keys', {}],
    ['a deny rule Bash(rm *)', 'rm -rf build', { deny: ['Bash(rm *)'] }],
  ] as Array<[string, string, Rules]>) {
    const wrong: string[] = []
    for (const mode of ALL_MODES) {
      const viaBash = await decide('Bash', { command: fill(text) }, mode, rules)
      const decision = await decide('Service', typed(service, fill(text)), mode, rules)
      if (viaBash.behavior !== 'deny' || decision.behavior !== 'deny' || decision.message !== viaBash.message) wrong.push(`${mode}: ${said(decision)} — Bash: ${said(viaBash)}`)
    }
    check(`service "${service}" · ${label} · ${shown(fill(text))} typed into it is refused in all six modes with the Bash layer's sentence`, wrong.length === 0, wrong.join(' ‖ '))
  }
}
{
  const flow = await decide('Service', typed('shell', 'git push origin main'), 'flow')
  check('flow · a push typed into a shell service asks first', flow.behavior === 'ask', said(flow))
  const sovereign = await decide('Service', typed('shell', 'git push origin main'), 'sovereign')
  check('sovereign · the same text asks nothing', sovereign.behavior === 'allow', said(sovereign))
  for (const [mode, behavior] of [['default', 'ask'], ['flow', 'allow'], ['sovereign', 'allow']] as const) {
    const plain = await decide('Service', typed('shell', 'ls'), mode)
    check(`${mode} · ls typed into a shell service is ${behavior === 'ask' ? 'asked about on the tool\'s own card' : 'allowed'}`, plain.behavior === behavior && (behavior !== 'ask' || /^Service input → shell: ls/.test(plain.message ?? '')), said(plain))
  }
  const end = await decide('Service', typed('shell', '', 'eof'), 'default')
  check('default · the end of input sent to a shell service keeps the tool\'s own card', end.behavior === 'ask' && /end of input/.test(end.message ?? ''), said(end))
}
for (const service of ['repl', 'server']) {
  const wrong: string[] = []
  for (const mode of ALL_MODES) {
    const decision = await decide('Service', typed(service, fill("print(open('<CONFIG>/.credentials.json').read())")), mode)
    if (decision.behavior !== 'deny' || !/holds Mercury's own credentials/.test(decision.message ?? '')) wrong.push(`${mode}: ${said(decision)}`)
  }
  check(`service "${service}" (not a shell) · text that reads Mercury's stored credentials is refused in all six modes by the floor's reader`, wrong.length === 0, wrong.join(' ‖ '))
  for (const [mode, behavior] of [['default', 'ask'], ['sovereign', 'allow']] as const) {
    const plain = await decide('Service', typed(service, 'print(1)'), mode)
    check(`service "${service}" · ${mode} · print(1) typed into it is ${behavior === 'ask' ? 'asked about on the tool\'s own card' : 'allowed'}`, plain.behavior === behavior, said(plain))
    const notShell = await decide('Service', typed(service, 'rm -rf build'), mode, { deny: ['Bash(rm *)'] })
    check(`service "${service}" · ${mode} · a Bash deny rule is not read into text typed into a program that is no shell (${behavior})`, notShell.behavior === behavior, said(notShell))
  }
}

section('§7 the environment a start hands its program joins the reading')
{
  const homed = { op: 'start', name: 'probe', command: 'sh', args: ['-c', 'cat ~/.credentials.json'], env: { HOME: fill('<CONFIG>') } }
  const wrong: string[] = []
  for (const mode of ALL_MODES) {
    const decision = await decide('Service', homed, mode)
    if (decision.behavior !== 'deny' || !/holds Mercury's own credentials/.test(decision.message ?? '')) wrong.push(`${mode}: ${said(decision)}`)
  }
  check('Service start of sh -c "cat ~/.credentials.json" with HOME set to the config home is refused in all six modes: the tilde is read as the home the service runs with', wrong.length === 0, wrong.join(' ‖ '))
  const dollar = await decide('Service', { ...homed, args: ['-c', 'cat $HOME/.credentials.json'] }, 'sovereign')
  check('sovereign · the same with $HOME spelled out is refused', dollar.behavior === 'deny', said(dollar))
  const own = await decide('Service', { op: 'start', name: 'probe', command: 'sh', args: ['-c', 'cat ~/.credentials.json'] }, 'default')
  check('control · default · with no environment handed over, the same start keeps its own card (the tilde is the user\'s home)', own.behavior === 'ask' && /^Service start: probe/.test(own.message ?? ''), said(own))
  const pathed = await decide('Service', { op: 'start', name: 'probe', command: 'rm', args: ['-rf', 'build'], env: { PATH: '/tmp/bin:/usr/bin' } }, 'sovereign', { deny: ['Bash(rm *)'] })
  check('sovereign · a deny rule still refuses a start that hands its program another PATH', pathed.behavior === 'deny', said(pathed))
  for (const [mode, behavior] of [['default', 'ask'], ['flow', 'allow'], ['sovereign', 'allow']] as const) {
    const plain = await decide('Service', { op: 'start', name: 'probe', command: 'node', args: ['server.js'], env: { NODE_ENV: 'test', PORT: '3000' } }, mode)
    check(`${mode} · a start with an ordinary environment is answered as before (${behavior})`, plain.behavior === behavior, said(plain))
  }
  standInService('homed', 'sh', [], { HOME: fill('<CONFIG>') })
  const typedHomed = await decide('Service', typed('homed', 'cat ~/.credentials.json'), 'sovereign')
  check('sovereign · text typed into a shell service started with HOME set to the config home reads the tilde as that home', typedHomed.behavior === 'deny', said(typedHomed))
}

section('§8 text the debuggee runs passes the floors\' readers')
{
  const reads = fill("open('<CONFIG>/.credentials.json').read()")
  const calls: Array<[string, Record<string, unknown>]> = [
    ['evaluate', { op: 'evaluate', expression: reads }],
    ['setVariable', { op: 'setVariable', name: 'x', value: reads, variablesReference: 1 }],
    ['a breakpoint\'s log message', { op: 'breakpoints', file: 'app.py', breakpoints: [{ line: 3, logMessage: `{${reads}}` }] }],
    ['a breakpoint\'s condition', { op: 'breakpoints', file: 'app.py', breakpoints: [{ line: 3, condition: `${reads} != ''` }] }],
  ]
  for (const [label, input] of calls) {
    const wrong: string[] = []
    for (const mode of ALL_MODES) {
      const decision = await decide('Debug', input, mode)
      if (decision.behavior !== 'deny' || !/holds Mercury's own credentials/.test(decision.message ?? '')) wrong.push(`${mode}: ${said(decision)}`)
    }
    check(`Debug ${label} that reads Mercury's stored credentials is refused in all six modes`, wrong.length === 0, wrong.join(' ‖ '))
  }
  for (const [label, input] of [['evaluate x + 1', { op: 'evaluate', expression: 'x + 1' }], ['a breakpoint with a plain condition', { op: 'breakpoints', file: 'app.py', breakpoints: [{ line: 3, condition: 'i > 3' }] }], ['setVariable to 4', { op: 'setVariable', name: 'x', value: '4', variablesReference: 1 }]] as Array<[string, Record<string, unknown>]>) {
    for (const mode of ['default', 'sovereign'] as const) {
      const decision = await decide('Debug', input, mode)
      check(`${mode} · Debug ${label} is allowed as before`, decision.behavior === 'allow', said(decision))
    }
  }
}
note('nothing in this proof is executed: tool inputs handed to the decision function with the real tools; the daemon is a stand-in process of this proof, and the services are record files it wrote, with no process behind them')
finish('prove-started-command-decision')
