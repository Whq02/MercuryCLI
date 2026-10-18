import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { spawn, spawnSync } from 'node:child_process'

const home = mkdtempSync(join(tmpdir(), 'stored-sign-in-refusal-'))
const beforeCwd = process.cwd()
const work = join(home, 'work')
mkdirSync(work)
process.chdir(work)
process.env.MERCURY_DAEMON_DIR = '.daemon'
process.env.MERCURY_CONFIG_DIR = home
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
delete process.env.MERCURY_HOME
for (const name of Object.keys(process.env)) if (/API_KEY|AUTH_TOKEN|OAUTH_TOKEN|HF_TOKEN|MERCURY_MODEL/.test(name)) delete process.env[name]
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const { enableConfigs } = await import('../../src/utils/config.js')
enableConfigs()
const secrets = await import('../../src/services/providers/providerSecrets.js')
const { composeSignInView, summarizeSignInView } = await import('../../src/daemon/signInView.js')
const { collectLoginsScreenFacts, loginsCatalogue, loginsRowStateOf } = await import('../../src/components/BootLoginsScreen.js')
const { computedDefault } = await import('../../src/utils/model/computedDefault.js')
const { refreshDeepseekCatalogue } = await import('../../src/services/providers/deepseek/deepseekCatalogue.js')
let status = 200
let requests = 0
const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch() {
  requests++
  return Response.json(status === 200 ? { data: [{ id: 'deepseek-chat' }] } : { error: { message: 'credential refused' } }, { status })
} })
process.env.MERCURY_DEEPSEEK_API_BASE = `http://127.0.0.1:${server.port}/v1`
let failures = 0
function check(label: string, ok: boolean, detail = '') {
  if (!ok) failures++
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
}
const view = () => composeSignInView({ refresh: true })
const chip = () => loginsRowStateOf(loginsCatalogue().find(row => row.familyId === 'deepseek')!, collectLoginsScreenFacts()).chip
const cli = () => spawnSync(process.execPath, ['-e', `globalThis.MACRO={VERSION:'1.0.0'};const c=await import(${JSON.stringify(join(import.meta.dir, '../../src/utils/config.ts'))});c.enableConfigs();const a=await import(${JSON.stringify(join(import.meta.dir, '../../src/cli/handlers/auth.ts'))});await a.authStatus({json:true});`], { env: { ...process.env, MERCURY_MODEL: 'deepseek-chat' }, encoding: 'utf8', timeout: 30000 })
try {
  secrets.writeStoredZaiApiKey('fixture-zai-working-key')
  secrets.writeStoredDeepseekApiKey('fixture-deepseek-stored-key')
  await refreshDeepseekCatalogue({ force: true })
  check('a stored key with an accepted list is usable', view().families.find(row => row.family === 'deepseek')?.usable === true)
  status = 401
  const before = Date.now()
  await refreshDeepseekCatalogue({ force: true })
  const refused = view().families.find(row => row.family === 'deepseek')
  check('a refused stored credential is not usable', refused?.usable === false, JSON.stringify(refused))
  check('the health sign-in view names refusal, status, time and the door', /key refused \(HTTP 401(?::[^)]*)?\) at .+ · \/logins deepseek reconnects/.test(summarizeSignInView(view())), summarizeSignInView(view()))
  check('the logins row names the stored refusal, time and the door', /^key refused \(HTTP 401(?::[^)]*)?\) at .+ · \/logins deepseek reconnects$/.test(chip()), chip())
  const auth = cli()
  check('auth status reports the refusal and exits nonzero for that family', auth.status === 1 && /key refused \(HTTP 401(?::[^)]*)?\) at .+ · \/logins deepseek reconnects/.test(auth.stdout), auth.stdout.slice(-800))
  check('the refusal is an observed time, not the original sign-in time', ((refused as { refused?: { at: number } })?.refused?.at ?? 0) >= before)
  check('the computed default chooses another credentialed family instead', computedDefault().provider === 'zai', computedDefault().why)
  const bin = join(import.meta.dir, '../../dist/mercury.mjs')
  const daemon = spawn('node', [bin, 'daemon', 'run', work], { cwd: work, env: { ...process.env, MERCURY_DAEMON_NO_SELF_WARM: '1' }, stdio: ['ignore', 'pipe', 'pipe'] })
  let daemonLog = ''
  daemon.stderr.on('data', chunk => { daemonLog += String(chunk) })
  daemon.stdout.on('data', chunk => { daemonLog += String(chunk) })
  const ended = new Promise<void>(resolve => daemon.once('exit', () => resolve()))
  const { daemonControlRpc } = await import('../../src/daemon/controlSocket.js')
  const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
  try {
    const deadline = Date.now() + 30000
    let ready = false
    while (!ready && Date.now() < deadline && daemon.exitCode === null) {
      ready = (await daemonControlRpc({ op: 'ping' }, { timeoutMs: 500 })).ok
      if (!ready) await pause(100)
    }
    check('the isolated daemon answers for the certificate', ready, daemonLog.slice(-500))
    if (ready) {
      const health = spawnSync('node', [bin, 'health', '--json', '--only', 'daemon-sign-ins'], { cwd: work, env: process.env, encoding: 'utf8', timeout: 30000 })
      check('the built health certificate carries the timed refusal', health.stdout.includes('Daemon sign-in view') && /key refused \(HTTP 401(?::[^)]*)?\) at .+ · \/logins deepseek reconnects/.test(health.stdout), health.stdout.slice(-1200))
    }
  } finally {
    await daemonControlRpc({ op: 'shutdown', reapWorkers: true }, { timeoutMs: 5000 })
    const stopped = await Promise.race([ended.then(() => true), pause(10000).then(() => false)])
    if (!stopped) { daemon.kill('SIGTERM'); await ended }
  }
  status = 200
  await refreshDeepseekCatalogue({ force: true })
  check('a successful request on that credential clears the memo', view().families.find(row => row.family === 'deepseek')?.usable === true && !chip().includes('refused'))
  status = 403
  await refreshDeepseekCatalogue({ force: true })
  check('403 is recorded as well', summarizeSignInView(view()).includes('refused (HTTP 403'))
  secrets.writeStoredDeepseekApiKey('fixture-deepseek-new-stored-key')
  check('a new sign-in clears the refusal without a network request', !summarizeSignInView(view()).includes('refused') && !chip().includes('refused'))
  check('the loopback actually received the four list requests', requests === 4, String(requests))
} finally { server.stop(true); process.chdir(beforeCwd); rmSync(home, { recursive: true, force: true }) }
console.log(failures ? `stored-sign-in-refusal: ${failures} FAILURE(S)` : 'stored-sign-in-refusal: ALL LAWS HOLD')
process.exit(failures ? 1 : 0)
