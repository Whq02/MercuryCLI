import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isDeepStrictEqual } from 'node:util'
import { boxScriptText } from './bankDownloadFixture.ts'

assert.ok(process.env.MERCURY_CONFIG_DIR, 'a scratch MERCURY_CONFIG_DIR is required')
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const childMode = process.argv.includes('--child')
if (childMode) {
  assert.equal(process.env.MERCURY_HOST_RECIPES_FILE, undefined)
  assert.equal(process.env.MERCURY_HOST_WEIGHTS_FILE, undefined)
  assert.equal(process.env.HF_TOKEN, undefined)
  const { enableConfigs } = await import('../../src/platform/settings/config.ts')
  enableConfigs()
  const { readHostRecord } = await import('../../src/models/hosting/store.ts')
  const { hostRecipeOfRecord } = await import('../../src/models/hosting/recipesFile.ts')
  const { pinnedWeightManifest } = await import('../../src/models/hosting/keptWeights.ts')
  const { bankDownloadPlan } = await import('../../src/models/hosting/bank.ts')
  const rows = ['setup', 'watch', 'bank'].map(kind => {
    const recipe = hostRecipeOfRecord(readHostRecord('manifest-' + kind)!)!
    return { kind, manifest: pinnedWeightManifest(recipe), plan: bankDownloadPlan(recipe) }
  })
  const { runHostJob } = await import('../../src/models/hosting/worker.ts')
  const bank = readHostRecord('manifest-bank')!
  let downloadScript = ''
  await runHostJob(bank.id, bank.generation!, {
    pauseMs: 5,
    runner: {
      async run(command, args) { downloadScript = boxScriptText(command, args); return '' },
      tunnel() { throw new Error('a Bank job must not open a tunnel') },
    },
  })
  console.log(JSON.stringify({ rows, downloadScript }))
} else {
  const parentHome = process.env.MERCURY_CONFIG_DIR
  mkdirSync(parentHome, { recursive: true })
  const home = mkdtempSync(join(parentHome, 'manifest-'))
  process.env.MERCURY_CONFIG_DIR = home
  process.env.MERCURY_CREDENTIAL_STORE = 'file'
  process.env.HOME = home
  delete process.env.MERCURY_HOME
  delete process.env.HF_TOKEN
  const { enableConfigs } = await import('../../src/platform/settings/config.ts')
  enableConfigs()
  let checks = 0
  let failures = 0
  const check = (name: string, truth: unknown, detail = '') => { checks++; if (!truth) failures++; console.log((truth ? 'PASS ' : 'FAIL ') + name + (!truth && detail ? ': ' + detail : '')) }
  const child = async () => {
    const processChild = spawn(process.execPath, [fileURLToPath(import.meta.url), '--child'], {
      cwd: home,
      env: { PATH: process.env.PATH, HOME: home, TMPDIR: home, MERCURY_CONFIG_DIR: home, MERCURY_CREDENTIAL_STORE: 'file', BROWSER: '/usr/bin/true', ...(process.env.BUN_OPTIONS ? { BUN_OPTIONS: process.env.BUN_OPTIONS } : {}) },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    processChild.stdout.on('data', chunk => { stdout += chunk })
    processChild.stderr.on('data', chunk => { stderr += chunk })
    const timer = setTimeout(() => processChild.kill('SIGTERM'), 15000)
    try {
      const code = await new Promise<number | null>((resolve, reject) => { processChild.once('error', reject); processChild.once('close', resolve) })
      assert.equal(code, 0, stderr)
      return JSON.parse(stdout.trim().split('\n').at(-1)!) as { rows: Array<{ kind: string; manifest?: unknown; plan: { revision?: string; include: string[] } }>; downloadScript: string }
    } finally { clearTimeout(timer) }
  }
  try {
    const { HOST_RECIPES } = await import('../../src/models/hosting/recipes.ts')
    const { queueHostSetup, queueHostWatch, queueHostBank } = await import('../../src/models/hosting/jobs.ts')
    const { bankDownloadScript, bankModelFolder, readBankRegistry } = await import('../../src/models/hosting/bank.ts')
    const { runBoxScript } = await import('../../src/models/hosting/boxExecution.ts')
    const bytes = Buffer.from('trusted model bytes')
    const recipe = { ...HOST_RECIPES[0]!, id: 'manifest-private', label: 'Private manifest model', model: 'Fixture/Manifest', weightsGb: bytes.length / 1e9, include: '*.gguf', weightFile: 'model.gguf', mmproj: undefined }
    const manifest = { model: recipe.model, include: recipe.include, revision: 'a'.repeat(40), files: [{ path: 'model.gguf', size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }] }
    const manifestsFile = join(home, 'private-weights.json')
    writeFileSync(manifestsFile, JSON.stringify([manifest]))
    process.env.MERCURY_HOST_WEIGHTS_FILE = manifestsFile
    const folder = join(home, 'bank')
    const path = bankModelFolder(folder, recipe)
    mkdirSync(path, { recursive: true })
    writeFileSync(join(path, 'model.gguf'), bytes)
    const record = (kind: string) => ({ id: 'manifest-' + kind, name: recipe.label, recipe: recipe.id, recipeRow: recipe, price: 0, status: 'QUEUED', startedAt: new Date().toISOString(), bankFolder: folder, sessionId: 'manifest-session' })
    queueHostSetup(record('setup'))
    queueHostWatch(record('watch'))
    queueHostBank(record('bank'))
    const result = await child()
    for (const row of result.rows) {
      check(row.kind + ' job retains the exact manifest when its private-file environment is absent', isDeepStrictEqual(row.manifest, manifest), 'fix queueHostSetup, queueHostWatch and queueHostBank in src/models/hosting/jobs.ts to pin the weight manifest in the record, and pinnedWeightManifest in src/models/hosting/keptWeights.ts to read it back; got ' + JSON.stringify(row.manifest))
      check(row.kind + ' worker retains the immutable download revision and exact file list', row.plan.revision === manifest.revision && isDeepStrictEqual(row.plan.include, ['model.gguf']), 'fix bankDownloadPlan in src/models/hosting/bank.ts to use the pinned revision and exact file list; got ' + JSON.stringify(row.plan))
    }
    check('the spawned Bank worker sends the saved revision to the downloader', result.downloadScript.includes("--revision '" + manifest.revision + "'"), 'fix bankDownloadScript in src/models/hosting/bank.ts to pass the saved revision to the downloader')
    let windowsCall: { command: string; args: string[] } | undefined
    await runBoxScript({ os: 'windows', target: undefined }, bankDownloadScript(recipe, path, true), { async run(command, args) { windowsCall = { command, args }; return '' }, tunnel() { throw new Error('a Bank job must not open a tunnel') } }, new AbortController().signal)
    check('the Windows Bank road carries the saved revision inside its encoded PowerShell command', windowsCall?.command === 'powershell.exe' && windowsCall.args[2] === '-EncodedCommand' && boxScriptText(windowsCall.command, windowsCall.args).includes("--revision '" + manifest.revision + "'"), 'fix runBoxScript in src/models/hosting/boxExecution.ts and bankDownloadScript in src/models/hosting/bank.ts to carry the revision into the encoded PowerShell command')
    check('the actual Bank seal verifies good bytes against trusted hashes rather than against itself', readBankRegistry().models[recipe.model + '\n' + recipe.include]?.check === 'manifest' || Object.values(readBankRegistry().models).some(row => row.path === path && row.check === 'manifest'), 'fix the Bank seal in src/models/hosting/bank.ts to verify bytes against the pinned manifest hashes and record check manifest')
    writeFileSync(join(path, 'model.gguf'), Buffer.alloc(bytes.length, 120))
    queueHostBank(record('bank'))
    await child()
    const bad = Object.values(readBankRegistry().models).find(row => row.path === path)
    check('same-size corrupt bytes are rejected in the separate worker', bad?.error === 'model.gguf · hash differs from the pinned manifest', 'fix the Bank seal in src/models/hosting/bank.ts to hash same-size files against the pinned manifest; error was ' + String(bad?.error))
    check('a failed trusted check cannot leave a verified Bank receipt', bad?.verifiedAt === undefined && bad?.check === undefined, 'fix the Bank seal in src/models/hosting/bank.ts to leave no verifiedAt or check on a failed hash; got ' + JSON.stringify(bad))
    console.log('BOUNDARY MANIFEST ' + (failures ? 'RED' : 'GREEN') + ' — ' + (checks - failures) + '/' + checks + '; real worker processes and real file hashing, no network')
  } finally {
    delete process.env.MERCURY_HOST_WEIGHTS_FILE
    process.env.MERCURY_CONFIG_DIR = parentHome
    rmSync(home, { recursive: true, force: true })
  }
  process.exitCode = failures ? 1 : 0
}
