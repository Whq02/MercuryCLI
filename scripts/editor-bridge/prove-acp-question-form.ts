import { spawn } from 'node:child_process'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { Readable, Writable } from 'node:stream'
import { isDeepStrictEqual } from 'node:util'
import * as acp from '@agentclientprotocol/sdk'
import { startFixtureApi } from '../lib/fixtureApi.ts'
import { seedFirstRun } from '../lib/firstRunSeed.ts'

const root = resolve(import.meta.dir, '../..')
const at = process.argv.indexOf('--dist')
const dist = at < 0 ? join(root, 'dist/mercury.mjs') : resolve(process.argv[at + 1]!)
const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'acp-question-')))
const input = {
  questions: [
    {
      id: 'iq_cache', decisionId: 'id_cache', header: 'Cache', question: 'Which cache should we use?', multiSelect: false,
      options: [
        { id: 'io_redis', label: 'Redis', description: 'Shared across workers.', preview: '### Redis\n\nShared cache' },
        { id: 'io_local', label: 'Local', description: 'One process only.' },
      ],
    },
    {
      id: 'iq_features', decisionId: 'id_features', header: 'Features', question: 'Which features matter?', multiSelect: true,
      options: [
        { id: 'io_offline', label: 'Offline', description: 'Works without a connection.' },
        { id: 'io_fast', label: 'Fast', description: 'Responds immediately.' },
      ],
    },
  ],
  answers: {},
}
let failures = 0
const check = (label: string, yes: boolean, detail: unknown = '') => {
  if (!yes) failures++
  console.log(`[${yes ? 'PASS' : 'FAIL'}] ${label}${yes ? '' : ` — ${JSON.stringify(detail)}`}`)
}
const bounded = async <T,>(promise: Promise<T>, label: string): Promise<T> => {
  let timer: ReturnType<typeof setTimeout>
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} did not settle within 60s`)), 60_000) })])
  } finally {
    clearTimeout(timer!)
  }
}
const requestInput = (params: Record<string, unknown>) => (params._meta as Record<string, unknown> | undefined)?.['mercury/input']
const node = process.execPath.includes('bun') ? 'node' : process.execPath

async function runCase(name: string, capabilities: Record<string, unknown>, answer: Record<string, unknown>, accepted: boolean, mode?: string): Promise<void> {
  const home = mkdtempSync(join(scratch, 'home-'))
  const cwd = realpathSync(mkdtempSync(join(scratch, 'project-')))
  seedFirstRun(home, [cwd])
  const api = await startFixtureApi([
    { kind: 'tool_use', name: 'AskUserQuestion', id: 'toolu_question_form', input },
    { kind: 'text', text: 'The interview turn is settled.' },
  ])
  const child = spawn(node, [dist, 'acp'], {
    cwd,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, MERCURY_CONFIG_DIR: home, MERCURY_CREDENTIAL_STORE: 'file', ANTHROPIC_API_KEY: 'proof-key-ci-gate-not-a-real-key', ANTHROPIC_BASE_URL: api.url },
  })
  let stderr = ''
  child.stderr.on('data', data => { stderr += String(data) })
  const exited = new Promise<void>(resolve => child.once('close', () => resolve()))
  const forms: Array<Record<string, unknown>> = []
  const permissions: Array<Record<string, unknown>> = []
  const updates: Array<Record<string, unknown>> = []
  let withdrawn = false
  const app = acp.client({ name: 'question-form-proof' })
    .onNotification('session/update', ctx => { updates.push(ctx.params.update as unknown as Record<string, unknown>) })
    .onRequest('session/request_permission', ctx => {
      permissions.push(ctx.params as unknown as Record<string, unknown>)
      return { outcome: { outcome: 'selected' as const, optionId: 'allow' } }
    })
    .onRequest('elicitation/create', ctx => {
      forms.push(ctx.params as unknown as Record<string, unknown>)
      if (name === 'withdrawn') {
        const held = new Promise(resolve => ctx.signal.addEventListener('abort', () => {
          withdrawn = true
          resolve(answer)
        }, { once: true }))
        void conn.agent.notify('session/cancel', { sessionId: sid! })
        return held as never
      }
      return answer as never
    })
  const conn = app.connect(acp.ndJsonStream(Writable.toWeb(child.stdin) as WritableStream<Uint8Array>, Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>))
  let sid: string | undefined
  try {
    await bounded(conn.agent.request('initialize', { protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: capabilities } as never), `${name} initialize`)
    const created = await conn.agent.request('session/new', { cwd, mcpServers: [] })
    sid = created.sessionId
    if (mode) {
      const selected = await conn.agent.request('session/set_mode', { sessionId: sid, modeId: mode }).then(() => true, error => { check(`${name}: Apollo selection succeeds`, false, String(error)); return false })
      if (!selected) return
    }
    const turn = await bounded(conn.agent.request('session/prompt', { sessionId: sid, prompt: [{ type: 'text', text: 'Interview me about the cache.' }] }), `${name} prompt`)
    check(`${name}: the turn settles`, turn.stopReason === (name === 'withdrawn' ? 'cancelled' : 'end_turn'), turn)
    if (name === 'withdrawn') check('the runner cancellation withdraws the editor form', withdrawn)
    check(`${name}: no generic approval substitutes for a question answer`, permissions.length === 0, permissions)
    const hasForm = typeof (capabilities.elicitation as { form?: unknown } | undefined)?.form === 'object'
    check(`${name}: only a form-capable editor receives a form`, forms.length === (hasForm ? 1 : 0), forms)
    const result = updates.find(u => u.sessionUpdate === 'tool_call_update' && u.toolCallId === 'toolu_question_form' && (u.status === 'completed' || u.status === 'failed'))
    const text = JSON.stringify(result)
    check(`${name}: the tool result reflects the answer, not an unanswered completion`, name === 'withdrawn' ? result?.status !== 'completed' : !!result && result.status === (accepted ? 'completed' : 'failed') && !text.includes('(unanswered)'), result)
    if (accepted) {
      const form = forms[0] ?? {}
      const schema = form.requestedSchema as { title?: string; properties?: Record<string, unknown>; required?: string[] } | undefined
      check(`${name}: the form names the session and tool call`, form.sessionId === sid && form.toolCallId === 'toolu_question_form', form)
      check(`${name}: the action title describes answering questions`, schema?.title === "Answer Mercury's questions", schema)
      check(`${name}: question, decision and option identities and previews cross unchanged`, isDeepStrictEqual(requestInput(form), input), form)
      const properties = schema?.properties as Record<string, { type?: string; title?: string; oneOf?: Array<{ const: string; title: string }>; items?: { anyOf?: Array<{ const: string }> } }> | undefined
      check(`${name}: single-select choices have their option identities and labels`, properties?.iq_cache?.type === 'string' && properties.iq_cache.title === input.questions[0]!.question && properties.iq_cache.oneOf?.some(o => o.const === 'io_redis' && o.title === 'Redis') === true, properties)
      check(`${name}: multiple selections remain multiple selections`, properties?.iq_features?.type === 'array' && properties.iq_features.items?.anyOf?.some(o => o.const === 'io_offline') === true, properties)
      check(`${name}: all questions are required`, JSON.stringify(schema?.required) === JSON.stringify(['iq_cache', 'iq_features']), schema)
      check(`${name}: edited selections reach the actual tool`, text.includes('[iq_cache]') && text.includes('Redis') && text.includes('[iq_features]') && text.includes('Offline, Fast'), result)
      const followup = api.requests.find(r => JSON.stringify(r.body).includes('User has answered your questions'))
      check(`${name}: the next model request carries the answered interview`, !!followup && !JSON.stringify(followup.body).includes('(unanswered)'), followup?.body)
    }
  } catch (error) {
    check(`${name}: the journey completes`, false, `${String(error)} ${stderr}`)
  } finally {
    if (sid) await bounded(conn.agent.request('session/close', { sessionId: sid }), `${name} close`).catch(() => {})
    conn.close()
    child.stdin.end()
    const timer = setTimeout(() => child.kill('SIGKILL'), 5000)
    await exited
    clearTimeout(timer)
    await api.close()
  }
}

try {
  const accepted = { action: 'accept', content: { iq_cache: 'io_redis', iq_features: ['io_offline', 'io_fast'] } }
  const forms = { elicitation: { form: {} } }
  if (process.argv.includes('--apollo')) {
    await runCase('Apollo interview', forms, accepted, true, 'apollo')
  } else {
    await runCase('form answer', forms, accepted, true)
    await runCase('no capability', {}, accepted, false)
    await runCase('URL capability only', { elicitation: { url: {} } }, accepted, false)
    await runCase('declined', forms, { action: 'decline' }, false)
    await runCase('cancelled', forms, { action: 'cancel' }, false)
    await runCase('withdrawn', forms, accepted, false)
    await runCase('missing answer', forms, { action: 'accept', content: { iq_cache: 'io_redis' } }, false)
    await runCase('unknown selection', forms, { action: 'accept', content: { iq_cache: 'not-an-option', iq_features: ['io_fast'] } }, false)
  }
} finally {
  rmSync(scratch, { recursive: true, force: true })
}
console.log(`ACP question forms: ${failures} failures`)
process.exitCode = failures ? 1 : 0
