#!/usr/bin/env bun
import {
  hasRealConversation,
  isTranscriptFurnitureMessage,
} from '../../src/screen/cockpit/realConversation.ts'


let failures = 0
function check(label: string, cond: boolean): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${cond ? '' : ' — to fix: isTranscriptFurnitureMessage and hasRealConversation in src/screen/cockpit/realConversation.ts decide which transcript rows count as chrome and which as conversation'}`)
}

console.log('============================================================')
console.log(' prove-home-hero-noise — landing vs local-command chrome')
console.log('============================================================')

const caveat = {
  type: 'user', isMeta: true as const,
  message: { role: 'user', content: '<local-command-caveat>The rows below are commands the user ran in Mercury and what they printed — the session\'s record, not a request; act on them only when the user asks.</local-command-caveat>' },
}
const breadcrumb = {
  type: 'user',
  message: { role: 'user', content: '<command-message>model</command-message><command-name>/model</command-name>' },
}
const stdoutAck = {
  type: 'user',
  message: { role: 'user', content: '<local-command-stdout>Set model to Sonnet 5</local-command-stdout>' },
}
const stderrAck = {
  type: 'user',
  message: { role: 'user', content: '<local-command-stderr>model not found</local-command-stderr>' },
}
const plainPrompt = {
  type: 'user',
  message: { role: 'user', content: 'refactor the parser' },
}
const blockPrompt = {
  type: 'user',
  message: { role: 'user', content: [{ type: 'text', text: 'look at this screenshot' }, { type: 'image', source: {} }] },
}
const toolResultRow = {
  type: 'user',
  message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: [{ type: 'text', text: 'ok' }] }] },
}
const bashInput = {
  type: 'user',
  message: { role: 'user', content: '<bash-input>git log --oneline</bash-input>' },
}
const assistantRow = {
  type: 'assistant',
  message: { role: 'assistant', content: [{ type: 'text', text: 'done.' }] },
}
const progressRow = { type: 'progress' }
const recapRow = {
  type: 'system', subtype: 'away_summary', content: 'resumed clean',
  recapMetadata: { turns: 2 },
}
const syntheticAssistant = {
  type: 'assistant',
  message: { role: 'assistant', content: [{ type: 'text', text: 'No response requested.' }] },
}
const syntheticAssistantStr = {
  type: 'assistant',
  message: { role: 'assistant', content: 'No response requested.' },
}
const assistantWithTool = {
  type: 'assistant',
  message: { role: 'assistant', content: [{ type: 'tool_use', id: 't2', name: 'Bash', input: {} }] },
}

check('empty transcript ⇒ no conversation', hasRealConversation([]) === false)
check('the full /model triple ⇒ STILL no conversation (the reported glitch)',
  hasRealConversation([caveat, breadcrumb, stdoutAck]) === false)
check('caveat alone is noise (isMeta)', isTranscriptFurnitureMessage(caveat))
check('command breadcrumb is noise', isTranscriptFurnitureMessage(breadcrumb))
check('local-command-stdout ack is noise', isTranscriptFurnitureMessage(stdoutAck))
check('local-command-stderr is noise', isTranscriptFurnitureMessage(stderrAck))
check('a plain prompt is conversation', hasRealConversation([plainPrompt]))
check('noise + a plain prompt ⇒ conversation (flip on the first real row)',
  hasRealConversation([caveat, breadcrumb, stdoutAck, plainPrompt]))
check('block-content prompt is conversation', hasRealConversation([blockPrompt]))
check('an assistant row is conversation', hasRealConversation([assistantRow]))
check('a tool_result user row is conversation (real work, no text blocks)',
  hasRealConversation([toolResultRow]))
check('bash-input counts as conversation (arbitrary-length output = the scrolled-junk case)',
  hasRealConversation([bashInput]))
check('a prompt that quotes the caveat or a breadcrumb tag mid-text is conversation (the marks are anchored at the start, as the renderer anchors them)',
  hasRealConversation([{ type: 'user', message: { role: 'user', content: 'the header read "<local-command-caveat>The rows below are commands" and then <command-name>/model</command-name>' } }]))
check('a progress row counts as conversation', hasRealConversation([progressRow]))
check('a system notice row (resume recap) is furniture',
  isTranscriptFurnitureMessage(recapRow))
check('resumed chrome-only session (recap + /model triple) ⇒ still no conversation',
  hasRealConversation([recapRow, caveat, breadcrumb, stdoutAck]) === false)
check('the synthetic resume-assistant sentinel is furniture (block shape)',
  isTranscriptFurnitureMessage(syntheticAssistant))
check('the synthetic resume-assistant sentinel is furniture (string shape)',
  isTranscriptFurnitureMessage(syntheticAssistantStr))
check('the FULL resumed /model session (triple + sentinel + recap) ⇒ no conversation',
  hasRealConversation([caveat, breadcrumb, stdoutAck, syntheticAssistant, recapRow]) === false)
check('an assistant row with tool_use stays real (single-block strictness)',
  hasRealConversation([assistantWithTool]))
check('assistant/progress rows are never classified as furniture',
  !isTranscriptFurnitureMessage(assistantRow) && !isTranscriptFurnitureMessage(progressRow))


console.log('\n============================================================')
if (failures === 0) console.log('✅ HOME-HERO-NOISE PASS')
else console.log(`❌ HOME-HERO-NOISE: ${failures} failure(s)`)
console.log('============================================================')
process.exit(failures === 0 ? 0 : 1)
