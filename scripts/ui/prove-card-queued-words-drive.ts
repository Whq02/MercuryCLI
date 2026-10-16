#!/usr/bin/env bun
// gate-watch: src/components/permissions/CardQueuedWords* src/utils/cockpit/composerSeed* src/screens/Chat*
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { grabScreens, requireDist, runArtifactArena, sendStamp } from '../streaming/artifactArena.ts'

requireDist()

const CAPTURE_DIR = process.env.MERCURY_CARD_QUEUED_WORDS_CAPTURE_DIR ?? null
if (CAPTURE_DIR) mkdirSync(CAPTURE_DIR, { recursive: true })

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail.slice(0, 400)}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t)
}

const NEEDLE = 'Do you want to proceed'
const MARKER = 'card-a.txt'
const WORDS = 'when done tell me the count'
const TRIMMED = WORDS.slice(0, -1)
const HINT = '↵ is off while words wait — 1 approves · 3 declines · ⌫ edits'
const YIELD_CUE = 'Waiting for permission…'
const CLOSING = 'The marker is in place.'
const ANSWER = 'Two files, as counted.'
const BACKSPACE = '\\x7f'

const flat = (rows: string[]): string => rows.map(r => r.replace(/\s+$/, '')).join('\n')
const rowsWith = (rows: string[], needle: string): string => rows.filter(r => r.includes(needle)).map(r => r.trim()).join(' | ') || `(no row carries "${needle}")`
function dump(label: string, rows: string[]): void {
  if (!CAPTURE_DIR) return
  writeFileSync(join(CAPTURE_DIR, `${label}.txt`), flat(rows) + '\n')
}
function lastUserText(body: unknown): string {
  const messages = (body as { messages?: Array<{ role?: string; content?: unknown }> } | null)?.messages ?? []
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!
    if (m.role !== 'user') continue
    if (typeof m.content === 'string') return m.content
    if (Array.isArray(m.content)) {
      return (m.content as Array<{ type?: string; text?: string }>)
        .filter(b => b.type === 'text' && typeof b.text === 'string')
        .map(b => b.text as string)
        .join('\n')
    }
    return ''
  }
  return ''
}

section('§1 words typed while a Bash card waits stay on the screen under the card, backspace edits them, and they send once after the turn')
const run = await runArtifactArena({
  cols: 120,
  rows: 50,
  turns: () => [
    { kind: 'tool_use', preText: 'Touching the file.\n', name: 'Bash', input: { command: `touch ${MARKER}`, description: 'Create an empty marker file' } },
    { kind: 'text', text: CLOSING },
    { kind: 'text', text: ANSWER },
  ],
  sends: [
    'after:Type a prompt:300:hello',
    'after:hello:400:\\r',
    `after:${NEEDLE}:1500:${WORDS}`,
    `after:${NEEDLE}:5500:${BACKSPACE}`,
    `after:${NEEDLE}:9500:1`,
    `after:${CLOSING}:800:\\r`,
  ],
  anchor: { needle: NEEDLE, atMs: 8000 },
  seconds: 30,
  keep: true,
})
try {
  const byText = (text: string) => run.sendLog.find(s => Buffer.from(s.b64, 'base64').toString('latin1') === text)
  const typed = byText(WORDS)
  const erased = byText('\x7f')
  const approved = byText('1')
  const sent = run.sendLog.filter(s => Buffer.from(s.b64, 'base64').toString('latin1') === '\r')
  const resend = sent.find(s => s.after === CLOSING)
  check('the card painted its question and every witnessed send was delivered (type · backspace · approve · send)', typed !== undefined && erased !== undefined && approved !== undefined && resend !== undefined, run.driverOut.slice(-400))
  if (typed !== undefined && erased !== undefined && approved !== undefined && resend !== undefined) {
    const t = sendStamp(run, typed)
    const e = sendStamp(run, erased)
    const a = sendStamp(run, approved)
    const [yielded, rested, edited, settled, final] = grabScreens(run, 120, 50, [t + 500, t + 3200, e + 3200, a + 2500, -1])

    dump('typing-yielded', yielded!.rows)
    const yieldedText = flat(yielded!.rows)
    check('while the hand moves the composer shows the words and says the card is waiting', yieldedText.includes(WORDS) && yieldedText.includes(YIELD_CUE), rowsWith(yielded!.rows, '❯'))

    dump('card-back-words-under-it', rested!.rows)
    const restedText = flat(rested!.rows)
    check('once the hand rests the card is back on the frame', restedText.includes(NEEDLE), rowsWith(rested!.rows, 'Bash'))
    check('the typed words are on the same frame as the card (they never vanish)', restedText.includes(WORDS), rowsWith(rested!.rows, '❯'))
    check('the row under the card says ↵ is off while the words wait, which digits answer, and that backspace edits them', restedText.includes(HINT), rowsWith(rested!.rows, 'words wait'))

    dump('after-backspace', edited!.rows)
    const editedText = flat(edited!.rows)
    check('backspace on the card trims the queued words by one character', editedText.includes(TRIMMED) && !editedText.includes(WORDS), rowsWith(edited!.rows, '❯'))
    check('the card still waits after the edit', editedText.includes(NEEDLE), rowsWith(edited!.rows, 'Bash'))

    dump('turn-settled', settled!.rows)
    const settledText = flat(settled!.rows)
    check('after the approval the turn settles (the closing text landed)', settledText.includes(CLOSING), rowsWith(settled!.rows, 'marker'))
    check('the edited words sit in the composer, unsent, when the turn ends', settledText.includes(TRIMMED) && !settledText.includes(WORDS) && !settledText.includes(NEEDLE), rowsWith(settled!.rows, '❯'))

    dump('final', final!.rows)
    const finalText = flat(final!.rows)
    check('↵ after the turn sends the words once and the model answers them', finalText.includes(ANSWER), rowsWith(final!.rows, 'counted'))
    const userRows = final!.rows.filter(r => r.includes(TRIMMED) && !r.includes('words wait')).length
    check('the words appear once as the user\'s own row (not twice, not as a queued mid-turn row)', userRows === 1, rowsWith(final!.rows, TRIMMED))
    const messageRequests = run.fixture.requests.filter(r => r.path.includes('/messages'))
    const last = messageRequests.at(-1)
    check('the wire carries the edited words as the user\'s next instruction, once, after the turn', last !== undefined && lastUserText(last.body) === TRIMMED, last ? lastUserText(last.body).slice(0, 200) : '(no request)')
    const midTurn = messageRequests.filter(r => lastUserText(r.body).includes(TRIMMED)).length
    check('no request before the final one carried the words (they waited for the turn)', midTurn === 1, `${midTurn} request(s) carried them`)
  }
  check('the approved command ran (the marker exists) — the queued words never blocked the answer', existsSync(join(run.paths.cwd, MARKER)))
} finally {
  run.cleanup()
}

console.log(`\n${failures === 0 ? '✅ card-queued-words PROVEN' : `❌ ${failures} FAILURE(S)`}`)
process.exit(failures === 0 ? 0 : 1)
