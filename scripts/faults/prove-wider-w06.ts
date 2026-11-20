#!/usr/bin/env bun
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

let failures = 0
let checks = 0
function check(label: string, cond: boolean, detail = ''): void {
  checks++
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}

const HERE = dirname(fileURLToPath(import.meta.url))
const BUN = process.execPath.includes('bun') ? process.execPath : join(process.env.HOME ?? '', '.bun/bin/bun')
const SRC = process.env.PROVE_SRC ?? join(HERE, '../../src')
const REPO = join(HERE, '../..')

function runScenario(body: string, extraEnv: Record<string, string> = {}): Record<string, unknown> {
  const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'prove-wider-w06-')))
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
    const fs = await import('node:fs')
    const fsp = await import('node:fs/promises')
    const path = await import('node:path')
    const SRC = ${JSON.stringify(SRC)}
    const REPO = ${JSON.stringify(REPO)}
    const HOME = ${JSON.stringify(home)}
    const SCRATCH = ${JSON.stringify(scratch)}
    const out = {}
    ${body}
    process.stdout.write('\\n' + JSON.stringify(out))
    process.exit(0)
  `
  try {
    const res = spawnSync(BUN, ['-e', src], {
      encoding: 'utf8',
      env: { ...process.env, MERCURY_CONFIG_DIR: home, MERCURY_HOME: '', ...extraEnv },
    })
    if (res.status !== 0) throw new Error(`scenario failed (rc=${res.status}): ${res.stderr.slice(-1500)}`)
    return JSON.parse(res.stdout.trim().split('\n').pop() ?? '{}') as Record<string, unknown>
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
}

console.log('\nw06-1: VerbsPart.leave and ExitHandoff — failed abort interrupt lands in receipt detail and shows on screen')
{
  const r = runScenario(`
    const { mock } = await import('bun:test')
    const socketPath = path.join(SRC, 'daemon/controlSocket.ts')
    const realSocket = await import(socketPath)
    let releaseLeave = null
    mock.module(socketPath, () => ({
      ...realSocket,
      daemonControlRpc: () => new Promise(resolve => {
        releaseLeave = resolve
      }),
    }))
    const { VerbsPart } = await import(path.join(SRC, 'services/engine-connector/daemon/verbs.ts'))
    let failInterrupt = true
    const verbs = new VerbsPart({
      record: () => ({ sessionId: 'sess-leave-w06' }),
      rpc: async () => {
        if (failInterrupt) throw new Error('ECONNREFUSED')
        releaseLeave?.({ ok: true, outcome: 'applied', detail: JSON.stringify({ note: 'skipped' }) })
        return { ok: true }
      },
      chainRpc: async () => ({ ok: true }),
      verbChain: () => Promise.resolve(),
      tick: async () => {},
      readFacts: () => {},
    })

    const c1 = new AbortController()
    let settledBeforeLeave = false
    const p1 = verbs.leave({ signal: c1.signal }).then(v => {
      if (releaseLeave !== null) settledBeforeLeave = true
      return v
    })
    await new Promise(resolve => setTimeout(resolve, 20))
    c1.abort(new Error('ctrl-c'))
    await new Promise(resolve => setTimeout(resolve, 60))
    const doneEarly = settledBeforeLeave
    const finish = releaseLeave
    releaseLeave = null
    finish?.({ ok: true, outcome: 'applied', detail: JSON.stringify({ note: 'none' }) })
    out.failedReceipt = await p1
    out.doneEarly = doneEarly

    failInterrupt = false
    const c2 = new AbortController()
    const p2 = verbs.leave({ signal: c2.signal })
    await new Promise(resolve => setTimeout(resolve, 20))
    c2.abort(new Error('ctrl-c'))
    out.okReceipt = await p2

    const { enableConfigs } = await import(path.join(SRC, 'utils/config/globalConfig.ts'))
    enableConfigs()
    const React = await import('react')
    const { Box } = await import(path.join(SRC, 'ink.ts'))
    const { ThemeProvider } = await import(path.join(SRC, 'components/design-system/ThemeProvider.tsx'))
    const { ExitHandoff, leaveNoteAtExit } = await import(path.join(SRC, 'components/ExitHandoff.tsx'))
    const { setFocusedSessionConnector, releaseFocusedSessionConnector } = await import(path.join(SRC, 'services/engine-connector/focusedConnector.ts'))
    const { noSessionConnector } = await import(path.join(SRC, 'services/engine-connector/noSessionConnector.ts'))
    const { mountOffscreen, waitFor } = await import(path.join(REPO, 'scripts/lib/settingsPopupHarness.ts'))
    const detailSentence = 'the handoff could not be interrupted (ECONNREFUSED) — the turn may still be running'
    setFocusedSessionConnector({
      ...noSessionConnector(),
      sessionId: () => '00000000-0000-4000-8000-0000000000ab',
      leave: async () => ({ note: 'none', detail: detailSentence }),
    })
    out.forwarded = await leaveNoteAtExit(new AbortController().signal)
    let settledReceipt = null
    const el = React.createElement(
      ThemeProvider,
      {},
      React.createElement(
        Box,
        { flexDirection: 'column', width: 100, height: 6 },
        React.createElement(ExitHandoff, { onSettled: (rec) => { settledReceipt = rec } }),
      ),
    )
    const m = await mountOffscreen(el, 100, 6)
    await waitFor(() => settledReceipt !== null, 3000)
    await new Promise(resolve => setTimeout(resolve, 60))
    out.renderedLines = m.lines().map(l => l.trim()).filter(Boolean)
    out.settledReceipt = settledReceipt
    m.unmount()
    releaseFocusedSessionConnector()
  `)
  const failed = r.failedReceipt as { note?: string; detail?: string } | undefined
  const ok = r.okReceipt as { note?: string; detail?: string } | undefined
  const forwarded = r.forwarded as { note?: string; detail?: string } | undefined
  const settled = r.settledReceipt as { note?: string; detail?: string } | undefined
  const lines = (r.renderedLines as string[] | undefined) ?? []
  const expected = 'the handoff could not be interrupted (ECONNREFUSED) — the turn may still be running'
  check('VerbsPart.leave waits for leave RPC (no early race) and returns interrupt failure detail', r.doneEarly === false && failed?.note === 'none' && failed?.detail === expected, JSON.stringify(r))
  check('VerbsPart.leave returns skipped with no error detail when abort interrupt succeeds without outcome field', ok?.note === 'skipped' && ok?.detail === undefined, JSON.stringify(ok))
  check('ExitHandoff forwards receipt.detail and renders it on screen', forwarded?.detail === expected && settled?.detail === expected && lines.some(l => l.includes('the handoff could not be interrupted (ECONNREFUSED)')), JSON.stringify({ forwarded, settled, lines }))
}

console.log(failures === 0 ? `\nGREEN (${checks} checks)` : `\nRED (${failures} of ${checks})`)
process.exit(failures === 0 ? 0 : 1)
