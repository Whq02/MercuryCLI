#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { createServer, request as httpRequest } from 'node:http'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

delete process.env.NODE_ENV
delete process.env.CI
for (const ambient of [
  'MERCURY_MODEL',
  'MERCURY_SMALL_FAST_MODEL',
  'ANTHROPIC_AUTH_TOKEN',
  'MERCURY_OAUTH_TOKEN',
  'MERCURY_SCRIPTED_STREAM',
  'MERCURY_BARE',
  'MERCURY_MAX_OUTPUT_TOKENS',
  'MERCURY_HOME',
  'GOOGLE_API_KEY',
]) {
  delete process.env[ambient]
}
process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'compact-router-'))

const FIXTURE_PORT = 34101
const PROXY_PORT = 34103
const CAPTURE_DIR = process.env.COMPACT_ROUTER_CAPTURE_DIR

let failures = 0
let checks = 0
function check(label: string, cond: boolean, detail = ''): void {
  checks++
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}
const j = (v: unknown): string => JSON.stringify(v) ?? ''

const guard = setTimeout(() => {
  console.log('\nTIMEOUT — compact router families prover exceeded 120s')
  process.exit(1)
}, 120_000)
guard.unref?.()

const { startCrossfamilyFixture } = await import('../lib/crossfamilyConcourseFixture.ts')
const fixture = await startCrossfamilyFixture({ port: FIXTURE_PORT })
Object.assign(process.env, fixture.env)

type RawHit = { method: string; url: string; rawHeaders: string[]; body: string }
const rawHits: RawHit[] = []
let closeProxy: (() => Promise<void>) | undefined
if (CAPTURE_DIR) {
  mkdirSync(CAPTURE_DIR, { recursive: true })
  const upstream = new URL(fixture.base)
  const proxy = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', c => chunks.push(c as Buffer))
    req.on('end', () => {
      const body = Buffer.concat(chunks)
      rawHits.push({ method: req.method ?? '', url: req.url ?? '', rawHeaders: req.rawHeaders, body: body.toString('utf8') })
      const forward = httpRequest(
        { host: upstream.hostname, port: Number(upstream.port), method: req.method, path: req.url, headers: req.headers },
        up => {
          res.writeHead(up.statusCode ?? 200, up.headers)
          up.pipe(res)
        },
      )
      forward.on('error', () => {
        res.writeHead(502)
        res.end()
      })
      forward.end(body)
    })
  })
  await new Promise<void>(resolve => proxy.listen(PROXY_PORT, '127.0.0.1', resolve))
  process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${PROXY_PORT}`
  closeProxy = () => new Promise<void>(resolve => proxy.close(() => resolve()))
}

const { enableConfigs } = await import('../../src/utils/config.ts')
enableConfigs()
const { compactConversation } = await import('../../src/services/compact/compact.ts')
const { createUserMessage } = await import('../../src/utils/messages.ts')
const { getEmptyToolPermissionContext } = await import('../../src/Tool.ts')
const { asSystemPrompt } = await import('../../src/utils/systemPromptType.ts')
const { FileStateCache, READ_FILE_STATE_CACHE_SIZE } = await import('../../src/utils/fileStateCache.ts')

const RETIRED_GENERIC_MARK = 'tasked with summarizing conversations'
const SESSION_POSTURE_MARK = 'fixture-driven session posture'
const FORK_SYSTEM_MARK = 'fixture-driven parent system prompt'

type Family = {
  route: 'anthropic' | 'openai' | 'zai'
  model: string
  lane: string
  path: string
  answer: RegExp
}
const FAMILIES: Family[] = [
  { route: 'anthropic', model: 'claude-opus-4-8', lane: 'anthropic-seat', path: '/v1/messages', answer: /spare-(?:landed|done) body\./ },
  { route: 'openai', model: 'gpt-5.5', lane: 'openai-seat', path: '/openai/v1/responses', answer: /spare-(?:landed|done) body\./ },
  { route: 'zai', model: 'glm-5.2', lane: 'zai-seat', path: '/zai/v4/chat/completions', answer: /spare-(?:landed|done) body\./ },
]
const EXPECTED_LANES = new Set(FAMILIES.map(f => f.lane))

function makeMessages(): unknown[] {
  const user = createUserMessage({ content: 'please bump the version and run the tests' })
  const assistant = {
    type: 'assistant',
    uuid: '00000000-0000-4000-a000-00000000c0de',
    requestId: 'req_c1',
    message: {
      id: 'msg_c1',
      type: 'message',
      role: 'assistant',
      model: 'fixture',
      content: [{ type: 'text', text: 'Bumped the version in package.json and ran the suite — all green.' }],
      stop_reason: 'end_turn',
      stop_sequence: null,
      usage: { input_tokens: 100, output_tokens: 50 },
    },
  }
  const user2 = createUserMessage({ content: 'now write the changelog entry' })
  return [user, assistant, user2]
}

type ReadState = { size: number; clear(): void }

function makeContext(model: string): { ctx: Record<string, unknown>; readFileState: ReadState } {
  const toolPermissionContext = { ...getEmptyToolPermissionContext(), mode: 'default' as const }
  const appState = {
    toolPermissionContext,
    sessionHooks: new Map(),
    denialTracking: undefined,
    tasks: {},
    mcp: { clients: [], tools: [], commands: [], resources: {} },
  }
  const readFileState = new FileStateCache(READ_FILE_STATE_CACHE_SIZE, 25 * 1024 * 1024)
  readFileState.set('/tmp/compact-router-file.ts', {
    content: 'export const x = 1\n',
    timestamp: Date.now(),
    offset: undefined,
    limit: undefined,
  })
  const ctx = {
    abortController: new AbortController(),
    getAppState: () => appState,
    setAppState: () => {},
    messages: [],
    agentType: undefined,
    agentId: undefined,
    readFileState,
    options: {
      tools: [],
      mcpClients: [],
      mainLoopModel: model,
      maxThinkingTokens: 0,
      thinkingConfig: { type: 'disabled' as const },
      isNonInteractiveSession: true,
      agentDefinitions: { activeAgents: [] },
    },
  }
  return { ctx, readFileState }
}

type Run = {
  result?: Record<string, unknown>
  error?: Error
  hits: typeof fixture.captured
  raw: RawHit[]
  readFileState: ReadState
}

async function runCompaction(family: Family, cacheSafe: (ctx: Record<string, unknown>, messages: unknown[]) => unknown): Promise<Run> {
  const before = fixture.captured.length
  const rawBefore = rawHits.length
  const { ctx, readFileState } = makeContext(family.model)
  const messages = makeMessages()
  let result: Record<string, unknown> | undefined
  let error: Error | undefined
  try {
    result = (await compactConversation(
      messages as never,
      ctx as never,
      cacheSafe(ctx, messages) as never,
      true,
    )) as never as Record<string, unknown>
  } catch (err) {
    error = err as Error
  }
  return {
    result,
    error,
    hits: fixture.captured.slice(before),
    raw: rawHits.slice(rawBefore).filter(h => h.method === 'POST' && (h.url.split('?')[0] ?? '').endsWith('/v1/messages')),
    readFileState,
  }
}

function assertOnTheFamilyWire(tag: string, family: Family, run: Run): void {
  const { hits } = run
  const lanes = hits.map(h => `${h.lane} ${h.path} model=${h.model}`).join(' | ')
  check(`${tag}: the wire saw the request (count ${hits.length} ≥ 1 — no VCR replay)`, hits.length >= 1)
  check(
    `${tag}: every hit rode the ${family.route} lane (${family.path})`,
    hits.length > 0 && hits.every(h => h.lane === family.lane && h.path === family.path),
    lanes,
  )
  check(`${tag}: no hit on another family's wire`, hits.every(h => h.lane === family.lane), lanes)
  check(`${tag}: the wire model is the session's own (${family.model})`, hits.every(h => h.model === family.model), lanes)
}

function assertSummaryInstalled(tag: string, family: Family, run: Run): void {
  const { result, error, readFileState } = run
  check(`${tag}: compactConversation resolves`, result !== undefined && error === undefined, (error?.stack ?? '').slice(0, 600))
  if (result === undefined) return
  const summary = j(result.summaryMessages ?? [])
  check(`${tag}: the ${family.route} dialect's answer came back as the summary`, family.answer.test(summary), summary.slice(0, 240))
  check(
    `${tag}: the summary was installed (boundary marker + isCompactSummary; pre-compact read state cleared)`,
    result.boundaryMarker !== undefined && /isCompactSummary[":]+true/.test(j(result)) && readFileState.size === 0,
    `boundary=${result.boundaryMarker !== undefined} readFileState.size=${readFileState.size}`,
  )
}

section('§1 the summariser\'s DIRECT call, per family — lands on that family\'s wire')
for (const family of FAMILIES) {
  console.log(`\n  · ${family.route} — main model ${family.model}`)
  const run = await runCompaction(family, () => ({
    systemPrompt: asSystemPrompt([`You are a ${SESSION_POSTURE_MARK}.`]),
  }))
  assertOnTheFamilyWire(`${family.route}/direct`, family, run)
  check(
    `${family.route}/direct: the request rides the SESSION'S OWN posture`,
    run.hits.some(h => j(h.body).includes(SESSION_POSTURE_MARK)),
    run.hits.map(h => j(h.body).slice(0, 160)).join(' | '),
  )
  check(
    `${family.route}/direct: the retired generic summarizer prompt is OFF the wire`,
    run.hits.every(h => !j(h.body).includes(RETIRED_GENERIC_MARK)),
    run.hits.map(h => j(h.body).slice(0, 160)).join(' | '),
  )
  assertSummaryInstalled(`${family.route}/direct`, family, run)
  if (CAPTURE_DIR && family.route === 'anthropic') {
    const out = join(CAPTURE_DIR, 'compact-anthropic.json')
    writeFileSync(out, JSON.stringify(run.raw, null, 2))
    console.log(`  · captured ${run.raw.length} raw Anthropic request(s) → ${out}`)
  }
}

section('§2 a full CacheSafeParams, per family — the fold still rides the family wire')
for (const family of FAMILIES) {
  console.log(`\n  · ${family.route} — main model ${family.model}`)
  const run = await runCompaction(family, (ctx, messages) => ({
    systemPrompt: asSystemPrompt([`You are a ${FORK_SYSTEM_MARK}.`]),
    userContext: {},
    systemContext: {},
    toolUseContext: ctx,
    forkContextMessages: messages,
  }))
  assertOnTheFamilyWire(`${family.route}/fork`, family, run)
  check(
    `${family.route}/fork: the fold's request (the parent's system prompt) rode the ${family.route} lane`,
    run.hits.some(h => h.lane === family.lane && j(h.body).includes(FORK_SYSTEM_MARK)),
    run.hits.map(h => `${h.lane}: ${j(h.body).slice(0, 120)}`).join(' | '),
  )
  assertSummaryInstalled(`${family.route}/fork`, family, run)
}

section('§3 the whole run — no hit anywhere but the three family lanes')
{
  const stray = fixture.captured.filter(h => !EXPECTED_LANES.has(h.lane))
  check('no coordinator-lane or unknown-path hit over the whole run', stray.length === 0, stray.map(h => `${h.lane} ${h.path}`).join(', '))
  check(
    'each family lane was hit at least once over the whole run',
    FAMILIES.every(f => fixture.captured.some(h => h.lane === f.lane)),
    [...new Set(fixture.captured.map(h => h.lane))].join(', '),
  )
}

await fixture.close()
await closeProxy?.()
clearTimeout(guard)

console.log('\n' + '='.repeat(60))
console.log(` ${checks} checks, ${failures} failures`)
if (failures === 0) {
  console.log(' ✅ COMPACT ROUTER FAMILIES GREEN')
  process.exit(0)
}
console.log(` ❌ ${failures} COMPACT ROUTER FAMILIES FAILURE(S)`)
process.exit(1)
