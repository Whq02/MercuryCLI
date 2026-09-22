#!/usr/bin/env bun
import { mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const HOME = realpathSync(mkdtempSync(join(tmpdir(), 'config-field-shape-home-')))
process.env.MERCURY_CONFIG_DIR = HOME
process.env.MERCURY_CREDENTIAL_STORE = 'file'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ' — ' + detail : ''}`)
  if (!cond) failures++
}
const section = (t: string): void => {
  console.log(`\n${t}`)
}

const file = join(HOME, '.mercury.json')
const seeded = JSON.stringify({
  hasCompletedOnboarding: true,
  numStartups: 3,
  theme: { not: 'a theme' },
  customApiKeyResponses: { approved: 5, rejected: ['abc'] },
  claudeAiMcpEverConnected: 7,
  autoCompactEnabled: 'false',
  concourseEnabled: null,
  mcpServers: 'left alone',
})
writeFileSync(file, seeded)

const { enableConfigs, getGlobalConfig, getGlobalConfigFieldDrops, readGlobalConfigAgain } = await import('../../src/utils/config/globalConfig.ts')
const { DEFAULT_THEME_SETTING } = await import('../../src/utils/systemTheme.ts')
enableConfigs()
const cfg = getGlobalConfig() as Record<string, unknown>
const keyResponses = cfg.customApiKeyResponses as Record<string, unknown>

section('§1 a field that fails its declared shape is dropped at the read seam; its siblings and undeclared fields stay')
check('customApiKeyResponses.approved (a number) is dropped', keyResponses.approved === undefined, JSON.stringify(keyResponses))
check('customApiKeyResponses.rejected (a list) beside it is kept', JSON.stringify(keyResponses.rejected) === '["abc"]', JSON.stringify(keyResponses))
check('claudeAiMcpEverConnected (a number) is dropped', cfg.claudeAiMcpEverConnected === undefined, String(cfg.claudeAiMcpEverConnected))
check('autoCompactEnabled holding the text "false" reads as its default, never as the text', cfg.autoCompactEnabled === true, String(cfg.autoCompactEnabled))
check('concourseEnabled holding null is dropped', cfg.concourseEnabled === undefined, String(cfg.concourseEnabled))
check('theme holding an object reads as the default theme', cfg.theme === DEFAULT_THEME_SETTING, String(cfg.theme))
check('well-formed fields read as stored', cfg.numStartups === 3 && cfg.hasCompletedOnboarding === true)
check('a field with no declared shape passes through untouched', cfg.mcpServers === 'left alone', String(cfg.mcpServers))

section('§2 the drops are named once, field by field, with the expected and the found shape')
const drops = getGlobalConfigFieldDrops()
const byField = new Map(drops.map(d => [d.field, d]))
check('exactly the five malformed fields are named', drops.length === 5 && ['customApiKeyResponses.approved', 'claudeAiMcpEverConnected', 'autoCompactEnabled', 'concourseEnabled', 'theme'].every(f => byField.has(f)), JSON.stringify(drops))
check('a nested drop names its path and the number it found', byField.get('customApiKeyResponses.approved')?.expected === 'list' && byField.get('customApiKeyResponses.approved')?.found === 'the number 5', JSON.stringify(byField.get('customApiKeyResponses.approved')))
check('the stringly boolean names the text it found', byField.get('autoCompactEnabled')?.expected === 'boolean' && byField.get('autoCompactEnabled')?.found === 'the text "false"', JSON.stringify(byField.get('autoCompactEnabled')))
check('null is named as null', byField.get('concourseEnabled')?.found === 'null', JSON.stringify(byField.get('concourseEnabled')))

section('§3 the readers read a typed value and never throw')
const { isCustomApiKeyApproved } = await import('../../src/utils/auth.ts')
let approvedOutcome = 'returned'
let approved: unknown = null
try {
  approved = isCustomApiKeyApproved('sk-ant-probe-key-0000000000')
} catch (e) {
  approvedOutcome = `threw: ${e instanceof Error ? e.message : String(e)}`
}
check('a malformed customApiKeyResponses.approved is read as "not approved", never a crash', approvedOutcome === 'returned' && approved === false, approvedOutcome)

const { getTheme } = await import('../../src/utils/theme.ts')
let themeOutcome = 'returned'
try {
  getTheme({ not: 'a theme' } as never)
} catch (e) {
  themeOutcome = `threw: ${e instanceof Error ? e.message : String(e)}`
}
check('the theme reader stays tolerant of a malformed value on its own', themeOutcome === 'returned', themeOutcome)

const { hasClaudeAiMcpEverConnected } = await import('../../src/services/mcp/claudeai.ts')
let everOutcome = 'returned'
let ever: unknown = null
try {
  ever = hasClaudeAiMcpEverConnected('some-connector')
} catch (e) {
  everOutcome = `threw: ${e instanceof Error ? e.message : String(e)}`
}
check('a malformed claudeAiMcpEverConnected is read as "never connected", never a crash', everOutcome === 'returned' && ever === false, everOutcome)

section('§4 the file is left as it was')
check('the read never rewrites the file', readFileSync(file, 'utf8') === seeded)

section('§5 the doctor names the ignored fields on one row, and a clean file reads ok')
const report = await import('../../src/utils/healthReport.ts')
const row = async (): Promise<{ status: string; evidence: string; fix?: string } | null> => {
  const cert = await report.runHealthReport({ depth: 'fast' })
  const r = cert.sections.flatMap(s => s.checks).find(c => c.id === 'config-fields')
  return r ? { status: String(r.status), evidence: String(r.evidence), ...(r.fix ? { fix: String(r.fix) } : {}) } : null
}
let warned: Awaited<ReturnType<typeof row>> = null
let rowOutcome = 'returned'
try {
  warned = await row()
} catch (e) {
  rowOutcome = `threw: ${e instanceof Error ? e.message : String(e)}`
}
check('the row exists (config-fields)', warned !== null, rowOutcome)
check(
  'a malformed file warns and names every ignored field with what was found',
  warned?.status === 'warn' && warned.evidence.includes('5 field(s) ignored') && ['customApiKeyResponses.approved', 'claudeAiMcpEverConnected', 'autoCompactEnabled', 'concourseEnabled', 'theme'].every(f => warned!.evidence.includes(f)) && warned.evidence.includes('the text "false"'),
  `${warned?.status}: ${warned?.evidence}`,
)
check('the fix names the file', warned?.fix?.includes(file) === true, String(warned?.fix))

writeFileSync(file, JSON.stringify({ hasCompletedOnboarding: true, numStartups: 4, customApiKeyResponses: { approved: ['abc'], rejected: [] }, claudeAiMcpEverConnected: ['x'], autoCompactEnabled: false }))
readGlobalConfigAgain()
const clean = getGlobalConfig() as Record<string, unknown>
check('a well-formed file re-read drops nothing and reads its stored values', getGlobalConfigFieldDrops().length === 0 && clean.autoCompactEnabled === false && clean.numStartups === 4, JSON.stringify(getGlobalConfigFieldDrops()))
const ok = await row()
check('the row reads ok on a well-formed file', ok?.status === 'ok' && ok.evidence.includes('every stored field has its declared shape'), `${ok?.status}: ${ok?.evidence}`)

if (failures > 0) {
  console.log(`\n${failures} check(s) failed`)
  process.exit(1)
}
console.log('\nall checks passed')
