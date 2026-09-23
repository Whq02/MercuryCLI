#!/usr/bin/env bun
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(import.meta.dir, '..', '..')
let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail.slice(0, 300)}` : ''}`)
}
function section(title: string): void {
  console.log(`\n${'─'.repeat(76)}\n${title}\n${'─'.repeat(76)}`)
}
const read = (rel: string): string => readFileSync(join(ROOT, rel), 'utf8')

const bar = await import('../../src/components/SwitchboardTagBar.tsx')
const { keyHintLabel } = await import('../../src/components/mercury-ui/keyHintLabel.ts')
const { shellToolRunning } = await import('../../src/services/engine-connector/shellRunning.ts')
const { IDLE_LIVE } = await import('../../src/services/engine-connector/seatLive.ts')
const { registerShellRun, requestShellBackground, mainShellRunsNow, subscribeShellRuns } = await import('../../src/tools/BashTool/backgroundRequest.ts')
const { ACTION_GRAPH } = await import('../../src/keybindings/actionGraph.ts')
const { DEFAULT_BINDINGS } = await import('../../src/keybindings/defaultBindings.ts')
const { DAEMON_VERB_BORN_AT, MERCURY_DAEMON_PROTO, verbBornAt } = await import('../../src/daemon/protocol.ts')
const { SDKControlBackgroundShellRequestSchema } = await import('../../src/entrypoints/sdk/controlSchemas.ts')

type Live = typeof IDLE_LIVE
const live = (inFlight: boolean): Live => ({ ...IDLE_LIVE, inFlight, phase: inFlight ? 'tool' : 'idle', inProgressToolUseIDs: new Set(inFlight ? ['toolu_1'] : []) })
const status = (interrupting = false, hardStopping = false): { interrupting: boolean; hardStopping: boolean } => ({ interrupting, hardStopping })

section('§1 the ready line\'s tail — the second key named only while a shell command runs, esc keeping its meaning on every rung')
check('a running shell command: esc interrupts · ⇧b backgrounds · ⇧← back', bar.escBackHint(live(true), status(), true) === keyHintLabel('esc interrupts · ⇧b backgrounds · ⇧← back'), bar.escBackHint(live(true), status(), true))
check('a plain model call: esc interrupts · ⇧← back, as shipped', bar.escBackHint(live(true), status(), false) === keyHintLabel('esc interrupts · ⇧← back'), bar.escBackHint(live(true), status(), false))
check('the default reads as shipped (every caller that says nothing about a shell)', bar.escBackHint(live(true), status()) === keyHintLabel('esc interrupts · ⇧← back'))
check('interrupting: esc again re-sends the interrupt · ⇧← back, the background clause gone with the interrupt rung', bar.escBackHint(live(true), status(true), true) === keyHintLabel('esc again re-sends the interrupt · ⇧← back'), bar.escBackHint(live(true), status(true), true))
check('hard-stopping: ⇧← back alone', bar.escBackHint(live(true), status(true, true), true) === keyHintLabel('⇧← back'))
check('idle: ⇧← back alone whatever the shell fact says', bar.escBackHint(live(false), status(), true) === keyHintLabel('⇧← back'))

section('§2 the shell fact — an unresolved Bash tool_use on the canvas, nothing else')
const row = (name: string, id: string): unknown => ({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name, input: {} }] } })
type Records = Parameters<typeof shellToolRunning>[0]
check('an in-progress Bash tool_use reads as a running shell', shellToolRunning([row('Bash', 'toolu_1')] as Records, new Set(['toolu_1'])))
check('an in-progress Read tool_use does not', !shellToolRunning([row('Read', 'toolu_1')] as Records, new Set(['toolu_1'])))
check('a Bash tool_use already resolved does not', !shellToolRunning([row('Bash', 'toolu_1')] as Records, new Set(['toolu_2'])))
check('nothing in progress reads as no shell', !shellToolRunning([row('Bash', 'toolu_1')] as Records, new Set()))
check('the newest unresolved Bash row wins over older resolved ones', shellToolRunning([row('Bash', 'toolu_0'), row('Read', 'toolu_1'), row('Bash', 'toolu_2')] as Records, new Set(['toolu_1', 'toolu_2'])))

section('§3 the request registry — the main conversation\'s running commands take the request, a sub-agent\'s never')
{
  const fired: string[] = []
  let notified = 0
  const off = subscribeShellRuns(() => { notified++ })
  const unMain = registerShellRun({ agentId: undefined, request: () => fired.push('main') })
  const unAgent = registerShellRun({ agentId: 'agent-1', request: () => fired.push('agent') })
  check('one main run counts, the sub-agent\'s does not', mainShellRunsNow() === 1, String(mainShellRunsNow()))
  check('a request reaches the main run alone and reports one taken', requestShellBackground() === 1 && fired.join(',') === 'main', fired.join(','))
  unMain()
  check('after the main run ends a request takes nothing', requestShellBackground() === 0 && mainShellRunsNow() === 0)
  unAgent()
  check('registrations and their ends notify the subscribers', notified >= 4, String(notified))
  off()
}

section('§4 the wire — the key row, the runner\'s subtype, the daemon\'s verb at its own proto')
check('chat:backgroundShell lives in the Chat context', ACTION_GRAPH['chat:backgroundShell']?.contexts.includes('Chat') === true)
check('the /keys row and the palette entry read the frames\' words: background the command', ACTION_GRAPH['chat:backgroundShell']?.description === 'background the command', JSON.stringify(ACTION_GRAPH['chat:backgroundShell']?.description))
const chat = Object.assign({}, ...(DEFAULT_BINDINGS as { context: string; bindings: Record<string, string> }[]).filter(b => b.context === 'Chat').map(b => b.bindings)) as Record<string, string>
check('the default Chat binding is shift+b', chat['shift+b'] === 'chat:backgroundShell', JSON.stringify(chat['shift+b']))
check('the runner accepts { subtype: background_shell }', SDKControlBackgroundShellRequestSchema().safeParse({ subtype: 'background_shell' }).success)
check('the daemon verb sessionControl/background-shell is born at proto 11 and the wire is at least there', DAEMON_VERB_BORN_AT['sessionControl/background-shell'] === 11 && verbBornAt('sessionControl', 'background-shell') === 11 && MERCURY_DAEMON_PROTO >= 11)
const server = read('src/daemon/controlServer.ts')
check('the control server admits the action and names it in its refusal', server.includes("raw.action === 'background-shell'") && server.includes('withdraw-send|background-shell, sessionId, by'))
const main = read('src/daemon/main.ts')
check('the daemon relays the action to the seat verb', main.includes("if (action === 'background-shell')") && main.includes('return backgroundSessionShell(sessionId, roster)'))
const seat = read('src/daemon/sessionSeat.ts')
check('the seat delivers the runner\'s background_shell control request and awaits its word', seat.includes("request: { subtype: 'background_shell' }") && seat.includes('export function backgroundSessionShell('))
check('a runner older than the verb is refused in one sentence naming the key and the way out', seat.includes(`"this session's runner predates shift+B · /daemon restart, then reopen the session"`))
const runner = read('src/cli/print.ts')
check('the runner answers the subtype from the registry: applied with the count, or the typed refusal', runner.includes("case 'background_shell': {") && runner.includes("respondError(requestId, 'no shell command is running in the main conversation')"))

section('§5 the tool\'s road and its words')
const tool = read('src/tools/BashTool/BashTool.tsx')
check('the Bash call registers its run for the request and unregisters on every exit', tool.includes('const unregisterRun = registerShellRun({') && tool.includes('unregisterRun()'))
check('the quiet window races the request beside completion', tool.includes("await Promise.race([completed, quietTimer, backgroundAsk])"))
check('the progress loop takes the request once and returns the task as backgrounded by the operator', tool.includes('if (backgroundAsked && !backgroundAskHandled && !interruptBackgroundingStarted && backgroundId === undefined)') && tool.includes('...(backgroundAskHandled ? { backgroundedByUser: true } : {})'))
check('the tool result says the operator moved the command to the background as a task whose output arrives as a notification', tool.includes('The operator moved this command to the background as task ${id}; it is still running, and its output arrives as a notification when it completes. Output: ${outputPath}.'))

section('§6 the two rows and the key, behind one setting')
const footer = read('src/components/PromptInput/PromptInputFooterLeftSide.tsx')
check('the hint row adds ⇧b background the command beside esc interrupt only while a shell command runs and the key is on', footer.includes("if (shellRunning && getSettingsSnapshot().settings.backgroundKey !== false) {") && footer.includes(`shortcut={keyHintLabel('⇧b')} action="background the command"`))
const tag = read('src/components/SwitchboardTagBar.tsx')
check('the ready line reads the shell fact through the same setting', tag.includes('escBackHint(live, status, shellRunning && getSettingsSnapshot().settings.backgroundKey !== false)'))
const cancel = read('src/hooks/useCancelRequest.ts')
check('the chord rides the Chat context, armed only while a shell runs and the key is on, and lets a draft keep its letter', cancel.includes("'chat:backgroundShell',") && cancel.includes("if (pendingInput.text() !== '') return false") && cancel.includes('isActive: isEscapeActive && shellRunning && getSettingsSnapshot().settings.backgroundKey !== false'))
const settings = read('src/utils/settings/types.ts')
check('the setting is declared in the settings store', settings.includes('backgroundKey: z.boolean().optional()'))

section('§7 the receipt — an applied verb paints nothing; a refusal paints the connector\'s own sentence on the notice row')
const hook = (await import('../../src/hooks/useCancelRequest.ts')) as { backgroundShellNotice?: (receipt: { outcome: 'applied' | 'refused'; detail?: string }) => { key: string; text?: string; priority: string; timeoutMs?: number } | null }
const notice = hook.backgroundShellNotice
check('the chord\'s receipt reader is exported from the hook', typeof notice === 'function')
if (typeof notice === 'function') {
  check('applied (the runner took the command): nothing is painted — the canvas shows the move', notice({ outcome: 'applied', detail: '{"taken":1}' }) === null && notice({ outcome: 'applied' }) === null)
  const older = "this session's runner predates shift+B · /daemon restart, then reopen the session"
  const painted = notice({ outcome: 'refused', detail: older })
  check('refused by an older runner: the seat\'s sentence itself, immediate, on the notice row, on the channel\'s own clock', painted !== null && painted.text === older && painted.priority === 'immediate' && painted.key === 'background-shell' && painted.timeoutMs === undefined, JSON.stringify(painted))
  for (const detail of ['no shell command is running in the main conversation', "the session's runner did not answer the background-shell within 10s", 'the session has no live control channel', 'the daemon is not answering — connect ECONNREFUSED', 'no chat is open — ↵ New Session on the boot menu starts one']) {
    const row = notice({ outcome: 'refused', detail })
    check(`refused: "${detail.slice(0, 44)}" reaches the row verbatim`, row !== null && row.text === detail, JSON.stringify(row))
  }
}
check('the chord reads the receipt through the reader into the notification road; no discarded promise', cancel.includes('void focused.backgroundShell().then(receipt => {') && cancel.includes('const notice = backgroundShellNotice(receipt)') && cancel.includes('if (notice !== null) addNotification(notice)') && !cancel.includes('void focused.backgroundShell()\n'))

console.log(`\n${failures === 0 ? '✅' : '❌'} shell-background-words — ${failures === 0 ? 'all checks pass' : `${failures} check(s) failed`}`)
process.exit(failures === 0 ? 0 : 1)
