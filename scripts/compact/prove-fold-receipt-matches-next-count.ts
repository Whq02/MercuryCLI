#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

delete process.env.NODE_ENV
for (const ambient of [
  'ANTHROPIC_API_KEY', 'MERCURY_MODEL', 'MERCURY_OAUTH_TOKEN', 'MERCURY_SCRIPTED_STREAM', 'MERCURY_BARE', 'GOOGLE_API_KEY',
  'MERCURY_COMPACT', 'MERCURY_AUTO_COMPACT', 'MERCURY_EFFORT_LEVEL', 'MERCURY_MAX_OUTPUT_TOKENS', 'MERCURY_COMPACT_KEEP_TAIL',
  'MERCURY_SM_COMPACT', 'MERCURY_CONCOURSE_WORKER',
]) {
  delete process.env[ambient]
}
const scratch = mkdtempSync(join(tmpdir(), 'fold-receipt-matches-next-'))
process.env.MERCURY_CONFIG_DIR = join(scratch, 'home')
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.on('exit', () => rmSync(scratch, { recursive: true, force: true }))

let failures = 0
let checks = 0
const HINT = 'foldSizes in src/engine/compaction/fold/foldMeasure.ts must exclude uncarried thinking tokens counted in the last settled usage.output_tokens when deriving the post-fold receipt count from reading'
function check(label: string, cond: boolean, detail = ''): void {
  checks++
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${cond ? '' : ` — ${detail} — change: ${HINT}`}`)
}

const { startOverflowFixture } = await import('./overflowFixture.ts')
const fixture = await startOverflowFixture()
Object.assign(process.env, fixture.env)
const { enableConfigs } = await import('../../src/platform/config/globalConfig.ts')
enableConfigs()
const bootstrap = await import('../../src/boot/process-state/processState.ts')
bootstrap.setIsInteractive(false)
const { getDefaultAppState } = await import('../../src/screen/app-state/AppStateStore.ts')
const { createUserMessage } = await import('../../src/engine/messages/messages.ts')
const { createAttachmentMessage } = await import('../../src/engine/attachment-shapes/attachmentMessage.ts')
const { createFileStateCacheWithSizeLimit } = await import('../../src/platform/files/fileStateCache.ts')
const { requestGaugeDigest } = await import('../../src/engine/run/requestGauge.ts')
const { buildPostFoldMessages } = await import('../../src/engine/compaction/foldConversation.ts')
const { estimateContextTokens } = await import('../../src/engine/compaction/pruneToolResults.ts')
const { stripThinkingFromIndex } = await import('../../src/engine/messages/apiFilters.ts')
const { contextFill } = await import('../../src/engine/context-window/contextTokenCount.ts')
const { call } = await import('../../src/commands/compact/compact.ts')

const MODEL = 'claude-opus-4-8'
const FIXED = 24_000
type AnyMsg = Record<string, unknown> & { type?: string }
type Folded = { type: string; displayText?: string; foldHandoff: Parameters<typeof buildPostFoldMessages>[0] }

async function foldAndCompare(opts: { thinkingTokens: number; scale: number; withFile: boolean }): Promise<{ receiptAfter: number; nextCount: number; footerAfter: number; diff: number; thinkingCounted: number }> {
  const listing = `The skills this session offers:\n\n${Array.from({ length: 20 }, (_, i) => `- skill-${i}: handles module ${i}.`).join('\n')}`
  const cap = createAttachmentMessage({
    type: 'context_capsule',
    markdown: '# Working set\n- src/pricing.ts — active',
    digest: 'k22-cap',
    refs: [],
    delta: null,
    sections: [{ name: 'Skills', kinds: ['skill_listing'], content: [{ type: 'text', text: listing }] }],
  } as never) as AnyMsg
  const capNoSkills = createAttachmentMessage({
    type: 'context_capsule',
    markdown: '# Working set\n- src/pricing.ts — active',
    digest: 'k22-cap',
    refs: [],
    delta: null,
    sections: [],
  } as never) as AnyMsg
  const skillsTokens = estimateContextTokens([cap] as never, MODEL) - estimateContextTokens([capNoSkills] as never, MODEL)
  const rows: AnyMsg[] = [cap]
  const thinkingText = opts.thinkingTokens > 0 ? 'Weighing the architecture carefully step by step. '.repeat(Math.ceil((opts.thinkingTokens * 4) / 49)) : ''
  let lastThinkingTokens = 0
  for (let n = 1; n <= 6; n++) {
    rows.push(createUserMessage({ content: `write design note ${n}` }) as AnyMsg)
    const text = `Note ${n}: ` + 'Detailed technical analysis of module boundary and state transitions. '.repeat(500)
    const wireBefore = stripThinkingFromIndex(rows as never, 0)
    const digest = requestGaugeDigest(rows as never)
    const asked = estimateContextTokens(wireBefore as never, MODEL)
    const content = [
      ...(thinkingText ? [{ type: 'thinking', thinking: thinkingText, signature: 'sig' }] : []),
      { type: 'text', text },
    ]
    const reply: AnyMsg = {
      type: 'assistant',
      uuid: `00000000-0000-4000-a000-${String(n + opts.thinkingTokens + (opts.withFile ? 5000 : 0)).padStart(12, '0')}`,
      timestamp: new Date().toISOString(),
      requestId: `req_${n}`,
      message: { id: `msg_${n}`, type: 'message', role: 'assistant', model: MODEL, content, stop_reason: 'end_turn', stop_sequence: null },
    }
    const replyTotal = estimateContextTokens([reply] as never, MODEL)
    const replyVisible = estimateContextTokens(stripThinkingFromIndex([reply] as never, 0), MODEL)
    lastThinkingTokens = Math.round((replyTotal - replyVisible) * opts.scale)
    ;(reply.message as Record<string, unknown>).usage = {
      input_tokens: Math.round((FIXED + asked) * opts.scale),
      output_tokens: Math.round(replyTotal * opts.scale),
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    }
    reply.contextGauge = {
      version: 1,
      key: `anthropic:${MODEL}:c1`,
      epoch: 1,
      digest,
      rawTokens: asked,
      fixed: { digest: 'f', tokens: FIXED },
      density: { ratio: opts.scale, samples: opts.scale === 1 ? 0 : 4, residuals: [] },
      sample: { eligible: false, denominator: 0, measured: 0, reason: 'cold' },
    }
    rows.push(reply)
  }
  const reads = createFileStateCacheWithSizeLimit(100)
  if (opts.withFile) {
    const filePath = join(scratch, 'pricing.ts')
    const body = Array.from({ length: 60 }, (_, i) => `export function price_${i}(x: number): number { return x + ${i} }`).join('\n') + '\n'
    writeFileSync(filePath, body)
    reads.set(filePath, { content: body, timestamp: 100, offset: 0, limit: undefined })
  }
  let appState: Record<string, unknown> = { ...(getDefaultAppState() as unknown as Record<string, unknown>), effortValue: 'high' }
  const ctx = {
    abortController: new AbortController(),
    options: { commands: [], tools: [], engineModel: MODEL, thinkingConfig: { type: 'disabled' }, mcpClients: [], mcpResources: {}, isNonInteractiveSession: true, debug: false, verbose: false, agentDefinitions: { activeAgents: [], allAgents: [] } },
    getAppState: () => appState,
    setAppState: (u: (p: never) => never) => { appState = u(appState as never) as unknown as Record<string, unknown> },
    messages: rows,
    readFileState: reads,
    setInProgressToolUseIDs: () => {},
    setResponseLength: () => {},
    updateFileHistoryState: () => {},
    updateAttributionState: () => {},
    agentId: undefined,
  }
  fixture.script([{ text: '<summary>Notes 1 through 6 were written and verified.</summary>' }])
  const folded = (await call('', ctx as never)) as Folded
  const post = buildPostFoldMessages(folded.foldHandoff) as AnyMsg[]
  const receiptAfter = folded.foldHandoff.truePostFoldTokenCount!
  const nextCount = Math.round((FIXED + estimateContextTokens(post as never, MODEL) + skillsTokens) * opts.scale)
  const footerAfter = contextFill([...rows, ...post] as never, MODEL).tokens
  return { receiptAfter, nextCount, footerAfter, diff: receiptAfter - nextCount, thinkingCounted: lastThinkingTokens }
}

try {
  const plain = await foldAndCompare({ thinkingTokens: 0, scale: 1, withFile: false })
  check('without thinking: receipt.after matches next request count within 300 tokens', Math.abs(plain.diff) < 300 && plain.footerAfter === plain.receiptAfter, JSON.stringify(plain))

  const withThinking = await foldAndCompare({ thinkingTokens: 2800, scale: 1, withFile: false })
  check('with 2.8k thinking on the last turn: receipt.after matches next request count within 300 tokens (does not carry stripped thinking)', Math.abs(withThinking.diff) < 300 && withThinking.footerAfter === withThinking.receiptAfter, JSON.stringify(withThinking))

  const scaledWithFile = await foldAndCompare({ thinkingTokens: 2800, scale: 0.85, withFile: true })
  check('with 0.85x provider tokenizer, 2.8k thinking and a restored file: receipt.after matches next request count within 300 tokens', Math.abs(scaledWithFile.diff) < 300 && scaledWithFile.footerAfter === scaledWithFile.receiptAfter, JSON.stringify(scaledWithFile))
} finally {
  await fixture.close()
}

console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAIL`} — ${checks} checks`)
process.exit(failures === 0 ? 0 : 1)
