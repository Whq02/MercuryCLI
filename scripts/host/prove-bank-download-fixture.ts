import assert from 'node:assert/strict'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { bankDownloadWords } from './bankDownloadFixture.ts'
import type { HostRunner } from '../../src/services/host/ssh.ts'

if (!process.env.MERCURY_CONFIG_DIR) throw new Error('A scratch MERCURY_CONFIG_DIR is required')
const home = join(process.env.MERCURY_CONFIG_DIR, "bank owner ' β")
mkdirSync(home, { recursive: true })
process.env.HOME = home
if (process.platform === 'win32') process.env.USERPROFILE = home
const { bankDownloadScript } = await import('../../src/services/host/bank.ts')
const { runBoxScript } = await import('../../src/services/host/boxExecution.ts')
const { HOST_RECIPES } = await import('../../src/services/host/recipes.ts')
const files = [{ path: 'shards/weights.bin', size: 3, sha256: 'a'.repeat(64) }, { path: 'config.json', size: 2, sha256: 'b'.repeat(64) }]
const recipe = { ...HOST_RECIPES[0]!, model: 'fixture/download', include: '', weightsGb: 5 / 1e9, weightManifest: { model: 'fixture/download', include: '', revision: 'c'.repeat(40), files } }
const signal = new AbortController().signal
const env = { HF_TOKEN: 'fixture-download-token-not-a-real-key' }
let checks = 0
for (const windows of [false, true]) {
  const destination = windows ? "C:\\proof bank\\O'Brien β\\weights" : join(home, 'weights')
  let calls = 0
  let encoded = ''
  const runner: HostRunner = {
    run: async (command, args, passedSignal, timeout, passedEnv) => {
      calls++
      assert.equal(command, windows ? 'powershell.exe' : '/bin/sh')
      assert.equal(passedSignal, signal)
      assert.equal(timeout, 43200000)
      assert.deepEqual(passedEnv, env)
      const script = windows ? Buffer.from(args[3]!, 'base64').toString('utf16le') : args[1]!
      assert.ok(!script.includes(env.HF_TOKEN))
      const words = bankDownloadWords(command, args)
      assert.ok(words)
      assert.deepEqual(words.slice(1), ['download', recipe.model, '--revision', recipe.weightManifest.revision, '--include', ...files.map(file => file.path), '--local-dir', destination])
      if (windows) {
        encoded = args[3]!
        assert.ok(script.includes('python -m venv ') && script.includes('Scripts') && script.includes('pip.exe') && script.includes('hf.exe'))
      }
      return 'fixture download'
    },
    tunnel: () => { throw new Error('The bank download is local') },
  }
  assert.equal(await runBoxScript({ os: windows ? 'windows' : 'linux' }, bankDownloadScript(recipe, destination, windows), runner, signal, 43200000, env), 'fixture download')
  assert.equal(calls, 1)
  if (windows) {
    const script = Buffer.from(encoded, 'base64').toString('utf16le')
    const argsFor = (text: string) => ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(text, 'utf16le').toString('base64')]
    assert.throws(() => bankDownloadWords('powershell.exe', argsFor(script.replace('pip.exe', 'other.exe'))))
    assert.throws(() => bankDownloadWords('powershell.exe', argsFor(script.replace('hf.exe', 'other.exe'))))
    assert.throws(() => bankDownloadWords('powershell.exe', argsFor(script.replace('if ($LASTEXITCODE -ne 0) { throw "download failed" }', ''))))
    assert.throws(() => bankDownloadWords('powershell.exe', argsFor(script.replace("'fixture/download'", '$model'))))
    assert.throws(() => bankDownloadWords('powershell.exe', argsFor(script + 'unexpected\n')))
  }
  checks++
  console.log('PASS ' + (windows ? 'PowerShell UTF-16LE venv + hf.exe' : 'POSIX shell venv + hf') + ' download keeps the revision, every file, quoted destination and environment-only token')
}
assert.equal(bankDownloadWords('ssh', ['fixture']), undefined)
console.log('BANK DOWNLOAD FIXTURE GREEN — ' + checks + ' roads; malformed PowerShell scripts refused; no subprocess downloads')
