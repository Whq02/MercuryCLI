import React from 'react'
import { mock } from 'bun:test'
import { dirname, join } from 'node:path'
import { mkdirSync, writeFileSync } from 'node:fs'
import { KEY, mountOffscreen, pinScratchHome, pinSourceRef, releaseScratchHome, settle, waitFor } from '../lib/settingsPopupHarness.js'

pinSourceRef()
const home = pinScratchHome('task-transcript-settle')
let failures = 0
const check = (label: string, ok: boolean, detail?: string): void => {
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${label}`)
  if (!ok) {
    failures++
    if (detail) console.log(`  ${detail}`)
  }
}
const deferred = <T,>() => {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}

await import('../../src/tools/crewmate/CrewmateTool.js')
const reader = await import('../../src/crew/crewmates/agentTranscriptReader.js')
mock.module('../../src/crew/crewmates/agentTranscriptReader.js', () => ({
  ...reader,
  readAgentTranscript: async () => ({ finalText: 'initial transcript' } as never),
}))
const loading = await import('../../src/sessions/transcripts/loading.js')
let diskReads = 0
let diskRead = deferred<Awaited<ReturnType<typeof loading.loadTranscriptFile>>>()
mock.module('../../src/sessions/transcripts/loading.js', () => ({
  ...loading,
  loadTranscriptFile: async () => { diskReads++; return diskRead.promise },
}))
const { useCrewmateTranscript, crewmateTranscriptFile } = await import('../../src/screen/tasks/useCrewmateTranscript.js')
const { AsyncAgentDetailDialog } = await import('../../src/screen/tasks/CrewmateDetailDialog.js')
const { BackgroundTasksDialog } = await import('../../src/screen/tasks/BackgroundTasksDialog.js')
const { AppStateProvider, getDefaultAppState, useSetAppState } = await import('../../src/screen/app-state/AppState.js')
const { ThemeProvider } = await import('../../src/screen/theme/ThemeProvider.js')
const { KeybindingSetup } = await import('../../src/screen/keys/KeybindingProviderSetup.js')
const { Box, Text } = await import('../../src/screen/themedRenderer.js')
const { noSessionConnector } = await import('../../src/engine/connector/noSessionConnector.js')
const { setFocusedSessionConnector, releaseFocusedSessionConnector } = await import('../../src/engine/connector/focusedConnector.js')
const { enableConfigs } = await import('../../src/platform/config/globalConfig.js')
enableConfigs()
const wrap = (node: React.ReactNode, initialState?: ReturnType<typeof getDefaultAppState>) => <AppStateProvider initialState={initialState}><ThemeProvider><KeybindingSetup><Box width={100} height={32} flexDirection="column">{node}</Box></KeybindingSetup></ThemeProvider></AppStateProvider>
const mount = (node: React.ReactNode) => mountOffscreen(wrap(node), 100, 32)

try {
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
  check('the crew starts its disk read', await waitFor(() => diskReads === 1, 3000), 'useCrewmateTranscript in src/screen/tasks/useCrewmateTranscript.ts did not call loadTranscriptFile once on mount; check that its disk read starts from the effect.')
  crewView.resize(wrap(<CrewProbe stamp={2} />), 100, 32)
  await settle(100)
  diskRead.resolve({ messages: new Map([['row', { type: 'assistant', uuid: 'row', agentId: 'fixture-crew', message: { content: [{ type: 'text', text: 'crew final answer' }] } }]]) } as never)
  check('a roster update during disk IO does not permanently lose the unchanged transcript', await waitFor(() => crewView.screen().includes('crew final answer'), 5500), 'the transcript read in src/screen/tasks/useCrewmateTranscript.ts must not drop a finished disk read when the stamp changes mid-read; check how it discards a stale read.')
  crewView.unmount()
  releaseFocusedSessionConnector()
  await settle(100)

  let closed = 0
  const agent = { id: 'fixture-agent', type: 'local_agent', status: 'completed', startTime: 1000, endTime: 2000, agentType: 'fixture', description: 'fixture detail', prompt: 'fixture brief' } as never
  const card = await mount(<AsyncAgentDetailDialog agent={agent} onDone={() => { closed++ }} />)
  check('the agent card renders', await waitFor(() => card.screen().includes('fixture brief'), 3000), 'AsyncAgentDetailDialog in src/screen/tasks/CrewmateDetailDialog.tsx should render the agent prompt for a completed agent.')
  card.push(KEY.esc)
  check('escape closes the agent card once', await waitFor(() => closed === 1, 1000), 'AsyncAgentDetailDialog in src/screen/tasks/CrewmateDetailDialog.tsx must call onDone exactly once on escape; closed=' + closed)
  card.unmount()
  await settle(100)

  const output = join(home, 'shell-output.txt')
  writeFileSync(output, 'last output\n')
  const shell = { id: 'fixture-shell', type: 'local_bash', status: 'running', startTime: Date.now() - 2000, description: 'fixture shell', command: 'fixture command', outputFile: output, isBackgrounded: true, shellCommand: null } as unknown as import('../../src/engine/tasks/local-shell/shellTaskState.js').LocalShellTaskState
  let setState: ReturnType<typeof useSetAppState> | undefined
  let shellClosed = 0
  function ShellProbe(): React.ReactNode {
    setState = useSetAppState()
    return <BackgroundTasksDialog initialDetailTaskId="fixture-shell" toolUseContext={{} as never} onDone={() => { shellClosed++ }} />
  }
  const initialState = { ...getDefaultAppState(), tasks: { 'fixture-shell': shell } }
  const shellView = await mountOffscreen(wrap(<ShellProbe />, initialState), 100, 32)
  check('the shell card renders its running state', await waitFor(() => shellView.screen().includes('fixture command') && shellView.screen().includes('last output') && shellView.screen().includes('running'), 3000), 'BackgroundTasksDialog in src/screen/tasks/BackgroundTasksDialog.tsx should open the shell task detail with its command, last output and running state.')
  shellClosed = 0
  setState!(state => ({ ...state, tasks: { 'fixture-shell': { ...shell, status: 'failed', endTime: Date.now(), result: { code: 23, interrupted: false } } } }))
  await settle(300)
  check('shell settlement keeps the final output and exit code readable', shellClosed === 0 && shellView.screen().includes('exit 23') && shellView.screen().includes('last output'), 'a shell task that settles as failed must keep the detail open (shellClosed=' + shellClosed + ') and show the exit code and output; look at BackgroundTasksDialog in src/screen/tasks/BackgroundTasksDialog.tsx.')
  shellView.unmount()
} finally {
  releaseFocusedSessionConnector()
  await releaseScratchHome(home)
}
console.log(`${failures} failures`)
process.exit(failures === 0 ? 0 : 1)
