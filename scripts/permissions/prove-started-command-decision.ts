#!/usr/bin/env bun
import { check, decide, fill, finish, note, pageText, said, section, shown, sourceText, standInService, type Rules } from './floorsKit.ts'

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
    check(`service "${service}" · ${mode} · text typed into a program that is not known for a shell is read as a command too: a Bash deny rule that matches it refuses`, notShell.behavior === 'deny' && /Bash\(rm \*\)/.test(notShell.message ?? ''), said(notShell))
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

section('§9 a service\'s inputs are one script: text sent to it is read with the state the text sent before it left')
{
  const history = await import('../../src/utils/permissions/serviceInputHistory.ts').catch(() => null)
  const { getOriginalCwd } = await import('../../src/bootstrap/state.ts')
  const PUSH = ['git', 'push', 'origin', 'main'].join(' ')
  check('the history of what a service was sent is there to be told', history !== null)
  const sentTo = (name: string, text: string, submitted = true, run = ':'): void => history?.noteServiceInput(history.serviceInputKey(getOriginalCwd(), name), run, fill(text), submitted)
  const everyMode = async (name: string, text: string, rules: Rules = {}): Promise<string[]> => {
    const wrong: string[] = []
    for (const mode of ALL_MODES) {
      const decision = await decide('Service', typed(name, fill(text)), mode, rules)
      if (decision.behavior !== 'deny') wrong.push(`${mode}: ${said(decision)}`)
    }
    return wrong
  }
  const body = sourceText('src/tools/ServiceTool/ServiceTool.ts')
  check('the tool notes a text only once it was written to the service, by the run it was written to', /const sent = sendInput\(project, input\.name!, input\.text \?\? '', sessionId, mode\)\n\s+if \('error' in sent\) return [^\n]+\n\s+if \(mode !== 'eof'\) noteServiceInput\(serviceInputKey\(project, input\.name!\), runOf\(readRecord\(project, input\.name!\)\), input\.text \?\? '', mode !== 'write'\)/.test(body))
  standInService('stateful', 'sh', [])
  for (const [mode, behavior] of [['sovereign', 'allow'], ['flow', 'allow'], ['default', 'ask']] as const) {
    const before = await decide('Service', typed('stateful', 'cat .credentials.json'), mode)
    check(`control · ${mode} · with nothing sent before, cat .credentials.json typed into a shell service is read in the folder it started in (${behavior})`, before.behavior === behavior, said(before))
  }
  sentTo('stateful', 'cd <CONFIG>')
  for (const text of ['cat .credentials.json', 'cat mcp-auth.json', 'cp .credentials.json <PROJECT>/copy.json']) {
    const wrong = await everyMode('stateful', text)
    check(`after cd <config> was sent to it, ${shown(fill(text))} is refused in all six modes: the folder the earlier text left is the folder this one is read in`, wrong.length === 0, wrong.join(' ‖ '))
  }
  for (const [mode, behavior] of [['sovereign', 'allow'], ['flow', 'allow'], ['default', 'ask']] as const) {
    const plain = await decide('Service', typed('stateful', 'ls'), mode)
    check(`control · ${mode} · ls typed after that cd is answered as before (${behavior})`, plain.behavior === behavior, said(plain))
  }
  sentTo('stateful', 'cd <PROJECT> && ls')
  const back = await decide('Service', typed('stateful', 'cat .credentials.json'), 'sovereign')
  check('control · sovereign · after a cd back to the project was sent, the same text is read in the project again', back.behavior === 'allow', said(back))
  sentTo('stateful', 'export D=<CONFIG>')
  const variable = await everyMode('stateful', 'cat $D/.credentials.json')
  check('after export D=<config> was sent, cat $D/.credentials.json is refused in all six modes: a variable an earlier text set is read', variable.length === 0, variable.join(' ‖ '))
  sentTo('stateful', 'unset D; cat <CONFIG>/.cred', false)
  const halves = await everyMode('stateful', 'entials.json')
  check('after half a line was written with no Enter, the text that completes it is read as the whole line and refused in all six modes', halves.length === 0, halves.join(' ‖ '))
  sentTo('stateful', '')
  sentTo('stateful', 'cat <CONFIG>/.cred', false)
  sentTo('stateful', '\u0003', false)
  const cleared = await decide('Service', typed('stateful', 'entials.json'), 'sovereign')
  check('control · sovereign · a half line followed by an interrupt key is no longer in front of the next text', cleared.behavior === 'allow', said(cleared))
  sentTo('stateful', 'cd <CONFIG>', true, 'an-earlier-run')
  const restarted = await decide('Service', typed('stateful', 'cat .credentials.json'), 'sovereign')
  check('control · sovereign · what was sent to an earlier run of the service is not read into this run', restarted.behavior === 'allow', said(restarted))
  standInService('ruled', 'sh', [])
  sentTo('ruled', 'cd build')
  const ruled = await everyMode('ruled', 'rm -rf ../secrets', { deny: ['Edit(secrets/**)'] })
  check('after cd build was sent, rm -rf ../secrets under a deny rule on secrets/** is refused in all six modes', ruled.length === 0, ruled.join(' ‖ '))
  const alone = await decide('Service', typed('ruled', PUSH), 'flow')
  check('flow · a push typed after a cd still asks first', alone.behavior === 'ask', said(alone))
  const zero = await decide('Service', typed('ruled', PUSH), 'sovereign')
  check('sovereign · the same text asks nothing', zero.behavior === 'allow', said(zero))
}

section('§10 a program that is not known for a shell but may run what it is sent: both readings, the stricter kept')
{
  const programs: Array<[string, string, string[]]> = [
    ['a shell loop that evaluates each line', 'sh', ['-c', 'while read l; do eval "$l"; done']],
    ['a shell behind arch', 'arch', ['-arm64', 'sh']],
    ['a shell this reading has no name for', 'yash', []],
    ['a shell on another host', 'ssh', ['localhost']],
    ['sqlite3', 'sqlite3', [':memory:']],
    ['a Python prompt', 'python3', ['-i']],
  ]
  let n = 0
  for (const [label, command, args] of programs) {
    const name = `evaluator-${n++}`
    standInService(name, command, args)
    for (const text of command === 'sqlite3' ? ['cat <CONFIG>/.credentials.json', '.shell cat <CONFIG>/.credentials.json'] : ['cat <CONFIG>/.credentials.json']) {
      const wrong: string[] = []
      for (const mode of ALL_MODES) {
        const decision = await decide('Service', typed(name, fill(text)), mode)
        if (decision.behavior !== 'deny' || !/holds Mercury's own credentials/.test(decision.message ?? '')) wrong.push(`${mode}: ${said(decision)}`)
      }
      check(`${label} (${[command, ...args].join(' ')}) · ${shown(fill(text))} typed into it is refused in all six modes: the text is read as a command too`, wrong.length === 0, wrong.join(' ‖ '))
    }
    const ruled: string[] = []
    for (const mode of ALL_MODES) {
      const decision = await decide('Service', typed(name, 'rm -rf build'), mode, { deny: ['Bash(rm *)'] })
      if (decision.behavior !== 'deny') ruled.push(`${mode}: ${said(decision)}`)
    }
    check(`${label} · rm -rf build under a deny rule Bash(rm *) is refused in all six modes`, ruled.length === 0, ruled.join(' ‖ '))
    for (const [mode, behavior] of [['default', 'ask'], ['flow', 'allow'], ['sovereign', 'allow']] as const) {
      const plain = await decide('Service', typed(name, 'ls'), mode)
      check(`control · ${label} · ${mode} · ls typed into it is answered as before (${behavior})`, plain.behavior === behavior, said(plain))
    }
  }
  standInService('prompt', 'python3', ['-i'])
  for (const text of ['print(1)', "import os; os.system('ls')", 'for i in range(3):\n    print(i)', 'x = {"a": [1, 2]}']) {
    for (const mode of ['flow', 'sovereign'] as const) {
      const decision = await decide('Service', typed('prompt', text), mode, { deny: ['Bash(rm *)', 'Read(secrets/**)'] })
      check(`control · ${mode} · ${shown(text)} typed into a Python prompt with deny rules in force is not refused for being no command the Bash reading can follow`, decision.behavior === 'allow', said(decision))
    }
  }
  const flowPush = await decide('Service', typed('evaluator-0', ['git', 'push', 'origin', 'main'].join(' ')), 'flow')
  check('flow · a push typed into the shell loop asks first', flowPush.behavior === 'ask', said(flowPush))
  const zeroPush = await decide('Service', typed('evaluator-0', ['git', 'push', 'origin', 'main'].join(' ')), 'sovereign')
  check('sovereign · the same text asks nothing', zeroPush.behavior === 'allow', said(zeroPush))
}

section('§11 Debug: a custom request\'s body, a debugger\'s own shell command, an attach by a program\'s name')
{
  const PUSH = ['git', 'push', 'origin', 'main'].join(' ')
  const reads = fill("open('<CONFIG>/.credentials.json').read()")
  const shellRead = fill('cat <CONFIG>/.credentials.json')
  const refusedEverywhere: Array<[string, Record<string, unknown>, Rules]> = [
    ['a custom evaluate request whose body reads the stored credentials', { op: 'customRequest', method: 'evaluate', body: JSON.stringify({ expression: reads, context: 'repl' }) }, {}],
    ['a custom request whose body is no JSON and reads them', { op: 'customRequest', method: 'evaluate', body: reads }, {}],
    ['a custom setVariable request whose value reads them', { op: 'customRequest', method: 'setVariable', body: JSON.stringify({ variablesReference: 1, name: 'x', value: reads }) }, {}],
    ['a custom evaluate request that hands the debugger a shell command', { op: 'customRequest', method: 'evaluate', body: JSON.stringify({ expression: `platform shell ${shellRead}` }) }, {}],
    ['evaluate platform shell <a read of them>', { op: 'evaluate', expression: `platform shell ${shellRead}` }, {}],
    ['evaluate with a backquote in front of it', { op: 'evaluate', expression: `\`platform shell ${shellRead}` }, {}],
    ['evaluate -exec shell <a read of them>', { op: 'evaluate', expression: `-exec shell ${shellRead}` }, {}],
    ['evaluate !<a read of them>', { op: 'evaluate', expression: `!${shellRead}` }, {}],
    ['a breakpoint whose log message hands the debugger a shell command', { op: 'breakpoints', file: 'app.c', breakpoints: [{ line: 3, logMessage: `shell ${shellRead}` }] }, {}],
    ['evaluate platform shell rm -rf build under a deny rule Bash(rm *)', { op: 'evaluate', expression: 'platform shell rm -rf build' }, { deny: ['Bash(rm *)'] }],
    ['an attach by the name mercury', { op: 'attach', program: 'mercury' }, {}],
    ['an attach by the path of the runtime\'s own program', { op: 'attach', program: fill('<CONFIG>/runtime/current/mercury') }, {}],
  ]
  for (const [label, input, rules] of refusedEverywhere) {
    const wrong: string[] = []
    for (const mode of ALL_MODES) {
      const decision = await decide('Debug', input, mode, rules)
      if (decision.behavior !== 'deny') wrong.push(`${mode}: ${said(decision)}`)
    }
    check(`Debug · ${label} is refused in all six modes`, wrong.length === 0, wrong.join(' ‖ '))
  }
  const answered: Array<[string, Record<string, unknown>, string, string]> = [
    ['a push handed to the debugger\'s shell', { op: 'evaluate', expression: `platform shell ${PUSH}` }, 'flow', 'ask'],
    ['a push handed to the debugger\'s shell', { op: 'evaluate', expression: `platform shell ${PUSH}` }, 'sovereign', 'allow'],
    ['ls handed to the debugger\'s shell', { op: 'evaluate', expression: 'platform shell ls' }, 'default', 'ask'],
    ['ls handed to the debugger\'s shell', { op: 'evaluate', expression: 'platform shell ls' }, 'flow', 'allow'],
    ['ls handed to the debugger\'s shell', { op: 'evaluate', expression: 'platform shell ls' }, 'sovereign', 'allow'],
    ['control: evaluate !done, an expression', { op: 'evaluate', expression: '!done' }, 'default', 'allow'],
    ['control: evaluate !done, an expression', { op: 'evaluate', expression: '!done' }, 'sovereign', 'allow'],
    ['control: evaluate shellcode + 1, a name that begins with the word', { op: 'evaluate', expression: 'shellcode + 1' }, 'default', 'allow'],
    ['control: a custom threads request', { op: 'customRequest', method: 'threads' }, 'default', 'ask'],
    ['control: a custom threads request', { op: 'customRequest', method: 'threads' }, 'sovereign', 'allow'],
    ['control: a custom evaluate request of x + 1', { op: 'customRequest', method: 'evaluate', body: JSON.stringify({ expression: 'x + 1' }) }, 'default', 'ask'],
    ['control: a custom evaluate request of x + 1', { op: 'customRequest', method: 'evaluate', body: JSON.stringify({ expression: 'x + 1' }) }, 'sovereign', 'allow'],
    ['control: an attach by the name of another program', { op: 'attach', program: 'myapp' }, 'default', 'ask'],
    ['control: an attach by the name of another program', { op: 'attach', program: 'myapp' }, 'sovereign', 'allow'],
  ]
  for (const [label, input, mode, behavior] of answered) {
    const decision = await decide('Debug', input, mode)
    check(`Debug · ${mode} · ${label}: ${behavior}`, decision.behavior === behavior, said(decision))
  }
}
note('nothing in this proof is executed: tool inputs handed to the decision function with the real tools; the daemon is a stand-in process of this proof, and the services are record files it wrote, with no process behind them; what a service was sent is told to the history by this proof, as the tool tells it after a write')
finish('prove-started-command-decision')
