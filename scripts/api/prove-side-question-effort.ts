#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dir, '..', '..')
process.chdir(ROOT)
delete process.env.NODE_ENV
for (const ambient of [
  'ANTHROPIC_API_KEY', 'MERCURY_MODEL', 'MERCURY_OAUTH_TOKEN', 'MERCURY_SCRIPTED_STREAM', 'MERCURY_BARE',
  'GOOGLE_API_KEY', 'MERCURY_COMPACT', 'MERCURY_AUTO_COMPACT', 'MERCURY_OVERFLOW_RECOVERY', 'MERCURY_HOME',
  'MERCURY_THINKING_BINDING', 'MERCURY_PREFIX_INDUCE_EDIT',
]) {
  delete process.env[ambient]
}
const HOMES = [
  (process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'side-question-effort-home-'))),
  (process.env.MERCURY_DAEMON_DIR = mkdtempSync(join(tmpdir(), 'side-question-effort-daemon-'))),
]
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.BROWSER = '/usr/bin/true'
process.env.MERCURY_EFFORT_LEVEL = 'max'

let failures = 0
let checks = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  checks++
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail.slice(0, 600)}` : ''}`)
}
const section = (t: string): void => console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
const j = (v: unknown): string => JSON.stringify(v)
const watchdog = setTimeout(() => {
  console.log('\nTIMEOUT — the side-question effort prover exceeded 120s')
  process.exit(1)
}, 120_000)
watchdog.unref?.()

const { startOverflowFixture } = await import('../compact/overflowFixture.ts')
const fixture = await startOverflowFixture()
Object.assign(process.env, fixture.env)

const { enableConfigs } = await import('../../src/utils/config/globalConfig.ts')
enableConfigs()
const bootstrap = await import('../../src/bootstrap/state.ts')
bootstrap.setIsInteractive(false)
const { routedCallModel } = await import('../../src/services/providers/callModelRouter.ts')
const { queryWithModel, querySmallFast } = await import('../../src/services/providers/anthropic/streamCore.ts')
const { asSystemPrompt } = await import('../../src/utils/systemPromptType.ts')
const { createUserMessage } = await import('../../src/utils/messages.ts')
const { getEmptyToolPermissionContext } = await import('../../src/Tool.ts')
const { extractTextContent } = await import('../../src/utils/messages/text.ts')
const { effortStampLine } = await import('../../src/utils/effortStamp.ts')

const MODEL = 'claude-opus-5-5'
const effortOf = (body: Record<string, unknown> | null): unknown => (body?.output_config as { effort?: unknown } | undefined)?.effort
const lastAnthropicBody = (from: number): Record<string, unknown> | null => fixture.captured.slice(from).find(entry => entry.dialect === 'anthropic')?.body ?? null

section("§1 the turn's request carries the session's effort dial (MERCURY_EFFORT_LEVEL=max)")
{
  const from = fixture.captured.length
  fixture.script(() => ({ text: 'answered' }))
  const control = new AbortController()
  const stream = routedCallModel({
    messages: [createUserMessage({ content: 'the turn' })] as never,
    systemPrompt: asSystemPrompt(['fixture system prompt']),
    thinkingConfig: { type: 'enabled', budgetTokens: 1024 },
    tools: [] as never,
    signal: control.signal,
    options: {
      model: MODEL,
      querySource: 'sdk',
      agents: [],
      isNonInteractiveSession: true,
      hasAppendSystemPrompt: false,
      mcpTools: [],
      enablePromptCaching: false,
      async getToolPermissionContext() {
        return getEmptyToolPermissionContext()
      },
    } as never,
  })
  let events = 0
  for await (const _ of stream) events++
  check('the turn streamed events', events > 0)
  const body = lastAnthropicBody(from)
  check('the turn request reached the wire', body !== null)
  check('the turn request carries output_config.effort max', effortOf(body) === 'max', j(body?.output_config))
  check('the turn request carries its thinking', typeof body?.thinking === 'object' && body?.thinking !== null, j(body?.thinking))
}

section('§2 a side question (queryWithModel: no tools, no thinking) carries no effort dial and no thinking')
{
  const from = fixture.captured.length
  fixture.script(() => ({ text: 'the side answer' }))
  const reply = await queryWithModel({
    systemPrompt: asSystemPrompt(['read the page']),
    userPrompt: 'what does the page say?',
    signal: new AbortController().signal,
    options: { model: MODEL, querySource: 'web_fetch_apply', agents: [], isNonInteractiveSession: true, hasAppendSystemPrompt: false, mcpTools: [] } as never,
  })
  const body = lastAnthropicBody(from)
  check('the side question reached the wire', body !== null)
  check("the side question carries no output_config.effort (the session's dial is the turn's, never a side question's)", body !== null && effortOf(body) === undefined, j(body?.output_config))
  check('the side question carries no thinking parameter', body !== null && body.thinking === undefined, j(body?.thinking))
  check('the answer comes back as text', extractTextContent(reply.message.content) === 'the side answer', j(reply.message.content))
  check('the reply\'s effort stamp says nothing was asked and nothing rode', effortStampLine(reply.effort) === 'effort asked none · applied none · wire none', effortStampLine(reply.effort))
}

section('§3 the small-fast tier rides the same road')
{
  const from = fixture.captured.length
  fixture.script(() => ({ text: 'the small answer' }))
  const reply = await querySmallFast({
    systemPrompt: asSystemPrompt(['read the page']),
    userPrompt: 'what does the page say?',
    signal: new AbortController().signal,
    options: { querySource: 'web_fetch_apply', agents: [], isNonInteractiveSession: true, hasAppendSystemPrompt: false, mcpTools: [] } as never,
  })
  const body = lastAnthropicBody(from)
  check('the small-fast question reached the wire', body !== null, j(fixture.captured.slice(from).map(entry => entry.dialect)))
  check('it carries no output_config.effort either', body !== null && effortOf(body) === undefined, j(body?.output_config))
  check('the answer comes back as text', extractTextContent(reply.message.content) === 'the small answer', j(reply.message.content))
}

await fixture.close()
for (const home of HOMES) rmSync(home, { recursive: true, force: true })
console.log(`\nprove-side-question-effort: ${checks} checks, ${failures} failed`)
process.exit(failures === 0 ? 0 : 1)
