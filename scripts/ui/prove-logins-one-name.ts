#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { existsSync, mkdtempSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { checker } from '../engine-durability/harness.ts'

process.env['MERCURY_CONFIG_DIR'] = realpathSync(mkdtempSync(join(existsSync('/private/tmp/mw') ? '/private/tmp/mw' : tmpdir(), 'logins-one-name-')))
process.env['MERCURY_CREDENTIAL_STORE'] = 'file'
process.env['FORCE_COLOR'] = '0'

const t = checker()


t.section('§2 — THE ONE NAME stands where the second name stood')
{
  const row = (await import('../../src/platform/substrate/flagRegistry.js')).getFlagSpec('MERCURY_LOGIN_COMMAND')
  const shown = row ? `  { ${Object.entries(row).map(([key, value]) => `${key}: ${typeof value === 'string' ? `'${value}'` : JSON.stringify(value)}`).join(', ')} },` : ''
  t.check('the flag keeps its env name and its words say /logins', row?.summary === 'the /logins command; =0 removes it' && row.off === '=0 no /logins', shown.slice(0, 160))
}

t.section('§3 — THE SILENT ALIAS: login stays because a saved keybinding can name it; it paints nowhere')
{
  const { enableConfigs } = await import('../../src/platform/config/globalConfig.js')
  enableConfigs()
  const { findCommand } = await import('../../src/commands/catalogue/commands.js')
  const { generateCommandSuggestions } = await import('../../src/screen/suggestions/commandSuggestions.js')
  const fake = (over: Record<string, unknown>): never =>
    ({ type: 'local-jsx', name: 'logins', description: 'Sign in', load: async () => ({}), ...over }) as never
  t.check(
    'findCommand resolves login through the alias alone — without it a saved command:login chord goes dead',
    findCommand('login', [fake({ aliases: ['login'] })]) !== undefined && findCommand('login', [fake({})]) === undefined && findCommand('logins', [fake({})]) !== undefined,
  )
  const table = [fake({ aliases: ['login'] }), fake({ name: 'health', aliases: ['certify'], description: 'Health' })]
  const rowsFor = (input: string): string[] => generateCommandSuggestions(input, table).map(s => s.displayText)
  const prefixes = ['/lo', '/log', '/logi', '/login']
  t.check(
    'typing any prefix of the alias paints /logins alone — the alias is silent in the typeahead',
    prefixes.every(q => rowsFor(q).includes('/logins') && !rowsFor(q).some(r => r.includes('(login)'))),
    prefixes.map(q => `${q} → ${rowsFor(q).join(' | ')}`).join(' ; '),
  )
  t.check('/login typed whole still ranks /logins first (the alias resolves)', rowsFor('/login')[0] === '/logins', rowsFor('/login').join(' | '))
  t.check('an alias the name does not begin with still paints its parenthetical (the general rule kept)', rowsFor('/cer').includes('/health (certify)'), rowsFor('/cer').join(' | '))
}

t.finish('prove-logins-one-name')
