#!/usr/bin/env bun
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const HOME = realpathSync(mkdtempSync(join(tmpdir(), 'launch-record-text-home-')))
process.env.MERCURY_CONFIG_DIR = HOME
process.env.NODE_ENV = 'test'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

const receipts = await import('../../src/tasks/LocalAgentTask/launchReceipts.ts')
const { backgroundLaunchReceipts, restartStopSummary, stoppedRecordFor } = receipts
type Message = import('../../src/types/message.ts').Message

let failures = 0
let checks = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  checks++
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ' — ' + detail : ''}`)
}
const section = (t: string): void => {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}

const ESC = String.fromCharCode(27)
const BEL = String.fromCharCode(7)
const CR = String.fromCharCode(13)
const dirtyDescription = `tidy the docs${ESC}[31m and paint the row red${ESC}[0m\nsecond line of a description that was written to the launch record${BEL}`
const dirtyPrompt = `first line of the brief${ESC}]0;retitle the terminal${BEL}\nsecond line of the brief${CR}\nthird line\n${'x'.repeat(30_000)}`
const controlByte = (s: string): boolean => {
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i)
    if (code === 9 || code === 10) continue
    if (code < 32 || code === 127 || (code >= 128 && code <= 159)) return true
  }
  return false
}

section('§1 the restart summary reads a recorded description as one clean bounded line')
const notice = restartStopSummary(dirtyDescription, 'crash')
check('no terminal escape sequence or control byte reaches the notice', !notice.includes(ESC) && !controlByte(notice), JSON.stringify(notice.slice(0, 90)))
check('no line break sits inside the quoted description', !/"[^"]*\n[^"]*"/.test(notice))
const long = restartStopSummary('x'.repeat(20_000))
check('an oversized description is bounded', long.length < 4_000, `${long.length} chars`)

section('§2 the receipts reader hands every consumer clean text: the description one bounded line, the prompt without controls')
const launchedAt = '2026-06-19T12:00:01.000Z'
const messages = [
  {
    type: 'assistant',
    uuid: 'u-assistant',
    timestamp: launchedAt,
    message: {
      role: 'assistant',
      content: [{ type: 'tool_use', id: 'toolu_launch_1', name: 'Agent', input: { description: dirtyDescription, prompt: dirtyPrompt, subagent_type: 'mercury-general', run_in_background: true } }],
    },
  },
  {
    type: 'user',
    uuid: 'u-result',
    timestamp: '2026-06-19T12:00:02.000Z',
    message: {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'toolu_launch_1', content: 'Agent launched in the background.\nagentId: a1b2c3d4e\nThe output file is /tmp/a1b2c3d4e.out' }],
    },
  },
] as unknown as Message[]
const found = backgroundLaunchReceipts(messages)
check('the launch is read back as one receipt', found.length === 1, String(found.length))
const receipt = found[0]
check('the receipt description carries no escape sequence or control byte', receipt !== undefined && !controlByte(receipt.description), JSON.stringify(receipt?.description.slice(0, 80)))
check('the receipt description is one line', receipt !== undefined && !receipt.description.includes('\n'), JSON.stringify(receipt?.description.slice(0, 80)))
check('the receipt description keeps its words', receipt !== undefined && receipt.description.startsWith('tidy the docs and paint the row red'), JSON.stringify(receipt?.description.slice(0, 80)))
check('the receipt prompt carries no escape sequence or control byte', receipt !== undefined && !controlByte(receipt.prompt), JSON.stringify(receipt?.prompt.slice(0, 60)))
check('the receipt prompt keeps its line breaks (a brief has lines)', receipt !== undefined && receipt.prompt.includes('first line of the brief\nsecond line of the brief\nthird line'), JSON.stringify(receipt?.prompt.slice(0, 80)))
check('the receipt prompt is bounded', receipt !== undefined && receipt.prompt.length <= 20_100, String(receipt?.prompt.length))
const stopped = receipt === undefined ? undefined : stoppedRecordFor(receipt, Date.parse(launchedAt) + 1_000)
check('the settled record the task list paints carries the clean bounded description', stopped !== undefined && !controlByte(stopped.description) && !stopped.description.includes('\n') && stopped.description.length <= 300, String(stopped?.description.length))

section('§3 an oversized recorded description is bounded at the reader too')
const bigMessages = JSON.parse(JSON.stringify(messages).replace(JSON.stringify(dirtyDescription).slice(1, -1), 'y'.repeat(20_000))) as Message[]
const big = backgroundLaunchReceipts(bigMessages)[0]
check('a 20,000-character recorded description reaches the receipt bounded', big !== undefined && big.description.length < 400, String(big?.description.length))

rmSync(HOME, { recursive: true, force: true })
console.log(`\n${checks - failures}/${checks} checks passed`)
if (failures > 0) {
  console.log(`${failures} check(s) failed`)
  process.exit(1)
}
console.log('all checks passed')
