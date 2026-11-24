#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

delete process.env.NODE_ENV
delete process.env.CI
for (const ambient of [
  'MERCURY_MODEL', 'ANTHROPIC_AUTH_TOKEN', 'MERCURY_OAUTH_TOKEN', 'MERCURY_SCRIPTED_STREAM', 'MERCURY_BARE',
  'MERCURY_MAX_OUTPUT_TOKENS', 'MERCURY_HOME', 'MERCURY_EFFORT_LEVEL', 'MERCURY_THINKING_BUDGET', 'GOOGLE_API_KEY', 'MERCURY_CONCOURSE_WORKER',
]) {
  delete process.env[ambient]
}
const scratch = mkdtempSync(join(tmpdir(), 'nothing-to-compact-words-'))
process.env.MERCURY_CONFIG_DIR = join(scratch, 'home')
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
process.env.MERCURY_COMPACT_KEEP_TAIL = '1'
process.on('exit', () => rmSync(scratch, { recursive: true, force: true }))

let failures = 0
let checks = 0
function check(label: string, cond: boolean, detail = '', hint = ''): void {
  checks++
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}${!cond && hint ? ` — change: ${hint}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}
const guard = setTimeout(() => {
  console.log('\nTIMEOUT — prove-nothing-to-compact-words exceeded 120s')
  process.exit(1)
}, 120_000)
guard.unref?.()

const { startCrossfamilyFixture } = await import('../lib/crossfamilyConcourseFixture.ts')
const fixture = await startCrossfamilyFixture({ port: 0 })
Object.assign(process.env, fixture.env)

const { enableConfigs } = await import('../../src/platform/settings/config.ts')
enableConfigs()
const compactCommand = (await import('../../src/commands/compact/index.ts')).default
const { processSlashCommand } = await import('../../src/engine/user-input/processSlashCommand.tsx')
const { buildPostFoldMessages, nothingToFoldLine } = await import('../../src/engine/compaction/foldConversation.ts')
const { call } = await import('../../src/commands/compact/compact.ts')
const { createUserMessage, extractTag } = await import('../../src/engine/messages/messages.ts')
const { LOCAL_COMMAND_STDERR_TAG, LOCAL_COMMAND_STDOUT_TAG } = await import('../../src/engine/message-shapes/messageTags.ts')
const { getEmptyToolPermissionContext } = await import('../../src/tools/kit/tool.ts')
const { FileStateCache, READ_FILE_STATE_CACHE_SIZE } = await import('../../src/platform/files/fileStateCache.ts')

const MODEL = 'claude-opus-4-8'
type AnyMsg = Record<string, unknown> & { type?: string }

let seq = 0
const uid = (): string => `00000000-0000-4000-a000-${String(++seq).padStart(12, '0')}`

function makeMessages(rounds: number, replyText: (index: number) => string, lastUsage: number): AnyMsg[] {
  const out: AnyMsg[] = []
  for (let index = 0; index < rounds; index++) {
    out.push(createUserMessage({ content: `operator ask ${index}: check module ${index}` }) as AnyMsg)
    out.push({
      type: 'assistant',
      uuid: uid(),
      requestId: `req_${seq}`,
      message: {
        id: `msg_${seq}`,
        type: 'message',
        role: 'assistant',
        model: MODEL,
        content: [{ type: 'text', text: replyText(index) }],
        stop_reason: 'end_turn',
        stop_sequence: null,
        usage: { input_tokens: index === rounds - 1 ? lastUsage : 1_000 + index * 100, output_tokens: 0 },
      },
    })
  }
  return out
}

function makeContext(messages: AnyMsg[]): Record<string, unknown> {
  const appState = {
    toolPermissionContext: { ...getEmptyToolPermissionContext(), mode: 'default' as const },
    sessionHooks: new Map(),
    tasks: {},
    mcp: { clients: [], tools: [], commands: [], resources: {} },
    effortValue: 'high',
    verbose: false,
    engineModel: MODEL,
  }
  return {
    abortController: new AbortController(),
    getAppState: () => appState,
    setAppState: () => {},
    setMessages: () => {},
    onChangeAPIKey: () => {},
    messages,
    agentType: undefined,
    agentId: undefined,
    readFileState: new FileStateCache(READ_FILE_STATE_CACHE_SIZE, 25 * 1024 * 1024),
    options: {
      tools: [],
      mcpClients: [],
      commands: [compactCommand],
      engineModel: MODEL,
      theme: 'dark',
      maxThinkingTokens: 0,
      thinkingConfig: { type: 'disabled' as const },
      isNonInteractiveSession: true,
      agentDefinitions: { activeAgents: [] },
    },
  }
}

async function runSlashCompact(messages: AnyMsg[]): Promise<{ rendered: string; commandError: string | undefined }> {
  const ctx = makeContext(messages)
  const result = await processSlashCommand('/compact', [], [], ctx as never, () => {})
  const outputs: string[] = []
  for (const row of result.messages) {
    const raw = row.type === 'system' && 'content' in row && typeof row.content === 'string'
      ? row.content
      : row.type === 'user' && typeof row.message.content === 'string'
        ? row.message.content
        : ''
    const out = extractTag(raw, LOCAL_COMMAND_STDOUT_TAG)?.trim()
    const err = extractTag(raw, LOCAL_COMMAND_STDERR_TAG)?.trim()
    if (out) outputs.push(out)
    if (err) outputs.push(err)
  }
  return { rendered: outputs.join('\n'), commandError: result.commandError }
}

const hintNoErrorPrefix = 'runLocalCommand in src/engine/user-input/processSlashCommand.tsx must emit error.message without Error: for non-fault compact refusals recognised by isNothingToCompactMessage in src/engine/compaction/fold/foldLimits.ts'
const hintTrueReason = 'nothingToCompactReason in src/engine/compaction/fold/projection.ts and nothingToCompactLine in src/engine/compaction/fold/foldLimits.ts must state the true cause in one plain line'

section('1 empty conversation: one plain line, no Error: prefix')
{
  const { rendered, commandError } = await runSlashCompact([])
  check(
    'empty conversation reads No messages to compact. with no Error: prefix',
    rendered === 'No messages to compact.' && commandError === 'No messages to compact.' && !rendered.includes('Error:') && !rendered.includes('\n'),
    JSON.stringify({ rendered, commandError }),
    hintNoErrorPrefix,
  )
}

section('2 ten turns where recent turns hold most of 55.9k tokens: names the recent turns kept whole, no Error:')
{
  const tenTurns = makeMessages(
    10,
    index => (index === 8 ? 'SESSIONS DOCS '.repeat(9_000) : `Short reply for turn ${index}.`),
    55_900,
  )
  const { rendered, commandError } = await runSlashCompact(tenTurns)
  const expected = 'Nothing to compact yet: the recent turns are kept whole and hold most of the 55.9k tokens.'
  check(
    'refuses with the true recent-turns reason and no Error: prefix',
    rendered === expected && commandError === expected && !rendered.includes('Error:') && !rendered.includes('\n'),
    JSON.stringify({ rendered, commandError }),
    hintTrueReason,
  )
}

section('3 two turns: genuinely too few messages to fold, no Error:')
{
  const twoTurns = makeMessages(2, index => `Short reply ${index}.`, 1_200)
  const { rendered, commandError } = await runSlashCompact(twoTurns)
  const expected = 'Nothing to compact yet: too few messages to fold (1.2k tokens).'
  check(
    'refuses with too few messages to fold and no Error: prefix',
    rendered === expected && commandError === expected && !rendered.includes('Error:') && !rendered.includes('\n'),
    JSON.stringify({ rendered, commandError }),
    hintTrueReason,
  )
}

section('4 refold right after a fold: names the last fold, no Error:')
{
  const long = makeMessages(40, index => `Adjusted module ${index}. ${'details '.repeat(180)}`, 22_000)
  const first = await call('', makeContext(long) as never)
  const post = first.type === 'compact' ? (buildPostFoldMessages(first.foldHandoff as Parameters<typeof buildPostFoldMessages>[0]) as AnyMsg[]) : []
  const { rendered, commandError } = await runSlashCompact(post)
  check(
    'refold names the last fold with no Error: prefix and one line',
    /^Nothing to compact: the last fold already holds this conversation \(\d+(\.\d+)?k? tokens\)$/.test(rendered) && commandError === rendered && !rendered.includes('Error:') && !rendered.includes('\n'),
    JSON.stringify({ rendered, commandError }),
    hintNoErrorPrefix,
  )
}

section('5 enough turns with keep-tail off, but too small to shrink: names that a summary would not shrink it, no Error:')
{
  process.env.MERCURY_COMPACT_KEEP_TAIL = '0'
  try {
    const fiveShort = makeMessages(5, index => `Short reply ${index}.`, 1_600)
    const { rendered, commandError } = await runSlashCompact(fiveShort)
    const expected = 'Nothing to compact yet: a summary would not shrink the 1.6k tokens.'
    check(
      'refuses with a summary would not shrink and no Error: prefix',
      rendered === expected && commandError === expected && !rendered.includes('Error:') && !rendered.includes('\n'),
      JSON.stringify({ rendered, commandError }),
      hintTrueReason,
    )
  } finally {
    process.env.MERCURY_COMPACT_KEEP_TAIL = '1'
  }
}

section('6 every reason formats in one plain line without Error:')
{
  const recent = nothingToFoldLine(55_900, 'recent-turns-kept')
  const few = nothingToFoldLine(1_200, 'too-few-messages')
  const shrink = nothingToFoldLine(1_600, 'would-not-shrink')
  const folded = nothingToFoldLine(169_900, 'already-folded')
  const lines = [recent, few, shrink, folded]
  check(
    'all four reasons produce exact single-line plain messages',
    recent === 'Nothing to compact yet: the recent turns are kept whole and hold most of the 55.9k tokens.' &&
      few === 'Nothing to compact yet: too few messages to fold (1.2k tokens).' &&
      shrink === 'Nothing to compact yet: a summary would not shrink the 1.6k tokens.' &&
      folded === 'Nothing to compact: the last fold already holds this conversation (169.9k tokens)' &&
      lines.every(line => !line.includes('\n') && !line.startsWith('Error:')),
    JSON.stringify(lines),
    hintTrueReason,
  )
}

await fixture.close()
clearTimeout(guard)
console.log('\n' + '='.repeat(60))
console.log(` ${checks} checks, ${failures} failures`)
console.log(failures === 0 ? ' ✅ NOTHING TO COMPACT WORDS GREEN' : ` ❌ ${failures} NOTHING TO COMPACT WORDS FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
