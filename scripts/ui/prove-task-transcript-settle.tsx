import React from 'react'
import { mock } from 'bun:test'
import { dirname, join } from 'node:path'
import { mkdirSync, writeFileSync } from 'node:fs'
import { KEY, mountOffscreen, pinScratchHome, pinSourceRef, releaseScratchHome, settle, waitFor } from '../lib/settingsPopupHarness.js'

pinSourceRef()
const home = pinScratchHome('task-transcript-settle')
let failures = 0
const check = (label: string, ok: boolean): void => {
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${label}`)
  if (!ok) failures++
}
const deferred = <T,>() => {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}

await import('../../src/tools/AgentTool/AgentTool.js')
const reader = await import('../../src/tools/WorkflowTool/agentTranscriptReader.js')
let transcriptText = 'initial transcript'
let transcriptCalls = 0
let heldView: ReturnType<typeof deferred<Awaited<ReturnType<typeof reader.readAgentTranscript>>>> | null = null
const viewOf = (text: string): Awaited<ReturnType<typeof reader.readAgentTranscript>> => ({ finalText: text } as never)
mock.module('../../src/tools/WorkflowTool/agentTranscriptReader.js', () => ({
  ...reader,
  readAgentTranscript: async () => {
    transcriptCalls++
    return heldView === null ? viewOf(transcriptText) : heldView.promise
  },
  readAgentMeta: async () => undefined,
}))
const loading = await import('../../src/utils/sessionStorage/loading.js')
let diskReads = 0
let diskRead = deferred<Awaited<ReturnType<typeof loading.loadTranscriptFile>>>()
mock.module('../../src/utils/sessionStorage/loading.js', () => ({
  ...loading,
  loadTranscriptFile: async () => { diskReads++; return diskRead.promise },
}))
const { useAgentTranscriptView } = await import('../../src/components/tasks/useAgentTranscriptView.js')
const { useCrewmateTranscript, crewmateTranscriptFile } = await import('../../src/components/tasks/useCrewmateTranscript.js')
const { AsyncAgentDetailDialog } = await import('../../src/components/tasks/AsyncAgentDetailDialog.js')
const { BackgroundTasksDialog } = await import('../../src/components/tasks/BackgroundTasksDialog.js')
const { AppStateProvider, getDefaultAppState, useSetAppState } = await import('../../src/state/AppState.js')
const { ThemeProvider } = await import('../../src/components/design-system/ThemeProvider.js')
const { KeybindingSetup } = await import('../../src/keybindings/KeybindingProviderSetup.js')
const { Box, Text } = await import('../../src/ink.js')
const { noSessionConnector } = await import('../../src/services/engine-connector/noSessionConnector.js')
const { setFocusedSessionConnector, releaseFocusedSessionConnector } = await import('../../src/services/engine-connector/focusedConnector.js')
const { enableConfigs } = await import('../../src/utils/config/globalConfig.js')
enableConfigs()
const wrap = (node: React.ReactNode, initialState?: ReturnType<typeof getDefaultAppState>) => <AppStateProvider initialState={initialState}><ThemeProvider><KeybindingSetup><Box width={100} height={32} flexDirection="column">{node}</Box></KeybindingSetup></ThemeProvider></AppStateProvider>
const mount = (node: React.ReactNode) => mountOffscreen(wrap(node), 100, 32)

function TranscriptProbe({ state, version }: { state: string; version: number }): React.ReactNode {
  const read = useAgentTranscriptView({ transcriptDir: home, agentId: 'fixture-agent', enabled: true, liveState: state, version })
  return <Text>{read.view?.finalText ?? read.status}</Text>
}

try {
  const view = await mount(<TranscriptProbe state="progress" version={1} />)
  check('the live workflow transcript reads on entry', await waitFor(() => view.screen().includes('initial transcript'), 3000))
  transcriptText = 'final transcript'
  view.resize(wrap(<TranscriptProbe state="done" version={2} />), 100, 32)
  check('settling inside the throttle window reads the final transcript without reopening', await waitFor(() => view.screen().includes('final transcript'), 3000))
  view.unmount()
  await settle(100)

  const held = deferred<Awaited<ReturnType<typeof reader.readAgentTranscript>>>()
  heldView = held
  const stale = await mount(<TranscriptProbe state="progress" version={3} />)
  await settle(100)
  heldView = null
  transcriptText = 'newer settled transcript'
  stale.resize(wrap(<TranscriptProbe state="done" version={4} />), 100, 32)
  await settle(150)
  held.resolve(viewOf('older live transcript'))
  check('an older in-flight read cannot overwrite the settled transcript', await waitFor(() => stale.screen().includes('newer settled transcript'), 3000))
  stale.unmount()
  await settle(100)

  const hosted = { sessionId: 'fixture-session', originalCwd: home }
  const resting = noSessionConnector()
  setFocusedSessionConnector(new Proxy(resting, {
    get(target, prop, receiver) {
      if (prop === 'sessionId') return () => hosted.sessionId
      if (prop === 'workspace') return () => ({ cwd: home, originalCwd: home })
      const value = Reflect.get(target, prop, receiver)
      return typeof value === 'function' ? value.bind(target) : value
    },
  }))
  const crewmate = { taskId: 'fixture-crew', local: undefined, name: 'fixture', facts: { transcriptAgentId: 'fixture-crew', running: false, endedAt: 100 }, pinned: false, running: 0 } as never
  const file = crewmateTranscriptFile(crewmate, hosted)!
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, 'fixture\n')
  function CrewProbe({ stamp }: { stamp: number }): React.ReactNode {
    const read = useCrewmateTranscript(crewmate, stamp)
    return <Text>{JSON.stringify(read)}</Text>
  }
  const crewView = await mount(<CrewProbe stamp={1} />)
  check('the crew starts its disk read', await waitFor(() => diskReads === 1, 3000))
  crewView.resize(wrap(<CrewProbe stamp={2} />), 100, 32)
  await settle(100)
  diskRead.resolve({ messages: new Map([['row', { type: 'assistant', uuid: 'row', agentId: 'fixture-crew', message: { content: [{ type: 'text', text: 'crew final answer' }] } }]]) } as never)
  check('a roster update during disk IO does not permanently lose the unchanged transcript', await waitFor(() => crewView.screen().includes('crew final answer'), 5500))
  crewView.unmount()
  releaseFocusedSessionConnector()
  await settle(100)

  let closed = 0
  const agent = { id: 'fixture-agent', type: 'local_agent', status: 'completed', startTime: 1000, endTime: 2000, agentType: 'fixture', description: 'fixture detail', prompt: 'fixture brief' } as never
  const card = await mount(<AsyncAgentDetailDialog agent={agent} onDone={() => { closed++ }} />)
  check('the agent card renders', await waitFor(() => card.screen().includes('fixture brief'), 3000))
  card.push(KEY.esc)
  check('escape closes the agent card once', await waitFor(() => closed === 1, 1000))
  card.unmount()
  await settle(100)

  const output = join(home, 'shell-output.txt')
  writeFileSync(output, 'last output\n')
  const shell = { id: 'fixture-shell', type: 'local_bash', status: 'running', startTime: Date.now() - 2000, description: 'fixture shell', command: 'fixture command', outputFile: output, isBackgrounded: true, shellCommand: null } as unknown as import('../../src/tasks/LocalShellTask/guards.js').LocalShellTaskState
  let setState: ReturnType<typeof useSetAppState> | undefined
  let shellClosed = 0
  function ShellProbe(): React.ReactNode {
    setState = useSetAppState()
    return <BackgroundTasksDialog initialDetailTaskId="fixture-shell" toolUseContext={{} as never} onDone={() => { shellClosed++ }} />
  }
  const initialState = { ...getDefaultAppState(), tasks: { 'fixture-shell': shell } }
  const shellView = await mountOffscreen(wrap(<ShellProbe />, initialState), 100, 32)
  check('the shell card renders its running state', await waitFor(() => shellView.screen().includes('fixture command') && shellView.screen().includes('last output') && shellView.screen().includes('running'), 3000))
  shellClosed = 0
  setState!(state => ({ ...state, tasks: { 'fixture-shell': { ...shell, status: 'failed', endTime: Date.now(), result: { code: 23, interrupted: false } } } }))
  await settle(300)
  check('shell settlement keeps the final output and exit code readable', shellClosed === 0 && shellView.screen().includes('exit 23') && shellView.screen().includes('last output'))
  shellView.unmount()
} finally {
  releaseFocusedSessionConnector()
  await releaseScratchHome(home)
}
console.log(`${failures} failures; ${transcriptCalls} workflow transcript reads`)
process.exit(failures === 0 ? 0 : 1)
