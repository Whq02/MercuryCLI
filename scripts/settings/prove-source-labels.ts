import { join } from 'node:path'

const root = process.env.PROVE_SRC ?? join(import.meta.dir, '../../src')
const source = await import(join(root, 'utils/settings/constants.ts'))
let failures = 0
function check(name: string, actual: unknown, wanted: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(wanted)
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}`)
  if (!ok) failures++
}
const keys = ['userSettings', 'projectSettings', 'localSettings', 'flagSettings', 'policySettings']
check('stored precedence', source.SETTING_SOURCES, keys)
check('save target order', source.SOURCES, ['localSettings', 'projectSettings', 'userSettings'])
check('plain names', keys.map(source.getSettingSourceName), ['user', 'project', 'project, gitignored', 'cli flag', 'managed'])
check('short labels', [...keys, 'extension', 'built-in'].map(source.getSourceDisplayName), ['User', 'Project', 'Local', 'Flag', 'Managed', 'Extension', 'Built-in'])
const origins = [...keys, 'cliArg', 'command', 'session']
check('sentence labels', origins.map(source.getSettingSourceDisplayNameCapitalized), ['User settings', 'Shared project settings', 'Project local settings', 'Command line arguments', 'Managed settings', 'CLI argument', 'Command configuration', 'Current session'])
check('inline labels', [...origins, 'toolsNarrowing', 'mcpServerPolicy'].map(source.getSettingSourceDisplayNameLowercase), ['user settings', 'shared project settings', 'project local settings', 'command line arguments', 'managed settings', 'CLI argument', 'command configuration', 'current session', 'tools narrowing', 'MCP server policy'])
for (const name of ['getSettingSourceName', 'getSourceDisplayName', 'getSettingSourceDisplayNameLowercase', 'getSettingSourceDisplayNameCapitalized']) {
  check(`${name} does not label unknown sources`, source[name]('nonsense'), undefined)
}
check('capitalized domain stays narrow', ['toolsNarrowing', 'mcpServerPolicy'].map(source.getSettingSourceDisplayNameCapitalized), [undefined, undefined])
check('layer spelling keeps order and repeats', source.parseSettingSourcesFlag(' local, ,user,project,local,'), ['localSettings', 'userSettings', 'projectSettings', 'localSettings'])
check('empty layer spelling', source.parseSettingSourcesFlag(''), [])
try {
  source.parseSettingSourcesFlag('elsewhere')
  check('unknown layer refused', false, true)
} catch (error) {
  check('unknown layer refusal words', (error as Error).message, 'Unknown setting source "elsewhere". Valid options are: user, project, local')
}
console.log(`${failures ? 'FAIL' : 'PASS'} settings source labels: ${failures} failures`)
process.exit(failures ? 1 : 0)
