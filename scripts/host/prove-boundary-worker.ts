import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isDeepStrictEqual } from 'node:util'

assert.ok(process.env.MERCURY_CONFIG_DIR, 'a scratch MERCURY_CONFIG_DIR is required')
const originalFetch = globalThis.fetch
globalThis.fetch = Object.assign((input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(input instanceof Request ? input.url : String(input))
  assert.ok(['127.0.0.1', '[::1]'].includes(url.hostname), 'all requests stay on loopback')
  return originalFetch(input, init)
}, originalFetch)
const childMode = process.argv.indexOf('--child')
if (childMode !== -1) {
  ;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
  assert.equal(process.env.MERCURY_HOST_RECIPES_FILE, undefined)
  assert.equal(process.env.MERCURY_HOST_WEIGHTS_FILE, undefined)
  assert.equal(process.env.HF_TOKEN, undefined)
  const { enableConfigs } = await import('../../src/utils/config.ts')
  enableConfigs()
  const { readHostRecord, hostRecords } = await import('../../src/services/host/store.ts')
  const { queueHostSetup, queueHostWatch, queueHostBank } = await import('../../src/services/host/jobs.ts')
  const mode = process.argv[childMode + 1]
  if (mode === 'requeue') {
    for (const [kind, queue] of [['setup', queueHostSetup], ['watch', queueHostWatch], ['bank', queueHostBank]] as const) {
      queue(readHostRecord('saved-' + kind)!)
    }
  } else {
    const { fakeSshRunner } = await import('./runpodFixture.mjs')
    const { hostRunner, closeHostTunnel } = await import('../../src/services/host/ssh.ts')
    const { runHostJob } = await import('../../src/services/host/worker.ts')
    const ssh = fakeSshRunner(process.argv[childMode + 2], hostRunner)
    const watch = readHostRecord('boundary-watch')!
    try {
      await runHostJob(watch.id, watch.generation!, { runner: ssh.runner, pauseMs: 5, timeoutMs: 10000, keepAlive: false })
      writeFileSync(join(process.env.MERCURY_CONFIG_DIR!, 'worker-commands.json'), JSON.stringify(ssh.commands))
    } finally {
      for (const record of hostRecords()) closeHostTunnel(record.id)
    }
  }
} else {
  const { llmhostFixture } = await import('../providers/lib/llmhostFixture.ts')
  const { runpodFixture } = await import('./runpodFixture.mjs')
  const f = await llmhostFixture()
  const rp = await runpodFixture()
  let checks = 0
  let failures = 0
  const check = (name: string, truth: unknown, detail = '') => {
    checks++
    if (!truth) failures++
    console.log((truth ? 'PASS ' : 'FAIL ') + name + (!truth && detail ? ' — ' + detail : ''))
  }
  const child = async (mode: string) => {
    const processChild = spawn(process.execPath, [fileURLToPath(import.meta.url), '--child', mode, f.baseUrl], {
      cwd: f.home,
      env: { PATH: process.env.PATH, HOME: f.home, TMPDIR: f.home, MERCURY_CONFIG_DIR: f.home, MERCURY_CREDENTIAL_STORE: 'file', BROWSER: '/usr/bin/true' },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let output = ''
    processChild.stdout.on('data', chunk => { output += chunk })
    processChild.stderr.on('data', chunk => { output += chunk })
    const timer = setTimeout(() => processChild.kill('SIGTERM'), 30000)
    try {
      const code = await new Promise<number | null>((resolve, reject) => { processChild.once('error', reject); processChild.once('close', resolve) })
      assert.equal(code, 0, output)
      check('fresh ' + mode + ' process exits without inherited recipe, manifest or token environment', code === 0)
    } finally { clearTimeout(timer) }
  }
  try {
    const { HOST_RECIPES } = await import('../../src/services/host/recipes.ts')
    const { queueHostWatch } = await import('../../src/services/host/jobs.ts')
    const { writeHostRecord, readHostRecord, hostRecords, removeHostRecord } = await import('../../src/services/host/store.ts')
    const { hostRecipeOfRecord } = await import('../../src/services/host/recipesFile.ts')
    const { writeStoredRunpodApiKey } = await import('../../src/services/providers/providerSecrets.ts')
    const source = HOST_RECIPES.find(row => row.gpu === 'RTX PRO 6000' && row.engine === 'llamacpp')!
    const privateRecipe = { ...source, id: 'boundary-private-model', model: f.model, label: 'Boundary private model · Q4', flags: [...source.flags, '--boundary-proof-marker'] }
    const recipes = join(f.home, 'private-recipes.json')
    writeFileSync(recipes, JSON.stringify({ version: 2, publishedAt: '2026-10-22', recipes: [privateRecipe] }))
    process.env.MERCURY_HOST_RECIPES_FILE = recipes
    f.state.dialect = 'llamacpp'
    f.state.window = 131072
    f.state.slots = 4
    writeStoredRunpodApiKey(rp.key)
    const watch = queueHostWatch({ id: 'boundary-watch', name: privateRecipe.label, recipe: privateRecipe.id, price: 10, status: 'WATCHING', startedAt: new Date().toISOString(), apiBaseUrl: rp.baseUrl, sessionId: 'boundary-session', workspace: f.home })
    check('the foreground saves its private recipe before it exits', watch.recipeRow?.id === privateRecipe.id)
    await child('watch')
    const setup = hostRecords().find(row => row.watchedFrom === watch.id)
    check('watch-created setup carries the exact selected recipe across its next handoff', setup && isDeepStrictEqual(hostRecipeOfRecord(setup), privateRecipe))
    check('a private-recipe watch completes setup rather than terminating the newly rented pod', setup?.jobState === 'ready' && rp.state.creates === 1 && rp.state.deletes === 0, JSON.stringify(setup))
    const commands = readFileSync(join(f.home, 'worker-commands.json'), 'utf8')
    check('the separate worker launches the private recipe flags', commands.includes('--boundary-proof-marker'))
    check('workspace, session, vendor address and SSH key remain attached to the watch result', setup?.workspace === f.home && setup.sessionId === 'boundary-session' && setup.apiBaseUrl === rp.baseUrl && setup.sshKey === join(f.home, 'host', 'keys', 'id_ed25519'))
    for (const record of hostRecords()) removeHostRecord(record.id)
    delete process.env.MERCURY_HOST_RECIPES_FILE
    const savedRecipe = { ...source, flags: [...source.flags, '--saved-recipe-marker'] }
    for (const kind of ['setup', 'watch', 'bank'] as const) {
      writeHostRecord({ id: 'saved-' + kind, name: source.label, recipe: source.id, recipeRow: savedRecipe, price: 0, startedAt: new Date().toISOString(), status: 'FAILED', jobKind: kind, jobState: 'failed' })
    }
    await child('requeue')
    for (const kind of ['setup', 'watch', 'bank']) check('requeued ' + kind + ' preserves its saved recipe instead of the same-id shipped recipe', readHostRecord('saved-' + kind)?.recipeRow?.flags.includes('--saved-recipe-marker'))
    console.log('BOUNDARY WORKER ' + (failures ? 'RED' : 'GREEN') + ' — ' + (checks - failures) + '/' + checks + '; spawned workers, loopback vendor and model only')
  } finally { delete process.env.MERCURY_HOST_RECIPES_FILE; await rp.close(); f.close() }
  process.exitCode = failures ? 1 : 0
}
