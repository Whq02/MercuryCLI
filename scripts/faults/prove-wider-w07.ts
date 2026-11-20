#!/usr/bin/env bun
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function skip(label: string, why: string): void {
  console.log(`  [SKIP] ${label} — ${why}`)
}

const HERE = dirname(fileURLToPath(import.meta.url))
const BUN = process.execPath.includes('bun') ? process.execPath : join(process.env.HOME ?? '', '.bun/bin/bun')
const SRC = process.env.PROVE_SRC ?? join(HERE, '../../src')
const LIB = join(HERE, '../lib')
const POSIX_MODES = process.platform !== 'win32' && (typeof process.getuid !== 'function' || process.getuid() !== 0)

function runSubprocess(
  body: string,
  opts?: { allowNonZero?: boolean },
): { status: number | null; stdout: string; stderr: string; out: Record<string, unknown> } {
  const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'wider-w07-')))
  const home = join(scratch, 'home')
  const project = join(scratch, 'project')
  mkdirSync(home, { recursive: true })
  mkdirSync(project, { recursive: true })
  const src = `
    process.env.MERCURY_CONFIG_DIR = ${JSON.stringify(home)}
    process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
    process.env.NODE_ENV = 'test'
    delete process.env.MERCURY_HOME
    globalThis.MACRO = { VERSION: '1.0.0' }
    process.chdir(${JSON.stringify(project)})
    const HOME = ${JSON.stringify(home)}
    const PROJECT = ${JSON.stringify(project)}
    const SRC = ${JSON.stringify(SRC)}
    const LIB = ${JSON.stringify(LIB)}
    const out = {}
    ${body}
    process.stdout.write('\\n__OUT__' + JSON.stringify(out))
    process.exit(0)
  `
  try {
    const res = spawnSync(BUN, ['-e', src], {
      encoding: 'utf8',
      env: { ...process.env, MERCURY_CONFIG_DIR: home, MERCURY_HOME: '' },
    })
    if (!opts?.allowNonZero && res.status !== 0) {
      throw new Error(`scenario exited ${res.status}: ${res.stderr.slice(-1200)}`)
    }
    const marker = res.stdout.lastIndexOf('__OUT__')
    const out = marker >= 0 ? (JSON.parse(res.stdout.slice(marker + 7).trim()) as Record<string, unknown>) : {}
    return { status: res.status, stdout: res.stdout, stderr: res.stderr, out }
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
}

console.log('\nw07-6 · useCrewmateTranscript + CrewmateTranscript — non-ENOENT stat/read failure shows read error')
if (!POSIX_MODES) skip('w07-6 crewmate transcript unreadable', 'chmod 0000 needs non-root POSIX')
else {
  const r = runSubprocess(`
    const React = await import('react')
    const fs = await import('node:fs')
    const path = await import('node:path')
    const harness = await import(path.join(LIB, 'settingsPopupHarness.ts'))
    harness.pinSourceRef()
    process.env.MERCURY_LIVE_GLYPHS = '0'
    process.env.MERCURY_LIVE_CLOCK = '0'
    process.env.MERCURY_REDUCED_MOTION = '1'
    process.env.MERCURY_FULLSCREEN = '0'
    const { enableConfigs } = await import(path.join(SRC, 'utils/config/globalConfig.ts'))
    enableConfigs()
    const { Box, Text } = await import(path.join(SRC, 'ink.ts'))
    const { AppStateProvider, getDefaultAppState } = await import(path.join(SRC, 'state/AppState.tsx'))
    const { ThemeProvider } = await import(path.join(SRC, 'components/design-system/ThemeProvider.tsx'))
    const { TerminalSizeContext } = await import(path.join(SRC, 'ink/components/TerminalSizeContext.tsx'))
    const { TranscriptSwap } = await import(path.join(SRC, 'components/CrewmateTranscript.tsx'))
    const { crewmateTranscriptFile, CREWMATE_TRANSCRIPT_EMPTY, CREWMATE_TRANSCRIPT_READING } = await import(path.join(SRC, 'components/tasks/useCrewmateTranscript.ts'))
    const { noSessionConnector } = await import(path.join(SRC, 'services/engine-connector/noSessionConnector.ts'))
    const { setFocusedSessionConnector, releaseFocusedSessionConnector } = await import(path.join(SRC, 'services/engine-connector/focusedConnector.ts'))
    const h = React.createElement
    const hosted = { sessionId: 'w07-6-session', originalCwd: PROJECT }
    const resting = noSessionConnector()
    setFocusedSessionConnector(new Proxy(resting, {
      get(target, prop, receiver) {
        if (prop === 'sessionId') return () => hosted.sessionId
        if (prop === 'workspace') return () => ({ cwd: PROJECT, originalCwd: PROJECT })
        const value = Reflect.get(target, prop, receiver)
        return typeof value === 'function' ? value.bind(target) : value
      },
    }))
    async function renderFor(agentId) {
      const state = {
        ...getDefaultAppState(),
        viewingAgentTaskId: agentId,
        tasks: { [agentId]: { id: agentId, type: 'local_agent', status: 'running', description: 'probe', agentId, startTime: 1 } },
      }
      const tree = h(AppStateProvider, {
        initialState: state,
        children: h(ThemeProvider, null, h(TerminalSizeContext.Provider, { value: { columns: 300, rows: 16 } }, h(Box, { width: 300, height: 16, flexDirection: 'column' }, h(TranscriptSwap, { lead: h(Text, null, 'LEAD'), tools: [], commands: [], screen: 'prompt' })))),
      })
      const view = await harness.mountOffscreen(tree, 300, 16)
      try {
        await harness.waitFor(() => !view.screen().includes(CREWMATE_TRANSCRIPT_READING), 3000)
        await harness.settle(80)
        return view.screen()
      } finally {
        view.unmount()
      }
    }
    try {
      const absentId = 'agent-absent'
      out.absentScreen = await renderFor(absentId)
      out.emptyConstant = CREWMATE_TRANSCRIPT_EMPTY

      const dirBlockedId = 'agent-dir-blocked'
      const dirBlockedLocal = { id: dirBlockedId, type: 'local_agent', status: 'running', description: 'probe', agentId: dirBlockedId, startTime: 1 }
      const dirBlockedFile = crewmateTranscriptFile({ taskId: dirBlockedId, local: dirBlockedLocal }, hosted)
      const subagentsDir = path.dirname(dirBlockedFile)
      fs.mkdirSync(subagentsDir, { recursive: true })
      fs.writeFileSync(dirBlockedFile, '')
      fs.chmodSync(subagentsDir, 0o000)
      try {
        out.dirBlockedFile = dirBlockedFile
        out.dirBlockedScreen = await renderFor(dirBlockedId)
      } finally {
        fs.chmodSync(subagentsDir, 0o700)
      }

      const fileBlockedId = 'agent-file-blocked'
      const fileBlockedLocal = { id: fileBlockedId, type: 'local_agent', status: 'running', description: 'probe', agentId: fileBlockedId, startTime: 1 }
      const fileBlockedFile = crewmateTranscriptFile({ taskId: fileBlockedId, local: fileBlockedLocal }, hosted)
      fs.mkdirSync(path.dirname(fileBlockedFile), { recursive: true })
      fs.writeFileSync(fileBlockedFile, '{"type":"user"}\\n')
      fs.chmodSync(fileBlockedFile, 0o000)
      try {
        out.fileBlockedFile = fileBlockedFile
        out.fileBlockedScreen = await renderFor(fileBlockedId)
      } finally {
        fs.chmodSync(fileBlockedFile, 0o600)
      }
    } finally {
      releaseFocusedSessionConnector()
    }
  `)
  const absentScreen = String(r.out.absentScreen ?? '')
  const emptyConst = String(r.out.emptyConstant ?? '')
  const dirBlockedScreen = String(r.out.dirBlockedScreen ?? '').replace(/\s+/g, ' ')
  const dirBlockedFile = String(r.out.dirBlockedFile ?? '')
  const fileBlockedScreen = String(r.out.fileBlockedScreen ?? '').replace(/\s+/g, ' ')
  const fileBlockedFile = String(r.out.fileBlockedFile ?? '')
  check('w07-6 ENOENT stays "no transcript yet"', absentScreen.includes(emptyConst), absentScreen.slice(0, 160))
  check(
    'w07-6 stat EACCES shows transcript read error instead of empty',
    dirBlockedScreen.includes(`the transcript at ${dirBlockedFile} could not be read (`) && !dirBlockedScreen.includes('no transcript yet'),
    dirBlockedScreen.slice(0, 200),
  )
  check(
    'w07-6 file read EACCES shows transcript read error instead of empty',
    fileBlockedScreen.includes(`the transcript at ${fileBlockedFile} could not be read (`) && !fileBlockedScreen.includes('no transcript yet'),
    fileBlockedScreen.slice(0, 200),
  )
}

process.exit(failures === 0 ? 0 : 1)
