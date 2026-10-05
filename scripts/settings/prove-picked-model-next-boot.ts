import '../lib/hermetic.js'
import { strict as assert } from 'node:assert'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { proofHome } from '../lib/hermetic.js'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
delete process.env.MERCURY_MODEL
const root = process.argv[2] ?? join(import.meta.dir, '../..')
const project = join(proofHome, 'project')
mkdirSync(project)
mkdirSync(join(project, '.mercury'))
const state = await import(join(root, 'src/bootstrap/state.ts'))
state.setOriginalCwd(project)
state.setAllowedSettingSources(['userSettings', 'projectSettings', 'localSettings'])
const settings = await import(join(root, 'src/utils/settings/settings.ts'))
const { persistModelChoice } = await import(join(root, 'src/commands/model/persistModelChoice.ts'))
const picked = 'gpt-6.1-sol'
assert.equal(settings.updateSettingsForSource('userSettings', { engine: { model: 'fixture-earlier-model' } }).error, null)
const receipt = persistModelChoice(picked)
assert.equal(receipt.outcome, 'saved')
assert.equal(JSON.parse(readFileSync(join(proofHome, 'settings.json'), 'utf8')).engine.model, picked)
console.log('[PASS] the picker persistence door writes engine.model into the user layer and invalidates its cached read')

function nextBoot(expected: string | null, extra: { env?: string; override?: string } = {}): void {
  const code = `
    const state = await import(${JSON.stringify(join(root, 'src/bootstrap/state.ts'))});
    state.setOriginalCwd(${JSON.stringify(project)});
    state.setAllowedSettingSources(['userSettings', 'projectSettings', 'localSettings']);
    ${extra.override ? `state.setEngineModelOverride(${JSON.stringify(extra.override)});` : ''}
    const { getUserSpecifiedModelSetting } = await import(${JSON.stringify(join(root, 'src/utils/model/model.ts'))});
    console.log(JSON.stringify(getUserSpecifiedModelSetting()));
  `
  const child = Bun.spawnSync([process.execPath, '-e', code], {
    cwd: root,
    env: { ...process.env, MERCURY_CONFIG_DIR: proofHome, MERCURY_MODEL: extra.env ?? '' },
    stdout: 'pipe', stderr: 'pipe',
  })
  assert.equal(child.exitCode, 0, Buffer.from(child.stderr).toString())
  assert.equal(JSON.parse(Buffer.from(child.stdout).toString().trim()), expected)
}
nextBoot(picked)
console.log('[PASS] a fresh process on the next boot reads the saved pick rather than the earlier model')
writeFileSync(join(project, '.mercury/settings.json'), JSON.stringify({ engine: { model: 'fixture-project-model' } }))
nextBoot('fixture-project-model')
writeFileSync(join(project, '.mercury/settings.local.json'), JSON.stringify({ engine: { model: 'fixture-local-model' } }))
nextBoot('fixture-local-model')
nextBoot('fixture-env-model', { env: 'fixture-env-model' })
nextBoot('fixture-flag-model', { env: 'fixture-env-model', override: 'fixture-flag-model' })
console.log('[PASS] project, local, environment and the explicit boot override retain their existing precedence over the saved default')
writeFileSync(join(project, '.mercury/settings.json'), '{}')
writeFileSync(join(project, '.mercury/settings.local.json'), '{}')
settings.updateSettingsForSource('userSettings', { engine: { model: picked } })
const cleared = persistModelChoice(null)
assert.equal(cleared.outcome, 'cleared')
nextBoot(null)
console.log('[PASS] clearing the saved choice removes the same key the next boot reads')
console.log('prove-picked-model-next-boot: all green')
