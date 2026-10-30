import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const root = resolve(import.meta.dir, '../..')
for (const force of ['0', 'false', '4', 'garbage']) {
  for (const noColor of [undefined, '1']) {
    const env = { ...process.env, FORCE_COLOR: force, NO_COLOR: noColor, COLORTERM: 'truecolor' }
    const child = spawnSync(process.execPath, ['-e', `const m = await import('./src/ink/colorize.ts'); console.log(JSON.stringify({ stripped: m.colorStripped(), ink: m.colorize('word', '#dd4444', 'foreground') }))`], { cwd: root, env, encoding: 'utf8' })
    assert.equal(child.status, 0, child.stderr)
    assert.deepEqual(JSON.parse(child.stdout), { stripped: true, ink: 'word' }, `FORCE_COLOR=${force}, NO_COLOR=${noColor}`)
  }
}
const source = readFileSync(resolve(root, 'assets/splash/mercury-splash.mjs'), 'utf8')
const start = source.indexOf('const NOCOLOR')
const end = source.indexOf('const TRUECOLOR_FLAG', start)
const plain = (env: Record<string, string>) => Function('process', `${source.slice(start, end)}; return NOCOLOR`)({ env }) as boolean
for (const force of ['0', 'false', '4', 'garbage']) {
  assert.equal(plain({ FORCE_COLOR: force }), true)
  assert.equal(plain({ FORCE_COLOR: force, NO_COLOR: '1' }), true)
}
for (const force of ['', '1', '2', '3', 'true']) assert.equal(plain({ FORCE_COLOR: force, NO_COLOR: '1' }), false)
assert.equal(plain({ NO_COLOR: '1' }), true)
assert.equal(plain({}), false)
console.log('PASS tui-06 disabled FORCE_COLOR values strip cockpit and standalone splash colours')
