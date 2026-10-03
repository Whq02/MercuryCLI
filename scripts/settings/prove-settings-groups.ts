import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const root = mkdtempSync(join(tmpdir(), 'settings-groups-'))
process.env.MERCURY_CONFIG_DIR = join(root, 'home')
mkdirSync(process.env.MERCURY_CONFIG_DIR)
const project = join(root, 'project')
mkdirSync(join(project, '.mercury'), { recursive: true })
const { SettingsSchema } = await import('../../src/utils/settings/types.js')
const pipeline = await import('../../src/utils/settings/settings.js')
const { resetSettingsCache } = await import('../../src/utils/settings/settingsCache.js')
const { setMdmSettingsCache, parseCommandOutputAsSettings } = await import('../../src/utils/settings/mdm/settings.js')
const state = await import('../../src/bootstrap/state.js')
state.setOriginalCwd(project)
state.setAllowedSettingSources(['userSettings', 'projectSettings', 'localSettings'])
const files = [
  join(process.env.MERCURY_CONFIG_DIR, 'settings.json'),
  join(project, '.mercury', 'settings.json'),
  join(project, '.mercury', 'settings.local.json'),
  join(root, 'flag.json'),
]
state.setFlagSettingsPath(files[3])

type Row = [string, unknown[], unknown[]]
const rows: Row[] = [
  ['credentials.keyCommand', ['printf fixture-key', ''], [false, 0]],
  ['credentials.proxyCommand', ['printf fixture-token', ''], [false, 0]],
  ['credentials.signInRoute', ['console', 'claudeai'], ['', false, 0]],
  ['credentials.organisation', ['fixture-org', ''], [false, 0]],
  ['files.suggester', [{ type: 'command', command: 'printf fixture' }], [false, 0, '']],
  ['files.honourGitignore', [true, false], [0, '']],
  ['records.retentionDays', [0, 3], [false, '', -1]],
  ['briefs.exclude', [[], ['**/notes.md']], [false, 0, '']],
  ['memory.enabled', [true, false], [0, '']],
  ['memory.directory', ['memory', ''], [false, 0]],
  ['turns.loopGuard', [true, false], [0, '']],
  ['environment.values', [{ FIXTURE: 'one' }, {}], [false, 0, '']],
  ['credit.lines', [{ commit: '', pr: '' }, {}], [false, 0, '']],
  ['credit.mercury', [true, false], [0, '']],
  ['briefs.git', [true, false], [0, '']],
  ['guardrails', [{ allow: ['Read'] }, {}], [false, 0, '']],
  ['engine.model', ['fixture-model', ''], [false, 0]],
  ['engine.roster', [[], ['fixture-model']], [false, 0, '']],
  ['engine.pins', [{ fixture: 'pinned' }, {}], [false, 0, '']],
  ['engine.effort', ['high', 'max'], []],
  ['engine.sessionDefaults', [true, false], [0, '']],
  ['engine.reasoning', [true, false], [0, '']],
  ['kit.trustProjectServers', [true, false], [0, '']],
  ['kit.projectOn', [[], ['fixture-server']], [false, 0, '']],
  ['kit.projectOff', [[], ['fixture-server']], [false, 0, '']],
  ['kit.permit', [[], [{ serverName: 'fixture' }]], [false, 0, '']],
  ['kit.deny', [[], [{ serverName: 'fixture' }]], [false, 0, '']],
  ['kit.managedOnly', [true, false], [0, '']],
  ['events.hooks', [{}, { Stop: [{ hooks: [{ type: 'command', command: 'true' }] }] }], [false, 0, '']],
  ['events.disabled', [true, false], [0, '']],
  ['events.managedOnly', [true, false], [0, '']],
  ['events.httpDestinations', [[], ['https://example.invalid/hook']], [false, 0, '']],
  ['events.httpEnvironment', [[], ['FIXTURE']], [false, 0, '']],
  ['guardrails.managedOnly', [true, false], [0, '']],
  ['extensions.exclusive', [true, false, [], ['agents']], []],
  ['voice.language', ['English', ''], [false, 0]],
  ['activity.tips.enabled', [true, false], [0, '']],
  ['view.files', [true, false], [0, '']],
  ['view.modelPicker.centred', [true, false], [0, '']],
  ['activity.verbs', [{ mode: 'append', verbs: [] }, { mode: 'replace', verbs: ['Working'] }], [false, 0, '']],
  ['activity.tips.words', [{ tips: [] }, { excludeDefault: true, tips: ['Fixture tip'] }], [false, 0, '']],
  ['view.syntaxOff', [true, false], [0, '']],
  ['view.reducedMotion', [true, false], [0, '']],
  ['context.wayBack', [true, false], [0, '']],
  ['view.backgroundKey', [true, false], [0, '']],
  ['view.sessionsBar', [true, false], [0, '']],
  ['view.firstRunCards', ['centred', 'top-left'], [false, 0, '']],
  ['activity.progress', [true, false], [0, '']],
  ['input.suggestions', [true, false], [0, '']],
  ['engine.agent', ['fixture-agent', ''], [false, 0]],
  ['guardrails.sovereignConsentSeen', [true, false], [0, '']],
  ['shell.kind', ['bash', 'powershell'], [false, 0, '']],
  ['shell.engine', ['system', 'brush'], [false, 0, '']],
  ['routing.openrouter', [{ dataCollection: 'allow', requireParameters: false }, {}], [false, 0, '']],
  ['shell.sessions', [1, 64], [false, 0, '']],
  ['briefs.profile', ['auto', 'native'], [false, 0, '']],
  ['channels.enabled', [true, false], [0, '']],
  ['guardrails.sandbox', [{ enabled: true }, { enabled: false }], [false, 0, '']],
  ['guardrails.sandbox.enabledPlatforms', [['macos'], []], [false, 0, '']],
  ['workspace.worktree', [{ symlinkDirectories: [] }, { sparsePaths: ['src'] }], [false, 0, '']],
  ['local.server', [{ parallelSlots: 1 }, { parallelSlots: 2 }], [false, 0, '']],
]
const objectAt = (path: string, value: unknown): Record<string, unknown> =>
  path.split('.').reduceRight<unknown>((child, key) => ({ [key]: child }), value) as Record<string, unknown>
const valueAt = (object: unknown, path: string): unknown =>
  path.split('.').reduce<unknown>((node, key) => node && typeof node === 'object' ? (node as Record<string, unknown>)[key] : undefined, object)
function declared(path: string): boolean {
  let schema: any = SettingsSchema()
  for (const key of path.split('.')) {
    while (!schema?.shape && typeof schema?.unwrap === 'function') schema = schema.unwrap()
    if (!schema?.shape?.[key]) return false
    schema = schema.shape[key]
  }
  return true
}
let failures = 0
function check(label: string, ok: boolean): void {
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}`)
}
function fixture(values: object[]): void {
  files.forEach((file, index) => writeFileSync(file, JSON.stringify(values[index] ?? {})))
  setMdmSettingsCache(parseCommandOutputAsSettings(JSON.stringify(values[4] ?? {}), 'fixture-policy'), { settings: {}, errors: [] })
  resetSettingsCache()
}
try {
  for (const [path, values, invalid] of rows) {
    check(`${path} is declared`, declared(path))
    check(`${path} absent remains absent`, valueAt(SettingsSchema().parse({}), path) === undefined)
    for (const value of values) {
      const input = objectAt(path, value)
      const result = SettingsSchema().safeParse(input)
      check(`${path} accepts ${JSON.stringify(value)}`, result.success && isDeepStrictEqual(valueAt(result.data, path), value))
      fixture([input])
      const before = readFileSync(files[0]!, 'utf8')
      check(`${path} loader and source agree`, isDeepStrictEqual(valueAt(pipeline.getInitialSettings(), path), value) && isDeepStrictEqual(valueAt(pipeline.getSettingsForSource('userSettings'), path), value))
      resetSettingsCache()
      pipeline.getInitialSettings()
      check(`${path} reads leave bytes unchanged`, readFileSync(files[0]!, 'utf8') === before)
      fixture([])
      const written = pipeline.updateSettingsForSource('userSettings', input)
      check(`${path} explicit write and read agree`, written.error === null && isDeepStrictEqual(valueAt(pipeline.getSettingsForSource('userSettings'), path), value))
    }
    for (const value of invalid) check(`${path} rejects ${JSON.stringify(value)}`, !SettingsSchema().safeParse(objectAt(path, value)).success)
    for (let low = 0; low < 5; low++) {
      for (let high = low + 1; high < 5; high++) {
        const sources: object[] = []
        const lowValue = values[0]
        const highValue = values[values.length - 1]
        sources[low] = objectAt(path, lowValue)
        sources[high] = objectAt(path, highValue)
        fixture(sources)
        const { default: mergeWith } = await import('lodash-es/mergeWith.js')
        const expected = mergeWith({}, sources[low], sources[high], pipeline.settingsMergeCustomizer)
        check(`${path} source pair ${low}<${high}`, isDeepStrictEqual(valueAt(pipeline.getInitialSettings(), path), valueAt(expected, path)))
      }
    }
  }
  check('engine effort invalid value degrades to absence', valueAt(SettingsSchema().parse({ engine: { effort: 'not-an-effort' } }), 'engine.effort') === undefined)
  for (const value of [1, null, {}, 'not-a-boolean']) {
    check('extension lock fails closed', valueAt(SettingsSchema().parse({ extensions: { exclusive: value } }), 'extensions.exclusive') === true)
  }
  fixture([{ futureSetting: { keep: [false, 0, ''] } }])
  pipeline.updateSettingsForSource('userSettings', { engine: { model: 'fixture-model' } } as never)
  check('unknown fields survive an explicit write', isDeepStrictEqual(JSON.parse(readFileSync(files[0]!, 'utf8')).futureSetting, { keep: [false, 0, ''] }))
  for (let source = 0; source < 5; source++) {
    const sources: object[] = []
    sources[source] = { guardrails: { sovereignConsentSeen: true } }
    fixture(sources)
    check(`consent source ${source} respects trust`, pipeline.hasSkipSovereignConsentPrompt() === (source !== 1))
  }
  const { isAutoMemoryEnabled, getAutoMemPath } = await import('../../src/memdir/paths.js')
  const { getSettingsSnapshot, _resetSettingsSnapshotForTesting } = await import('../../src/utils/settings/snapshot.js')
  delete process.env.MERCURY_BARE
  fixture([{ memory: { enabled: false } }])
  check('memory.enabled reaches the memory gate', isAutoMemoryEnabled() === false)
  fixture([{ memory: { enabled: true } }])
  check('memory.enabled true reaches the memory gate', isAutoMemoryEnabled() === true)
  for (let source = 0; source < 5; source++) {
    const sources: object[] = []
    const directory = join(root, `memory-${source}`)
    const hooks = { Stop: [{ hooks: [{ type: 'command', command: 'true' }] }] }
    sources[source] = { memory: { directory }, credentials: { keyCommand: `fixture-${source}` }, events: { hooks } }
    fixture(sources)
    getAutoMemPath.cache.clear?.()
    check(`memory directory source ${source} respects trust`, getAutoMemPath().startsWith(directory) === (source !== 1))
    const executable = source !== 1 && source !== 2
    check(`key command source ${source} respects checkout trust`, pipeline.getApiKeyHelperFromOutsideCheckoutSources() === (executable ? `fixture-${source}` : undefined))
    check(`hook source ${source} respects checkout trust`, isDeepStrictEqual(pipeline.getHooksFromOutsideCheckoutSources(), executable ? hooks : {}))
  }
  for (const lock of ['disableSovereignMode', 'disableFlowMode']) {
    for (const value of [1, null, {}, 'not-a-boolean']) {
      fixture([{ guardrails: { [lock]: value, deny: ['Read(secret)'] } }])
      check(`malformed ${lock} fails closed`, valueAt(pipeline.getInitialSettings(), `guardrails.${lock}`) === true)
      check('a malformed lock preserves denial rules', isDeepStrictEqual(pipeline.getInitialSettings().guardrails?.deny, ['Read(secret)']))
    }
  }
  fixture([{ engine: { model: 'user' } }, { engine: { effort: 'high' } }, { engine: { model: 'local' } }])
  _resetSettingsSnapshotForTesting()
  const provenance = getSettingsSnapshot().provenance
  check('provenance names the winning model leaf', provenance['engine.model']?.winner === 'localSettings')
  check('provenance does not assign sibling effort to the model source', provenance['engine.effort']?.winner === 'projectSettings')
  fixture([{ engine: { futureLeaf: { keep: [false, 0, ''] } }, guardrails: { deny: ['Read(secret)'] } }])
  pipeline.updateSettingsForSource('userSettings', { engine: { effort: 'high' } })
  const nested = JSON.parse(readFileSync(files[0]!, 'utf8'))
  check('nested unknown fields survive an unrelated settings write', isDeepStrictEqual(nested.engine.futureLeaf, { keep: [false, 0, ''] }))
  check('nested writes preserve sibling security settings', isDeepStrictEqual(nested.guardrails.deny, ['Read(secret)']))
  fixture([{ records: { retentionDays: 'invalid' }, engine: { model: 'fixture-model' } }])
  check('retention raw-presence guard sees a malformed nested setting', pipeline.rawSettingsContainsKey('records.retentionDays'))
  const salvaged = pipeline.getSettingsWithErrors()
  check('a malformed nested value is salvaged without voiding siblings', salvaged.settings.engine?.model === 'fixture-model' && salvaged.errors.some(error => error.path === 'records.retentionDays'))
  const file = (): Record<string, unknown> => JSON.parse(readFileSync(files[0]!, 'utf8'))
  const write = (partial: object): void => {
    const result = pipeline.updateSettingsForSource('userSettings', partial as never)
    check(`write ${JSON.stringify(partial)} succeeds`, result.error === null)
  }
  fixture([{ engine: { model: 'kept' } }])
  write({ view: { files: undefined } })
  check('clearing an absent nested leaf invents no group', !('view' in file()))
  write({ view: { files: true } })
  check('absent group then set writes the leaf', isDeepStrictEqual(file().view, { files: true }))
  write({ view: { files: undefined } })
  check('clearing the only leaf removes the group it emptied', !('view' in file()))
  check('an unrelated group survives the clears', isDeepStrictEqual(file().engine, { model: 'kept' }))
  fixture([{ view: { files: true, futureLeaf: 'keep' } }])
  write({ view: { files: undefined } })
  check('clearing one leaf keeps the unknown sibling and the group', isDeepStrictEqual(file().view, { futureLeaf: 'keep' }))
  fixture([{ kit: { projectOn: ['one', 'two'], trustProjectServers: true } }])
  write({ kit: { projectOn: ['three'] } })
  check('an array leaf is replaced whole, its sibling kept', isDeepStrictEqual(file().kit, { projectOn: ['three'], trustProjectServers: true }))
  write({ kit: { projectOn: [] } })
  check('an empty array is an explicit value, not a clear', isDeepStrictEqual(file().kit, { projectOn: [], trustProjectServers: true }))
  fixture([{ engine: { model: 'kept' } }])
  write({ events: { hooks: {} } })
  check('an explicit empty object is written as a value', isDeepStrictEqual(file().events, { hooks: {} }))
  write({ events: {} })
  check('an empty partial leaves the group as it was', isDeepStrictEqual(file().events, { hooks: {} }))
  fixture([{ engine: 'malformed' }])
  write({ engine: { model: 'repaired' } })
  check('a nested write over a malformed scalar replaces it with the group', isDeepStrictEqual(file().engine, { model: 'repaired' }))
  fixture([{ environment: { values: { KEEP: 'one', DROP: 'two' } } }])
  write({ environment: { values: { DROP: undefined, ADD: 'three' } } })
  check('nested writes delete and add leaves two levels down', isDeepStrictEqual(file().environment, { values: { KEEP: 'one', ADD: 'three' } }))
  write({ environment: { values: { KEEP: undefined, ADD: undefined } } })
  check('emptying a nested map removes it and its emptied parent', !('environment' in file()))
  const { validateSettingsFileContent } = await import('../../src/utils/settings/validation.js')
  const editVerdict = (document: object): string => {
    const verdict = validateSettingsFileContent(JSON.stringify(document))
    return verdict.isValid ? 'valid' : verdict.error.split('\n').slice(1).join(' ').trim()
  }
  check('an edit keeping every declared key is valid', editVerdict({ engine: { model: 'fixture-model' }, view: { files: true } }) === 'valid')
  check('an edit adding an unknown root key is refused', editVerdict({ notASetting: true }).includes('Unrecognized field: notASetting'))
  check('an edit adding an unknown key inside a group is refused', editVerdict({ engine: { notASetting: true } }).includes('engine: Unrecognized field: notASetting'))
  check('a group refusal names the group, never a replacement', !/instead|use |rename|was/i.test(editVerdict({ engine: { notASetting: true } })))
  check('an unknown key in guardrails keeps its latitude', editVerdict({ guardrails: { allow: [], futureRule: true } }) === 'valid')
  const unknownFile = { notASetting: { keep: [false, 0, ''] }, engine: { notASetting: true, model: 'fixture-model' } }
  fixture([unknownFile])
  const unknownBytes = readFileSync(files[0]!, 'utf8')
  const loaded = pipeline.getSettingsWithErrors()
  check('a file with unknown keys loads without error', loaded.errors.length === 0, JSON.stringify(loaded.errors))
  check('the declared sibling of an unknown key applies', loaded.settings.engine?.model === 'fixture-model')
  check('unknown keys are carried, not read', isDeepStrictEqual((loaded.settings as Record<string, unknown>).notASetting, { keep: [false, 0, ''] }) && (loaded.settings.engine as Record<string, unknown>).notASetting === true)
  check('loading a file with unknown keys writes no byte', readFileSync(files[0]!, 'utf8') === unknownBytes)
  check('the unknown keys appear in no tip', JSON.stringify(loaded.errors).includes('notASetting') === false)
} finally {
  rmSync(root, { recursive: true, force: true })
}
console.log(`settings groups: ${rows.length} paths; ${failures} failures`)
process.exitCode = failures ? 1 : 0
