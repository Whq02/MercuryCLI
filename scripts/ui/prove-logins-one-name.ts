#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { checker } from '../engine-durability/harness.ts'
import { CODE_TEXT_FILE, codeOnlyText } from '../lib/codeText.ts'

process.env['MERCURY_CONFIG_DIR'] = realpathSync(mkdtempSync(join(existsSync('/private/tmp/mw') ? '/private/tmp/mw' : tmpdir(), 'logins-one-name-')))
process.env['MERCURY_CREDENTIAL_STORE'] = 'file'
process.env['FORCE_COLOR'] = '0'

const t = checker()
const REPO = join(import.meta.dir, '..', '..')
const read = (rel: string): string => readFileSync(join(REPO, rel), 'utf8')
const code = (rel: string): string => codeOnlyText(rel, read(rel))

const IDENTIFIERS = [
  "import('./login.js')",
  "from './commands/login/index.js'",
  "'src/commands/login/index.ts'",
  "aliases: ['login']",
  "mode = 'login'",
  "mode?: 'login' | 'setup-token'",
  ".command('login')",
  "item('login', 'Login'",
  'MERCURY_LOGIN_COMMAND',
]

const STRAY: Array<{ name: string; re: RegExp }> = [
  { name: '/login — the command spelled without its s', re: /\/login(?=$|[^A-Za-z0-9_-])/ },
  { name: '— login — a title or lockup word', re: /— login(?=$|[^A-Za-z0-9_-])/ },
  { name: 'view="login" — a CommandCenter view word', re: /view=\{?["'`]login["'`]/ },
  { name: 'the surface named as a noun', re: /\bLogin closed\b|\bcloses login\b|\blogin (card|command|screen|surface|door|face)\b/ },
]

const PROSE_FILE = /\.(md|txt)$/

function walk(rel: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(join(REPO, rel), { withFileTypes: true })) {
    const child = join(rel, entry.name)
    if (entry.isDirectory()) out.push(...walk(child))
    else if (CODE_TEXT_FILE.test(entry.name) || PROSE_FILE.test(entry.name)) out.push(child)
  }
  return out
}

t.section('§1 — THE CENSUS over src/: the sign-in surface is spelled /logins; identifiers allow-listed by name')
{
  const files = walk('src')
  const raws = new Map(files.map(rel => [rel, read(rel)]))
  const strays: string[] = []
  for (const [rel, raw] of raws) {
    let text = CODE_TEXT_FILE.test(rel) ? codeOnlyText(rel, raw) : raw
    for (const id of IDENTIFIERS) text = text.split(id).join(' ')
    text.split('\n').forEach((line, i) => {
      for (const stray of STRAY) {
        if (stray.re.test(line)) strays.push(`${rel}:${i + 1} [${stray.name}] ${line.trim().slice(0, 110)}`)
      }
    })
  }
  t.check(`the census walked the tree (${files.length} files)`, files.length > 500 && raws.has('src/commands/login/login.tsx') && files.some(f => f.endsWith('SKILL.md')))
  t.check('no user-visible word names the sign-in surface by a second name', strays.length === 0, strays.length === 0 ? '' : `${strays.length} stray spelling(s)`)
  for (const stray of strays) console.log(`    stray: ${stray}`)
  const listed = IDENTIFIERS.filter(id => ![...raws.values()].some(raw => raw.includes(id)))
  t.check('every allow-listed identifier still exists by that name (a stale entry would hide a future stray)', listed.length === 0, listed.join(' | '))
}

t.section('§2 — THE ONE NAME stands where the second name stood')
{
  const login = code('src/commands/login/login.tsx')
  t.check("the card's title word is logins (the lockup reads Mercury — logins)", login.includes('view="logins"') && read('src/components/mercury-ui/components.tsx').includes('const title = `Mercury${separator}${view}`'))
  t.check('the footer and the close receipt say /logins', login.includes('esc closes /logins') && login.includes("'/logins closed — no credential changed'"))
  const row = read('src/substrate/flagRegistry.ts').split('\n').find(l => l.includes("env: 'MERCURY_LOGIN_COMMAND'")) ?? ''
  t.check('the flag keeps its env name and its words say /logins', row.includes("summary: 'the /logins command; =0 removes it'") && row.includes("off: '=0 no /logins'"), row.slice(0, 160))
  t.check('the bundled skill and its source say /logins', read('src/skills/bundled/provider-apis/SKILL.md').includes('Use `/logins` and `/accounts`') && read('mercury-skills/provider-apis/SKILL.md').includes('Use `/logins` and `/accounts`'))
  t.check("the face's own title is logins", read('src/components/BootLoginsScreen.tsx').includes("title: 'logins'") && read('src/components/BootLoginsScreen.tsx').includes("summaryTitle: 'LOGINS'"))
}

t.section('§3 — THE SILENT ALIAS: login stays because a saved keybinding can name it; it paints nowhere')
{
  const index = code('src/commands/login/index.ts')
  t.check('the command is /logins with the alias login', index.includes("name: 'logins'") && index.includes("aliases: ['login']"))
  t.check('a saved keybinding may name any command (the schema grammar)', read('src/keybindings/validate.ts').includes('const COMMAND_BINDING_RE = /^command:[a-zA-Z0-9:\\-_]+$/'))
  t.check('a command:* chord resolves through findCommand and is INERT for an unregistered name', read('src/hooks/useCommandKeybindings.tsx').includes('if (findCommand(name, commandsRef.current) === undefined) return'))
  t.check('the extension layer writes command:<target> from a manifest target', read('src/extensions/load/keybindings.ts').includes("`command:${binding.target.replace(/^\\//, '')}`"))
  const { enableConfigs } = await import('../../src/utils/config/globalConfig.js')
  enableConfigs()
  const { findCommand } = await import('../../src/commands.js')
  const { generateCommandSuggestions } = await import('../../src/utils/suggestions/commandSuggestions.js')
  const fake = (over: Record<string, unknown>): never =>
    ({ type: 'local-jsx', name: 'logins', description: 'Sign in', load: async () => ({}), ...over }) as never
  t.check(
    'findCommand resolves login through the alias alone — without it a saved command:login chord goes dead',
    findCommand('login', [fake({ aliases: ['login'] })]) !== undefined && findCommand('login', [fake({})]) === undefined && findCommand('logins', [fake({})]) !== undefined,
  )
  const table = [fake({ aliases: ['login'] }), fake({ name: 'health', aliases: ['doctor'], description: 'Health' })]
  const rowsFor = (input: string): string[] => generateCommandSuggestions(input, table).map(s => s.displayText)
  const prefixes = ['/lo', '/log', '/logi', '/login']
  t.check(
    'typing any prefix of the alias paints /logins alone — the alias is silent in the typeahead',
    prefixes.every(q => rowsFor(q).includes('/logins') && !rowsFor(q).some(r => r.includes('(login)'))),
    prefixes.map(q => `${q} → ${rowsFor(q).join(' | ')}`).join(' ; '),
  )
  t.check('/login typed whole still ranks /logins first (the alias resolves)', rowsFor('/login')[0] === '/logins', rowsFor('/login').join(' | '))
  t.check('an alias the name does not begin with still paints its parenthetical (the general rule kept)', rowsFor('/doc').includes('/health (doctor)'), rowsFor('/doc').join(' | '))
  t.check('help lists no aliases (the typeahead was the one listing)', !read('src/commands/help/help.tsx').includes('aliases'))
}

t.finish('prove-logins-one-name')
