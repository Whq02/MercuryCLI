#!/usr/bin/env bun
import React from 'react'
import { mock } from 'bun:test'
import { mountOffscreen, pinScratchHome, releaseScratchHome, waitFor } from '../lib/settingsPopupHarness.ts'

const home = pinScratchHome('sessions-command-routing')
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
const { enableConfigs } = await import('../../src/platform/settings/config.js')
enableConfigs()
const storage = await import('../../src/sessions/transcripts/sessionStorage.js')
const id = '00000000-0000-4000-8000-000000000044'
let logs: unknown[] = []
let direct: unknown = { sessionId: id }
let titles: unknown[] = []
let hydrationFails = false
let selected: ((log: unknown) => void) | undefined
let failures = 0
const unhandled: unknown[] = []
const onUnhandled = (error: unknown): void => { unhandled.push(error) }
process.on('unhandledRejection', onUnhandled)
mock.module('../../src/sessions/transcripts/sessionStorage.js', () => ({
  ...storage,
  listRepoSessions: async () => logs,
  listSessionsAcrossProjects: async () => logs,
  lastSession: async () => direct,
  searchSessionsByCustomTitle: async () => titles,
  sessionIdOfListing: (log: { sessionId: string }) => log.sessionId,
  isCustomTitleEnabled: () => true,
  isLiteListing: (log: { lite?: boolean }) => log.lite === true,
  fillSessionListing: async (log: unknown) => { if (hydrationFails) throw new Error('fixture transcript unreadable'); return log },
}))
mock.module('../../src/platform/git/worktree/worktreePathsPortable.js', () => ({ getWorktreePathsPortable: async () => [home] }))
mock.module('../../src/screen/session-chooser/sessionResumeFilter.js', () => ({ filterResumableSessions: (rows: unknown[]) => rows }))
mock.module('../../src/screen/session-chooser/SessionBrowser.js', () => ({ LogSelector: (props: { onSelect: typeof selected }) => { selected = props.onSelect; return null } }))
mock.module('../../src/screen/spinner/Spinner.js', () => ({ Spinner: () => null }))
const { call } = await import('../../src/commands/sessions/sessions.js')
const check = (label: string, ok: boolean, detail = ''): void => {
  if (!ok) failures++
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
}

for (const argument of [id, 'kept title']) {
  logs = []
  titles = argument === id ? [] : [{ sessionId: id }]
  const resumed: string[] = []
  const done: Array<string | undefined> = []
  const node = await call(message => { done.push(message) }, { resume: async (sessionId: string) => { resumed.push(sessionId) } } as never, argument)
  const mounted = await mountOffscreen(React.createElement(React.Fragment, {}, node), 120, 40)
  await waitFor(() => done.length > 0, 1500)
  check(`an empty local listing still resolves ${argument === id ? 'an explicit session id' : 'a stored title'}`, resumed.join() === id && done.length === 1 && done[0] === undefined, JSON.stringify({ resumed, done }) + ' — in src/commands/sessions/sessions.tsx the argument branch of call must still look up lastSession for an id and searchSessionsByCustomTitle for a title when the local listing is empty, then call performResume')
  mounted.unmount()
}

logs = [{ sessionId: id, lite: true }]
hydrationFails = true
const done: Array<string | undefined> = []
const node = await call(message => { done.push(message) }, {} as never, '')
const mounted = await mountOffscreen(React.createElement(React.Fragment, {}, node), 120, 40)
check('the fallback picker loads its selectable row', await waitFor(() => selected !== undefined, 1500), 'the LogSelector never received onSelect; check that call in src/commands/sessions/sessions.tsx still renders the picker when the argument is empty and context.resume is absent')
selected?.(logs[0])
await waitFor(() => done.length > 0 || unhandled.length > 0, 1500)
check('a failed transcript hydration settles through the existing error receipt', done.length === 1 && done[0] === 'Failed to resume: fixture transcript unreadable' && unhandled.length === 0, JSON.stringify({ done, unhandled: unhandled.map(String) }) + ' — the selection handler in src/commands/sessions/sessions.tsx must catch a fillSessionListing rejection and call onDone with Failed to resume: and the error message, not let it escape')
mounted.unmount()
process.removeListener('unhandledRejection', onUnhandled)

let generated: ((name: string) => void) | undefined
mock.module('../../src/commands/rename/generateSessionName.js', () => ({ generateSessionName: () => new Promise<string>(resolve => { generated = resolve }) }))
const control = await import('../../src/daemon/control/controlSocket.js')
const renamed: string[] = []
mock.module('../../src/daemon/control/controlSocket.js', () => ({ ...control, daemonControlRpc: async (request: { sessionId: string }) => { renamed.push(request.sessionId); return { ok: true, outcome: 'applied' } } }))
const { setFocusedSessionConnector, releaseFocusedSessionConnector } = await import('../../src/engine/connector/focusedConnector.js')
const { NoSessionConnector } = await import('../../src/engine/connector/noSessionConnector.js')
const { call: rename } = await import('../../src/commands/rename/rename.js')
const focus = (sessionId: string): void => { setFocusedSessionConnector(Object.assign(new NoSessionConnector(), { sessionId: () => sessionId })) }
let mirrors = 0
const renameContext = { messages: [], abortController: new AbortController(), setAppState() { mirrors++ } } as never
focus('original-session')
const pending = rename(() => {}, renameContext)
check('automatic naming waits for its generated name', generated !== undefined, 'src/commands/rename/rename.ts call must await generateSessionName when no name is given')
focus('other-session')
generated?.('generated-name')
await pending
check('a generated name targets the session that requested it, not a later focus', renamed.join() === 'original-session' && mirrors === 0, JSON.stringify({ renamed, mirrors }) + ' — src/commands/rename/rename.ts call must read focusedSessionId before awaiting generateSessionName and send that id in the set-title daemonControlRpc')
await rename(() => {}, renameContext, 'explicit name')
check('an explicit name still targets and mirrors the currently focused session', renamed.at(-1) === 'other-session' && mirrors === 1, JSON.stringify({ renamed, mirrors }) + ' — src/commands/rename/rename.ts call must send set-title for the focused session and call context.setAppState once when that session is still focused')
releaseFocusedSessionConnector()
await releaseScratchHome(home)
console.log(`prove-sessions-command-routing: ${failures} failure(s)`)
process.exit(failures ? 1 : 0)
