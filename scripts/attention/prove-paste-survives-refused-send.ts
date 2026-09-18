#!/usr/bin/env bun
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = process.cwd()
let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
const section = (t: string): void => console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))

section('§A the loss mechanism: the submit clears the paste map, and a bare chip ships without it')
{
  const { expandPastedTextRefs } = await import('../../src/history.ts')
  const bytes = 'PASTE-BODY-' + 'z'.repeat(1200)
  const chip = '[Pasted text #1]'
  const map = { 1: { id: 1, type: 'text' as const, content: bytes } }
  check('the first send, map intact, expands the chip to the pasted bytes', expandPastedTextRefs(`kick off ${chip}`, map).includes(bytes))
  const cleared = expandPastedTextRefs(`kick off ${chip}`, {})
  check('a re-send with the CLEARED map ships a bare chip — the paste lost (the deployed build)', cleared.includes(chip) && !cleared.includes(bytes))
  check('a re-send with the RESTORED map carries the bytes again (what the fix makes true)', expandPastedTextRefs(`kick off ${chip}`, map).includes(bytes))
}

section('§B the fix at the true cause: a refused send restores the pastes with the text')
{
  const repl = readFileSync(join(ROOT, 'src/screens/REPL.tsx'), 'utf8')
  const refAt = repl.indexOf("if (receipt.state !== 'refused') return")
  const refBlock = refAt !== -1 ? repl.slice(refAt, refAt + 500) : ''
  check('the refused-send handler exists', refBlock !== '')
  check('it restores the TEXT to the composer', refBlock.includes('setInputValue(input)'))
  check('it restores the PASTES with the text, so the chips resolve on the re-send', refBlock.includes('setPastedContents(seatPastes)'))
  check('both restores sit under the one empty-composer guard', /pendingInput\.text\(\) === ''\)\s*\{[\s\S]*setInputValue\(input\)[\s\S]*setPastedContents\(seatPastes\)[\s\S]*\}/.test(refBlock))
  check('the composer captures the pastes before the submit clears them', repl.includes('const seatPastes = pendingInput.pastedContents()'))
}

console.log(`\n${failures === 0 ? 'prove-paste-survives-refused-send: ALL LAWS HOLD' : `prove-paste-survives-refused-send: ${failures} FAILURE(S)`}`)
process.exit(failures === 0 ? 0 : 1)
