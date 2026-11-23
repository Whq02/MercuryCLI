#!/usr/bin/env bun
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

let failures = 0
const faultHints: Array<[string, string]> = [
  ['tensorfoldHelper-', 'change helperServedRecord or stopHelperServing in src/models/roads/local/tensorfoldHelper.ts to reject on a failed served read or stop and keep helperProcess so a retry stops it'],
  ['tensorfoldHosts-', 'change rememberTensorFoldHost or rememberTensorFoldPort in src/models/roads/local/tensorfoldHosts.ts to refuse, and leave the file untouched, when tensorfold-hosts.json is corrupt or unreadable'],
  ['tensorfoldState-', 'change readTensorFoldState or tensorFoldPresenceCached in src/models/roads/local/tensorfoldState.ts to reject or throw when a served, discovery or presence read fails'],
  ['tensorfoldUsage-', 'change tensorFoldServing in src/models/roads/local/tensorfoldUsage.ts to answer undefined when a served or hosts read throws'],
  ['localLiveness-', 'change recordLocalIngestPace in src/models/roads/localLiveness.ts to remove its temp file when the rename fails'],
  ['metaAccounts-', 'change readMetaMuseCodeGrant in src/models/roads/meta/metaAccounts.ts to call logError with the reason when .meta-auth.json is corrupt or unreadable, and log nothing when absent'],
  ['minimaxUsageState-', 'change fetchMinimaxPlanUsage in src/models/roads/minimax/minimaxUsageState.ts to report invalid on an HTTP 200 body that is not JSON'],
  ['moonshotUsageState-', 'change refreshKimiManagedUsage in src/models/roads/moonshot/moonshotUsageState.ts to record the thrown credential error for kimiManagedUsageError'],
  ['nousCallModel-', 'change nousLaneProfile.resolveCredential in src/models/roads/nous/nousCallModel.ts to reject on a credential read error and return undefined only when absent'],
  ['nousClientContract-', 'change peekNousClient in src/models/roads/nous/nousClientContract.ts to heal torn JSON, keep an unreadable file byte-identical, and return learned false when it cannot write'],
  ['nousUsageState-', 'change refreshNousAccount in src/models/roads/nous/nousUsageState.ts to record an unreachable failure carrying the thrown credential error'],
]
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  const hint = cond ? '' : (faultHints.find(([prefix]) => label.startsWith(prefix))?.[1] ?? '')
  const said = [detail, hint].filter(Boolean).join(' | ')
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && said ? ` — ${said}` : ''}`)
}
function skip(label: string, why: string): void {
  console.log(`  [SKIP] ${label} — ${why}`)
}

const HERE = dirname(fileURLToPath(import.meta.url))
const BUN = process.execPath.includes('bun') ? process.execPath : join(process.env.HOME ?? '', '.bun/bin/bun')
const SRC = process.env.PROVE_SRC ?? join(HERE, '../../src')
const POSIX_MODES = process.platform !== 'win32' && (typeof process.getuid !== 'function' || process.getuid() !== 0)

function runScenario(body: string, extraEnv: Record<string, string> = {}): Record<string, unknown> {
  const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'faults-fn18-')))
  const home = join(scratch, 'home')
  const project = join(scratch, 'project')
  for (const dir of [home, project]) mkdirSync(dir, { recursive: true })
  const src = `
    process.env.MERCURY_CONFIG_DIR = ${JSON.stringify(home)}
    process.env.MERCURY_CREDENTIAL_STORE = 'file'
    process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
    process.env.NODE_ENV = 'test'
    delete process.env.MERCURY_HOME
    globalThis.MACRO = { VERSION: '1.0.0' }
    process.chdir(${JSON.stringify(project)})
    const HOME = ${JSON.stringify(home)}
    const SCRATCH = ${JSON.stringify(scratch)}
    const SRC = ${JSON.stringify(SRC)}
    const out = {}
    ${body}
    process.stdout.write('\\n' + JSON.stringify(out))
    process.exit(0)
  `
  try {
    const res = spawnSync(BUN, ['-e', src], {
      encoding: 'utf8',
      env: { ...process.env, MERCURY_CONFIG_DIR: home, MERCURY_HOME: '', MERCURY_CREDENTIAL_STORE: 'file', ...extraEnv },
    })
    if (res.status !== 0) throw new Error(`scenario failed: ${res.stderr.slice(-1500)}`)
    return JSON.parse(res.stdout.trim().split('\n').pop() ?? '{}') as Record<string, unknown>
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
}

console.log('\ntensorfoldHelper — failed served read and failed stop reject and keep helperProcess for retry')
{
  const r = runScenario(`
    const path = await import('node:path')
    const { mock } = await import('bun:test')
    const helper = await import(path.join(SRC, 'services/providers/local/tensorfoldHelper.ts'))
    let serveFails = true
    let stop2bCalls = 0
    let stop2bFails = true
    helper.__pinHelperServeSeamForTest(() => ({
      start: async () => { throw new Error('unused') },
      stop: async () => {
        stop2bCalls++
        if (stop2bFails) throw new Error('stop-2b-boom')
      },
      served: () => {
        if (serveFails) throw new Error('served-read-boom')
        return [{ repo: helper.HELPER_2B_REPO, name: helper.HELPER_2B_NAME, port: 43210, window: helper.HELPER_2B_WINDOW, pid: 99999 }]
      },
    }))
    helper.__pinHelperProcessForTest({ size: '2b', port: 43210, modelId: 'local/qwen3.5-2b' })
    out.servedReadThrew = (() => { try { helper.helperServedRecord(); return null } catch (e) { return String(e?.message ?? e) } })()
    out.stopOnServedFail = await helper.stopHelperServing().then(() => null, e => String(e?.message ?? e))
    serveFails = false
    out.stop2bFirstFail = await helper.stopHelperServing().then(() => null, e => String(e?.message ?? e))
    stop2bFails = false
    out.stop2bRetry = await helper.stopHelperServing().then(() => null, e => String(e?.message ?? e))
    out.stop2bCalls = stop2bCalls

    mock.module(path.join(SRC, 'services/projectServices/serviceManager.js'), () => ({
      liveServiceChildren: () => [{ pid: 77777 }],
    }))
    let stop4bCalls = 0
    let stop4bFails = true
    helper.__pinHelperProcessForTest({
      size: '4b',
      port: 43211,
      modelId: 'local/qwen3.5-4b',
      pid: 77777,
      stop: async () => {
        stop4bCalls++
        if (stop4bFails) throw new Error('stop-4b-boom')
      },
    })
    out.stop4bFirstFail = await helper.stopHelperServing().then(() => null, e => String(e?.message ?? e))
    stop4bFails = false
    out.stop4bRetry = await helper.stopHelperServing().then(() => null, e => String(e?.message ?? e))
    out.stop4bCalls = stop4bCalls
  `)
  check('tensorfoldHelper-served-read-throws: helperServedRecord throws when served() fails', r.servedReadThrew === 'served-read-boom', JSON.stringify(r.servedReadThrew))
  check('tensorfoldHelper-stop-2b-retry: failed served read and failed 2b stop reject and keep helperProcess so retry stops it', r.stopOnServedFail === 'served-read-boom' && r.stop2bFirstFail === 'stop-2b-boom' && r.stop2bRetry === null && r.stop2bCalls === 2, JSON.stringify({ stopOnServedFail: r.stopOnServedFail, stop2bFirstFail: r.stop2bFirstFail, stop2bRetry: r.stop2bRetry, stop2bCalls: r.stop2bCalls }))
  check('tensorfoldHelper-stop-4b-retry: failed 4b stop rejects and keeps helperProcess so retry stops it', r.stop4bFirstFail === 'stop-4b-boom' && r.stop4bRetry === null && r.stop4bCalls === 2, JSON.stringify({ stop4bFirstFail: r.stop4bFirstFail, stop4bRetry: r.stop4bRetry, stop4bCalls: r.stop4bCalls }))
}

console.log('\ntensorfoldHosts — writers refuse to overwrite an unreadable or corrupt hosts store')
{
  const r = runScenario(`
    const fs = await import('node:fs')
    const path = await import('node:path')
    const hosts = await import(path.join(SRC, 'services/providers/local/tensorfoldHosts.ts'))
    const store = path.join(HOME, 'local-setup', 'tensorfold-hosts.json')
    fs.mkdirSync(path.dirname(store), { recursive: true })
    const torn = '{ torn-json'
    fs.writeFileSync(store, torn, { mode: 0o600 })
    out.corruptHost = await hosts.rememberTensorFoldHost({ name: 'box', baseUrl: 'http://127.0.0.1:8080', origin: 'typed' }).then(() => null, e => String(e?.message ?? e))
    out.corruptPort = (() => { try { hosts.rememberTensorFoldPort(8081); return null } catch (e) { return String(e?.message ?? e) } })()
    out.corruptSame = fs.readFileSync(store, 'utf8') === torn
    if (${JSON.stringify(POSIX_MODES)}) {
      const valid = JSON.stringify({ version: 1, hosts: [{ name: 'kept', baseUrl: 'http://127.0.0.1:9000', origin: 'typed' }], ports: [9000] })
      fs.writeFileSync(store, valid, { mode: 0o600 })
      fs.chmodSync(store, 0o200)
      out.unreadableHost = await hosts.rememberTensorFoldHost({ name: 'other', baseUrl: 'http://127.0.0.1:8080', origin: 'typed' }).then(() => null, e => String(e?.code ?? e?.message ?? e))
      out.unreadablePort = (() => { try { hosts.rememberTensorFoldPort(8081); return null } catch (e) { return String(e?.code ?? e?.message ?? e) } })()
      fs.chmodSync(store, 0o600)
      out.unreadableSame = fs.readFileSync(store, 'utf8') === valid
    } else {
      out.unreadableHost = 'skip'
      out.unreadablePort = 'skip'
      out.unreadableSame = true
    }
  `)
  check('tensorfoldHosts-corrupt-kept: writers refuse and keep corrupt tensorfold-hosts.json intact', r.corruptHost !== null && r.corruptPort !== null && r.corruptSame === true, JSON.stringify({ corruptHost: r.corruptHost, corruptPort: r.corruptPort, corruptSame: r.corruptSame }))
  if (!POSIX_MODES) skip('tensorfoldHosts-unreadable-kept', 'mode 0200 needs non-root POSIX')
  else check('tensorfoldHosts-unreadable-kept: writers refuse and keep unreadable tensorfold-hosts.json intact', r.unreadableHost === 'EACCES' && r.unreadablePort === 'EACCES' && r.unreadableSame === true, JSON.stringify({ unreadableHost: r.unreadableHost, unreadablePort: r.unreadablePort, unreadableSame: r.unreadableSame }))
}

console.log('\ntensorfoldState — failed served/discovery/presence reads reject instead of answering empty')
{
  const r = runScenario(`
    const path = await import('node:path')
    const { mock } = await import('bun:test')
    mock.module(path.join(SRC, 'services/tensorfold/serve.js'), () => ({
      servedTensorFold: () => { throw new Error('serve-read-boom') },
    }))
    mock.module(path.join(SRC, 'services/providers/local/localDiscovery.js'), () => ({
      getCachedLocalDiscovery: () => null,
      refreshLocalDiscovery: async () => { throw new Error('discovery-refresh-boom') },
    }))
    const state = await import(path.join(SRC, 'services/providers/local/tensorfoldState.ts'))
    out.servedReject = await state.readTensorFoldState({
      engine: async () => null,
      snapshot: async () => ({ probedAtMs: 1, targetCount: 0, servers: [] }),
      hosts: () => [],
      app: async () => ({ running: false }),
      helper: () => ({ enabled: false }),
      exited: async () => undefined,
    }).then(() => null, e => String(e?.message ?? e))
    out.discoveryReject = await state.readTensorFoldState({
      engine: async () => null,
      served: () => [],
      hosts: () => [],
      app: async () => ({ running: false }),
      helper: () => ({ enabled: false }),
      exited: async () => undefined,
    }).then(() => null, e => String(e?.message ?? e))
    out.installedThrow = (() => { try { state.tensorFoldPresenceCached({ installed: () => { throw new Error('installed-boom') }, snapshot: () => null, hosts: () => [] }); return null } catch (e) { return String(e?.message ?? e) } })()
    out.hostsThrow = (() => { try { state.tensorFoldPresenceCached({ installed: () => false, snapshot: () => null, hosts: () => { throw new Error('hosts-boom') } }); return null } catch (e) { return String(e?.message ?? e) } })()
  `)
  check('tensorfoldState-served-rejects: readTensorFoldState rejects when servedTensorFold throws', r.servedReject === 'serve-read-boom', JSON.stringify(r.servedReject))
  check('tensorfoldState-discovery-rejects: readTensorFoldState rejects when refreshLocalDiscovery rejects', r.discoveryReject === 'discovery-refresh-boom', JSON.stringify(r.discoveryReject))
  check('tensorfoldState-presence-throws: tensorFoldPresenceCached throws when installed or hosts fails', r.installedThrow === 'installed-boom' && r.hostsThrow === 'hosts-boom', JSON.stringify({ installedThrow: r.installedThrow, hostsThrow: r.hostsThrow }))
}

console.log('\ntensorfoldUsage — failed served or hosts read answers undefined instead of absent')
{
  const r = runScenario(`
    const path = await import('node:path')
    const usage = await import(path.join(SRC, 'services/providers/local/tensorfoldUsage.ts'))
    const empty = () => ({ probedAtMs: 1, targetCount: 0, servers: [] })
    out.servedFailed = (() => {
      try {
        return { value: usage.tensorFoldServing('local/tensorfold/qwen3.5-2b', { snapshot: empty, served: () => { throw new Error('served-boom') }, hosts: () => [], turns: () => [] }) ?? null }
      } catch (e) {
        return { threw: String(e?.message ?? e) }
      }
    })()
    out.hostsFailed = (() => {
      try {
        return { value: usage.tensorFoldServing('local/tensorfold/qwen3.5-2b', { snapshot: empty, served: () => [], hosts: () => { throw new Error('hosts-boom') }, turns: () => [] }) ?? null }
      } catch (e) {
        return { threw: String(e?.message ?? e) }
      }
    })()
  `)
  check('tensorfoldUsage-served-failed-undefined: throwing served read returns undefined instead of absent', JSON.stringify(r.servedFailed) === JSON.stringify({ value: null }), JSON.stringify(r.servedFailed))
  check('tensorfoldUsage-hosts-failed-undefined: throwing hosts read returns undefined instead of absent', JSON.stringify(r.hostsFailed) === JSON.stringify({ value: null }), JSON.stringify(r.hostsFailed))
}

console.log('\nlocalLiveness — failed pace store rename cleans up its temp file')
{
  const r = runScenario(`
    const fs = await import('node:fs')
    const path = await import('node:path')
    const live = await import(path.join(SRC, 'services/providers/localLiveness.ts'))
    const storePath = live.localPaceStorePath()
    fs.mkdirSync(storePath, { recursive: true })
    live.recordLocalIngestPace({ wireModel: 'qwen3-8b', promptTokens: 5000, ingestMs: 10000 })
    out.leftovers = fs.readdirSync(HOME).filter(name => name.startsWith(live.LOCAL_PACE_STORE_FILE + '.'))
  `)
  check('localLiveness-pace-tmp-cleaned: failed rename leaves no temp file behind', Array.isArray(r.leftovers) && r.leftovers.length === 0, JSON.stringify(r.leftovers))
}

console.log('\nmetaAccounts — corrupt or unreadable .meta-auth.json is reported via logError instead of silently passing over')
{
  const r = runScenario(`
    const fs = await import('node:fs')
    const path = await import('node:path')
    const { mock } = await import('bun:test')
    const logged = []
    mock.module(path.join(SRC, 'utils/log.js'), () => ({
      logError: e => logged.push(e instanceof Error ? e.message : String(e)),
    }))
    const meta = await import(path.join(SRC, 'services/providers/meta/metaAccounts.ts'))
    const authFile = meta.metaAuthPathForDisplay()
    out.absentGrant = meta.readMetaMuseCodeGrant() ?? null
    out.absentLogged = logged.length
    fs.mkdirSync(path.dirname(authFile), { recursive: true })
    fs.writeFileSync(authFile, '{ torn', { mode: 0o600 })
    out.corruptGrant = meta.readMetaMuseCodeGrant() ?? null
    out.corruptLogged = [...logged]
    if (${JSON.stringify(POSIX_MODES)}) {
      fs.writeFileSync(authFile, JSON.stringify({ version: 1 }), { mode: 0o600 })
      fs.chmodSync(authFile, 0o200)
      out.unreadableGrant = meta.readMetaMuseCodeGrant() ?? null
      fs.chmodSync(authFile, 0o600)
      out.unreadableLogged = [...logged]
    } else {
      out.unreadableGrant = null
      out.unreadableLogged = ['skip']
    }
  `)
  check('metaAccounts-corrupt-logged: absent logs nothing, corrupt .meta-auth.json logs reason via logError', r.absentGrant === null && r.absentLogged === 0 && r.corruptGrant === null && Array.isArray(r.corruptLogged) && r.corruptLogged.some(m => String(m).includes('.meta-auth.json') && String(m).includes('not valid JSON')), JSON.stringify({ absentLogged: r.absentLogged, corruptLogged: r.corruptLogged }))
  if (!POSIX_MODES) skip('metaAccounts-unreadable-logged', 'mode 0200 needs non-root POSIX')
  else check('metaAccounts-unreadable-logged: unreadable .meta-auth.json logs error via logError', r.unreadableGrant === null && Array.isArray(r.unreadableLogged) && r.unreadableLogged.length >= 2 && r.unreadableLogged.some(m => String(m).includes('.meta-auth.json') && /EACCES|permission/i.test(String(m))), JSON.stringify(r.unreadableLogged))
}

console.log('\nminimaxUsageState — non-JSON HTTP 200 plan read reports invalid instead of no-plan')
{
  const r = runScenario(`
    const path = await import('node:path')
    const usage = await import(path.join(SRC, 'services/providers/minimax/minimaxUsageState.ts'))
    usage.__resetMinimaxUsageForTest()
    const probe = await usage.fetchMinimaxPlanUsage('sk-minimax-fixture', {
      env: { MINIMAX_API_KEY: 'sk-minimax-fixture' },
      fetchImpl: async () => new Response('<html>gateway error</html>', { status: 200, headers: { 'content-type': 'text/html' } }),
    })
    out.probeState = probe.state
    out.observed = usage.minimaxObservedPlanUsage({ MINIMAX_API_KEY: 'sk-minimax-fixture' })
  `)
  check('minimaxUsageState-non-json-200-invalid: HTTP 200 non-JSON reports invalid instead of no-plan', r.probeState === 'invalid' && (r.observed as { failure?: { kind?: string }; plan?: string })?.failure?.kind === 'invalid' && (r.observed as { plan?: string })?.plan !== 'none', JSON.stringify(r))
}

console.log('\nmoonshotUsageState — refreshKimiManagedUsage records error when credential resolution throws')
{
  const r = runScenario(`
    const path = await import('node:path')
    const { mock } = await import('bun:test')
    const real = await import(path.join(SRC, 'services/providers/moonshot/moonshotAccounts.ts'))
    mock.module(path.join(SRC, 'services/providers/moonshot/moonshotAccounts.js'), () => ({
      ...real,
      moonshotStoredTokens: () => ({ accessToken: 'at-fixture', refreshToken: 'rt-fixture' }),
      resolveMoonshotDispatchCredential: async () => { throw new Error('token-refresh-boom') },
    }))
    const usage = await import(path.join(SRC, 'services/providers/moonshot/moonshotUsageState.ts'))
    usage.__resetMoonshotUsageForTest()
    await usage.refreshKimiManagedUsage({ force: true })
    out.error = usage.kimiManagedUsageError() ?? null
  `)
  check('moonshotUsageState-refresh-records-error: kimiManagedUsageError records thrown credential error', typeof r.error === 'string' && r.error.includes('token-refresh-boom'), JSON.stringify(r.error))
}

console.log('\nnousCallModel — resolveCredential rejects when credential read throws and returns undefined when absent')
{
  const r = runScenario(`
    const path = await import('node:path')
    const { mock } = await import('bun:test')
    const real = await import(path.join(SRC, 'services/providers/nous/nousAccounts.ts'))
    let mode = 'throw'
    mock.module(path.join(SRC, 'services/providers/nous/nousAccounts.js'), () => ({
      ...real,
      resolveNousCredential: async () => {
        if (mode === 'throw') throw new Error('nous-cred-boom')
        return undefined
      },
    }))
    const mod = await import(path.join(SRC, 'services/providers/nous/nousCallModel.ts'))
    out.rejected = await Promise.resolve(mod.nousLaneProfile.resolveCredential()).then(() => null, e => String(e?.message ?? e))
    mode = 'absent'
    out.absent = (await Promise.resolve(mod.nousLaneProfile.resolveCredential())) ?? null
  `)
  check('nousCallModel-resolve-credential-throws: resolveCredential rejects with credential read error and returns undefined when absent', r.rejected === 'nous-cred-boom' && r.absent === null, JSON.stringify(r))
}

console.log('\nnousClientContract — unreadable file is not overwritten, torn content heals, and failed write returns learned=false')
{
  const r = runScenario(`
    const fs = await import('node:fs')
    const path = await import('node:path')
    const contract = await import(path.join(SRC, 'services/providers/nous/nousClientContract.ts'))
    const file = contract.nousClientContractPath()
    const env = { ...process.env, MERCURY_NOUS_CLIENT_SOURCE_BASE: 'http://127.0.0.1:9999' }
    const fakeFetch = async url => {
      if (String(url).includes('/releases/latest')) return new Response(JSON.stringify({ tag_name: 'v9.9.9' }), { status: 200 })
      return new Response('DEFAULT_NOUS_CLIENT_ID = "hermes-next"\\nNOUS_INFERENCE_INVOKE_SCOPE = "inference:invoke"\\n', { status: 200 })
    }
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, '{ torn', { mode: 0o600 })
    const healed = await contract.peekNousClient({ env, fetchImpl: fakeFetch, force: true, now: () => 1_700_000_000_000 })
    out.healedLearned = healed.kind === 'read' && healed.learned === true && contract.readNousClientRecord().learned?.clientId === 'hermes-next'
    if (${JSON.stringify(POSIX_MODES)}) {
      const kept = JSON.stringify({ version: 1, learned: { clientId: 'kept-client', scope: 'inference:invoke', release: '1.0.0', learnedAtMs: 1, from: 'http://127.0.0.1' } }) + '\\n'
      fs.writeFileSync(file, kept, { mode: 0o600 })
      fs.chmodSync(file, 0o200)
      const unread = await contract.peekNousClient({ env, fetchImpl: fakeFetch, force: true, now: () => 1_700_000_001_000 })
      fs.chmodSync(file, 0o600)
      out.unreadableSame = fs.readFileSync(file, 'utf8') === kept
      out.unreadableLearned = unread.kind === 'read' ? unread.learned : 'not-read'

      fs.rmSync(file, { force: true })
      fs.chmodSync(path.dirname(file), 0o500)
      const writeFailed = await contract.peekNousClient({ env, fetchImpl: fakeFetch, force: true, now: () => 1_700_000_002_000 })
      fs.chmodSync(path.dirname(file), 0o700)
      out.writeFailedLearned = writeFailed.kind === 'read' ? writeFailed.learned : 'not-read'
    } else {
      out.unreadableSame = true
      out.unreadableLearned = false
      out.writeFailedLearned = false
    }
  `)
  check('nousClientContract-torn-heals: torn JSON is replaced by the next learned contract', r.healedLearned === true, JSON.stringify(r.healedLearned))
  if (!POSIX_MODES) skip('nousClientContract-unreadable-and-write-fail', 'mode 0200/0500 needs non-root POSIX')
  else {
    check('nousClientContract-unreadable-kept: unreadable contract file stays byte-identical and returns learned=false', r.unreadableSame === true && r.unreadableLearned === false, JSON.stringify({ unreadableSame: r.unreadableSame, unreadableLearned: r.unreadableLearned }))
    check('nousClientContract-write-fail-not-learned: failed write returns learned=false', r.writeFailedLearned === false, JSON.stringify(r.writeFailedLearned))
  }
}

console.log('\nnousUsageState — refreshNousAccount records failure when credential resolution throws')
{
  const r = runScenario(`
    const path = await import('node:path')
    const { mock } = await import('bun:test')
    const real = await import(path.join(SRC, 'services/providers/nous/nousAccounts.ts'))
    mock.module(path.join(SRC, 'services/providers/nous/nousAccounts.js'), () => ({
      ...real,
      nousAccountIdentity: () => 'fixture-nous-id',
      resolveNousCredential: async () => { throw new Error('nous-usage-cred-boom') },
    }))
    const usage = await import(path.join(SRC, 'services/providers/nous/nousUsageState.ts'))
    usage.__resetNousUsageForTest()
    await usage.refreshNousAccount({ force: true })
    out.failure = usage.nousAccountFailure()
  `)
  const fail = r.failure as { kind?: string; message?: string } | null
  check('nousUsageState-refresh-records-failure: nousAccountFailure records thrown credential error', fail?.kind === 'unreachable' && typeof fail.message === 'string' && fail.message.includes('nous-usage-cred-boom'), JSON.stringify(r.failure))
}

console.log(failures === 0 ? '\nGREEN' : `\nRED (${failures})`)
process.exit(failures === 0 ? 0 : 1)
