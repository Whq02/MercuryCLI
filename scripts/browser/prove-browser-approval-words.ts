#!/usr/bin/env bun
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'browser-approval-words-'))
process.env.MERCURY_BROWSER_CACHE_DIR = mkdtempSync(join(tmpdir(), 'browser-approval-cache-'))
process.env.MERCURY_BROWSER ??= '1'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const ROOT = join(import.meta.dir, '..', '..')

let failures = 0
let checks = 0
function check(label: string, ok: boolean, detail = ''): void {
  checks++
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail.slice(0, 500)}` : ''}`)
}

const { BrowserTool } = await import(join(ROOT, 'src/tools/BrowserTool/BrowserTool.ts'))
const { call: browserCommand } = await import(join(ROOT, 'src/commands/browser/browserCommand.ts'))
const { detectInstalledBrowsers } = await import(join(ROOT, 'src/services/browser/browserResolver.ts'))
type Words = {
  APPROVAL_RULE_LINE: string
  INSTALLED_NOT_DRIVEN: string
  approvalScopeWords: (origin: string) => string[]
  crossingScopeWords: (origin: string) => string[]
}
const words: Words = await import(join(ROOT, 'src/services/browser/browserWords.ts')).catch(() => ({
  APPROVAL_RULE_LINE: '(no shared approval words in this tree)',
  INSTALLED_NOT_DRIVEN: '(no shared installed words in this tree)',
  approvalScopeWords: () => [],
  crossingScopeWords: () => [],
}))
const { APPROVAL_RULE_LINE, INSTALLED_NOT_DRIVEN, approvalScopeWords, crossingScopeWords } = words

console.log('§1 what an approval covers, in one sentence shared by /browser and the tool')
{
  check('the rule says an approved origin is driven for the session', /an origin you approve is driven for the session/.test(APPROVAL_RULE_LINE), APPROVAL_RULE_LINE)
  check('the rule says linked pages are read without asking and the first act asks', /pages it links or redirects to are read without asking and the first act on one asks/.test(APPROVAL_RULE_LINE), APPROVAL_RULE_LINE)
  check('the rule says a new origin opened by address asks by name', /a new origin opened by address asks by name/.test(APPROVAL_RULE_LINE), APPROVAL_RULE_LINE)
  const slash = await browserCommand('status', {} as never)
  const slashText = slash.type === 'text' ? slash.value : ''
  check('/browser carries the approval rule', slashText.includes(APPROVAL_RULE_LINE), slashText)
  const status = await BrowserTool.call({ op: 'status' } as never, {} as never)
  check("the tool's status carries the approval rule", status.data.result.includes(APPROVAL_RULE_LINE), status.data.result)
  const installed = detectInstalledBrowsers()
  if (installed.length > 0) {
    check("the tool's status says an installed browser is not driven (as /browser already did)", status.data.result.includes(`installed: ${installed[0]!.label}`) && status.data.result.includes(INSTALLED_NOT_DRIVEN), status.data.result)
    check('/browser says the same', slashText.includes(INSTALLED_NOT_DRIVEN), slashText)
  } else {
    console.log('  – no installed browser on this box: the "not driven" line has no row to carry it here')
  }
}

console.log('§2 the card words for a first visit and for a crossing')
{
  const first = approvalScopeWords('http://127.0.0.1:8765')
  check('the first-visit words name the origin and the session', first.some(l => l.includes('http://127.0.0.1:8765 for this session')), first.join(' | '))
  check('…say linked pages are read without asking and the first act asks', first.some(l => /links or redirects to are read .* without asking; the first act on one asks/.test(l)), first.join(' | '))
  check('…say a new origin opened by address is asked', first.some(l => /new origin opened by address is asked/.test(l)), first.join(' | '))
  const crossing = crossingScopeWords('http://localhost:8765')
  check('the crossing words say the page was already read and this is the first act there', crossing.some(l => /already read this page/.test(l) && l.includes('http://localhost:8765')), crossing.join(' | '))
}

console.log('§3 the tool tells the model which browser it drives and what reads cover')
{
  const description = await BrowserTool.description({} as never)
  check('the description no longer claims installed browsers are driven', !description.includes('installed or managed-cache'), description)
  check('the description names Chrome for Testing and says installed browsers are never driven', description.includes('Chrome for Testing') && description.includes('installed browsers are never driven'), description)
  const prompt = await BrowserTool.prompt({} as never)
  check('the status line of the prompt no longer ranks installed browsers as drivable', !prompt.includes('operator pin > installed browser'), prompt.match(/op:"status"[^\n]*/)?.[0] ?? '')
  check('the prompt says reads never ask on a crossed-to origin either, and what to do about it', /on a crossed-to origin too/.test(prompt) && /name the origin when you report them/.test(prompt), prompt.match(/Reads \([^\n]*/)?.[0] ?? '')
}

console.log(`\n${checks} checks, ${failures} failures`)
if (failures > 0) {
  console.error(`browser approval words: ${failures} FAILURES`)
  process.exit(1)
}
console.log('prove-browser-approval-words: ALL LAWS HOLD')
