#!/usr/bin/env bun
// ============================================================================
//  scripts/messages/prove-answer-seam.ts
//  PROOF: cross-provider ANSWER decoding on the side-chat surfaces — the
//  console (side-question fork), Minerva (both legs), and the coordinator
//  round loop — under the two live operator sightings:
//
//   (a) the console pinned to Sonnet 5 painted a raw
//       "Cannot read properties of undefined (reading 'type')" AS ITS REPLY
//       (1s, 0→0 tok): a runtime throw became an isApiErrorMessage assistant
//       settlement whose bare text the extraction flattened as the answer,
//       and the prefix-sniffing failure detector let it through;
//   (b) Minerva on gpt-5.6-luna painted "gpt-5.6-luna answered without
//       decodable JSON: …" over a PROVIDER failure — the runtime's refusal
//       prose was fed to the JSON decoder and the model blamed for words it
//       never said.
//
//  The seam laws proven here:
//   §1 an api-error settlement is a FAILURE, never an answer (sighting a);
//   §2 a real answer beside an api-error settlement stays the answer;
//   §3 settledProviderFailure classifies settlements ONCE for every
//      structured one-shot consumer, and every decodeModelJson consumer
//      asks it (or its local equivalent) BEFORE decoding — source-pinned;
//   §4 per-family captured-SHAPE answer fixtures decode (fences, prose
//      wrap, bare JSON), and a genuinely undecodable answer still names
//      the model honestly;
//   §5 a malformed response frame gets the TYPED sentence naming the frame
//      and the missing body — never a raw TypeError — and the inbound
//      normalizers survive null holes.
//
//  Run:  ~/.bun/bin/bun run scripts/messages/prove-answer-seam.ts
// ============================================================================
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
const MJ = await import('../../src/utils/messages/modelJson.ts')
const ERR = await import('../../src/services/api/errors.ts')
const ASK = await import('../../src/utils/cockpit/helmConsoleAsk.ts')

// ── message fixtures (the transcript shapes the engine actually settles) ────
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

// The operator's sighting (a), verbatim: the raw V8 TypeError text the turn
// machine's catch minted into an api-error assistant settlement.
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
  // A failure sentence already carrying the API-error prefix passes verbatim
  // — no double wrap, and the detector still fires on the prefix.
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

section('§3 settledProviderFailure — one classification, every consumer asks first')
{
  // Sighting (b)'s shape: the luna call failed on the way back; the runtime
  // settled its refusal sentence as an api-error message.
  const lunaFailure = `${ERR.API_ERROR_MESSAGE_PREFIX}: OpenAI stream failed (http-500) — upstream connect error`
  const failed = MJ.settledProviderFailure(apiErrored(lunaFailure) as never)
  check('an api-error settlement classifies as the provider failure, verbatim', failed === lunaFailure, String(failed))
  const fine = MJ.settledProviderFailure(answered('{"ops":[],"reply":"nothing to do"}') as never)
  check('a real answer classifies null (decode proceeds)', fine === null)
  const empty = MJ.settledProviderFailure({ type: 'assistant', isApiErrorMessage: true, message: { content: [] } } as never)
  check(
    'an empty-text error settlement still yields a sentence (never a blank reason)',
    typeof empty === 'string' && empty.length > 0,
    String(empty),
  )

  // Source pins: every decodeModelJson consumer guards BEFORE decoding.
  const minerva = read('src/utils/tabula/minerva.ts')
  const bootLeg = minerva.indexOf('settledProviderFailure(result)')
  const bootDecode = minerva.indexOf('decodeModelJson(text)')
  check('minerva boot leg asks settledProviderFailure before its decode', bootLeg !== -1 && bootDecode !== -1 && bootLeg < bootDecode)
  check(
    'minerva chat leg asks it too (two call sites in the file)',
    minerva.indexOf('settledProviderFailure(result)', bootLeg + 1) !== -1,
  )
  const room = read('src/utils/tabula/minervaRoom.ts')
  check(
    'the minerva room keeps its own pre-decode refusal arm',
    room.includes('result.isApiErrorMessage === true'),
  )
  const memories = read('src/memdir/findRelevantMemories.ts')
  check('findRelevantMemories keeps its pre-decode api-error arm', memories.includes('isApiErrorMessage'))
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

section('§4 per-family captured-SHAPE answers decode; real garbage stays honestly named')
{
  // Captured SHAPES (marked as such): the layouts the families actually
  // return for a JSON-forced ask — captured from live drives of the decode
  // ladder's consumer estates, reduced to shape (not verbatim transcripts).
  const plan = '{"ops":[{"op":"add","text":"note"}],"reply":"added 1"}'
  const families: Array<[string, string]> = [
    ['anthropic/openai (schema-forced): bare JSON', plan],
    ['moonshot/deepseek shape: fenced JSON', '```json\n' + plan + '\n```'],
    ['compat-chat shape: prose-wrapped JSON', 'Here is the plan you asked for:\n' + plan],
    ['bare fence, no language word', '```\n' + plan + '\n```'],
    ['prose + trailing sentence around the object', 'Sure. ' + plan + ' Let me know if that works.'],
  ]
  for (const [label, text] of families) {
    const decoded = MJ.decodeModelJson(text)
    check(
      `${label} decodes`,
      decoded.ok === true && (decoded as { value: { reply?: string } }).value.reply === 'added 1',
    )
  }
  const garbage = MJ.decodeModelJson('I cannot produce JSON for that.')
  check('a genuinely non-JSON answer refuses decode', garbage.ok === false)
  const line = MJ.describeUndecodableModelText('gpt-5.6-luna', 'I cannot produce JSON for that.')
  check(
    'the undecodable line names the model and the head of what it SAID (the honest arm, kept)',
    line.startsWith('gpt-5.6-luna answered without decodable JSON:') && line.includes('I cannot produce JSON'),
    line,
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
