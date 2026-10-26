import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Message } from '../../src/types/message.js'
import type { AdvisorContext } from '../../src/services/advisor/advisorContext.js'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const home = mkdtempSync(join(process.env.SCRATCHPAD ?? tmpdir(), 'advisor-evidence-'))
process.env.MERCURY_CONFIG_DIR = home
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
const { enableConfigs } = await import('../../src/utils/config/globalConfig.js')
enableConfigs()
const { createUserMessage, createAssistantMessage } = await import('../../src/utils/messages/factories.js')
const advisor = await import('../../src/services/advisor/index.js')
const { ADVISOR_INCOMPLETE_EVIDENCE_RULE, advisorTranscriptTail, clipAdvisorText, serializeAdvisorInput } = await import('../../src/services/advisor/advisorProjection.js')
const { DIGEST_INPUT_STRING_CLIP } = await import('../../src/services/advisor/advisorNote.js')
let checks = 0
function check(label: string, condition: unknown): void {
  assert.ok(condition, label)
  checks++
  console.log(`PASS ${label}`)
}
const operator = (text: string): Message => createUserMessage({ content: text })
const agent = (text: string): Message => createAssistantMessage({ content: text })
const tool = (name: string, input: Record<string, unknown>): Message => createAssistantMessage({ content: [{ type: 'tool_use', id: 'fixture-call', name, input }] })
const result = (text: string, isError = false): Message => createUserMessage({ content: [{ type: 'tool_result', tool_use_id: 'fixture-call', content: text, is_error: isError }] })
const context = (id: string, note?: string): AdvisorContext => ({
  agentId: id, cursor: undefined, rows: note ? [{ kind: 'note', at: 'earlier', text: note }] : [], path: null, openedAt: 0,
})
const header = `${'Fixture license header and includes.\n'.repeat(27)}using TGenerator = std::minstd_rand;\n`.padEnd(2866, ' ')
const fetched = `Source: lib/CRandomGenerator.h\n[Page text: characters 0–2866; 2866 of 2866 characters shown; end of page.]\n\n${header}`
const longPrompt = 'Review the assigned specification and its source evidence.\n'.repeat(70)
const launches = [
  { run_in_background: true, crewmate_type: 'mercury-crew', prompt: longPrompt, model: 'claude-opus-5-5', description: 'Review lane one', effort: 'max', name: 'lane-one' },
  { description: 'Review lane two', effort: 'max', model: 'claude-opus-5-5', prompt: longPrompt, run_in_background: true, crewmate_type: 'mercury-crew', name: 'lane-two' },
  { effort: 'max', crewmate_type: 'mercury-crew', prompt: longPrompt, model: 'claude-opus-5-5', run_in_background: true, description: 'Review lane three', name: 'lane-three' },
  { description: 'Review README', name: 'readme', prompt: longPrompt, run_in_background: true, crewmate_type: 'mercury-crew', effort: 'max', model: 'k3.1-pro' },
]
const lore = { crewmate_type: 'mercury-crew', name: 'lore', model: 'claude-sonnet-5-5', run_in_background: true, prompt: longPrompt, description: 'Review lore', effort: 'max' }
const inputsIn = (prompt: string): Record<string, unknown>[] => prompt.split('\n').filter(line => line.startsWith('[tool] Crewmate ')).map(line => JSON.parse(line.slice('[tool] Crewmate '.length)))
const hasGenerator = (prompt: string): boolean => prompt.includes('using TGenerator = std::minstd_rand;')
const oldClaim = 'The source declares mt19937; minstd_rand is a confabulation.'
const cases: Array<{ id: string; messages: Message[]; previous?: string; evidence: (prompt: string) => boolean }> = [
  { id: 'L379', messages: [result('Review report: using TGenerator = std::minstd_rand;'), agent('The source uses minstd_rand.')], evidence: hasGenerator },
  { id: 'L394', messages: [result(fetched), agent('The header was fetched.')], previous: oldClaim, evidence: prompt => prompt.includes(fetched) },
  { id: 'L414', messages: [result(fetched), agent('The source uses minstd_rand.')], previous: oldClaim, evidence: hasGenerator },
  { id: 'L442', messages: launches.map(input => tool('Crewmate', input)), evidence: prompt => {
    const inputs = inputsIn(prompt)
    return inputs.length === launches.length && inputs.every((input, i) => input.model === launches[i]!.model && input.effort === 'max' && Object.keys(input).join() === Object.keys(launches[i]!).join())
  } },
  { id: 'L471', messages: [result(fetched), tool('Crewmate', lore)], previous: oldClaim, evidence: prompt => hasGenerator(prompt) && inputsIn(prompt)[0]?.effort === 'max' && inputsIn(prompt)[0]?.model === lore.model },
  { id: 'L909', messages: [tool('Read', { file_path: 'lib/CRandomGenerator.h' }), result(header), agent('minstd_rand is correct for this tag.')], previous: oldClaim, evidence: hasGenerator },
]

try {
  check('the source fixture has the recorded size and its declaration lies past the old cut', header.length === 2866 && fetched.indexOf('using TGenerator') > 400)
  check('launch fixture strings hide trailing keys under the old cut', longPrompt.length > 3000 && !JSON.stringify(launches[0]).slice(0, 400).includes('"model"') && !JSON.stringify(lore).slice(0, 400).includes('"effort"'))
  check('the advisor prompt forbids corrections inferred from hidden text or recalled code', advisor.ADVISOR_SYSTEM_PROMPT.includes(ADVISOR_INCOMPLETE_EVIDENCE_RULE) && ADVISOR_INCOMPLETE_EVIDENCE_RULE.includes('Never raise a correction') && ADVISOR_INCOMPLETE_EVIDENCE_RULE.includes('visible evidence'))
  check('earlier advisor claims are not treated as source evidence', advisor.ADVISOR_SYSTEM_PROMPT.includes('Your earlier notes are hypotheses, not source evidence.'))
  for (const fixture of cases) {
    let calls = 0
    const memory = context(fixture.id, fixture.previous)
    const note = await advisor.composeAdvisorNote(memory, fixture.messages, {
      settings: { enabled: true, minutes: 5 }, chat: true, model: 'claude-fable-5-1', window: 200_000,
      call: async args => {
        calls++
        check(`${fixture.id}: the judging call sees the evidence the old projection hid`, fixture.evidence(args.prompt))
        check(`${fixture.id}: the judging call gets the incomplete-evidence rule`, args.system.includes(ADVISOR_INCOMPLETE_EVIDENCE_RULE))
        return { ok: true, text: 'carry on' }
      },
    })
    check(`${fixture.id}: a quiet fixture response raises no correction note`, calls === 1 && note === null && memory.rows.at(-1)?.text === 'carry on')
  }

  const nested = { prompt: longPrompt, options: [{ content: longPrompt, model: 'claude-fable-5-1', effort: 'max', enabled: false, count: 0, absent: null }], tail: 'kept' }
  const encoded = serializeAdvisorInput(nested, DIGEST_INPUT_STRING_CLIP)
  const decoded = JSON.parse(encoded)
  const omitted = longPrompt.length - DIGEST_INPUT_STRING_CLIP
  check('input strings are shortened individually with exact omission counts', decoded.prompt === `${longPrompt.slice(0, DIGEST_INPUT_STRING_CLIP)}… [${omitted} more characters not shown]` && decoded.options[0].content === decoded.prompt)
  check('nested objects, array entries and every trailing scalar survive', decoded.options[0].model === 'claude-fable-5-1' && decoded.options[0].effort === 'max' && decoded.options[0].enabled === false && decoded.options[0].count === 0 && decoded.options[0].absent === null && decoded.tail === 'kept')
  const whitespace = '  first\n\tsecond  '
  check('short tool strings and results preserve whitespace verbatim', JSON.parse(serializeAdvisorInput({ prompt: whitespace }, 400)).prompt === whitespace && advisor.renderAgentDigest([result(whitespace)], undefined).text === `[result] ${whitespace}`)
  check('a boundary-length string is whole, not marked as truncated', clipAdvisorText('abcd', 4) === 'abcd' && clipAdvisorText('abcde', 4) === 'abcd… [1 more characters not shown]')
  const large = 'x'.repeat(advisor.DIGEST_RESULT_CLIP) + 'unseen'
  const clipped = advisor.renderAgentDigest([result(large)], undefined)
  check('a deliberately capped result states exactly what the advisor could not see', clipped.text === `[result] ${'x'.repeat(advisor.DIGEST_RESULT_CLIP)}… [6 more characters not shown]`)
  const blocks = createUserMessage({ content: [{ type: 'tool_result', tool_use_id: 'fixture-call', content: [{ type: 'text', text: 'header' }, { type: 'text', text: header }] }] })
  check('text-block tool results retain the source beyond the first block', advisor.renderAgentDigest([blocks], undefined).text === `[result] header\n${header}`)

  const many = Array.from({ length: 1200 }, (_, i) => operator(`row-${i} ${'x'.repeat(100)}`))
  const tail = advisor.renderAgentDigest([...many, tool('Crewmate', launches[0]!)], undefined)
  check('the total budget drops whole earlier rows, never a JSON prefix', /^\[\d+ earlier rows; \d+ characters not shown\]\n\[operator\]/.test(tail.text) && inputsIn(tail.text)[0]?.effort === 'max')
  check('the digest stays bounded apart from its omission marker', tail.text.length <= advisor.DIGEST_MAX_CHARS + 100)
  check('whole-row omission counts cover the exact dropped text', advisorTranscriptTail(['abc', 'defgh', 'tail'], 5) === '[2 earlier rows; 10 characters not shown]\ntail')
  const wideInput = Object.fromEntries(Array.from({ length: 5000 }, (_, i) => [`key${i}`, i]))
  const wideDigest = advisor.renderAgentDigest([tool('Example', wideInput)], undefined)
  const wideRead = JSON.parse(wideDigest.text.slice('[tool] Example '.length))
  check('even an input wider than the overall budget keeps every key', Object.keys(wideRead).length === 5000 && wideRead.key4999 === 4999)

  const folded = advisor.renderAdvisorFoldTranscript([{ kind: 'digest', at: 'earlier', text: advisor.renderAgentDigest([result(fetched), tool('Crewmate', launches[0]!)], undefined).text }])
  check('compaction does not silently reclip a digest at 1200 characters', folded.includes(fetched) && inputsIn(folded)[0]?.effort === 'max')
  check('the summary prompt preserves the same incomplete-evidence rule', advisor.advisorCompactSummaryPrompt().includes(ADVISOR_INCOMPLETE_EVIDENCE_RULE))
  const foldTail = advisor.renderAdvisorFoldTranscript([{ kind: 'digest', at: 'a', text: 'x'.repeat(60_000) }, { kind: 'note', at: 'b', text: 'visible note' }])
  check('a bounded summary transcript marks dropped rows', /^\[1 earlier rows; \d+ characters not shown\]\n\[your note to the agent\] visible note$/.test(foldTail))
  const summaryContext = context('summary')
  summaryContext.rows.push({ kind: 'digest', at: 'a', text: 'older' }, { kind: 'note', at: 'b', text: 'newer' })
  await advisor.compactAdvisorContext(summaryContext, { model: 'fixture', keep: 1, summarize: async () => 's'.repeat(advisor.ADVISOR_SUMMARY_MAX_CHARS + 10) })
  check('an overlong summary carries its own omission marker', summaryContext.rows[0]?.text.endsWith('… [10 more characters not shown]'))

  const missing = context('partial', oldClaim)
  missing.cursor = 'old-cursor'
  let partialCalls = 0
  const partialNote = await advisor.composeAdvisorNote(missing, [result(large)], {
    settings: { enabled: true, minutes: 5 }, chat: true, model: 'claude-fable-5-1', window: 200_000,
    call: async args => {
      partialCalls++
      check('a partial view is explicitly incomplete at the judging call', args.prompt.includes('[6 more characters not shown]') && args.system.includes('outside the shown conversation window'))
      return { ok: true, text: 'carry on' }
    },
  })
  check('the partial-evidence quiet response is not turned into a correction', partialCalls === 1 && partialNote === null)

  const positives = [
    { messages: [operator('Run the pin on the base before editing.'), agent('I edited first; I have not run the pin.')], text: 'You have not run the pin on the base yet.', visible: 'I edited first; I have not run the pin.' },
    { messages: [result('using TGenerator = std::mt19937;'), agent('The source declares minstd_rand.')], text: 'The visible declaration is mt19937, not minstd_rand.', visible: 'using TGenerator = std::mt19937;' },
    { messages: [tool('Crewmate', { prompt: longPrompt, model: 'claude-sonnet-5-5', effort: 'low' })], text: 'The launch explicitly sets effort low, not max.', visible: '"effort":"low"' },
    { messages: [result('the pin failed with exit 1', true)], text: 'The pin failed; fix the reported error.', visible: '[result error] the pin failed with exit 1' },
  ]
  for (const [i, fixture] of positives.entries()) {
    const note = await advisor.composeAdvisorNote(context(`positive-${i}`), fixture.messages, {
      settings: { enabled: true, minutes: 5 }, chat: true, model: 'claude-fable-5-1', window: 200_000,
      call: async args => {
        check(`visible-error fixture ${i}: the contradiction survives projection`, args.prompt.includes(fixture.visible))
        return { ok: true, text: fixture.text }
      },
    })
    check(`visible-error fixture ${i}: the correction still reaches the agent`, note?.text === fixture.text)
  }
  console.log(`Advisor evidence: ${checks} checks passed (deterministic call fixtures; no live model)`)
} finally {
  rmSync(home, { recursive: true, force: true })
}
