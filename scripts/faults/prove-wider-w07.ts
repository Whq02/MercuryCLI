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
    const { enableConfigs } = await import(path.join(SRC, 'platform/config/globalConfig.ts'))
    enableConfigs()
    const { Box, Text } = await import(path.join(SRC, 'screen/themedRenderer.ts'))
    const { AppStateProvider, getDefaultAppState } = await import(path.join(SRC, 'screen/app-state/AppState.tsx'))
    const { ThemeProvider } = await import(path.join(SRC, 'screen/theme/ThemeProvider.tsx'))
    const { TerminalSizeContext } = await import(path.join(SRC, 'screen/renderer/elements/TerminalSizeContext.tsx'))
    const { TranscriptSwap } = await import(path.join(SRC, 'screen/chat/CrewmateTranscript.tsx'))
    const { crewmateTranscriptFile, CREWMATE_TRANSCRIPT_EMPTY, CREWMATE_TRANSCRIPT_READING } = await import(path.join(SRC, 'screen/tasks/useCrewmateTranscript.ts'))
    const { noSessionConnector } = await import(path.join(SRC, 'engine/connector/noSessionConnector.ts'))
    const { setFocusedSessionConnector, releaseFocusedSessionConnector } = await import(path.join(SRC, 'engine/connector/focusedConnector.ts'))
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
        viewingCrewmateTaskId: agentId,
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

console.log('\nw07-3 · clearedSessions + hopIntoSession — failed clear mark returns error and emits warning receipt')
{
  const r = runSubprocess(`
    const fs = await import('node:fs')
    const path = await import('node:path')
    const { mock } = await import('bun:test')
    const cleared = await import(path.join(SRC, 'sessions/transcripts/clearedSessions.ts'))
    const receipts = await import(path.join(SRC, 'models/facts/seatReceipts.ts'))
    const focused = await import(path.join(SRC, 'engine/connector/focusedConnector.ts'))
    const { noSessionConnector } = await import(path.join(SRC, 'engine/connector/noSessionConnector.ts'))

    const file = path.join(HOME, 'cleared-sessions.json')
    out.okMark = cleared.markSessionCleared('sess-ok-1')

    fs.writeFileSync(file, '{corrupt json')
    out.badMark = cleared.markSessionCleared('sess-bad-1')

    const seen = []
    const unsub = receipts.subscribeSeatReceipts(r => seen.push(r))
    const bornPath = path.join(SRC, 'daemon/switchboard/bornSession.ts')
    mock.module(bornPath, () => ({ bornSession: async () => ({ ok: true }) }))
    const resting = noSessionConnector()
    focused.setFocusedSessionConnector(new Proxy(resting, {
      get(target, prop, receiver) {
        if (prop === 'sessionId') return () => 'sess-clear-fail-1'
        if (prop === 'turnActive') return () => false
        if (prop === 'workspace') return () => ({ cwd: PROJECT, originalCwd: PROJECT })
        if (prop === 'modelFacts') return () => ({ effective: null })
        const v = Reflect.get(target, prop, receiver)
        return typeof v === 'function' ? v.bind(target) : v
      },
    }))
    try {
      const hop = await import(path.join(SRC, 'daemon/switchboard/hopIntoSession.ts'))
      out.clearOutcome = await hop.clearFocusedSession()
      out.receipts = seen
    } finally {
      unsub()
      focused.releaseFocusedSessionConnector()
    }
  `)
  const okMark = r.out.okMark as { ok?: boolean } | undefined
  const badMark = r.out.badMark as { ok?: boolean; error?: string } | undefined
  const seen = (r.out.receipts as Array<{ text?: string; level?: string }> | undefined) ?? []
  check('w07-3 markSessionCleared returns { ok: true } on success', okMark?.ok === true, JSON.stringify(okMark))
  check('w07-3 markSessionCleared returns { ok: false, error } on corrupt map', badMark?.ok === false && typeof badMark.error === 'string' && badMark.error.length > 0, JSON.stringify(badMark))
  check(
    'w07-3 clearFocusedSession emits warning receipt when cleared mark fails to save',
    seen.some(item => item.level === 'warning' && item.text === 'the cleared mark could not be saved, so this session may show in the list again'),
    JSON.stringify(seen),
  )
}

console.log('\nw07-2 · projectStoreIdentity + sessionStoragePortable — unreadable store/root/head notifies transcript store health')
if (!POSIX_MODES) skip('w07-2 projectStoreIdentity unreadable', 'chmod 0000 needs non-root POSIX')
else {
  const r1 = runSubprocess(`
    const fs = await import('node:fs')
    const path = await import('node:path')
    const portable = await import(path.join(SRC, 'sessions/transcripts/sessionStoragePortable.ts'))
    const health = await import(path.join(SRC, 'sessions/transcripts/writer/storeHealth.ts'))
    const p1 = path.join(PROJECT, 'fresh-proj')
    fs.mkdirSync(p1, { recursive: true })
    out.freshDir = portable.getProjectDir(p1)
    out.freshHealth = health.transcriptStoreHealth()

    const projectsDir = portable.getProjectsDir()
    fs.mkdirSync(projectsDir, { recursive: true })
    const p2 = path.join(PROJECT, 'root-blocked-proj')
    fs.mkdirSync(p2, { recursive: true })
    fs.chmodSync(projectsDir, 0o000)
    try {
      out.projectsDir = projectsDir
      out.rootBlockedDir = portable.getProjectDir(p2)
      out.rootBlockedHealth = health.transcriptStoreHealth()
    } finally {
      fs.chmodSync(projectsDir, 0o700)
    }
  `)
  const freshHealth = r1.out.freshHealth as { failing?: boolean; sentence?: string | null }
  const rootHealth = r1.out.rootBlockedHealth as { failing?: boolean; sentence?: string | null }
  const projectsDir = String(r1.out.projectsDir ?? '')
  check('w07-2 absent projects root (ENOENT) does not trigger store health notice', freshHealth?.failing === false, JSON.stringify(freshHealth))
  check(
    'w07-2 unreadable projects root keeps answer and sets transcript-store notice',
    typeof r1.out.rootBlockedDir === 'string' &&
      rootHealth?.failing === true &&
      typeof rootHealth.sentence === 'string' &&
      rootHealth.sentence.includes(`${projectsDir} could not be read (`) &&
      rootHealth.sentence.includes("), so this project's earlier sessions may not be listed — restore read permission on it."),
    JSON.stringify(rootHealth),
  )

  const r2 = runSubprocess(`
    const fs = await import('node:fs')
    const path = await import('node:path')
    const portable = await import(path.join(SRC, 'sessions/transcripts/sessionStoragePortable.ts'))
    const health = await import(path.join(SRC, 'sessions/transcripts/writer/storeHealth.ts'))
    const projectsDir = portable.getProjectsDir()
    const olderStore = path.join(projectsDir, '-old-spelling-12345678')
    fs.mkdirSync(olderStore, { recursive: true })
    const p = path.join(PROJECT, 'store-blocked-proj')
    fs.mkdirSync(p, { recursive: true })
    fs.chmodSync(olderStore, 0o000)
    try {
      out.olderStore = olderStore
      out.dir = portable.getProjectDir(p)
      out.health = health.transcriptStoreHealth()
    } finally {
      fs.chmodSync(olderStore, 0o700)
    }
  `)
  const storeHealth = r2.out.health as { failing?: boolean; sentence?: string | null }
  const olderStore = String(r2.out.olderStore ?? '')
  check(
    'w07-2 unreadable older store folder keeps answer and sets transcript-store notice',
    typeof r2.out.dir === 'string' &&
      storeHealth?.failing === true &&
      typeof storeHealth.sentence === 'string' &&
      storeHealth.sentence.includes(`${olderStore} could not be read (`) &&
      storeHealth.sentence.includes("), so this project's earlier sessions may not be listed — restore read permission on it."),
    JSON.stringify(storeHealth),
  )

  const r3 = runSubprocess(`
    const fs = await import('node:fs')
    const path = await import('node:path')
    const portable = await import(path.join(SRC, 'sessions/transcripts/sessionStoragePortable.ts'))
    const health = await import(path.join(SRC, 'sessions/transcripts/writer/storeHealth.ts'))
    const projectsDir = portable.getProjectsDir()
    const olderStore = path.join(projectsDir, '-old-head-12345678')
    fs.mkdirSync(olderStore, { recursive: true })
    const transcript = path.join(olderStore, '11111111-1111-4111-8111-111111111111.jsonl')
    fs.writeFileSync(transcript, '{"cwd":"/somewhere"}\\n')
    const p = path.join(PROJECT, 'head-blocked-proj')
    fs.mkdirSync(p, { recursive: true })
    fs.chmodSync(transcript, 0o000)
    try {
      out.transcript = transcript
      out.dir = portable.getProjectDir(p)
      out.health = health.transcriptStoreHealth()
    } finally {
      fs.chmodSync(transcript, 0o600)
    }
  `)
  const headHealth = r3.out.health as { failing?: boolean; sentence?: string | null }
  const transcript = String(r3.out.transcript ?? '')
  check(
    'w07-2 unreadable transcript head keeps answer and sets transcript-store notice',
    typeof r3.out.dir === 'string' &&
      headHealth?.failing === true &&
      typeof headHealth.sentence === 'string' &&
      headHealth.sentence.includes(`${transcript} could not be read (`) &&
      headHealth.sentence.includes("), so this project's earlier sessions may not be listed — restore read permission on it."),
    JSON.stringify(headHealth),
  )
}

console.log('\nw07-4 · json.ts parseJSONL + fabric/transcriptDecode.ts — skipped lines counted (native & fallback, excluding torn last line)')
{
  const runCase = (disableNative: boolean) =>
    runSubprocess(`
      const path = await import('node:path')
      ${disableNative ? 'if (globalThis.Bun) { try { Object.defineProperty(globalThis.Bun, "JSONL", { value: undefined, configurable: true }) } catch {} }' : ''}
      const { parseJSONL } = await import(path.join(SRC, 'platform/storage/json.ts'))
      const probe = input => {
        let skipped = 0
        let calls = 0
        const values = parseJSONL(input, { onSkipped: n => { skipped += n; calls++ } })
        return { values, skipped, calls }
      }
      out.valid = probe('{"a":1}\\n{"b":2}\\n')
      out.oneBad = probe('{"a":1}\\n{bad\\n{"b":2}\\n')
      out.twoBad = probe('{"a":1}\\n{bad1\\n{bad2\\n{"b":2}\\n')
      out.crlfBad = probe('{"a":1}\\r\\n{bad\\r\\n{"b":2}\\r\\n')
      out.tornLast = probe('{"a":1}\\n{"b":')
      out.bufBad = probe(Buffer.from('{"a":1}\\n{bad\\n{"b":2}\\n'))
    `)
  for (const [mode, res] of [
    ['native', runCase(false)],
    ['fallback', runCase(true)],
  ] as const) {
    const valid = res.out.valid as { values: unknown[]; skipped: number; calls: number }
    const oneBad = res.out.oneBad as { values: unknown[]; skipped: number; calls: number }
    const twoBad = res.out.twoBad as { values: unknown[]; skipped: number; calls: number }
    const crlfBad = res.out.crlfBad as { values: unknown[]; skipped: number; calls: number }
    const tornLast = res.out.tornLast as { values: unknown[]; skipped: number; calls: number }
    const bufBad = res.out.bufBad as { values: unknown[]; skipped: number; calls: number }
    check(`w07-4 (${mode}) valid JSONL reports 0 skipped`, valid.values.length === 2 && valid.skipped === 0 && valid.calls === 0, JSON.stringify(valid))
    check(`w07-4 (${mode}) one bad line reports skipped=1`, oneBad.values.length === 2 && oneBad.skipped === 1, JSON.stringify(oneBad))
    check(`w07-4 (${mode}) two bad lines report skipped=2`, twoBad.values.length === 2 && twoBad.skipped === 2, JSON.stringify(twoBad))
    check(`w07-4 (${mode}) CRLF bad line reports skipped=1`, crlfBad.values.length === 2 && crlfBad.skipped === 1, JSON.stringify(crlfBad))
    check(`w07-4 (${mode}) torn last line is not counted`, tornLast.values.length === 1 && tornLast.skipped === 0 && tornLast.calls === 0, JSON.stringify(tornLast))
    check(`w07-4 (${mode}) Buffer input with bad line reports skipped=1`, bufBad.values.length === 2 && bufBad.skipped === 1, JSON.stringify(bufBad))
  }

  const rDecode = runSubprocess(`
    const fs = await import('node:fs')
    const path = await import('node:path')
    const { encodeTranscriptLine } = await import(path.join(SRC, 'sessions/transcripts/vnext.ts'))
    const { decodeTranscriptBuffer } = await import(path.join(SRC, 'sessions/fabric/transcriptDecode.ts'))
    const loading = await import(path.join(SRC, 'sessions/transcripts/loading.ts'))
    const sid = '00000000-dddd-eeee-ffff-000000000d07'
    const file = path.join(PROJECT, sid + '.jsonl')
    const meta = (uuid, parent) => ({
      isSidechain: false, entrypoint: 'cli', cwd: PROJECT, sessionId: sid,
      version: '1.0.0', gitBranch: '', parentUuid: parent, uuid, timestamp: '2026-11-20T06:00:00.000Z',
    })
    const l1 = encodeTranscriptLine(file, { ...meta('00000000-0000-4000-8000-00000000d701', null), type: 'user', message: { role: 'user', content: 'first' } }).line
    const l2 = encodeTranscriptLine(file, { ...meta('00000000-0000-4000-8000-00000000d702', '00000000-0000-4000-8000-00000000d701'), type: 'assistant', message: { role: 'assistant', model: 'glm-5.3', content: [{ type: 'text', text: 'second' }] } }).line
    const l3 = encodeTranscriptLine(file, { ...meta('00000000-0000-4000-8000-00000000d703', '00000000-0000-4000-8000-00000000d702'), type: 'user', message: { role: 'user', content: 'third' } }).line
    const content = l1 + l2.trimEnd() + l3
    fs.writeFileSync(file, content)
    const decoded = decodeTranscriptBuffer(content)
    out.malformedLen = decoded.malformed.length
    loading._resetTranscriptLoadDegradationForTesting()
    await loading.loadTranscriptFile(file)
    out.degradation = loading.transcriptLoadDegradation()
  `)
  const deg = rDecode.out.degradation as { malformed?: number; path?: string } | null
  check(
    'w07-4 two values on one line still triggers classifyMalformed and latches transcriptLoadDegradation',
    rDecode.out.malformedLen === 1 && deg !== null && deg.malformed === 1,
    JSON.stringify({ malformedLen: rDecode.out.malformedLen, deg }),
  )
}

console.log('\nw07-5 · promptDraft — autosave refuses unreadable draft/scoped files; failed delete retries at next send')
{
  const rIo = runSubprocess(`
    const fs = await import('node:fs')
    const fsp = await import('node:fs/promises')
    const path = await import('node:path')
    const { mock } = await import('bun:test')
    const s1 = '11111111-1111-4111-8111-111111111101'
    const s3 = '11111111-1111-4111-8111-111111111103'
    let failPaths = new Set()
    const realReadFile = fsp.readFile
    mock.module('node:fs/promises', () => ({
      ...fsp,
      readFile: async (p, ...rest) => {
        if (failPaths.has(String(p))) {
          const err = new Error('EIO: i/o error, read')
          err.code = 'EIO'
          throw err
        }
        return realReadFile(p, ...rest)
      },
    }))
    mock.module('fs/promises', () => ({
      ...fsp,
      readFile: async (p, ...rest) => {
        if (failPaths.has(String(p))) {
          const err = new Error('EIO: i/o error, read')
          err.code = 'EIO'
          throw err
        }
        return realReadFile(p, ...rest)
      },
    }))
    const drafts = await import(path.join(SRC, 'screen/composer/input-core/promptDraft.ts'))
    drafts.saveDraftDebounced(s1, { text: 'important draft 1', cursorOffset: 5, mode: 'prompt', pastedContents: {} })
    await drafts.flushDraftSaves()

    const draftsDir = path.join(HOME, 'drafts')
    const draftFile = path.join(draftsDir, fs.readdirSync(draftsDir).find(f => f.endsWith('.json') && !f.endsWith('-scoped.json')))
    const beforeDraft = fs.readFileSync(draftFile, 'utf8')

    failPaths = new Set([draftFile])
    drafts.saveDraftDebounced(s3, { text: 'overwrite attempt', cursorOffset: 2, mode: 'prompt', pastedContents: {} })
    await drafts.flushDraftSaves()
    failPaths = new Set()

    out.draftPreserved = fs.readFileSync(draftFile, 'utf8') === beforeDraft
  `)
  check('w07-5 autosave does not overwrite a draft file that fails I/O read (EIO)', rIo.out.draftPreserved === true, JSON.stringify(rIo.out.draftPreserved))

  if (!POSIX_MODES) skip('w07-5 failed deleteDraft retry', 'chmod 0000 needs non-root POSIX')
  else {
    const rRetry = runSubprocess(`
      const fs = await import('node:fs')
      const path = await import('node:path')
      const drafts = await import(path.join(SRC, 'screen/composer/input-core/promptDraft.ts'))
      const pendingInput = await import(path.join(SRC, 'screen/composer/input-core/pending-input.ts'))
      const s1 = '11111111-1111-4111-8111-111111111101'
      const s2 = '11111111-1111-4111-8111-111111111102'

      drafts.saveDraftDebounced(s1, { text: 'sent draft 1', cursorOffset: 4, mode: 'prompt', pastedContents: {} })
      await drafts.flushDraftSaves()
      drafts.saveDraftDebounced(s2, { text: 'sent draft 2', cursorOffset: 4, mode: 'prompt', pastedContents: {} })
      await drafts.flushDraftSaves()

      const draftsDir = path.join(HOME, 'drafts')
      const draftFile = path.join(draftsDir, fs.readdirSync(draftsDir).find(f => f.endsWith('.json') && !f.endsWith('-scoped.json')))
      fs.chmodSync(draftFile, 0o000)
      try {
        drafts.deleteDraft(s1)
        await drafts.flushDraftSaves()
        await new Promise(r => setTimeout(r, 80))
      } finally {
        fs.chmodSync(draftFile, 0o600)
      }
      out.s1StayedAfterFailedDelete = drafts.readDraftSync(s1)?.text ?? null

      pendingInput.initSession(s2, '')
      pendingInput.clearForSubmit('sent s2')
      await drafts.flushDraftSaves()
      await new Promise(r => setTimeout(r, 80))
      out.s1AfterNextSend = drafts.readDraftSync(s1)
      out.s2AfterNextSend = drafts.readDraftSync(s2)
    `)
    check(
      'w07-5 failed deleteDraft for s1 is retried at next send (clearForSubmit on s2)',
      rRetry.out.s1StayedAfterFailedDelete === 'sent draft 1' && rRetry.out.s1AfterNextSend === null && rRetry.out.s2AfterNextSend === null,
      JSON.stringify(rRetry.out),
    )
  }
}

console.log('\nw07-1 · session listing roads + BootResumeScreen + sessionManager + ResumeSession — unreadable folders/sessions counted and shown')
if (!POSIX_MODES) skip('w07-1 session listing unreadable', 'chmod 0000 needs non-root POSIX')
else {
  const rRoads = runSubprocess(`
    const fs = await import('node:fs')
    const path = await import('node:path')
    const { encodeSeedTranscript } = await import(path.join(LIB, 'seedTranscript.ts'))
    const portable = await import(path.join(SRC, 'sessions/transcripts/sessionStoragePortable.ts'))
    const logs = await import(path.join(SRC, 'sessions/transcripts/sessionListings.ts'))

    const projectsDir = portable.getProjectsDir()
    const absentPage = await logs.listSessionsAcrossProjectsProgressive()
    out.absentFailures = absentPage.readFailures ?? null

    fs.mkdirSync(projectsDir, { recursive: true })
    fs.chmodSync(projectsDir, 0o000)
    try {
      const rootPage = await logs.listSessionsAcrossProjectsProgressive()
      out.rootPage = { count: rootPage.logs.length, readFailures: rootPage.readFailures ?? null, projectsDir }
    } finally {
      fs.chmodSync(projectsDir, 0o700)
    }

    const goodStore = path.join(projectsDir, '-good-project-11111111')
    const badStore = path.join(projectsDir, '-bad-project-22222222')
    fs.mkdirSync(goodStore, { recursive: true })
    fs.mkdirSync(badStore, { recursive: true })
    const sidGood = '11111111-1111-4111-8111-111111111111'
    const sidBad = '22222222-2222-4222-8222-222222222222'
    const mkLines = (sid, text) => encodeSeedTranscript([
      {
        uuid: '00000000-0000-4000-8000-' + sid.slice(0, 12).replace(/-/g, '').padEnd(12, '1'),
        parentUuid: null,
        timestamp: '2026-11-20T06:00:00.000Z',
        isSidechain: false,
        sessionId: sid,
        cwd: PROJECT,
        version: '1.0.0',
        type: 'user',
        message: { role: 'user', content: text },
      },
    ], sid)
    const goodFile = path.join(goodStore, sidGood + '.jsonl')
    const badFile = path.join(goodStore, sidBad + '.jsonl')
    fs.writeFileSync(goodFile, mkLines(sidGood, 'readable session prompt'))
    fs.writeFileSync(badFile, mkLines(sidBad, 'unreadable session prompt'))

    logs.invalidateSessionListingMemo()
    fs.chmodSync(badStore, 0o000)
    fs.chmodSync(badFile, 0o000)
    try {
      const partialPage = await logs.listSessionsAcrossProjectsProgressive()
      out.partialPage = {
        ids: partialPage.logs.map(l => l.sessionId),
        readFailures: partialPage.readFailures ?? null,
        badStore,
        badFile,
      }
      const liteErrors = []
      const liteNull = await portable.readSessionLite(badFile, (p, e) => liteErrors.push({ path: p, msg: String(e?.message ?? e) }))
      out.liteCheck = { liteNull, liteErrors }
    } finally {
      fs.chmodSync(badStore, 0o700)
      fs.chmodSync(badFile, 0o600)
    }
  `)
  const rootPage = rRoads.out.rootPage as { count: number; readFailures: { count: number; firstPath: string; firstError: string } | null; projectsDir: string }
  const partialPage = rRoads.out.partialPage as { ids: string[]; readFailures: { count: number; firstPath: string; firstError: string } | null; badStore: string; badFile: string }
  const liteCheck = rRoads.out.liteCheck as { liteNull: unknown; liteErrors: Array<{ path: string; msg: string }> }
  check('w07-1 absent projects root (ENOENT) reports no readFailures', rRoads.out.absentFailures === null, JSON.stringify(rRoads.out.absentFailures))
  check(
    'w07-1 unreadable projects root reports readFailures with count=1 and path',
    rootPage.count === 0 && rootPage.readFailures !== null && rootPage.readFailures.count === 1 && rootPage.readFailures.firstPath === rootPage.projectsDir && rootPage.readFailures.firstError.length > 0,
    JSON.stringify(rootPage),
  )
  check(
    'w07-1 unreadable store and transcript keep readable session and report count=2',
    partialPage.ids.includes('11111111-1111-4111-8111-111111111111') &&
      !partialPage.ids.includes('22222222-2222-4222-8222-222222222222') &&
      partialPage.readFailures !== null &&
      partialPage.readFailures.count === 2,
    JSON.stringify(partialPage),
  )
  check(
    'w07-1 readSessionLite keeps returning null and reports non-ENOENT error to callback',
    liteCheck.liteNull === null && liteCheck.liteErrors.length === 1 && liteCheck.liteErrors[0]!.path === partialPage.badFile,
    JSON.stringify(liteCheck),
  )

  const rUi = runSubprocess(`
    const React = await import('react')
    const fs = await import('node:fs')
    const path = await import('node:path')
    const harness = await import(path.join(LIB, 'settingsPopupHarness.ts'))
    harness.pinSourceRef()
    process.env.MERCURY_LIVE_GLYPHS = '0'
    process.env.MERCURY_LIVE_CLOCK = '0'
    process.env.MERCURY_REDUCED_MOTION = '1'
    process.env.MERCURY_FULLSCREEN = '0'
    const { enableConfigs } = await import(path.join(SRC, 'platform/config/globalConfig.ts'))
    enableConfigs()
    const { Box } = await import(path.join(SRC, 'screen/themedRenderer.ts'))
    const { AppStateProvider, getDefaultAppState } = await import(path.join(SRC, 'screen/app-state/AppState.tsx'))
    const { ThemeProvider } = await import(path.join(SRC, 'screen/theme/ThemeProvider.tsx'))
    const { TerminalSizeContext } = await import(path.join(SRC, 'screen/renderer/elements/TerminalSizeContext.tsx'))
    const { KeybindingSetup } = await import(path.join(SRC, 'screen/keys/KeybindingProviderSetup.tsx'))
    const { BootResumeScreen } = await import(path.join(SRC, 'screen/boot-face/BootResumeScreen.tsx'))
    const { sessionListView } = await import(path.join(SRC, 'screen/widgets/faces/session-manager/views.tsx'))
    const { ResumeSession } = await import(path.join(SRC, 'screen/chat/ResumeSession.tsx'))
    const { useMercuryTokens } = await import(path.join(SRC, 'screen/widgets/useMercuryTokens.ts'))
    const portable = await import(path.join(SRC, 'sessions/transcripts/sessionStoragePortable.ts'))
    const h = React.createElement

    const projectsDir = portable.getProjectsDir()
    fs.mkdirSync(projectsDir, { recursive: true })
    fs.chmodSync(projectsDir, 0o000)
    try {
      const bootTree = h(AppStateProvider, {
        initialState: getDefaultAppState(),
        children: h(KeybindingSetup, null, h(ThemeProvider, null, h(TerminalSizeContext.Provider, { value: { columns: 180, rows: 30 } }, h(Box, { width: 180, height: 30, flexDirection: 'column' }, h(BootResumeScreen, { fullScene: { columns: 180, rows: 30 } }))))),
      })
      const bootView = await harness.mountOffscreen(bootTree, 180, 30)
      try {
        await harness.waitFor(() => !bootView.screen().includes('reading the session store'), 3000)
        await harness.settle(80)
        out.bootScreen = bootView.screen()
      } finally {
        bootView.unmount()
      }
    } finally {
      fs.chmodSync(projectsDir, 0o700)
    }

    const notice = '2 sessions or folders could not be read and are not listed (first: /tmp/bad: EACCES)'
    const SmProbe = () => sessionListView({
      onClose: () => {},
      footer: 'esc back',
      accent: '#00aaff',
      ownState: { parked: false, glyph: '●', state: 'live', tail: '' },
      flat: [],
      scope: 'all',
      pendingMore: 0,
      logs: [],
      elsewhereCount: 0,
      newerHidden: 0,
      shown: [],
      winStart: 0,
      sel: 0,
      confirming: null,
      navKeys: [],
      moveTo: () => {},
      setConfirmingKey: () => {},
      tokens: useMercuryTokens(),
      olderHidden: 0,
      targetAt: () => null,
      targetLabel: () => '',
      W: 160,
      readNotice: notice,
    })
    const smTree = h(AppStateProvider, {
      initialState: getDefaultAppState(),
      children: h(KeybindingSetup, null, h(ThemeProvider, null, h(TerminalSizeContext.Provider, { value: { columns: 180, rows: 24 } }, h(Box, { width: 180, height: 24, flexDirection: 'column' }, h(SmProbe, null))))),
    })
    const smView = await harness.mountOffscreen(smTree, 180, 24)
    try {
      await harness.settle(60)
      out.smScreen = smView.screen()
    } finally {
      smView.unmount()
    }

    const resumeTree = h(AppStateProvider, {
      initialState: getDefaultAppState(),
      children: h(KeybindingSetup, null, h(ThemeProvider, null, h(TerminalSizeContext.Provider, { value: { columns: 180, rows: 24 } }, h(Box, { width: 180, height: 24, flexDirection: 'column' }, h(ResumeSession, { commands: [], worktreePaths: [], initialTools: [], worktreeReadError: 'git worktree list failed' }))))),
    })
    const resumeView = await harness.mountOffscreen(resumeTree, 180, 24)
    try {
      await harness.waitFor(() => !resumeView.screen().includes('Loading conversations'), 3000)
      await harness.settle(80)
      out.resumeScreen = resumeView.screen()
    } finally {
      resumeView.unmount()
    }
  `)
  const bootScreen = String(rUi.out.bootScreen ?? '').replace(/\s+/g, ' ')
  const smScreen = String(rUi.out.smScreen ?? '').replace(/\s+/g, ' ')
  const resumeScreen = String(rUi.out.resumeScreen ?? '').replace(/\s+/g, ' ')
  check(
    'w07-1 BootResumeScreen displays the unreadable sessions/folders notice',
    bootScreen.includes('1 sessions or folders could not be read and are not listed (first:'),
    bootScreen.slice(0, 220),
  )
  check(
    'w07-1 sessionManager sessionListView displays the unreadable sessions/folders notice',
    smScreen.includes('2 sessions or folders could not be read and are not listed (first: /tmp/bad: EACCES)'),
    smScreen.slice(0, 220),
  )
  check(
    'w07-1 ResumeSession displays the unreadable worktrees/sessions notice',
    resumeScreen.includes('1 sessions or folders could not be read and are not listed (first:') && resumeScreen.includes('git worktree list failed'),
    resumeScreen.slice(0, 220),
  )
}

process.exit(failures === 0 ? 0 : 1)
