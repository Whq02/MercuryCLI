import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { ownerOnlyFile } from '../lib/ownerOnly.ts'
import { join } from 'node:path'
import { KEY, mountOffscreen, waitFor, type Mounted } from '../lib/settingsPopupHarness.ts'
import { llmhostFixture } from '../providers/lib/llmhostFixture.ts'
import { fakeSshRunner } from './runpodFixture.mjs'
import { gridToPng } from '../ui/gridToPng.ts'

export async function vmVendorDrive(vendor: string, makeFixture: () => Promise<any>): Promise<void> {
  assert.ok(process.env.MERCURY_CONFIG_DIR, 'scratch MERCURY_CONFIG_DIR required')
  assert.equal(process.env.MERCURY_HOME, undefined)
  const f = await llmhostFixture()
  const fixture = await makeFixture()
  const originalFetch = globalThis.fetch
  globalThis.fetch = Object.assign(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input))
    assert.ok(url.protocol === 'http:' && ['127.0.0.1', '[::1]'].includes(url.hostname), 'only loopback fixtures: ' + url.origin)
    return originalFetch(input, init)
  }, originalFetch)
  let mounted: Mounted | undefined
  let ssh: ReturnType<typeof fakeSshRunner> | undefined
  let checks = 0
  const check = (name: string, value: unknown) => { assert.ok(value, name); checks++; console.log('PASS ' + vendor + ' ' + name) }
  const signal = new AbortController().signal
  const publicKey = 'ssh-ed25519 Zml4dHVyZS1wdWJsaWM= fixture'
  try {
    const registry = await import(f.root + '/src/services/host/vendors/client.ts')
    check('registered vendor', registry.HOST_VENDORS.includes(vendor))
    const info = await import(f.root + '/src/services/host/vendors/vendor.ts')
    check('the vendor carries no boot stamp', !('booted' in info.HOST_VENDOR_INFO[vendor]) && !('vendorStamp' in info))
    const module = await import(f.root + '/src/services/host/vendors/' + vendor + '.ts')
    const Client = module[{ hyperstack: 'HyperstackClient', verda: 'VerdaClient', digitalocean: 'DigitalOceanClient' }[vendor]!]
    const api = new Client(fixture.key, fixture.baseUrl, { readyTimeoutMs: 80, pollMs: 2, requestTimeoutMs: 1000 })
    const label = api.label
    assert.throws(() => new Client(fixture.key, 'https://unexpected.invalid/v1'), /official API URL/)
    await assert.rejects(() => new Client(vendor === 'verda' ? 'bad:bad' : 'bad', fixture.baseUrl).pods(), /HTTP 401/)
    check('bad key never creates a machine', fixture.state.creates === 0)
    check('account check is read-only', (await api.pods(signal)).length === 0 && fixture.state.creates === 0)
    let offers = await api.offers(signal)
    const recipeId = vendor === 'digitalocean' ? 'qwen38-27b-h200' : 'qwen38-27b-rtx-pro-6000'
    const offer = offers.find((row: any) => row.recipe.id === recipeId)!
    check('shipped recipe has regional stock', offer?.dataCenter && offer.price > 0)
    const expected = vendor === 'hyperstack' ? 1.85 + 0.00672043 : vendor === 'verda' ? 2.492 : 4.47
    check('whole-instance hourly compute price', Math.abs(offer.price - expected) < 1e-8)
    if (vendor === 'hyperstack') check('only real H200 and B200 eight-GPU configurations', offers.some((row: any) => row.recipe.gpu === 'B200') && offers.filter((row: any) => ['H200', 'B200', 'B300'].includes(row.recipe.gpu)).every((row: any) => row.recipe.count === 8))
    if (vendor === 'verda') check('268 GB B300 is never inflated to 288 GB', !offers.some((row: any) => row.recipe.gpu === 'B300') && api.offersNote().includes('268'))
    if (vendor === 'digitalocean') check('no invented B200 or on-demand B300 stock', !offers.some((row: any) => ['B200', 'B300'].includes(row.recipe.gpu)) && api.offersNote().includes('B200'))
    check('watch obeys exact price ceiling', (await api.watchOffer(offer.recipe, offer.price, signal))?.price === offer.price && !(await api.watchOffer(offer.recipe, offer.price - 0.001, signal)))
    fixture.state.noStock = true
    check('no stock is not a rentable offer', !(await api.offers(signal)).length && api.shapes().every((row: any) => row.availability === 'NONE'))
    fixture.state.noStock = false
    offers = await api.offers(signal)
    const chosen = offers.find((row: any) => row.recipe.id === recipeId)!
    await assert.rejects(() => api.create({ ...chosen }, publicKey, 'copied'), /unchanged/)
    await assert.rejects(() => api.create(chosen, 'invalid-key', 'invalid-key'), /OpenSSH/)
    check('unbound offer and invalid SSH key send no create', fixture.state.creates === 0)
    fixture.state.createStatus = 400
    const refused = await api.create(chosen, publicKey, 'refused').catch((e: any) => e)
    check('create refusal is definite and not retried', refused.outcome === 'refused' && fixture.state.creates === 1 && fixture.state.pods.size === 0 && !refused.message.includes(fixture.key))
    fixture.state.createStatus = 0
    const pod = await api.create(chosen, publicKey, 'fixture-lifecycle')
    const ready = await api.get(pod.id)
    check('ready returns direct SSH', ready.status === 'RUNNING' && ready.ssh.direct.username === (vendor === 'hyperstack' ? 'ubuntu' : 'root') && ready.ssh.direct.port === 22)
    check('SSH registration is reused', fixture.state.keyCreates === 1)
    if (vendor === 'verda') fixture.state.jsonCreate = true
    const sibling = await api.create(chosen, publicKey, 'fixture-sibling')
    if (vendor === 'verda') fixture.state.jsonCreate = false
    check('complete account listing includes every instance', (await api.pods()).length === 2)
    await api.terminate(sibling.id)
    check('deleting one instance preserves its sibling', (await api.pods()).length === 1 && fixture.state.pods.has(pod.id))
    check('logs are truthful', /ready|SSH/.test(await api.logs(pod.id)))
    if (vendor === 'hyperstack') {
      const instance = fixture.state.pods.get(pod.id)
      for (const [status, cost] of [['SHUTOFF', chosen.price], ['HIBERNATED', 0.00672043], ['ERROR', 0], ['CREATING', 0]] as const) {
        instance.status = status
        check(status + ' current compute/IP rate follows provider billing', Math.abs((await api.pods()).find((row: any) => row.id === pod.id).cost - cost) < 1e-8)
      }
      instance.status = 'ACTIVE'
      fixture.state.refuseCreating = true; fixture.state.bootReads = 3
      const starting = await api.create(chosen, publicKey, 'still-creating')
      const deletes = fixture.state.deletes
      await api.terminate(starting.id)
      check('creation-state delete refusal is read back before retry', fixture.state.deletes > deletes + 1 && !fixture.state.pods.has(starting.id))
      fixture.state.refuseCreating = false; fixture.state.bootReads = 1
    }
    if (vendor === 'verda') {
      fixture.state.expiresIn = 1
      const refreshing = new Client(fixture.key, fixture.baseUrl)
      const before = fixture.state.tokenReads
      await refreshing.pods(); await refreshing.pods()
      check('OAuth refreshes an expiring token without a paid replay', fixture.state.tokenReads === before + 2)
      fixture.state.expiresIn = 3600
      const sent = fixture.requests.find((request: any) => request.method === 'POST' && request.path === '/v1/instances' && request.body.hostname === 'fixture-lifecycle')
      check('fixed-price creation allocates only the recipe-sized root disk', sent.body.os_volume.size === chosen.recipe.diskGb && !sent.body.existing_volumes && !sent.body.volumes)
    }
    await assert.rejects(() => api.stop(pod.id), /terminate|termination/i)
    fixture.state.holdTerminate = true
    await assert.rejects(() => api.terminate(pod.id), /not verified|still lists/)
    check('held delete cannot report absence', fixture.state.pods.size === 1)
    fixture.state.holdTerminate = false
    if (vendor === 'verda') {
      fixture.state.holdVolume = true
      await assert.rejects(() => api.terminate(pod.id), /not verified|still lists/)
      check('remaining root storage prevents a false clean deletion', fixture.state.volumes.size === 1)
      fixture.state.volumes.clear(); fixture.state.holdVolume = false
    }
    await api.terminate(pod.id)
    check('termination verified by fresh complete list', !(await api.pods()).some((row: any) => row.id === pod.id))
    await assert.rejects(() => api.get(pod.id), /HTTP 404/)
    check('missing pod is not fabricated', true)
    fixture.state.badList = true
    await assert.rejects(() => api.pods(), /shape|incomplete/)
    fixture.state.badList = false
    check('malformed account list is not an empty account', true)
    const uncertain = await makeFixture()
    try {
      uncertain.state.ambiguousCreate = true
      const client = new Client(uncertain.key, uncertain.baseUrl, { pollMs: 2, requestTimeoutMs: 1000 })
      const row = (await client.offers(signal)).find((item: any) => item.recipe.id === recipeId)!
      const error = await client.create(row, publicKey, 'uncertain').catch((e: any) => e)
      check('lost create response remains ambiguous', error.outcome === 'ambiguous' && uncertain.state.creates === 1)
      await assert.rejects(() => client.create(row, publicKey, 'again'), /No new rental|no new rental/)
      check('ambiguous create is never replayed', uncertain.state.creates === 1)
    } finally { await uncertain.close() }

    const React = await import('react')
    const { Box } = await import('../../src/ink.ts')
    const { AppStateProvider } = await import('../../src/state/AppState.tsx')
    const { ThemeProvider } = await import('../../src/components/design-system/ThemeProvider.tsx')
    const { KeybindingSetup } = await import('../../src/keybindings/KeybindingProviderSetup.tsx')
    const { SettingsPopupSlot } = await import('../../src/components/SettingsPopupSlot.tsx')
    const popup = await import('../../src/utils/cockpit/settingsPopup.ts')
    const { llmHostPopupRequest } = await import('../../src/commands/llmhost/llmhost.tsx')
    const { createHostRoad } = await import(f.root + '/src/services/host/index.ts')
    const { hostRunner } = await import(f.root + '/src/services/host/ssh.ts')
    const { runHostJob } = await import(f.root + '/src/services/host/worker.ts')
    const { hostRecords } = await import(f.root + '/src/services/host/store.ts')
    const { configuredCompatEndpoints } = await import(f.root + '/src/services/providers/openaicompat/compatAccounts.ts')
    ssh = fakeSshRunner(f.baseUrl, hostRunner)
    const runner = { ...ssh.runner, run: async (...args: Parameters<typeof hostRunner.run>) => args[0] === 'ssh' && args[1].at(-1)?.includes('nvidia-smi') ? 'NVIDIA H200, 144384\nDOCKER_ENGINE_PRESENT\n' : ssh!.runner.run(...args) }
    const jobs: Promise<void>[] = []
    const road = createHostRoad({ vendorApiBaseUrls: { [vendor]: fixture.baseUrl }, runner, pauseMs: 5, readyTimeoutMs: 2000, sessionId: vendor + '-fixture', startJob: (record: any) => jobs.push(runHostJob(record.id, record.generation, { runner, pauseMs: 5, timeoutMs: 3000, keepAlive: false })) })
    mounted = await mountOffscreen(React.createElement(AppStateProvider, {}, React.createElement(ThemeProvider, {}, React.createElement(KeybindingSetup, {}, React.createElement(Box, { flexDirection: 'column', width: 120, height: 44 }, React.createElement(SettingsPopupSlot))))), 120, 44)
    const until = async (needle: string) => assert.ok(await waitFor(() => mounted!.screen().includes(needle), 20000), 'screen reaches ' + needle + '\n' + mounted!.screen())
    const choose = async (needle: string) => {
      for (let n = 0; n < 100; n++) {
        const selected = mounted!.lines().find(line => line.includes('› ')) ?? ''
        if (selected.includes(needle)) { mounted!.push(KEY.enter); return }
        mounted!.push(KEY.down)
        assert.ok(await waitFor(() => (mounted!.lines().find(line => line.includes('› ')) ?? '') !== selected, 3000), 'selection advances to ' + needle + '\n' + mounted!.screen())
      }
      throw new Error('Choice not found: ' + needle)
    }
    const at = process.argv.indexOf('--frames')
    const frames = at >= 0 ? process.argv[at + 1] : undefined
    const capture = async (name: string) => {
      if (!frames) return
      mkdirSync(frames, { recursive: true })
      writeFileSync(join(frames, vendor + '-' + name + '.txt'), mounted!.screen())
      const grid = mounted!.lines().map((line, y) => Array.from(line.padEnd(120)).map((c, x) => ({ c, bg: mounted!.styleAt(x, y)?.bg ?? 'default', fg: mounted!.styleAt(x, y)?.fg ?? 'default', bold: mounted!.styleAt(x, y)?.bold ?? false })))
      const file = join(frames, vendor + '-' + name + '.json')
      writeFileSync(file, JSON.stringify({ grid, cols: 120, rows: 44 })); await gridToPng(file, join(frames, vendor + '-' + name + '.png'))
    }
    popup.openSettingsPopup(llmHostPopupRequest(road)); await until('Which model?'); await choose('Qwen3.8-27B'); await until('WEIGHTS'); await capture('connect-row')
    await choose('Connect ' + label); await until(label + ' API key'); await capture('connect')
    const keyHelp = { hyperstack: 'Create a key at https://console.hyperstack.cloud/api-keys.', verda: 'API Credentials at https://console.verda.com · paste Client ID:Client Secret.', digitalocean: 'Create a token at https://cloud.digitalocean.com/account/api/tokens with Droplet, size, image, region and SSH-key access.' }[vendor]!
    check('connect says where to create the credential and what to paste without quota narration', mounted.screen().replace(/[│\s]+/g, ' ').includes(keyHelp) && !mounted.screen().includes('quotas'))
    mounted.push(fixture.key); await until('********'); mounted.push(KEY.enter)
    await until('Rent · ' + label); await capture('offer')
    check('the offer row carries no boot stamp', !mounted.screen().includes('not yet booted') && !mounted.screen().includes('verified on a live rental'))
    const before = fixture.state.creates
    await choose('Rent · ' + label); await until('Confirm the hourly price'); await capture('confirm')
    const screen = mounted.screen().replace(/[│\s]+/g, ' ')
    check('confirmation names storage, the account SSH key and billing before creating a machine', fixture.state.creates === before && screen.includes(vendor === 'verda' ? 'Root disk: $0.20/GiB-month; Terminate deletes it.' : 'Local disk included; Terminate deletes it.') && screen.includes('Adds an SSH key') && screen.includes('Billing starts now and continues after closing.'))
    if (vendor === 'verda') check('the confirmation says the egress price is unavailable', screen.includes('Egress price unavailable.'))
    await choose('Confirm $'); await until('Machine controls')
    check('worker reaches ready and registers model', await waitFor(() => hostRecords().some((row: any) => row.vendor === vendor && row.jobState === 'ready'), 15000))
    const record = hostRecords().find((row: any) => row.vendor === vendor && row.jobState === 'ready')!
    check('VM engine actually launches in Docker', ssh.commands.some((row: any) => row.args?.at(-1)?.includes('docker run --rm --gpus all')) && configuredCompatEndpoints().some((row: any) => row.name === record.provider))
    check('no misleading stop control', !mounted.screen().includes('Stop ·'))
    await choose('Terminate'); await until('Confirm terminate'); await choose('Confirm terminate'); await until('Machine terminated')
    check('popup termination also verifies absence', fixture.state.pods.size === 0 && !hostRecords().some((row: any) => row.id === record.id))
    await Promise.all(jobs)
    const secrets = await import(f.root + '/src/services/providers/providerSecrets.ts')
    check('key is private and independently removable', ownerOnlyFile(secrets.providerSecretsPathForDisplay()) && registry.vendorKey(vendor) === fixture.key)
    registry.saveVendorKey(vendor, null)
    check('removed key is gone', registry.vendorKey(vendor) === undefined)
    console.log(vendor.toUpperCase() + ' DRIVE GREEN — ' + checks + ' checks; fixtures only; no live rental')
  } finally {
    mounted?.unmount(); (await import('../../src/keybindings/loadUserBindings.ts')).disposeKeybindingWatcher(); ssh?.close(); await fixture.close(); f.close(); globalThis.fetch = originalFetch
  }
}
