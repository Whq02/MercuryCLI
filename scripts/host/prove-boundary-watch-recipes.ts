import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isDeepStrictEqual } from 'node:util'

assert.ok(process.env.MERCURY_CONFIG_DIR, 'a scratch MERCURY_CONFIG_DIR is required')
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
if (process.argv.includes('--child')) {
  assert.equal(process.env.MERCURY_HOST_RECIPES_FILE, undefined)
  const { enableConfigs } = await import('../../src/utils/config.ts'); enableConfigs()
  const { readHostRecord } = await import('../../src/services/host/store.ts')
  const { hostRecipeOfRecord } = await import('../../src/services/host/recipesFile.ts')
  const { RunpodClient } = await import('../../src/services/host/runpod.ts')
  const { VastClient } = await import('../../src/services/host/vendors/vast.ts')
  const { LambdaClient } = await import('../../src/services/host/vendors/lambda.ts')
  const spec = JSON.parse(readFileSync(0, 'utf8')) as { kind: string; key: string; url: string; id: string }
  const recipe = hostRecipeOfRecord(readHostRecord(spec.id)!)!
  const api = spec.kind === 'vast' ? new VastClient(spec.key, spec.url) : spec.kind === 'lambda' ? new LambdaClient(spec.key, spec.url) : new RunpodClient(spec.key, spec.url)
  const offer = await api.watchOffer(recipe, 1000, AbortSignal.timeout(10000))
  console.log(JSON.stringify({ recipe: offer?.recipe, price: offer?.price }))
} else {
  const { runpodFixture } = await import('./runpodFixture.mjs')
  const { vastFixture } = await import('./vastFixture.mjs')
  const { lambdaFixture } = await import('./lambdaFixture.mjs')
  const fixtures = { runpod: await runpodFixture(), vast: await vastFixture(), lambda: await lambdaFixture() }
  const outer = process.env.MERCURY_CONFIG_DIR
  mkdirSync(outer, { recursive: true })
  const home = mkdtempSync(join(outer, 'watch-recipes-'))
  process.env.MERCURY_CONFIG_DIR = home
  delete process.env.MERCURY_HOME
  const { HOST_RECIPES } = await import('../../src/services/host/recipes.ts')
  const { writeHostRecord } = await import('../../src/services/host/store.ts')
  let checks = 0
  let failures = 0
  const check = (name: string, truth: unknown) => { checks++; if (!truth) failures++; console.log((truth ? 'PASS ' : 'FAIL ') + name) }
  const child = async (kind: string, id: string, fixture: { key: string; baseUrl: string }) => {
    const worker = spawn(process.execPath, [fileURLToPath(import.meta.url), '--child'], { cwd: home, env: { PATH: process.env.PATH, HOME: home, TMPDIR: home, MERCURY_CONFIG_DIR: home, MERCURY_CREDENTIAL_STORE: 'file', BROWSER: '/usr/bin/true' }, stdio: ['pipe', 'pipe', 'pipe'] })
    worker.stdin.end(JSON.stringify({ kind, id, key: fixture.key, url: fixture.baseUrl }))
    let out = ''; let err = ''
    worker.stdout.on('data', c => { out += c }); worker.stderr.on('data', c => { err += c })
    const timer = setTimeout(() => worker.kill('SIGTERM'), 15000)
    try { const code = await new Promise<number | null>((resolve, reject) => { worker.once('error', reject); worker.once('close', resolve) }); assert.equal(code, 0, err); return JSON.parse(out.trim().split('\n').at(-1)!) } finally { clearTimeout(timer) }
  }
  try {
    const source = HOST_RECIPES.find(row => row.gpu === 'B200' && row.count === 4 && !row.nodes)!
    assert.ok(source)
    const recipe = { ...source, flags: [...source.flags, '--saved-watch-marker'], environment: { ...source.environment, SAVED_WATCH_MARKER: 'kept' } }
    fixtures.runpod.state.customGpus = [{ id: 'NVIDIA B200', name: 'B200', memory: 192, secure: true, price: { secure: 2 }, maxCount: { secure: 8 }, availability: 'HIGH', dataCenters: [{ id: 'EU-NL-1', availability: 'HIGH' }] }]
    for (const [kind, fixture] of Object.entries(fixtures)) {
      const id = 'saved-' + kind
      writeHostRecord({ id, name: recipe.label, recipe: recipe.id, recipeRow: recipe, price: 1000, status: 'WATCHING', startedAt: new Date().toISOString() })
      const offer = await child(kind, id, fixture)
      check(kind + ' still finds a live fixture offer in the fresh process', offer.recipe !== undefined)
      check(kind + ' keeps the saved same-id recipe instead of replacing it from its catalogue', isDeepStrictEqual(offer.recipe, recipe))
    }
    const clusterSource = HOST_RECIPES.find(row => (row.nodes ?? 1) > 1)!
    assert.ok(clusterSource)
    const clusterRecipe = { ...clusterSource, flags: [...clusterSource.flags, '--saved-cluster-marker'] }
    fixtures.runpod.state.clusterGpus = [{ id: 'NVIDIA ' + clusterRecipe.gpu, name: clusterRecipe.gpu, memory: clusterRecipe.vramGb, secure: true, price: { secure: 2 }, maxCount: { secure: 64 }, availability: 'HIGH', dataCenters: [{ id: 'EU-NL-1', availability: 'HIGH' }] }]
    writeHostRecord({ id: 'saved-cluster', name: clusterRecipe.label, recipe: clusterRecipe.id, recipeRow: clusterRecipe, price: 1000, status: 'WATCHING', startedAt: new Date().toISOString() })
    const cluster = await child('runpod', 'saved-cluster', fixtures.runpod)
    check('a cluster watch keeps its saved recipe across the same boundary', isDeepStrictEqual(cluster.recipe, clusterRecipe))
    check('watch lookups never create a paid resource', Object.values(fixtures).every(fixture => fixture.state.creates === 0) && fixtures.runpod.state.clusterCreates === 0)
    console.log('BOUNDARY WATCH RECIPES ' + (failures ? 'RED' : 'GREEN') + ' — ' + (checks - failures) + '/' + checks + '; four independent lookup processes, loopback catalogues only')
  } finally { for (const fixture of Object.values(fixtures)) await fixture.close(); process.env.MERCURY_CONFIG_DIR = outer; rmSync(home, { recursive: true, force: true }) }
  process.exitCode = failures ? 1 : 0
}
