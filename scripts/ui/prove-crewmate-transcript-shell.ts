import React from 'react'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { mountOffscreen, pinSourceRef, settle, waitFor } from '../lib/settingsPopupHarness.js'
import { encodeSeedTranscript } from '../lib/seedTranscript.js'

pinSourceRef()
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
process.env.MERCURY_LIVE_GLYPHS = '0'
process.env.MERCURY_LIVE_CLOCK = '0'
process.env.MERCURY_REDUCED_MOTION = '1'
const home = process.env.MERCURY_CONFIG_DIR!
const { enableConfigs } = await import('../../src/utils/config/globalConfig.js')
enableConfigs()
const { Box, Text } = await import('../../src/ink.js')
const { AppStateProvider, getDefaultAppState } = await import('../../src/state/AppState.js')
const { ThemeProvider } = await import('../../src/components/design-system/ThemeProvider.js')
const { TerminalSizeContext } = await import('../../src/ink/components/TerminalSizeContext.js')
const { TranscriptSwap } = await import('../../src/components/CrewmateTranscript.js')
const { crewmateTranscriptFile } = await import('../../src/components/tasks/useCrewmateTranscript.js')
const { BashTool } = await import('../../src/tools/BashTool/BashTool.js')
const { SleepTool } = await import('../../src/tools/SleepTool/SleepTool.js')
const { noSessionConnector } = await import('../../src/services/engine-connector/noSessionConnector.js')
const { setFocusedSessionConnector, releaseFocusedSessionConnector } = await import('../../src/services/engine-connector/focusedConnector.js')
const h = React.createElement
const hosted = { sessionId: 'transcript-shell-session', originalCwd: home }
const resting = noSessionConnector()
setFocusedSessionConnector(new Proxy(resting, {
  get(target, prop, receiver) {
    if (prop === 'sessionId') return () => hosted.sessionId
    if (prop === 'workspace') return () => ({ cwd: home, originalCwd: home })
    const value = Reflect.get(target, prop, receiver)
    return typeof value === 'function' ? value.bind(target) : value
  },
}))
let checks = 0
let failures = 0
function check(label: string, ok: boolean): void {
  checks++
  if (!ok) failures++
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${label}`)
}
const framesAt = process.argv.indexOf('--frames')
const frames = framesAt < 0 ? undefined : process.argv[framesAt + 1]
if (frames !== undefined) mkdirSync(frames, { recursive: true })
let serial = 0
async function capture(command: string, structured: boolean, fullscreen: boolean, tool = 'Bash'): Promise<string> {
  const agentId = `transcript-shell-${++serial}`
  const file = crewmateTranscriptFile({ taskId: agentId, local: undefined }, hosted)!
  const output = 'CREW-SHELL-OUTPUT\n' + '1234567890'.repeat(9) + '\nlast recorded line'
  const row = (n: number, extra: Record<string, unknown>): Record<string, unknown> => ({ uuid: `00000000-0000-4000-8000-${String(serial * 10 + n).padStart(12, '0')}`, parentUuid: n === 0 ? null : `00000000-0000-4000-8000-${String(serial * 10 + n - 1).padStart(12, '0')}`, timestamp: '2026-06-19T12:00:00.000Z', agentId, isSidechain: true, sessionId: hosted.sessionId, cwd: home, version: '1.0.0', ...extra })
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, encodeSeedTranscript([
    row(0, { type: 'assistant', message: { id: `call-${serial}`, role: 'assistant', type: 'message', model: 'claude-sonnet-5', content: [{ type: 'tool_use', id: `shell-${serial}`, name: tool, input: tool === 'Bash' ? { command } : { seconds: 4 } }], stop_reason: 'tool_use', usage: { input_tokens: 1, output_tokens: 1 } } }),
    row(1, { type: 'user', ...(structured ? { toolUseResult: { stdout: output, stderr: '', interrupted: false } } : {}), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: `shell-${serial}`, content: output }] } }),
  ], hosted.sessionId))
  if (fullscreen) delete process.env.MERCURY_FULLSCREEN
  else process.env.MERCURY_FULLSCREEN = '0'
  const state = { ...getDefaultAppState(), viewingAgentTaskId: agentId, tasks: { [agentId]: { id: agentId, type: 'local_agent', status: 'completed', description: 'shell-output', agentId, startTime: 1, endTime: 100 } } as never }
  const tree = h(AppStateProvider, { initialState: state, children: h(ThemeProvider, null, h(TerminalSizeContext.Provider, { value: { columns: 80, rows: 24 } }, h(Box, { width: 80, height: 24, flexDirection: 'column' }, h(TranscriptSwap, { lead: h(Text, null, 'LEAD-FALLBACK'), tools: [BashTool, SleepTool], commands: [], screen: 'prompt' })))) })
  const view = await mountOffscreen(tree, 80, 24)
  try {
    check(`${fullscreen ? 'fullscreen' : 'inline'} ${tool} ${command} ${structured ? 'structured' : 'recorded'}: the real transcript is selected and loaded`, await waitFor(() => view.screen().includes(tool) && !view.screen().includes('LEAD-FALLBACK'), 3000))
    await settle(120)
    const text = view.lines().join('\n')
    if (frames !== undefined) writeFileSync(join(frames, `${serial}-${fullscreen ? 'fullscreen' : 'inline'}-${structured ? 'structured' : 'recorded'}.txt`), text + '\n')
    return text
  } finally {
    view.unmount()
  }
}
try {
  for (const fullscreen of [true, false]) {
    for (const command of ['printf fixture', 'ls', 'git status']) {
      const recorded = await capture(command, false, fullscreen)
      const structured = await capture(command, true, fullscreen)
      const label = `${fullscreen ? 'fullscreen' : 'inline'} ${command}`
      check(`${label}: the recorded output paints once through TranscriptSwap`, recorded.split('CREW-SHELL-OUTPUT').length === 2 && recorded.includes('last recorded line'))
      check(`${label}: long output wraps at exactly the structured result's width`, recorded === structured)
    }
    const other = await capture('wait', false, fullscreen, 'Sleep')
    check(`${fullscreen ? 'fullscreen' : 'inline'}: a non-shell call gains no raw-result text`, !other.includes('CREW-SHELL-OUTPUT'))
  }
} finally {
  releaseFocusedSessionConnector()
}
console.log(`${checks} checks, ${failures} failed`)
process.exit(failures === 0 ? 0 : 1)
