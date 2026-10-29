#!/usr/bin/env bun
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(import.meta.dir, '..', '..')
const read = (rel: string): string => readFileSync(join(ROOT, rel), 'utf8')

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}

const SQ = await import('../../src/utils/sideQuestion.ts')
const ERR = await import('../../src/services/api/errors.ts')
const ASK = await import('../../src/utils/cockpit/helmConsoleAsk.ts')

type AnyMessage = {
  type: string
  isApiErrorMessage?: boolean
  message: { content: unknown }
}
const answered = (text: string): AnyMessage => ({
  type: 'assistant',
  message: { content: [{ type: 'text', text }] },
})
const apiErrored = (text: string): AnyMessage => ({
  type: 'assistant',
  isApiErrorMessage: true,
  message: { content: [{ type: 'text', text }] },
})

const SIGHTING_A = "Cannot read properties of undefined (reading 'type')"

section('§1 sighting (a): an api-error settlement is a FAILURE, never an answer')
{
  const out = SQ.extractResponse([apiErrored(SIGHTING_A)] as never)
  check('the raw TypeError text is NOT returned as the bare answer', out !== SIGHTING_A, String(out))
  check(
    "it surfaces as the recognised failure shape ('An API error occurred: …')",
    out !== null && out.startsWith('An API error occurred: ') && out.includes(SIGHTING_A),
    String(out),
  )
  check(
    'the console failure detector recognises it (the error row, not a reply row)',
    ASK.consoleAskFailure(out) !== null,
  )
  const prefixed = `${ERR.API_ERROR_MESSAGE_PREFIX}: the anthropic wire refused the request`
  const outPrefixed = SQ.extractResponse([apiErrored(prefixed)] as never)
  check('a prefix-carrying failure passes through verbatim (no double wrap)', outPrefixed === prefixed, String(outPrefixed))
  check('…and the console detector recognises that shape too', ASK.consoleAskFailure(outPrefixed) !== null)
}

section('§2 a real answer beside an api-error settlement stays the answer')
{
  const out = SQ.extractResponse([apiErrored(SIGHTING_A), answered('The model is claude-sonnet-5.')] as never)
  check('the real text wins', out === 'The model is claude-sonnet-5.', String(out))
  check('…and reads as an answer to the console detector', ASK.consoleAskFailure(out) === null)
}

section('§3 every structured consumer asks the settlement classification first')
{
  const coordinator = read('src/services/concourse/coordinatorCall.ts')
  check(
    'the coordinator round loop excludes api-error settlements from its reply text',
    coordinator.includes("isApiErrorMessage !== true"),
  )
  check(
    'an error-only coordinator round throws into the fail-soft contract (never paints the refusal as words the coordinator said)',
    coordinator.includes('realAssistants.length === 0'),
  )
}

section('§5 malformed frames refuse TYPED; the inbound normalizers survive null holes')
{
  const s = ERR.malformedStreamFrameText('content_block_start', 'content_block')
  check(
    'the malformed-frame sentence names the frame and the missing body',
    s.includes("'content_block_start'") && s.includes("'content_block'"),
    s,
  )
  check('…and names the expected wire shape', s.includes('Anthropic stream shape'))
  check('…and never reads as a raw TypeError', !s.includes('Cannot read properties'))

  const core = read('src/services/providers/anthropic/streamCore.ts')
  check(
    'streamCore guards content_block_start through the typed sentence',
    core.includes("malformedStreamFrameText('content_block_start', 'content_block')"),
  )
  check(
    'streamCore guards content_block_delta through the typed sentence',
    core.includes("malformedStreamFrameText('content_block_delta', 'delta')"),
  )
  check(
    'streamCore guards message_delta through the typed sentence',
    core.includes("malformedStreamFrameText('message_delta', 'delta')"),
  )

  const MSGS = await import('../../src/utils/messages.ts')
  const holed = [null as never, { type: 'text', text: 'still here' }, undefined as never]
  let holedOut = ''
  let threw = false
  try {
    holedOut = MSGS.extractTextContent(holed as never)
  } catch {
    threw = true
  }
  check('extractTextContent survives null holes and keeps the real text', !threw && holedOut === 'still here')

  const AV = await import('../../src/utils/messages/apiView.ts')
  let normalized: unknown[] = []
  let normThrew = false
  try {
    normalized = AV.normalizeContentFromAPI(
      [null as never, { type: 'text', text: 'kept', citations: null } as never],
      [] as never,
    ) as unknown[]
  } catch {
    normThrew = true
  }
  check(
    'normalizeContentFromAPI drops a null block instead of dereferencing it',
    !normThrew && normalized.length === 1 && (normalized[0] as { text?: string }).text === 'kept',
  )
}

console.log('')
if (failures > 0) {
  console.log(`prove-answer-seam: ${failures} check(s) FAILED`)
  process.exit(1)
}
console.log('prove-answer-seam: all checks passed')
