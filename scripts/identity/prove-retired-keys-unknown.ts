#!/usr/bin/env bun
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const HOME = realpathSync(mkdtempSync(join(tmpdir(), 'retired-keys-home-')))
const PROJ = realpathSync(mkdtempSync(join(tmpdir(), 'retired-keys-proj-')))
process.env.MERCURY_CONFIG_DIR = HOME
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
process.env.ANTHROPIC_API_KEY = 'proof-key-ci-gate-not-a-real-key'
delete process.env.NODE_ENV
delete process.env.MERCURY_HOME
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const launchDir = process.cwd()
process.chdir(PROJ)

let failures = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
}
const section = (title: string): void => console.log(`\n${title}`)
const j = (value: unknown): string => JSON.stringify(value)

const { enableConfigs } = await import('../../src/utils/config/globalConfig.js')
enableConfigs()
const { getSettingsWithErrors, getInitialSettings } = await import('../../src/utils/settings/settings.js')
const { resetSettingsCache } = await import('../../src/utils/settings/settingsCache.js')
const { validateSettingsFileContent } = await import('../../src/utils/settings/validation.js')
const { loadAllPermissionRulesFromDisk } = await import('../../src/utils/permissions/permissionsLoader.js')
const { getHooksConfigFromSnapshot, resetHooksConfigSnapshot } = await import('../../src/utils/hooks/hooksConfigSnapshot.js')
const { getConfiguredApiKeyHelper } = await import('../../src/utils/auth.js')
const { getGlobalConfig, readGlobalConfigAgain } = await import('../../src/utils/config/globalConfig.js')
const { setSessionTrustAccepted } = await import('../../src/bootstrap/state.js')
setSessionTrustAccepted(true)

const RETIRED_SETTINGS_ROOTS: Record<string, unknown> = {
  apiKeyHelper: 'echo sk-fixture',
  proxyAuthHelper: 'echo proxy',
  forceLoginMethod: 'console',
  forceLoginOrgUUID: 'org-1',
  fileSuggestion: { type: 'command', command: 'echo' },
  respectGitignore: false,
  cleanupPeriodDays: 3,
  instructionExcludes: ['**/x.md'],
  includeGitInstructions: false,
  instructionProfile: 'native',
  plansDirectory: 'plans',
  showClearContextOnStrategyAccept: true,
  autoMemoryEnabled: false,
  autoMemoryDirectory: '/tmp/x',
  memoryUpkeepEnabled: false,
  loopGuardStopEnabled: true,
  env: { RETIRED_FIXTURE: '1' },
  attribution: { commit: 'x' },
  includeMercuryCoAuthor: false,
  permissions: { allow: ['Bash(echo:*)'], deny: ['Write'] },
  allowManagedPermissionRulesOnly: true,
  skipSovereignConsentPrompt: true,
  sandbox: { enabled: true },
  model: 'fixture/model',
  availableModels: ['fixture/model'],
  modelOverrides: { a: 'b' },
  effortLevel: 'max',
  supercodeEffort: true,
  sessionDefaultsKey: false,
  alwaysThinkingEnabled: true,
  agent: 'fixture',
  enableAllProjectMcpServers: true,
  enabledMcpjsonServers: ['a'],
  disabledMcpjsonServers: ['b'],
  allowedMcpServers: [{ serverName: 'a' }],
  deniedMcpServers: [{ serverName: 'b' }],
  allowManagedMcpServersOnly: true,
  hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'echo retired-hook' }] }] },
  disableAllHooks: true,
  allowManagedHooksOnly: true,
  allowedHttpHookUrls: ['https://example.invalid'],
  httpHookAllowedEnvVars: ['PATH'],
  strictExtensionOnlyCustomization: true,
  language: 'fr',
  spinnerTipsEnabled: false,
  spinnerTipsOverride: { tips: ['x'] },
  spinnerVerbs: { mode: 'replace', verbs: ['x'] },
  progressReporting: true,
  filesBox: false,
  modelPickerCentred: false,
  syntaxHighlightingDisabled: true,
  prefersReducedMotion: true,
  backgroundKey: false,
  sessionsBar: false,
  firstRunCards: 'top-left',
  compactWayBack: false,
  promptSuggestionEnabled: false,
  defaultShell: 'bash',
  shellEngine: 'brush',
  shellEngineSessions: 2,
  openrouterRouting: { zeroDataRetention: true },
  channelsEnabled: false,
  worktree: { sparsePaths: ['x'] },
  localServer: { maxLoadedModels: 2 },
}
const RETIRED_ADOPTION_FIELDS: Record<string, unknown> = {
  disableBypassPermissionsMode: 'disable',
  disableAutoMode: 'disable',
  skipDangerousModePermissionPrompt: true,
  autoDreamEnabled: false,
  showClearContextOnPlanAccept: true,
}
const NONSENSE = 'notASetting'

type Loaded = { errors: number; sibling: unknown; carried: boolean; bytesAfter: string }
const settingsPath = join(HOME, 'settings.json')
function load(key: string, value: unknown): Loaded {
  const file = { [key]: value, view: { sessionsBar: true } }
  const bytes = JSON.stringify(file, null, 2)
  writeFileSync(settingsPath, bytes)
  resetSettingsCache()
  resetHooksConfigSnapshot()
  const loaded = getSettingsWithErrors()
  const raw = loaded.settings as Record<string, unknown>
  return {
    errors: loaded.errors.length,
    sibling: (raw.view as { sessionsBar?: unknown } | undefined)?.sessionsBar,
    carried: j(raw[key]) === j(value),
    bytesAfter: readFileSync(settingsPath, 'utf8'),
  }
}
const editTime = (key: string, value: unknown): { valid: boolean; words: string } => {
  const result = validateSettingsFileContent(JSON.stringify({ [key]: value }))
  const words = (result.errors ?? []).map(error => `${String(error.path ?? '')} ${error.message ?? ''}`).join(' | ')
  return { valid: result.isValid, words }
}
const NEW_PATHS = /credentials\.|files\.|records\.|briefs\.|memory\.|turns\.|environment\.|credit\.|guardrails|engine\.|kit\.|events\.|extensions\.|voice\.|activity\.|view\.|context\.|input\.|shell\.|routing\.|channels\.|workspace\.|local\./

section('§1 every retired settings root is an unknown key: the loader carries it, reads nothing from it, applies the declared sibling, writes no byte — exactly as a nonsense key')
{
  const control = load(NONSENSE, 'x')
  check('control: the nonsense key loads without errors, is carried, and the sibling applies', control.errors === 0 && control.carried && control.sibling === true, j(control))
  for (const [key, value] of Object.entries({ ...RETIRED_SETTINGS_ROOTS, ...RETIRED_ADOPTION_FIELDS })) {
    const loaded = load(key, value)
    const same = loaded.errors === control.errors && loaded.carried && loaded.sibling === true
    check(`${key}: loads as the nonsense key does (no error, carried, view.sessionsBar read)`, same, j(loaded))
    check(`${key}: the file is not rewritten`, loaded.bytesAfter === JSON.stringify({ [key]: value, view: { sessionsBar: true } }, null, 2))
  }
}

section('§2 edit-time validation refuses a retired root as it refuses a nonsense root, with words that name no replacement')
{
  const control = editTime(NONSENSE, 'x')
  check('control: the nonsense root is refused at edit time', !control.valid, control.words)
  for (const [key, value] of Object.entries(RETIRED_SETTINGS_ROOTS)) {
    const verdict = editTime(key, value)
    check(`${key}: refused like the nonsense root, and the refusal names no grouped path`, !verdict.valid && !NEW_PATHS.test(verdict.words.replace(key, '')), verdict.words)
  }
}

section('§3 the consequential ones steer nothing: no rule, no hook, no model, no credential command comes from a retired root')
{
  load('permissions', RETIRED_SETTINGS_ROOTS.permissions)
  const rules = loadAllPermissionRulesFromDisk() as Array<{ ruleValue: { toolName: string } }>
  check('a retired permissions block grants and denies nothing', !rules.some(rule => rule.ruleValue.toolName === 'Bash' || rule.ruleValue.toolName === 'Write'), j(rules))
  load('hooks', RETIRED_SETTINGS_ROOTS.hooks)
  const hooks = getHooksConfigFromSnapshot() as { SessionStart?: unknown } | null
  check('a retired hooks block runs no hook', hooks?.SessionStart === undefined, j(hooks))
  load('model', RETIRED_SETTINGS_ROOTS.model)
  check('a retired model line picks no engine', getInitialSettings().engine?.model === undefined, j(getInitialSettings().engine))
  load('apiKeyHelper', RETIRED_SETTINGS_ROOTS.apiKeyHelper)
  check('a retired credential helper runs nothing', getConfiguredApiKeyHelper() === undefined, String(getConfiguredApiKeyHelper()))
  load('effortLevel', RETIRED_SETTINGS_ROOTS.effortLevel)
  check('a retired effort line sets no effort', getInitialSettings().engine?.effort === undefined, j(getInitialSettings().engine))
}

section('§4 the global config: a retired spelling steers nothing and is carried as written, like any unknown key')
{
  const configPath = join(HOME, '.mercury.json')
  const written = { showExpandedTodos: true, lastPlanModeUse: 1700000000000, clientDataCache: { rows: [] }, advisor: { enabled: true, seats: 20, crewmates: true }, notAConfigKey: true }
  writeFileSync(configPath, `${JSON.stringify(written, null, 2)}\n`)
  readGlobalConfigAgain()
  const config = getGlobalConfig() as unknown as Record<string, unknown>
  check('the current task-list key keeps its default: the retired spelling did not write it', config.showExpandedTasks === false, j(config.showExpandedTasks))
  check('the retired spellings are carried as written, like the nonsense key beside them', config.showExpandedTodos === true && config.lastPlanModeUse === 1700000000000 && j(config.clientDataCache) === j({ rows: [] }) && config.notAConfigKey === true, j(config))
  check('the advisor block is carried whole: nothing drops a key nothing reads', j(config.advisor) === j(written.advisor), j(config.advisor))
  check('the file keeps its bytes: no rewrite at read', readFileSync(configPath, 'utf8') === `${JSON.stringify(written, null, 2)}\n`)
}

process.chdir(launchDir)
rmSync(HOME, { recursive: true, force: true })
rmSync(PROJ, { recursive: true, force: true })
console.log(`\nretired keys unknown: ${failures === 0 ? 'ALL PASS' : `${failures} FAILED`}`)
process.exit(failures === 0 ? 0 : 1)
