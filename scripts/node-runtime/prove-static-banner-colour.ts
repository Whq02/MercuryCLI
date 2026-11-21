import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { parseEnginesNode, posixLauncher } from '../release/launcherTemplates.mjs'

const root = resolve(import.meta.dir, '../..')
const shellRoot = spawnSync('bash', ['-c', 'printf %s "$PWD"'], { cwd: root, encoding: 'utf8' }).stdout
const policy = parseEnginesNode(JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')).engines.node)
const ops = readFileSync(resolve(root, 'scripts/ops/launcher-mercury.sh'), 'utf8')
const release = posixLauncher(policy)
const bodies = [
  ops.match(/  elif \[ "\$\{MERCURY_SPLASH:-\}" != "off" \]; then\n([\s\S]*?)\n  fi\nfi/)?.[1],
  release.match(/\n  else\n([^]*?)\n  fi\nfi\n# ONE PROCESS/)?.[1],
]
const cases: Array<[Record<string, string>, number]> = [
  [{ TERM: 'xterm-256color', COLORTERM: 'truecolor', NO_COLOR: '1' }, 0],
  [{ TERM: 'xterm-256color', COLORTERM: 'truecolor', FORCE_COLOR: '0' }, 0],
  [{ TERM: 'xterm-256color', COLORTERM: 'truecolor', FORCE_COLOR: 'false' }, 0],
  [{ TERM: 'dumb' }, 0], [{ TERM: 'linux' }, 1], [{ TERM: 'xterm' }, 1],
  [{ TERM: 'xterm-256color' }, 2], [{ TERM: 'xterm-256color', COLORTERM: 'truecolor' }, 3],
  [{ TERM: 'xterm', NO_COLOR: '1', FORCE_COLOR: '1' }, 1],
]
for (const [index, body] of bodies.entries()) {
  assert.ok(body, `launcher ${index} static fallback located; the splash block of launcher 0 (scripts/ops/launcher-mercury.sh) or of launcher 1 (posixLauncher in scripts/release/launcherTemplates.mjs) no longer matches the pattern at the top of this file, so restore its shape or update that pattern`)
  for (const [extra, level] of cases) {
    const env = { ...process.env }
    for (const key of ['FORCE_COLOR', 'NO_COLOR', 'COLORTERM', 'TERM_PROGRAM', 'KITTY_WINDOW_ID', 'WT_SESSION']) delete env[key]
    Object.assign(env, extra)
    const run = spawnSync('bash', ['-c', body], { cwd: root, env, encoding: 'utf8' })
    assert.equal(run.status, 0, `the static banner block of launcher ${index} (0 is scripts/ops/launcher-mercury.sh, 1 is posixLauncher in scripts/release/launcherTemplates.mjs) must exit 0 under ${JSON.stringify(extra)}; stderr: ${run.stderr}`)
    const actual = /\x1b\[[\d;]*38;2;/.test(run.stdout) ? 3 : /\x1b\[[\d;]*38;5;/.test(run.stdout) ? 2 : /\x1b\[[\d;]*3[0-7]m/.test(run.stdout) ? 1 : 0
    assert.equal(actual, level, `launcher ${index} ${JSON.stringify(extra)}; the banner colour depth must be ${level} (0 none, 1 basic, 2 256, 3 truecolor) for this environment: fix the NO_COLOR, FORCE_COLOR, TERM and COLORTERM handling in the static banner block of that launcher (0 is scripts/ops/launcher-mercury.sh, 1 is posixLauncher in scripts/release/launcherTemplates.mjs)`)
    assert.equal(run.stdout.replace(/\x1b\[[\d;]*m/g, ''), `\n  ✦ MERCURY · ${shellRoot}\n\n`, `banner wording and spacing are unchanged (the folder as the shell spells it); launcher ${index} must print only the colour codes around the text new line, two spaces, the star, MERCURY, a dot and the folder, then a blank line: restore the text in its static banner block`)
  }
}
console.log('PASS tui-07 both static launch banners honour no-colour and terminal depth without changing text')
