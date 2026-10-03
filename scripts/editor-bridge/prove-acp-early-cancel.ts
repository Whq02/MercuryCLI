import { spawn } from 'node:child_process'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { Readable, Writable } from 'node:stream'
import * as acp from '@agentclientprotocol/sdk'
import { seedFirstRun } from '../lib/firstRunSeed.ts'
import { startFixtureApi } from '../lib/fixtureApi.ts'

const root = resolve(import.meta.dir, '../..')
const at = process.argv.indexOf('--dist')
const dist = at < 0 ? join(root, 'dist/mercury.mjs') : resolve(process.argv[at + 1]!)
const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'acp-early-cancel-')))
let failures = 0
const check = (label: string, yes: boolean, detail: unknown = '') => {
  if (!yes) failures++
  console.log(`[${yes ? 'PASS' : 'FAIL'}] ${label}${yes ? '' : ` — ${JSON.stringify(detail)}`}`)
}
const bounded = async <T,>(promise: Promise<T>): Promise<T | null> => {
  let timer: ReturnType<typeof setTimeout>
  try {
    return await Promise.race([promise, new Promise<null>(resolve => { timer = setTimeout(() => resolve(null), 10_000) })])
  } finally {
    clearTimeout(timer!)
  }
}
try {
  for (const ready of [false, true]) {
    const name = ready ? 'ready runner' : 'new session'
    const home = mkdtempSync(join(scratch, 'home-'))
    seedFirstRun(home, [scratch])
    const api = await startFixtureApi([
      { kind: 'text', text: 'PROOF_FOLLOWUP_COMPLETE', whenBody: 'PROOF_FOLLOWUP' },
      { kind: 'hang', deltas: ['Waiting for the cancellation.'] },
    ])
    const server = spawn('node', [dist, 'acp'], { cwd: scratch, stdio: ['pipe', 'pipe', 'inherit'], env: { ...process.env, MERCURY_CONFIG_DIR: home, ANTHROPIC_API_KEY: 'proof-key-ci-gate-not-a-real-key', ANTHROPIC_BASE_URL: api.url } })
    const exited = new Promise<void>(resolve => server.once('close', () => resolve()))
    const app = acp.client({ name: 'early-cancel-proof' }).onNotification('session/update', () => {})
    const conn = app.connect(acp.ndJsonStream(Writable.toWeb(server.stdin!) as WritableStream<Uint8Array>, Readable.toWeb(server.stdout!) as ReadableStream<Uint8Array>))
    let sid: string | undefined
    try {
      await conn.agent.request('initialize', { protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: {} })
      sid = (await conn.agent.request('session/new', { cwd: scratch, mcpServers: [] })).sessionId
      if (ready) await conn.agent.request('session/set_mode', { sessionId: sid, modeId: 'default' })
      const turn = conn.agent.request('session/prompt', { sessionId: sid, prompt: [{ type: 'text', text: 'PROOF_CANCEL_TARGET' }] })
      await conn.agent.notify('session/cancel', { sessionId: sid })
      const settled = await bounded(turn)
      check(`${name}: the first cancel settles the turn`, settled?.stopReason === 'cancelled', { settled, requests: api.requests.length })
      if (!ready) check('a cancellation before admission makes no provider request', api.requests.length === 0, api.requests.map(r => r.path))
      if (settled) {
        const followup = await bounded(conn.agent.request('session/prompt', { sessionId: sid, prompt: [{ type: 'text', text: 'PROOF_FOLLOWUP' }] }))
        check(`${name}: cancellation does not poison the next turn`, followup?.stopReason === 'end_turn', followup)
      }
    } catch (error) {
      check(`${name}: the cancellation journey completes`, false, String(error))
    } finally {
      if (sid) await conn.agent.request('session/close', { sessionId: sid }).catch(() => {})
      conn.close()
      server.stdin?.end()
      const timer = setTimeout(() => server.kill('SIGKILL'), 5000)
      await exited
      clearTimeout(timer)
      await api.close()
    }
  }
} finally {
  rmSync(scratch, { recursive: true, force: true })
}
console.log(`ACP early cancel: ${failures} failures`)
process.exitCode = failures ? 1 : 0
