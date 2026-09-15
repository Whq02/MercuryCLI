#!/usr/bin/env bun
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const home = mkdtempSync(join(tmpdir(), 'size-prune-law-'))
process.env.MERCURY_CONFIG_DIR = home
process.env.MERCURY_DAEMON_DIR = join(home, 'daemon')
process.env.MERCURY_TEAMS_DIR = join(home, 'teams')
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
process.env.MERCURY_TIME_BASED_MC = '0'
process.env.BROWSER = '/usr/bin/true'
process.env.ANTHROPIC_API_KEY = 'proof-key-ci-gate-not-a-real-key'
process.env.ANTHROPIC_BASE_URL = 'http://127.0.0.1:1'

const { projectTimeBasedMicrocompact, microcompactMessages } = await import('../../src/services/compact/microCompact.ts')
const { createAssistantMessage, createUserMessage } = await import('../../src/utils/messages.ts')
const { isClearedOrDigested } = await import('../../src/services/compact/microCompactDigest.ts')
type Message = import('../../src/types/message.ts').Message
const big = 'the complete original result remains available until a successful later file operation supersedes it\n'.repeat(50)
const history: Message[] = [createUserMessage({ content: 'keep the operator instruction verbatim' })]
function pair(id: string, name: string, input: Record<string, unknown>, content = big, error = false): void {
  history.push(createAssistantMessage({ content: [{ type: 'tool_use', id, name, input }] as never }))
  history.push(createUserMessage({ content: [{ type: 'tool_result', tool_use_id: id, content, ...(error ? { is_error: true } : {}) }] as never }))
}
pair('read_old', 'Read', { file_path: '/work/current.txt' })
pair('edit_later', 'Edit', { file_path: '/work/current.txt' })
pair('write_old', 'Write', { file_path: '/work/rewritten.txt' })
pair('read_later', 'Read', { file_path: '/work/rewritten.txt' })
pair('read_unique', 'Read', { file_path: '/work/unique.txt' })
pair('bash_old', 'Bash', { command: 'check the files' })
pair('grep_old', 'Grep', { pattern: 'value', path: '/work/current.txt' })
pair('skill', 'Skill', { skill: 'review' })
pair('brief', 'Brief', {})
pair('enter_strategy', 'EnterStrategyMode', {})
pair('exit_strategy', 'ExitStrategyMode', {})
pair('skill_read_old', 'Read', { file_path: '/work/skills/review/reference.txt' })
pair('skill_read_new', 'Read', { file_path: '/work/skills/review/reference.txt' })
pair('small_old', 'Read', { file_path: '/work/small.txt' }, 'tiny')
pair('small_later', 'Write', { file_path: '/work/small.txt' })
pair('failed_later_old', 'Read', { file_path: '/work/failure.txt' })
pair('failed_later', 'Edit', { file_path: '/work/failure.txt' }, 'the edit failed', true)
pair('unpaired_old', 'Read', { file_path: '/work/unpaired.txt' })
history.push(createAssistantMessage({ content: [{ type: 'tool_use', id: 'unpaired_later', name: 'Read', input: { file_path: '/work/unpaired.txt' } }] as never }))
pair('dedup_original', 'Read', { file_path: '/work/unchanged.txt' })
pair('dedup_later', 'Read', { file_path: '/work/unchanged.txt' }, 'The earlier result remains current.')
;(history[history.length - 1] as { toolUseResult?: unknown }).toolUseResult = { type: 'file_unchanged' }
for (let index = 0; index < 5; index++) pair(`recent_${index}`, 'Read', { file_path: '/work/recent.txt' })

const size = projectTimeBasedMicrocompact(history, 'sdk', { pressure: true, supersededOnly: true })
const overflow = projectTimeBasedMicrocompact(history, 'sdk', { pressure: true })
const contentOf = (messages: Message[], id: string): string => {
  for (const message of messages) {
    if (message.type !== 'user' || !Array.isArray(message.message.content)) continue
    for (const block of message.message.content) if (block.type === 'tool_result' && block.tool_use_id === id) return String(block.content)
  }
  return ''
}
let failures = 0
const check = (label: string, passed: boolean): void => { if (!passed) failures++; console.log(`[${passed ? 'PASS' : 'FAIL'}] ${label}`) }
check('a later successful Edit supersedes the old same-path Read', size !== null && isClearedOrDigested(contentOf(size.messages, 'read_old')))
check('a later successful Read supersedes the old same-path Write', size !== null && isClearedOrDigested(contentOf(size.messages, 'write_old')))
for (const id of ['edit_later', 'read_later', 'read_unique', 'bash_old', 'grep_old', 'failed_later_old', 'unpaired_old', 'dedup_original']) {
  check(`${id} is not superseded by a successful later same-path operation`, size !== null && contentOf(size.messages, id) === big)
}
for (const id of ['skill', 'brief', 'enter_strategy', 'exit_strategy', 'skill_read_old', 'skill_read_new']) {
  check(`${id} keeps the existing protection`, size !== null && contentOf(size.messages, id) === big)
}
check('a result below the placeholder cost floor remains verbatim', size !== null && contentOf(size.messages, 'small_old') === 'tiny')
for (let index = 0; index < 5; index++) {
  check(`recent_${index} remains inside the unchanged five-result window`, size !== null && contentOf(size.messages, `recent_${index}`) === big)
}
check('the size receipt counts only the two eligible superseded results', size?.cleared === 2 && JSON.stringify(size.clearedIds) === JSON.stringify(['read_old', 'write_old']))
check('the existing overflow walk remains broader and unchanged', overflow !== null && isClearedOrDigested(contentOf(overflow.messages, 'read_unique')) && isClearedOrDigested(contentOf(overflow.messages, 'bash_old')))
check('the projection never changes its input', contentOf(history, 'read_old') === big && contentOf(history, 'write_old') === big)
check('a second projection makes no repeated prune', size !== null && projectTimeBasedMicrocompact(size.messages, 'sdk', { pressure: true, supersededOnly: true }) === null)
const invalidated: string[] = []
const applied = await microcompactMessages(history, undefined, 'sdk', { readFileState: { delete: path => { invalidated.push(path); return true } } }, { pressure: true, supersededOnly: true })
check('the live path returns the same cleared ids as the pure projection', JSON.stringify(applied.pruned?.clearedIds) === JSON.stringify(size?.clearedIds))
check('only a cleared Read invalidates read-dedup delivery truth', invalidated.includes('/work/current.txt') && !invalidated.includes('/work/unique.txt') && !invalidated.includes('/work/rewritten.txt'))
check('the target is a net saving after replacement cost', size !== null && size.tokensSaved < Math.ceil(big.length / 4) * 2)
check('a prune that cannot reach the target does not land', size !== null && projectTimeBasedMicrocompact(history, 'sdk', { pressure: true, supersededOnly: true, minimumTokensSaved: size.tokensSaved + 1 }) === null)
const noInvalidations: string[] = []
const insufficient = await microcompactMessages(history, undefined, 'sdk', { readFileState: { delete: path => { noInvalidations.push(path); return true } } }, { pressure: true, supersededOnly: true, minimumTokensSaved: Number.MAX_SAFE_INTEGER })
check('an insufficient prune has no live side effects or replacement receipt', insufficient.messages === history && insufficient.pruned === undefined && noInvalidations.length === 0)
const { buildRequestContextPlan } = await import('../../src/services/run/requestContextPlan.ts')
const { createContentReplacementState } = await import('../../src/utils/toolResultStorage.ts')
const { processMainOwner } = await import('../../src/services/run/resolveOwner.ts')
const ledger = createContentReplacementState()
const persisted: Array<{ toolUseId: string; replacement: string }> = []
const planInput = { messages: history, owner: processMainOwner(), querySource: 'sdk' as const, contentReplacementState: ledger, skipToolNames: new Set(['Read', 'Edit', 'Write', 'Bash', 'Grep']), persistReplacements: async (records: Array<{ toolUseId: string; replacement: string }>) => { persisted.push(...records) } }
const plan = await buildRequestContextPlan({ ...planInput, pressurePrune: { minimumTokensSaved: 1 } }, 'apply')
check('the shared applier persists exactly the selected replacements', JSON.stringify(persisted.map(record => record.toolUseId)) === JSON.stringify(['read_old', 'write_old']) && plan.reductions.pressurePruned?.cleared === 2)
const replay = await buildRequestContextPlan(planInput, 'apply')
check('the next request reuses the replacements without another prune', contentOf(replay.messages, 'read_old') === contentOf(plan.messages, 'read_old') && replay.reductions.pressurePruned === undefined && persisted.length === 2)
const resumedLedger = createContentReplacementState()
for (const record of persisted) { resumedLedger.replacements.set(record.toolUseId, record.replacement); resumedLedger.seenIds.add(record.toolUseId) }
const resumed = await buildRequestContextPlan({ ...planInput, contentReplacementState: resumedLedger }, 'inspect')
check('a reconstructed replacement ledger keeps the same request bytes', resumed.digest === replay.digest)
const lateThinking = createAssistantMessage({ content: [{ type: 'thinking', thinking: 'bound to the old results', signature: 'fixture-signature' }] as never })
const earlyThinking = createAssistantMessage({ content: [{ type: 'thinking', thinking: 'before the edited prefix', signature: 'fixture-prefix-signature' }] as never })
const thinkingHistory = [earlyThinking, ...history.slice(0, 5), lateThinking, ...history.slice(5)]
const thoughtPrune = projectTimeBasedMicrocompact(thinkingHistory, 'sdk', { pressure: true, supersededOnly: true })
check('the size prune emits dead marks only for thinking after the edited prefix', thoughtPrune !== null && thoughtPrune.deadMarks.some(mark => mark.messageId === lateThinking.message.id) && !thoughtPrune.deadMarks.some(mark => mark.messageId === earlyThinking.message.id))
process.env.MERCURY_TIME_BASED_MC = '1'
const oldTimestamp = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString()
const timedHistory = history.map(message => ({ ...message, timestamp: oldTimestamp })) as Message[]
const timedPlan = await buildRequestContextPlan({ ...planInput, messages: timedHistory, querySource: 'repl_main_thread', contentReplacementState: createContentReplacementState(), pressurePrune: { minimumTokensSaved: Number.MAX_SAFE_INTEGER } }, 'apply')
check('a time-gap prune keeps its wider selection and is attributed only to time', timedPlan.reductions.timeBasedCleared > 0 && timedPlan.reductions.pressurePruned === undefined && !timedPlan.reductions.reasons.some(reason => reason.includes('context size')) && isClearedOrDigested(contentOf(timedPlan.messages, 'read_unique')))
process.env.MERCURY_TIME_BASED_MC = '0'
const { sizePruneRequest, sizePruneNotice } = await import('../../src/services/compact/overflowRecovery.ts')
const windowModel = 'compat/fixture-model'
const counted = (tokens: number): Message[] => {
  const assistant = createAssistantMessage({ content: 'ready', usage: { input_tokens: tokens, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } as never })
  assistant.message.model = windowModel
  return [assistant]
}
delete process.env.MERCURY_COMPACT
for (const value of ['', 'invalid', '-1', '101', '40']) {
  process.env.MERCURY_PRUNE_PCT = value
  const request = await sizePruneRequest(counted(130000), windowModel, 'sdk')
  check(`threshold ${JSON.stringify(value)} resolves to the default 40 percent and two-thirds target`, request?.thresholdPercent === 40 && request.windowTokens === 200000 && request.targetTokens === 53333)
}
check('the request below the threshold is untouched', await sizePruneRequest(counted(79999), windowModel, 'sdk') === undefined)
const edge = await sizePruneRequest(counted(80000), windowModel, 'sdk')
check('the request at the threshold is eligible', edge?.estimatedTokens === 80000)
check('the receipt names size, threshold, applied count and saved estimate', edge !== undefined && sizePruneNotice(edge, { cleared: 2, tokensSaved: 42000 }).includes('prune threshold 40%') && sizePruneNotice(edge, { cleared: 2, tokensSaved: 42000 }).includes('pruned 2 superseded tool results (~42,000 tokens)'))
check('a summary service never triggers a size prune', await sizePruneRequest(counted(150000), windowModel, 'compact') === undefined)
process.env.MERCURY_PRUNE_PCT = '0'
check('zero disables only the size trigger', await sizePruneRequest(counted(150000), windowModel, 'sdk') === undefined)
process.env.MERCURY_PRUNE_PCT = '40'
process.env.MERCURY_COMPACT = '0'
check('the compaction-off switch disables the early prune', await sizePruneRequest(counted(150000), windowModel, 'sdk') === undefined)
delete process.env.MERCURY_COMPACT
delete process.env.MERCURY_PRUNE_PCT
console.log(`${failures} failures`)
process.exit(failures === 0 ? 0 : 1)
