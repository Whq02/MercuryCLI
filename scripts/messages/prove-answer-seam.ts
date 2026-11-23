#!/usr/bin/env bun


let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}

const ERR = await import('../../src/engine/requests/apiErrorRows.ts')


section('§5 malformed frames refuse TYPED; the inbound normalizers survive null holes')
{
  const s = ERR.malformedStreamFrameText('content_block_start', 'content_block')
  check(
    'the malformed-frame sentence names the frame and the missing body',
    s.includes("'content_block_start'") && s.includes("'content_block'"),
    `${s} — fix malformedStreamFrameText in src/engine/requests/apiErrorRows.ts so the sentence names the frame type and the missing body field`,
  )
  check(
    '…and names the expected wire shape',
    s.includes('Anthropic stream shape'),
    `${s} — fix malformedStreamFrameText in src/engine/requests/apiErrorRows.ts to name the Anthropic stream shape`,
  )
  check(
    '…and never reads as a raw TypeError',
    !s.includes('Cannot read properties'),
    `${s} — fix malformedStreamFrameText in src/engine/requests/apiErrorRows.ts so it builds its own sentence`,
  )


  const MSGS = await import('../../src/engine/messages/messages.ts')
  const holed = [null as never, { type: 'text', text: 'still here' }, undefined as never]
  let holedOut = ''
  let threw = false
  try {
    holedOut = MSGS.extractTextContent(holed as never)
  } catch {
    threw = true
  }
  check(
    'extractTextContent survives null holes and keeps the real text',
    !threw && holedOut === 'still here',
    `threw=${threw} out=${JSON.stringify(holedOut)} — make extractTextContent in src/engine/message-shapes/text.ts skip null or undefined blocks`,
  )

  const AV = await import('../../src/engine/messages/apiView.ts')
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
    `threw=${normThrew} out=${JSON.stringify(normalized)} — make normalizeContentFromAPI in src/engine/messages/apiView.ts drop null blocks before reading them`,
  )
}

console.log('')
if (failures > 0) {
  console.log(`prove-answer-seam: ${failures} check(s) FAILED`)
  process.exit(1)
}
console.log('prove-answer-seam: all checks passed')
