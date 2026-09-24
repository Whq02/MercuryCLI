#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { checker } from '../engine-durability/harness.ts'
import { codeOnlyText } from '../lib/codeText.ts'

for (const knob of ['GOOGLE_API_KEY', 'GEMINI_API_KEY', 'MERCURY_GEMINI_OAUTH_CLIENT_ID', 'MERCURY_GEMINI_OAUTH_CLIENT_SECRET']) delete process.env[knob]
process.env['MERCURY_CONFIG_DIR'] = realpathSync(mkdtempSync(join(existsSync('/private/tmp/mw') ? '/private/tmp/mw' : tmpdir(), 'logins-key-lines-')))
process.env['MERCURY_CREDENTIAL_STORE'] = 'file'
process.env['FORCE_COLOR'] = '0'

const t = checker()
const REPO = join(import.meta.dir, '..', '..')
const read = (rel: string): string => readFileSync(join(REPO, rel), 'utf8')
const code = (rel: string): string => codeOnlyText(rel, read(rel))
const arg = (name: string): string | undefined => {
  const at = process.argv.indexOf(name)
  return at < 0 ? undefined : process.argv[at + 1]
}
const count = (text: string, needle: string): number => text.split(needle).length - 1

const PAGES = {
  openai: 'platform.openai.com/api-keys',
  openrouter: 'openrouter.ai/settings/keys',
  gemini: 'aistudio.google.com/apikey',
  huggingface: 'huggingface.co/settings/tokens',
  moonshot: 'platform.kimi.ai',
  zai: 'z.ai/manage-apikey',
  deepseek: 'platform.deepseek.com',
} as const
type Family = keyof typeof PAGES
const FAMILIES = Object.keys(PAGES) as Family[]
const menuWord = (family: Family): string => (family === 'huggingface' ? 'Access Tokens' : 'API Keys')
const expectedLine = (family: Family): string =>
  `${family === 'huggingface' ? 'Token' : 'API key'}: ${PAGES[family]} — sign in, ${menuWord(family)}, create, paste it here.`
const LINE_SHAPE = /^(API key|Token): \S+ — sign in, (API Keys|Access Tokens), create, paste it here\.$/

const OWNER = 'src/components/loginFamilyRows.ts'
const FACE = 'src/components/BootLoginsScreen.tsx'
const GUIDE = 'src/components/geminiConnectGuide.ts'
const PANE: Record<Family, string> = {
  openai: 'src/components/ConsoleOAuthFlow.tsx',
  openrouter: 'src/components/RouterOpenrouterConnect.tsx',
  gemini: 'src/components/GeminiConnect.tsx',
  huggingface: 'src/components/HuggingfaceConnect.tsx',
  moonshot: 'src/components/KimiConnect.tsx',
  zai: 'src/components/ZaiConnect.tsx',
  deepseek: 'src/components/DeepseekConnect.tsx',
}
const ROAD: Partial<Record<Family, string[]>> = {
  deepseek: ['src/services/providers/deepseek/deepseekLogin.ts', 'src/services/providers/deepseek/deepseekCallModel.ts'],
  moonshot: ['src/services/providers/moonshot/moonshotLogin.ts'],
  huggingface: ['src/services/providers/huggingface/huggingfaceLogin.ts'],
  zai: ['src/services/providers/zai/zaiCallModel.ts'],
}

const { enableConfigs } = await import('../../src/utils/config/globalConfig.js')
enableConfigs()
const owner = (await import('../../src/components/loginFamilyRows.js')) as unknown as Record<string, unknown>
const screen = await import('../../src/components/BootLoginsScreen.js')
const guide = await import('../../src/components/geminiConnectGuide.js')
const { composeLogins, renderStill, signedOutFacts } = await import('./face-logins-stills.ts')

const DETAIL_W = 38
const WAY_OUT: Record<'pick' | 'key', string> = { pick: 'esc — back to the roster', key: '↵ stores it · esc back' }
const cardKind = (family: Family): 'pick' | 'key' => (family === 'deepseek' ? 'key' : 'pick')
const cardLines = (family: Family): string[] =>
  family === 'deepseek' ? screen.keyPromptPaneLines('deepseek', null, 0, false) : screen.loginsPickPaneLines(family)
const cardFlow = (family: Family) =>
  family === 'deepseek'
    ? { kind: 'key' as const, leg: 'deepseek' as const, note: null, draftLen: 0, storing: false }
    : { kind: 'pick' as const, pick: family, pickSel: 0 }

t.section('§1 — ONE OWNER: the family-row owner spells every key page once; the guide and the line derive from it')
{
  const pages = owner['KEY_PAGES'] as Record<string, string> | undefined
  t.check(
    'KEY_PAGES names exactly the seven key families with these page spellings',
    pages !== undefined && JSON.stringify(Object.entries(pages).sort()) === JSON.stringify(Object.entries(PAGES).sort()),
    pages === undefined ? 'no KEY_PAGES export' : JSON.stringify(pages),
  )
  const rows = (owner['loginFamilyRows'] as (o: { engineLegs: boolean }) => Array<{ value: string }>)({ engineLegs: true })
  const keyRows = rows.map(r => r.value).filter(v => v !== 'claudeai' && v !== 'console').sort()
  const families = owner['KEY_FAMILIES'] as string[] | undefined
  t.check(
    'KEY_FAMILIES is the catalogue minus the two Anthropic rows (no key family invented, none forgotten)',
    families !== undefined && JSON.stringify([...families].sort()) === JSON.stringify(keyRows),
    families === undefined ? 'no KEY_FAMILIES export' : families.join(','),
  )
  const line = owner['keyPageLine'] as ((f: string) => string) | undefined
  const drift = FAMILIES.filter(f => line === undefined || line(f) !== expectedLine(f))
  t.check('keyPageLine spells the one plain line — the page, then sign in · the menu word · create · paste', drift.length === 0, drift.join(','))
  t.check('every expected line has the ruled shape', FAMILIES.every(f => LINE_SHAPE.test(expectedLine(f))))
  t.check(
    "the Gemini guide's key page IS the owner's page (scheme added, nothing respelled)",
    guide.GEMINI_API_KEY_PAGE.address === `https://${PAGES.gemini}` && code(GUIDE).includes('KEY_PAGES.gemini') && !code(GUIDE).includes(PAGES.gemini),
    guide.GEMINI_API_KEY_PAGE.address,
  )
}

t.section("§2 — THE CARDS: each key family's card carries exactly one key line, the page hides in no other sentence")
{
  for (const family of FAMILIES) {
    const lines = cardLines(family)
    const joined = lines.join(' ')
    const line = expectedLine(family)
    const rest = joined.replace(line, '')
    t.check(`${family}: the card carries the key line exactly once`, count(joined, line) === 1, JSON.stringify(lines))
    t.check(
      `${family}: the page appears nowhere else on the card — never inside a parenthesis or another sentence`,
      !rest.includes(PAGES[family]) && !joined.includes(`(${PAGES[family]}`),
      JSON.stringify(lines),
    )
    t.check(`${family}: the card keeps its way out last and every line inside ${DETAIL_W} columns`, lines.at(-1) === WAY_OUT[cardKind(family)] && lines.every(l => l.length <= DETAIL_W))
    const wrapped = lines.filter(l => l !== '' && line.includes(l))
    t.check(`${family}: the wrapped key line never strands a lone word on a row`, wrapped.length > 0 && wrapped.every(l => l.includes(' ')), wrapped.join(' | '))
    if (family !== 'deepseek') {
      const labels = screen.loginsPickOptions(family).map(o => o.label)
      t.check(`${family}: no choice row hides the page inside its label`, labels.every(l => !l.includes(PAGES[family])), labels.join(' | '))
    }
  }
  const glm = screen.loginsPickPaneLines('zai').join(' ')
  t.check('GLM keeps its Coding-Plan/base sentence beside the key line', glm.includes('Which key is this?') && glm.includes('the answer picks the base'))
  t.check('the kimi-region question is a host choice, not a credential — it carries no key line', !screen.loginsPickPaneLines('kimi-region').join(' ').includes('API key:'))
  t.check("a DeepSeek prompt wearing a correction gives the key line's rows to the note (the pane stays compact)", !screen.keyPromptPaneLines('deepseek', 'the driver said no', 4, false).join(' ').includes(PAGES.deepseek))
  const facts = signedOutFacts()
  const arms = screen.loginsSortedArms(facts)
  for (const family of FAMILIES) {
    const placed = composeLogins(120, 40, { facts, sel: Math.max(0, arms.findIndex(a => a.row.value === family)), flow: cardFlow(family) }).join('\n')
    t.check(`${family}: at the 120x40 tier the card fits its panel whole (way out painted, no clamp)`, placed.includes(WAY_OUT[cardKind(family)]) && !placed.includes('the trail continues'))
  }
}

t.section('§3 — THE PANES AGREE: every in-chat pane reuses the one line; no file respells a page; the road spells the same')
{
  for (const family of FAMILIES) {
    const pane = code(PANE[family])
    if (family === 'gemini') {
      t.check("gemini: the in-chat pane paints the guide's key-leg lines and spells no page of its own", pane.includes('geminiKeyLegLines(') && !pane.includes(PAGES.gemini))
    } else {
      t.check(`${family}: the in-chat pane renders keyPageLine('${family}') and spells no page of its own`, pane.includes(`keyPageLine('${family}')`) && !pane.includes(PAGES[family]))
    }
    for (const road of ROAD[family] ?? []) {
      t.check(`${family}: the road's own receipt (${road.split('/').at(-1)}) spells the owner's page`, code(road).includes(PAGES[family]))
    }
  }
  const face = code(FACE)
  const respelled = FAMILIES.filter(f => face.includes(PAGES[f]))
  t.check('the face module spells no key page itself (every card line comes from the owner)', respelled.length === 0, respelled.join(','))
  t.check('the face composes the cards through keyPageLine', face.includes('keyPageLine(pick)') && face.includes("keyPageLine('deepseek')"))
  const ownerCode = code(OWNER)
  t.check('the owner spells each page exactly once', FAMILIES.every(f => count(ownerCode, `'${PAGES[f]}'`) === 1))
}

const COLS = 178
const ROWS = 51
t.section(`§4 — THE FRAMES at ${COLS}x${ROWS}: the title frame and one card frame per key family (--frames <dir> writes them)`)
{
  const facts = signedOutFacts()
  const arms = screen.loginsSortedArms(facts)
  const frames: Array<{ id: string; family: Family | null; lines: string[] }> = [
    { id: `logins-${COLS}x${ROWS}-title`, family: null, lines: composeLogins(COLS, ROWS, { facts, sel: 0 }) },
  ]
  for (const family of FAMILIES) {
    frames.push({
      id: `logins-${COLS}x${ROWS}-card-${family}`,
      family,
      lines: composeLogins(COLS, ROWS, { facts, sel: Math.max(0, arms.findIndex(a => a.row.value === family)), flow: cardFlow(family) }),
    })
  }
  const dir = arg('--frames')
  if (dir !== undefined) mkdirSync(dir, { recursive: true })
  for (const frame of frames) {
    const text = renderStill(frame.lines)
    if (dir !== undefined) writeFileSync(join(dir, `${frame.id}.txt`), text)
    t.check(`${frame.id}: fits ${COLS}x${ROWS}`, frame.lines.length <= ROWS && frame.lines.every(l => l.length <= COLS), `rows=${frame.lines.length} widest=${Math.max(...frame.lines.map(l => l.length))}`)
    if (frame.family === null) t.check(`${frame.id}: the face's title reads logins`, text.includes('⌁ logins'))
    else t.check(`${frame.id}: the card paints its key page (${PAGES[frame.family]})`, text.includes(PAGES[frame.family]))
  }
  if (dir !== undefined) console.log(`  frames written to ${dir}`)
}

t.finish('prove-logins-key-lines')
