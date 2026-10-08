import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
for (const key of ['MERCURY_HOME', 'MERCURY_OAUTH_TOKEN', 'MERCURY_MODEL', 'MERCURY_EXTRA_BODY', 'MERCURY_EFFORT_LEVEL', 'MERCURY_SCRIPTED_STREAM', 'MERCURY_SM_COMPACT']) delete process.env[key]
const home = mkdtempSync(join(tmpdir(), 'summary-refusal-phrasings-'))
process.env.MERCURY_CONFIG_DIR = home
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.ANTHROPIC_API_KEY = 'proof-key-ci-gate-not-a-real-key'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
const { startOverflowFixture } = await import('./overflowFixture.ts')
const fixture = await startOverflowFixture()
Object.assign(process.env, fixture.env)
const { enableConfigs } = await import('../../src/utils/config/globalConfig.ts')
enableConfigs()
const { setIsInteractive } = await import('../../src/bootstrap/state.ts')
setIsInteractive(false)
const { createUserMessage } = await import('../../src/utils/messages.ts')
const { getEmptyToolPermissionContext } = await import('../../src/Tool.ts')
const { compactConversation, partialCompactConversation } = await import('../../src/services/compact/compact.ts')
const { getCompactPrompt, getPartialCompactPrompt, SUMMARY_SECTION_TITLES } = await import('../../src/services/compact/prompt.ts')
const state = { toolPermissionContext: getEmptyToolPermissionContext(), sessionHooks: new Map(), tasks: {}, agentNameRegistry: new Map(), mcp: { clients: [], tools: [], commands: [], resources: {} }, effortValue: 'max' }
let failures = 0
let checks = 0
const check = (name: string, ok: boolean, details: unknown = ''): void => {
  checks++
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok ? '' : ` — ${JSON.stringify(details)}`}`)
}
const messages = [createUserMessage({ content: 'Keep the parser fact: quoted commas are supported, and 14 checks passed.' })]
const original = JSON.stringify(messages)
const skeleton = SUMMARY_SECTION_TITLES.slice(0, 10).map((title, index) => `${index + 1}. ${title}:\n   [...]`).join('\n')
const good = 'The parser supports quoted commas. All 14 checks passed. Next, check the CLI and preserve the pending test command.'
const tenSections = [
  '1. Operator Intent: the owner asked for the fold fix and its proof.',
  '2. Technical Ground: TypeScript, bun, the loopback fixtures.',
  '3. Files and Code Touched: compact.ts (the validator), prompt.ts (the titles), the proof.',
  '4. Errors and Corrections: none.',
  '5. Problems Worked: refusal phrasings were installed as summaries.',
  '6. Operator Messages: attack the claims.',
  '7. Open Work: the suites.',
  '8. Where Work Stands: the probe passes. I cannot summarize the remaining tool output as it was truncated in the transcript.',
  '9. Next Move (optional): run the compact suite.',
  '10. Agents in flight: none.',
  'The parser supports quoted commas and every check passed. '.repeat(6),
].join('\n')
const refusals: ReadonlyArray<readonly [string, string]> = [
  ['not able to help', "I'm not able to help with that."],
  ['as an AI', "As an AI I can't summarize this conversation."],
  ['as an AI language model', 'As an AI language model, I cannot provide a summary of this conversation.'],
  ["can't help", "I can't help with that."],
  ["can't assist", "I can't assist with that request."],
  ['unable to comply', "I'm unable to comply with this request."],
  ["won't be able", "I won't be able to provide that summary."],
  ['unable to help', 'I am unable to help with this.'],
  ['apologize', 'I apologize, but I cannot summarize this conversation.'],
  ['unfortunately', 'Unfortunately, I cannot summarize this conversation.'],
  ['must decline', 'I must decline to summarize this conversation.'],
  ['afraid', "I'm afraid I can't help with that request."],
  ['not permitted', 'I am not permitted to summarize this conversation.'],
  ['hedged then refusal', 'This conversation covers a parser change and some test results. I have read through all of it carefully and considered the request.\n\nHowever, I cannot provide a summary of this conversation.'],
  ['request cannot be completed', 'This request cannot be completed.'],
  ['preface then refusal wrapper', 'Here is the summary:\n<summary>I cannot summarize this conversation.</summary>'],
  ['fenced refusal inside wrapper', '<summary>```markdown\nI cannot summarize this conversation.\n```</summary>'],
  ['wrapper inside fence', "```xml\n<summary>I'm not able to help with that.</summary>\n```"],
  ['analysis then refusal', '<analysis>thinking</analysis>\n<summary>I cannot summarize this conversation.</summary>'],
  ['unclosed wrapper then refusal', '<summary>I cannot summarize this conversation.'],
  ['unclosed wrapper then not able', "<summary>\nI'm not able to help with that."],
  ['closer only after a refusal', 'I cannot summarize this conversation.</summary>'],
]
const empties: ReadonlyArray<readonly [string, string]> = [
  ['the ten headings only', skeleton],
  ['the ten headings in the wrapper', `<summary>\n${skeleton}\n</summary>`],
  ['bold headings only', '**Operator Intent**\n\n**Technical Ground**\n\n**Open Work**'],
  ['markdown headings only', '## 1. Operator Intent\n## 2. Technical Ground\n## 3. Files and Code Touched'],
  ['preface then empty wrapper', 'Here is the summary:\n<summary>\n</summary>'],
  ['empty wrapper with spaces', '<summary>   </summary>'],
  ['analysis only', '<analysis>I looked at everything.</analysis>'],
  ['lone punctuation', '...'],
  ['a rule', '---'],
  ['the skeleton without the optional mark', '1. Operator Intent:\n2. Technical Ground:\n9. Next Move:\n10. Agents in flight:'],
  ['the skeleton with dashes for content', '1. Operator Intent: -\n2. Technical Ground: -\n3. Files and Code Touched: [...]'],
]
const accepted: ReadonlyArray<readonly [string, string]> = [
  ['a narrative summary', good],
  ['a summary quoting an inability', 'The provider said "I cannot summarize this conversation" on the previous attempt. The parser still passes 14 checks.'],
  ['a summary opening with I', 'I reviewed the parser change: quoted commas are supported and all 14 checks passed. Next: the CLI check.'],
  ['a summary with an inability about a detail', "The user asked for a parser fix. I can't tell whether the CLI passes; the last run was interrupted. Next: rerun the CLI check."],
  ['an apology before a summary', 'Sorry for the length. The parser supports quoted commas and 14 checks pass; the pending step is the CLI check.'],
  ['the ten sections with one real line', '1. Operator Intent:\n   The user asked for the parser fix.\n2. Technical Ground:\n   [...]'],
  ['the ten sections carrying an inability sentence', tenSections],
  ['a fenced summary with a language tag', `\`\`\`markdown\n${good}\n\`\`\``],
  ['a fenced summary inside the wrapper', `<summary>\n\`\`\`text\n${good}\n\`\`\`\n</summary>`],
  ['a preface before the wrapper', `Here is the summary:\n<summary>${good}</summary>`],
  ['an unclosed wrapper around a real summary', `<summary>${good}`],
  ['the skeleton with none as its content', '1. Operator Intent:\n   none\n2. Technical Ground:\n   none'],
  ['a summary quoting a refusal inside the sections', '1. Operator Intent: the owner asked for the fold fix.\n2. Technical Ground: TypeScript, bun.\n3. Files and Code Touched: compact.ts.\n4. Errors and Corrections: the model said "I cannot summarize the tool output" once; retried.\n5. Problems Worked: none.'],
]
const fold = async (text: string, direction: 'full' | 'from' | 'up_to'): Promise<{ installed: boolean; error: string; requests: number; kept: boolean; reads: boolean; notices: string[] }> => {
  const notices: string[] = []
  const ledger = new Map([[join(home, 'parser.ts'), { content: 'parser fact', timestamp: 17 }]])
  const reads = JSON.stringify([...ledger])
  const loaded = new Set(['nested-memory'])
  const context: any = { abortController: new AbortController(), getAppState: () => state, setAppState: () => {}, messages, readFileState: ledger, loadedNestedMemoryPaths: loaded, addNotification: (notice: { text: string }) => notices.push(notice.text), options: { tools: [], commands: [], mcpClients: [], engineModel: 'claude-sonnet-5-5', maxThinkingTokens: 0, isNonInteractiveSession: true, agentDefinitions: { activeAgents: [] } } }
  const cache = { systemPrompt: ['Synthetic refusal phrasing proof.'] } as never
  fixture.script(() => ({ text }))
  const before = fixture.captured.length
  let result: unknown
  let error = ''
  try {
    result = direction === 'full'
      ? await compactConversation(messages, context, cache, false)
      : await partialCompactConversation(messages, direction === 'from' ? 0 : messages.length, context, cache, undefined, direction)
  } catch (caught) { error = String(caught) }
  return { installed: result !== undefined, error, requests: fixture.captured.length - before, kept: JSON.stringify(messages) === original, reads: JSON.stringify([...ledger]) === reads && loaded.has('nested-memory'), notices }
}
try {
  console.log('1. a refusal in prose, whatever its phrasing, preface or wrapper, is rejected before anything is installed')
  for (const [label, text] of refusals) {
    const outcome = await fold(text, 'full')
    check(`${label}: rejected`, !outcome.installed && outcome.error.includes('Failed to generate a conversation summary.'), outcome)
    check(`${label}: the conversation, the read ledger and the notice survive; one request`, outcome.kept && outcome.reads && outcome.requests === 1 && outcome.notices.some(value => value.includes('Compaction error:')), outcome)
  }
  console.log('2. a summary that says nothing — the prompt\'s own skeleton, a wrapper with nothing inside, punctuation — is empty')
  for (const [label, text] of empties) {
    const outcome = await fold(text, 'full')
    check(`${label}: rejected as empty`, !outcome.installed && outcome.error.includes('Failed to generate a conversation summary.'), outcome)
    check(`${label}: the conversation and the read ledger survive`, outcome.kept && outcome.reads, outcome)
  }
  console.log('3. the partial folds share the validator')
  for (const direction of ['from', 'up_to'] as const) {
    for (const [label, text] of [refusals[0]!, refusals[13]!, empties[0]!]) {
      const outcome = await fold(text, direction)
      check(`${direction} ${label}: rejected`, !outcome.installed && outcome.kept && outcome.reads, outcome)
    }
  }
  console.log('4. a substantive summary is accepted whatever its shape, even when it mentions an inability or quotes a refusal')
  for (const [label, text] of accepted) {
    const outcome = await fold(text, 'full')
    check(`${label}: installed`, outcome.installed && outcome.requests === 1, outcome)
  }
  console.log('5. a refusal stop that arrives with text is the provider\'s refusal, never the summary')
  {
    const notices: string[] = []
    const context: any = { abortController: new AbortController(), getAppState: () => state, setAppState: () => {}, messages, readFileState: new Map(), addNotification: (notice: { text: string }) => notices.push(notice.text), options: { tools: [], commands: [], mcpClients: [], engineModel: 'claude-sonnet-5-5', maxThinkingTokens: 0, isNonInteractiveSession: true, agentDefinitions: { activeAgents: [] } } }
    fixture.script(() => ({ refusal: true, text: good }))
    let result: unknown
    let error = ''
    try { result = await compactConversation(messages, context, { systemPrompt: ['Synthetic refusal phrasing proof.'] } as never, false) } catch (caught) { error = String(caught) }
    check('a refusal stop with a plausible summary text is rejected', result === undefined && error.includes('stop_reason: refusal'), { error, installed: result !== undefined })
    check('the conversation survives it', JSON.stringify(messages) === original)
  }
  console.log('6. the section titles the validator strips are the prompt\'s own')
  const prompts = [getCompactPrompt(), getPartialCompactPrompt(undefined, 'from'), getPartialCompactPrompt(undefined, 'up_to')]
  for (const title of SUMMARY_SECTION_TITLES) {
    check(`"${title}" is a section title of a fold prompt`, prompts.some(prompt => prompt.includes(`${title}:`)), title)
  }
  check('every section title of the full prompt is in the list', [...getCompactPrompt().matchAll(/^\d{1,2}\. ([^:\n]+):/gm)].every(match => SUMMARY_SECTION_TITLES.includes(match[1] as string)), getCompactPrompt().match(/^\d{1,2}\. ([^:\n]+):/gm))
  check('every section title of the up_to prompt is in the list', [...getPartialCompactPrompt(undefined, 'up_to').matchAll(/^\d{1,2}\. ([^:\n]+):/gm)].every(match => SUMMARY_SECTION_TITLES.includes(match[1] as string)))
} finally {
  await fixture.close()
  rmSync(home, { recursive: true, force: true })
}
console.log(`${failures ? 'FAIL' : 'PASS'} summary-refusal-phrasings: ${checks} checks, ${failures} failures`)
process.exit(failures ? 1 : 0)
