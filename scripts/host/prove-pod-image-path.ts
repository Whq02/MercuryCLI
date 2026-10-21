import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pinSourceRef } from '../lib/settingsPopupHarness.ts'
import type { HostRunner } from '../../src/services/host/ssh.ts'

pinSourceRef()
if (!process.env.MERCURY_CONFIG_DIR) throw new Error('A scratch MERCURY_CONFIG_DIR is required')
mkdirSync(process.env.MERCURY_CONFIG_DIR, { recursive: true })
const home = mkdtempSync(join(process.env.MERCURY_CONFIG_DIR, 'image-path-'))
try {
  const { startHostEngine } = await import('../../src/services/host/ssh.ts')
  const { HOST_RECIPES } = await import('../../src/services/host/recipes.ts')
  const recipe = HOST_RECIPES.find(row => row.id === 'qwen38-27b-rtx-pro-6000')!
  const bin = join(home, 'image-bin')
  mkdirSync(bin)
  const calls = join(home, 'calls')
  for (const name of ['hf', 'sglang']) writeFileSync(join(bin, name), '#!/bin/sh\nprintf "%s\\n" "' + name + ' $*" >> "' + calls + '"\n', { mode: 0o700 })
  const environ = join(home, 'pid1-environ')
  writeFileSync(environ, 'PATH=' + bin + ':/usr/bin:/bin\0NOT_FOR_SSH=do-not-copy\0')
  let script = ''
  const runner: HostRunner = {
    async run(command, args) {
      assert.equal(command, 'ssh')
      const remote = args.at(-1)!
      if (remote.includes('printf %s')) {
        const parsed = spawnSync('python3', ['-c', 'import json,shlex,sys; print(json.dumps(shlex.split(sys.argv[1])))', remote], { encoding: 'utf8' })
        assert.equal(parsed.status, 0, parsed.stderr)
        const tokens: string[] = JSON.parse(parsed.stdout)
        script = tokens[tokens.indexOf('printf') + 2]!
      }
      return ''
    },
    tunnel() { throw new Error('No tunnel in the launch-script reading') },
  }
  await startHostEngine({ host: 'fixture.invalid' }, recipe, runner, new AbortController().signal, false, true)
  assert.ok(script.includes('sglang') && script.includes('hf download'))
  const path = join(home, 'engine.sh')
  writeFileSync(path, script.replaceAll('/proc/1/environ', environ).replaceAll('/workspace', join(home, 'workspace')))
  const result = spawnSync('bash', [path], { encoding: 'utf8', env: { PATH: '/usr/bin:/bin', HOME: home } })
  assert.equal(result.status, 0, 'pod launch finds image tools from a stripped SSH PATH\n' + result.stdout + result.stderr)
  const invoked = readFileSync(calls, 'utf8')
  assert.match(invoked, /hf download Qwen\/Qwen3\.8-27B-FP8/)
  assert.match(invoked, /sglang serve --model-path/)
  for (const flag of recipe.flags) assert.ok(invoked.includes(flag), 'recipe flag retained: ' + flag)
  assert.ok(!script.includes('eval ') && !script.includes('source /proc/1/environ'), 'only the image PATH is imported, never executable environment text')
  console.log('POD IMAGE PATH GREEN · generated launch finds downloader and engine with the SSH PATH stripped; every serving flag retained')
} finally { rmSync(home, { recursive: true, force: true }) }
