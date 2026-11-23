#!/usr/bin/env bun
import { join } from 'node:path'

let failures = 0
function check(label: string, cond: boolean, detail = '', hint = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail.slice(0, 300)}` : ''}${!cond && hint ? ` — change: ${hint}` : ''}`)
}
function section(title: string): void {
  console.log(`\n${'─'.repeat(76)}\n${title}\n${'─'.repeat(76)}`)
}

const bar = await import('../../src/screen/chat/SwitchboardTagBar.tsx')
const { keyHintLabel } = await import('../../src/screen/widgets/keyHintLabel.ts')
const { shellToolRunning, foregroundShellInRoster } = await import('../../src/engine/connector/shellRunning.ts')
const { IDLE_LIVE } = await import('../../src/engine/connector/seatLive.ts')
const { registerShellRun, requestShellBackground, mainShellRunsNow, subscribeShellRuns } = await import('../../src/tools/shell/backgroundRequest.ts')
const { ACTION_GRAPH } = await import('../../src/screen/keys/actionGraph.ts')
const { DEFAULT_BINDINGS } = await import('../../src/screen/keys/defaultBindings.ts')
const { DAEMON_VERB_BORN_AT, MERCURY_DAEMON_PROTO, verbBornAt } = await import('../../src/daemon/control/protocol.ts')
const { METHODS } = await import('../../src/daemon/runner-wire/methods.ts')

type Live = typeof IDLE_LIVE
const live = (inFlight: boolean): Live => ({ ...IDLE_LIVE, inFlight, phase: inFlight ? 'tool' : 'idle', inProgressToolUseIDs: new Set(inFlight ? ['toolu_1'] : []) })
const status = (interrupting = false, hardStopping = false): { interrupting: boolean; hardStopping: boolean } => ({ interrupting, hardStopping })

section('§1 the ready line\'s tail — the second key named only while a shell command runs, esc keeping its meaning on every rung')
check('a running shell command: esc interrupts · ⇧b backgrounds · ⇧← back', bar.escBackHint(live(true), status(), true) === keyHintLabel('esc interrupts · ⇧b backgrounds · ⇧← back'), bar.escBackHint(live(true), status(), true), 'escBackHint in src/screen/chat/SwitchboardTagBar.tsx must name the background key when shellRunning is true')
check('a plain model call: esc interrupts · ⇧← back, as shipped', bar.escBackHint(live(true), status(), false) === keyHintLabel('esc interrupts · ⇧← back'), bar.escBackHint(live(true), status(), false), 'escBackHint in src/screen/chat/SwitchboardTagBar.tsx must leave the background clause out when shellRunning is false')
check('the default reads as shipped (every caller that says nothing about a shell)', bar.escBackHint(live(true), status()) === keyHintLabel('esc interrupts · ⇧← back'), '', 'the shellRunning parameter of escBackHint in src/screen/chat/SwitchboardTagBar.tsx must default to false')
check('interrupting: esc again re-sends the interrupt · ⇧← back, the background clause gone with the interrupt rung', bar.escBackHint(live(true), status(true), true) === keyHintLabel('esc again re-sends the interrupt · ⇧← back'), bar.escBackHint(live(true), status(true), true), 'escBackHint in src/screen/chat/SwitchboardTagBar.tsx must drop the background clause once interrupting')
check('hard-stopping: ⇧← back alone', bar.escBackHint(live(true), status(true, true), true) === keyHintLabel('⇧← back'), '', 'escBackHint in src/screen/chat/SwitchboardTagBar.tsx must return only the back key while hardStopping')
check('idle: ⇧← back alone whatever the shell fact says', bar.escBackHint(live(false), status(), true) === keyHintLabel('⇧← back'), '', 'escBackHint in src/screen/chat/SwitchboardTagBar.tsx must return only the back key when live.inFlight is false')

section('§2 the shell fact — an unresolved Bash tool_use on the canvas, or the operator\'s own `!` line holding the turn (the roster\'s foreground shell)')
const row = (name: string, id: string): unknown => ({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name, input: {} }] } })
type Records = Parameters<typeof shellToolRunning>[0]
check('an in-progress Bash tool_use reads as a running shell', shellToolRunning([row('Bash', 'toolu_1')] as Records, new Set(['toolu_1'])), '', 'shellToolRunning in src/engine/connector/shellRunning.ts must be true for a Bash tool_use whose id is in progress')
check('an in-progress Read tool_use does not', !shellToolRunning([row('Read', 'toolu_1')] as Records, new Set(['toolu_1'])), '', 'shellToolRunning in src/engine/connector/shellRunning.ts must match only Bash tool_use rows')
check('a Bash tool_use already resolved does not', !shellToolRunning([row('Bash', 'toolu_1')] as Records, new Set(['toolu_2'])), '', 'shellToolRunning in src/engine/connector/shellRunning.ts must require the tool_use id to be in the in-progress set')
check('nothing in progress reads as no shell', !shellToolRunning([row('Bash', 'toolu_1')] as Records, new Set()), '', 'shellToolRunning in src/engine/connector/shellRunning.ts must be false when the in-progress set is empty')
check('the newest unresolved Bash row wins over older resolved ones', shellToolRunning([row('Bash', 'toolu_0'), row('Read', 'toolu_1'), row('Bash', 'toolu_2')] as Records, new Set(['toolu_1', 'toolu_2'])), '', 'shellToolRunning in src/engine/connector/shellRunning.ts must pick the newest unresolved Bash row')
check('a `!` line: the roster\'s running shell row stamped foreground reads as a running shell (no tool_use row exists for it)', foregroundShellInRoster([{ kind: 'shell', status: 'running', foreground: true }]), '', 'foregroundShellInRoster in src/engine/connector/shellRunning.ts must be true for a running shell row stamped foreground')
check('a shell already in the background (no stamp) does not — the key stands down once the command moved', !foregroundShellInRoster([{ kind: 'shell', status: 'running' }]), '', 'foregroundShellInRoster in src/engine/connector/shellRunning.ts must require the foreground stamp')
check('a finished shell, a monitor: never', !foregroundShellInRoster([{ kind: 'shell', status: 'completed', foreground: true }, { kind: 'monitor', status: 'running', foreground: true }]), '', 'foregroundShellInRoster in src/engine/connector/shellRunning.ts must count only running rows of kind shell')

section('§3 the request registry — the main conversation\'s running commands take the request, a sub-agent\'s never')
{
  const fired: string[] = []
  let notified = 0
  const off = subscribeShellRuns(() => { notified++ })
  const unMain = registerShellRun({ agentId: undefined, request: () => fired.push('main') })
  const unAgent = registerShellRun({ agentId: 'agent-1', request: () => fired.push('agent') })
  check('one main run counts, the sub-agent\'s does not', mainShellRunsNow() === 1, String(mainShellRunsNow()), 'registerShellRun and mainShellRunsNow in src/tools/shell/backgroundRequest.ts must count runs with no agentId only')
  check('a request reaches the main run alone and reports one taken', requestShellBackground() === 1 && fired.join(',') === 'main', fired.join(','), 'requestShellBackground in src/tools/shell/backgroundRequest.ts must call only main runs and return how many it took')
  unMain()
  check('after the main run ends a request takes nothing', requestShellBackground() === 0 && mainShellRunsNow() === 0, '', 'the function registerShellRun returns in src/tools/shell/backgroundRequest.ts must remove the run so requestShellBackground returns 0')
  unAgent()
  check('registrations and their ends notify the subscribers', notified >= 4, String(notified), 'registerShellRun and its unregister function in src/tools/shell/backgroundRequest.ts must notify the subscribeShellRuns listeners')
  off()
}

section('§4 the wire — the key row, the runner\'s method, the daemon\'s verb at its own proto')
check('chat:backgroundShell lives in the Chat context', ACTION_GRAPH['chat:backgroundShell']?.contexts.includes('Chat') === true, '', 'the chat:backgroundShell entry in src/screen/keys/actionGraph.ts must list Chat in contexts')
check('the /keys row and the palette entry read the frames\' words: background the command', ACTION_GRAPH['chat:backgroundShell']?.description === 'background the command', JSON.stringify(ACTION_GRAPH['chat:backgroundShell']?.description), 'set the description of chat:backgroundShell in src/screen/keys/actionGraph.ts')
const chat = Object.assign({}, ...(DEFAULT_BINDINGS as { context: string; bindings: Record<string, string> }[]).filter(b => b.context === 'Chat').map(b => b.bindings)) as Record<string, string>
check('the default Chat binding is shift+b', chat['shift+b'] === 'chat:backgroundShell', JSON.stringify(chat['shift+b']), 'bind shift+b to chat:backgroundShell in the Chat context of src/screen/keys/defaultBindings.ts')
check('the wire declares shell/background as a host request with no params and a positive taken count', METHODS['shell/background'].from === 'host' && METHODS['shell/background'].kind === 'request' && METHODS['shell/background'].params().safeParse({}).success && METHODS['shell/background'].result().safeParse({ taken: 1 }).success && !METHODS['shell/background'].result().safeParse({ taken: 0 }).success, '', 'the shell/background entry in src/daemon/runner-wire/sessionVerbs.ts must be a host request with empty params and a positive integer taken')
check('the daemon verb sessionControl/background-shell is born at proto 11 and the wire is at least there', DAEMON_VERB_BORN_AT['sessionControl/background-shell'] === 11 && verbBornAt('sessionControl', 'background-shell') === 11 && MERCURY_DAEMON_PROTO >= 11, '', 'DAEMON_VERB_BORN_AT in src/daemon/runner-wire/sessionVerbs.ts must give sessionControl/background-shell the value 11 and MERCURY_DAEMON_PROTO in src/daemon/control/protocol.ts must be at least 11')


section('§7 the receipt — an applied verb paints nothing; a refusal paints the connector\'s own sentence on the notice row')
const hook = (await import('../../src/screen/chat/interruptKeys.ts')) as { backgroundShellNotice?: (receipt: { outcome: 'applied' | 'refused'; detail?: string }) => { key: string; text?: string; priority: string; timeoutMs?: number } | null }
const notice = hook.backgroundShellNotice
check('the chord\'s receipt reader is exported from the hook', typeof notice === 'function', '', 'export backgroundShellNotice from src/screen/chat/interruptKeys.ts')
if (typeof notice === 'function') {
  check('applied (the runner took the command): nothing is painted — the canvas shows the move', notice({ outcome: 'applied', detail: '{"taken":1}' }) === null && notice({ outcome: 'applied' }) === null, '', 'backgroundShellNotice in src/screen/chat/interruptKeys.ts must return null for an applied receipt')
  const older = "this session's runner predates shift+B · /daemon restart, then reopen the session"
  const painted = notice({ outcome: 'refused', detail: older })
  check('refused by an older runner: the seat\'s sentence itself, immediate, on the notice row, on the channel\'s own clock', painted !== null && painted.text === older && painted.priority === 'immediate' && painted.key === 'background-shell' && painted.timeoutMs === undefined, JSON.stringify(painted), 'backgroundShellNotice in src/screen/chat/interruptKeys.ts must return the refusal detail as text, priority immediate, key background-shell, no timeoutMs')
  for (const detail of ['no shell command is running in the main conversation', "the session's runner did not answer the background-shell within 10s", 'the session has no live control channel', 'the daemon is not answering — connect ECONNREFUSED', 'no chat is open — ↵ New Session on the boot menu starts one']) {
    const row = notice({ outcome: 'refused', detail })
    check(`refused: "${detail.slice(0, 44)}" reaches the row verbatim`, row !== null && row.text === detail, JSON.stringify(row), 'backgroundShellNotice in src/screen/chat/interruptKeys.ts must pass a refused receipt detail through unchanged')
  }
}

console.log(`\n${failures === 0 ? '✅' : '❌'} shell-background-words — ${failures === 0 ? 'all checks pass' : `${failures} check(s) failed`}`)
process.exit(failures === 0 ? 0 : 1)
