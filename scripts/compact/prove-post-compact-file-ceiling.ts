#!/usr/bin/env bun
// gate-watch: src/services/compact/compact.ts src/utils/attachments/fileAttachments.ts src/tools/FileReadTool/prompt.ts src/services/tokenEstimation.ts
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'post-compact-ceiling-')))
process.env.MERCURY_CONFIG_DIR = join(scratch, 'home')
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

let passed = 0
let failed = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  ok ? passed++ : failed++
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
}

const bootstrap = await import('../../src/bootstrap/state.ts')
bootstrap.setIsInteractive(false)
const { enableConfigs } = await import('../../src/utils/config/globalConfig.ts')
enableConfigs()
const { getDefaultAppState } = await import('../../src/state/AppStateStore.ts')
const { createFileStateCacheWithSizeLimit } = await import('../../src/utils/fileStateCache.ts')
const compact = await import('../../src/services/compact/compact.ts')
const { roughTokenCountEstimation } = await import('../../src/services/tokenEstimation.ts')

type FileBody = { attachment: { type: string; truncated?: boolean; filename?: string; content?: { type: string; file?: { content: string; numLines: number; totalLines: number } } } }
const bodyOf = (message: unknown): FileBody['attachment'] => (message as FileBody).attachment
const tokensOf = (body: FileBody['attachment']): number => roughTokenCountEstimation(body.content?.file?.content ?? '')

let appState: Record<string, unknown> = { ...(getDefaultAppState() as unknown as Record<string, unknown>) }
const ctx = {
  abortController: new AbortController(),
  options: { commands: [], tools: [], engineModel: 'claude-opus-5', thinkingConfig: { type: 'disabled' }, mcpClients: [], mcpResources: {}, isNonInteractiveSession: true, debug: false, verbose: false, agentDefinitions: { activeAgents: [], allAgents: [] } },
  getAppState: () => appState,
  setAppState: (f: (prev: never) => never): void => { appState = f(appState as never) as unknown as Record<string, unknown> },
  messages: [],
  readFileState: createFileStateCacheWithSizeLimit(100),
  setInProgressToolUseIDs: () => {},
  setResponseLength: () => {},
  updateFileHistoryState: () => {},
  updateAttributionState: () => {},
  agentId: undefined,
}

const ceiling = compact.POST_COMPACT_MAX_TOKENS_PER_FILE
const shortLine = 'abcdefghi'
const longLine = 'x'.repeat(39)
const tall = Array.from({ length: 20_000 }, () => shortLine).join('\n') + '\n'
const dense = Array.from({ length: 6_000 }, () => longLine).join('\n') + '\n'
const small = 'one\ntwo\nthree\n'

console.log(`§1 the projected restore (a fold with a projection) keeps each file under ${ceiling} tokens, not ${ceiling} lines`)
{
  const ledger = { [join(scratch, 'tall.txt')]: { content: tall, timestamp: 3 }, [join(scratch, 'small.txt')]: { content: small, timestamp: 2 } }
  const restored = (await compact.createPostCompactFileAttachments(ledger, ctx as never, 5, [], true)).map(bodyOf)
  const tallRow = restored.find(row => row.filename?.endsWith('tall.txt'))
  const smallRow = restored.find(row => row.filename?.endsWith('small.txt'))
  check('both files are restored', tallRow !== undefined && smallRow !== undefined, JSON.stringify(restored.map(row => row.filename)))
  check(`the tall file carries at most ${ceiling} tokens`, tallRow !== undefined && tokensOf(tallRow) <= ceiling, String(tallRow && tokensOf(tallRow)))
  check(`the tall file carries fewer than ${ceiling} lines (the old line window would have sent ${ceiling} lines, ${roughTokenCountEstimation(Array.from({ length: ceiling }, () => shortLine).join('\n'))} tokens)`, (tallRow?.content?.file?.numLines ?? 0) < ceiling && (tallRow?.content?.file?.numLines ?? 0) > 1000, String(tallRow?.content?.file?.numLines))
  check('the cut is marked on the row and the total line count is the whole file', tallRow?.truncated === true && tallRow?.content?.file?.totalLines === 20_001, JSON.stringify({ truncated: tallRow?.truncated, totalLines: tallRow?.content?.file?.totalLines }))
  check('a small file rides whole, unmarked', smallRow?.content?.file?.content === small && smallRow?.truncated === undefined, JSON.stringify(smallRow))
}

console.log(`§2 the read restore (the ordinary fold) reads the file and keeps it under ${ceiling} tokens`)
{
  const densePath = join(scratch, 'dense.ts')
  const smallPath = join(scratch, 'small.ts')
  writeFileSync(densePath, dense)
  writeFileSync(smallPath, small)
  const ledger = { [densePath]: { content: dense, timestamp: 3 }, [smallPath]: { content: small, timestamp: 2 } }
  const restored = (await compact.createPostCompactFileAttachments(ledger, ctx as never, 5, [])).map(bodyOf)
  const denseRow = restored.find(row => row.filename?.endsWith('dense.ts'))
  const smallRow = restored.find(row => row.filename?.endsWith('small.ts'))
  check('the dense file comes back as content, not a reference', denseRow?.type === 'file' && denseRow.content?.type === 'text', JSON.stringify(denseRow)?.slice(0, 160))
  check(`the dense file carries at most ${ceiling} tokens`, denseRow !== undefined && tokensOf(denseRow) <= ceiling, String(denseRow && tokensOf(denseRow)))
  check('the dense file keeps whole lines from line 1', denseRow?.content?.file?.content.split('\n').every(line => line === longLine) === true && denseRow?.truncated === true, String(denseRow?.content?.file?.numLines))
  check('the small file rides whole', smallRow?.content?.file?.content.trimEnd() === small.trimEnd() && smallRow?.truncated === undefined, JSON.stringify(smallRow)?.slice(0, 160))
}

console.log(`§3 the ${compact.POST_COMPACT_TOKEN_BUDGET}-token total still binds`)
{
  const ledger: Record<string, { content: string; timestamp: number }> = {}
  for (let index = 0; index < 20; index++) ledger[join(scratch, `file-${index}.txt`)] = { content: tall, timestamp: index }
  const restored = (await compact.createPostCompactFileAttachments(ledger, ctx as never, 20, [], true)).map(bodyOf)
  const total = restored.reduce((sum, row) => sum + tokensOf(row), 0)
  check('fewer files than offered are restored and their total is under the budget', restored.length < 20 && total <= compact.POST_COMPACT_TOKEN_BUDGET, JSON.stringify({ restored: restored.length, total }))
}

console.log('§4 the line count under a ceiling')
{
  check('an empty list is zero lines', compact.linesWithinTokenCeiling([], 10) === 0)
  check('a first line over the ceiling still shows one line', compact.linesWithinTokenCeiling(['x'.repeat(100)], 5) === 1)
  check('lines that fit are all shown', compact.linesWithinTokenCeiling(['ab', 'cd', 'ef'], 100) === 3)
  check('the count stops before the line that crosses the ceiling', compact.linesWithinTokenCeiling(['abcdefgh', 'abcdefgh', 'abcdefgh'], 5) === 2)
}

rmSync(scratch, { recursive: true, force: true })
console.log(failed === 0 ? `\nprove-post-compact-file-ceiling: ALL PASS (${passed})` : `\nprove-post-compact-file-ceiling: ${failed} FAIL`)
process.exit(failed === 0 ? 0 : 1)
