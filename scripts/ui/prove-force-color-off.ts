import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'
import { splashTierOf } from '../../assets/splash/splash-core.mjs'

const root = resolve(import.meta.dir, '../..')
for (const force of ['0', 'false', '4', 'garbage']) {
  for (const noColor of [undefined, '1']) {
    const env = { ...process.env, FORCE_COLOR: force, NO_COLOR: noColor, COLORTERM: 'truecolor' }
    const child = spawnSync(process.execPath, ['-e', `const m = await import('./src/screen/renderer/colorize.ts'); console.log(JSON.stringify({ stripped: m.colorStripped(), ink: m.colorize('word', '#dd4444', 'foreground') }))`], { cwd: root, env, encoding: 'utf8' })
    assert.equal(child.status, 0, `the colorize probe of src/screen/renderer/colorize.ts exited nonzero, fix the import or colorStripped there. ${child.stderr}`)
    assert.deepEqual(JSON.parse(child.stdout), { stripped: true, ink: 'word' }, `a disabled FORCE_COLOR must strip colour: change the FORCE_COLOR handling in src/screen/renderer/colorize.ts (colorStripped, colorize). FORCE_COLOR=${force}, NO_COLOR=${noColor}`)
  }
}
const plain = (env: Record<string, string>, platform = 'linux') => splashTierOf({ TERM: 'xterm-256color', ...env }, platform) === 'plain'
for (const force of ['0', 'false', '4', 'garbage']) {
  assert.equal(plain({ FORCE_COLOR: force }), true, `change splashTierOf in assets/splash/splash-core.mjs so FORCE_COLOR=${force} disables colour`)
  assert.equal(plain({ FORCE_COLOR: force, NO_COLOR: '1' }), true, `change splashTierOf in assets/splash/splash-core.mjs so FORCE_COLOR=${force} with NO_COLOR=1 disables colour`)
}
for (const force of ['', '1', '2', '3', 'true']) assert.equal(plain({ FORCE_COLOR: force, NO_COLOR: '1' }), false, `change splashTierOf in assets/splash/splash-core.mjs so FORCE_COLOR=${force} keeps colour on`)
assert.equal(plain({ NO_COLOR: '1' }), true, 'change splashTierOf in assets/splash/splash-core.mjs so NO_COLOR=1 alone disables colour')
assert.equal(plain({}), false, 'change splashTierOf in assets/splash/splash-core.mjs so an empty environment with TERM=xterm-256color keeps colour on')
assert.equal(splashTierOf({}, 'win32') === 'plain', false, 'change splashTierOf in assets/splash/splash-core.mjs so an empty win32 environment keeps colour on')
assert.equal(splashTierOf({ NO_COLOR: '1' }, 'win32') === 'plain', true, 'change splashTierOf in assets/splash/splash-core.mjs so NO_COLOR=1 disables colour on win32')
console.log('PASS tui-06 disabled FORCE_COLOR values strip cockpit and standalone splash colours')
