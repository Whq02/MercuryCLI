import { runInNewContext } from 'node:vm'
import { DOC_SCRIPT } from '../../src/services/samples/docTheme.js'

const start = DOC_SCRIPT.indexOf('function syncDecisionToShell(')
const end = DOC_SCRIPT.indexOf("  all('.part-question')", start)
if (start < 0 || end < 0) throw new Error('the sample decision bridge is not present')
const source = DOC_SCRIPT.slice(start, end)
let failures = 0
let checks = 0
function check(name: string, ok: boolean, detail = ''): void {
  checks++
  if (!ok) failures++
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}${!ok ? ` — ${detail}` : ''}`)
}
const attrs = new Map<string, string>()
const note = {
  value: 'Keep the second paragraph · it explains why',
  getAttribute: (key: string) => attrs.get(key) ?? null,
  setAttribute: (key: string, value: string) => { attrs.set(key, value) },
}
const status = { textContent: '' }
const parentDoc = () => ({ getElementById: (id: string) => id === 'note' ? note : id === 'status' ? status : null })
const bind = (): ((heading: string, choice: string) => boolean) => runInNewContext(`${source}; syncDecisionToShell`, { parentDoc })
let choose = bind()
const ownWords = note.value
check('D1 the first choice stages with the original note intact', choose('Question', 'Option A') && note.value === `Decision (Question): Option A · ${ownWords}`, note.value)
check('D2 changing the choice keeps the original note', choose('Question', 'Option B') && note.value === `Decision (Question): Option B · ${ownWords}`, note.value)
check('D3 the status still teaches the send key', status.textContent === 'decision staged in the note — s sends it')
choose('Route (preferred)', 'Fast · local')
check('D4 punctuation in a question and choice is preserved', note.value === `Decision (Route (preferred)): Fast · local · ${ownWords}`, note.value)
choose = bind()
choose('Route (preferred)', 'Steady · checked')
check('D5 a newly loaded version replaces its decision, preserving the note', note.value === `Decision (Route (preferred)): Steady · checked · ${ownWords}`, note.value)
note.value += ' · Also keep the footnote'
choose('Question', 'Option A')
check('D6 edits made after a choice survive the next choice', note.value === `Decision (Question): Option A · ${ownWords} · Also keep the footnote`, note.value)
note.value = 'My manually rewritten decision is different'
choose('Question', 'Option B')
check('D7 manually rewritten text is never mistaken for the previous staged choice', note.value === 'Decision (Question): Option B · My manually rewritten decision is different', note.value)
note.value = ''
choose('Question', 'Option A')
check('D8 after send clears the note a new choice has no stale suffix', note.value === 'Decision (Question): Option A', note.value)
choose('Question', 'Option B')
check('D9 a choice without other text is replaced exactly', note.value === 'Decision (Question): Option B', note.value)
const standalone = runInNewContext(`${source}; syncDecisionToShell`, { parentDoc: () => null }) as typeof choose
check('D10 a standalone document stays on its clipboard road', standalone('Question', 'Option A') === false)
console.log(`${checks - failures}/${checks} checks passed`)
process.exit(failures ? 1 : 0)
