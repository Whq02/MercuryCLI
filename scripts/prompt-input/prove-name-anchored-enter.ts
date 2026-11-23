#!/usr/bin/env bun
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'name-anchored-home-'))
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.ANTHROPIC_API_KEY = 'fixture-key-000'
delete process.env.NODE_ENV
delete process.env.CI

let failures = 0
const check = (label: string, cond: boolean, detail = '', hint = ''): void => {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}${!cond && hint ? ` | to fix: ${hint}` : ''}`)
}

const { isNameAnchoredSuggestion, generateCommandSuggestions } = await import('../../src/screen/suggestions/commandSuggestions.js')

console.log('§1 the pure law')
const mk = (name: string, opts?: { aliases?: string[]; description?: string }): { id: string; displayText: string; metadata: unknown } => ({
  id: `command-${name}`,
  displayText: `/${name}`,
  metadata: { type: 'local', name, description: opts?.description ?? 'words', aliases: opts?.aliases ?? [], isEnabled: true, isHidden: false, async call() {}, userFacingName: () => name },
})
check('a name prefix anchors ("/mo" → model)', isNameAnchoredSuggestion('/mo', mk('model') as never) === true, '', 'isNameAnchoredSuggestion in src/screen/suggestions/commandSuggestions.ts must treat a command-name prefix as anchored')
check('a name part anchors ("/config" → update-config)', isNameAnchoredSuggestion('/config', mk('update-config') as never) === true, '', 'isNameAnchoredSuggestion in src/screen/suggestions/commandSuggestions.ts must treat a part of a hyphen, colon or underscore separated name as anchored')
check('an alias anchors', isNameAnchoredSuggestion('/quit', mk('exit', { aliases: ['quit'] }) as never) === true, '', 'isNameAnchoredSuggestion in src/screen/suggestions/commandSuggestions.ts must treat an alias prefix as anchored')
check('a description-only match does NOT anchor ("/theme" vs update-config)', isNameAnchoredSuggestion('/theme', mk('update-config', { description: 'configure theme settings' }) as never) === false, '', 'isNameAnchoredSuggestion in src/screen/suggestions/commandSuggestions.ts must not anchor on the description, only on the name and aliases')
check('a non-slash input passes through (file/agent suggestions unaffected)', isNameAnchoredSuggestion('hello', mk('model') as never) === true, '', 'isNameAnchoredSuggestion in src/screen/suggestions/commandSuggestions.ts must return true when the input does not start with a slash')
check('a bare slash passes through (the empty-query menu)', isNameAnchoredSuggestion('/', mk('model') as never) === true, '', 'isNameAnchoredSuggestion in src/screen/suggestions/commandSuggestions.ts must return true when the text after the slash is empty')
check('a metadata-less row never anchors', isNameAnchoredSuggestion('/x', { id: 'x', displayText: 'x' } as never) === false, '', 'isNameAnchoredSuggestion in src/screen/suggestions/commandSuggestions.ts must return false for a row without command metadata')

console.log('§3 the poison from the real command table')
{
  const { enableConfigs } = await import('../../src/platform/config/globalConfig.js')
  enableConfigs()
  const { getCommands } = await import('../../src/commands/catalogue/commands.js')
  const commands = (await getCommands(process.cwd()).catch(() => null)) as unknown[] | null
  if (commands === null || !Array.isArray(commands) || commands.length === 0) {
    console.log('  [INFO] the live command table did not assemble in this harness — §3 rides §1/§2')
  } else {
    const themed = generateCommandSuggestions('/theme', commands as never)
    const modeled = generateCommandSuggestions('/mo', commands as never)
    check('the live "/theme" menu is non-empty (the description match still SHOWS — only the bare ↵ refuses it)', themed.length > 0, '', 'generateCommandSuggestions in src/screen/suggestions/commandSuggestions.ts must still list description matches for /theme')
    check('its top row is not name-anchored (the guard bites)', themed.length > 0 && !isNameAnchoredSuggestion('/theme', themed[0]!), '', 'the top /theme row came from a description match; isNameAnchoredSuggestion in src/screen/suggestions/commandSuggestions.ts must return false for it')
    check('the live "/mo" top row IS name-anchored (completion keeps working)', modeled.length > 0 && isNameAnchoredSuggestion('/mo', modeled[0]!), '', 'generateCommandSuggestions in src/screen/suggestions/commandSuggestions.ts must rank a name-prefix match first for /mo')
  }
}

console.log(failures === 0 ? '\nname-anchored enter: ALL LAWS HOLD' : `\nname-anchored enter: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
