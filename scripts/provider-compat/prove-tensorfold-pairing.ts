#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { execFileSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdtempSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const HOME = mkdtempSync(join(tmpdir(), 'tensorfold-pairing-proof-'))
process.env.MERCURY_CONFIG_DIR = HOME
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t)
}

const announcer = await import('../../src/services/lan/announcer.ts')
const pairing = await import('../../src/services/lan/pairing.ts')
const keyFile = await import('../../src/services/providers/local/tensorfoldKeyFile.ts')
const hosts = await import('../../src/services/providers/local/tensorfoldHosts.ts')

section('§1 the scoped key file: Mercury writes name[inference]: KEY itself, private, and shows the one line to paste')
const written = keyFile.writeTensorFoldKeyFile({ path: join(HOME, 'local-setup', 'tensorfold', 'api-key') })
check('the line is the scoped form', written.line === `mercury[inference]: ${written.key}`, written.line)
check('the key is 48 hex characters, no whitespace', /^[0-9a-f]{48}$/.test(written.key), written.key.length.toString())
check('the file is private (0600) — his server refuses any group or other bit', (statSync(written.path).mode & 0o777) === 0o600, (statSync(written.path).mode & 0o777).toString(8))
check('the directory is private (0700)', (statSync(join(written.path, '..')).mode & 0o777) === 0o700)
check('a second write keeps the same key', keyFile.writeTensorFoldKeyFile({ path: written.path }).key === written.key)
check('the file reads back', keyFile.readTensorFoldKeyFile(written.path)?.key === written.key)
check('the paste words name no flag', !/--/.test(keyFile.TENSORFOLD_KEY_PASTE_WORDS), keyFile.TENSORFOLD_KEY_PASTE_WORDS)

section('§2 the pairing server: one-time code, three attempts, the key crosses once')
const NAME = `Mercury proof ${randomBytes(3).toString('hex')}`
const offer = { model: 'qwen3.8-27b', enginePort: 8099, window: 131072, version: '1.2.2', chip: 'Apple M3 Ultra', key: written.key, name: NAME }
const server = await pairing.startPairingServer(offer, { listenHost: '127.0.0.1', announce: false })
check('the code has six digits', /^\d{6}$/.test(server.code), server.code)
check('the words shown on the serving Mac say plain HTTP on your own network', pairing.PAIRING_WORDS.shown(server.code, NAME).includes('plain HTTP on your home or office network, not across the internet'))
const wrong = await pairing.pairWithHost({ host: '127.0.0.1', pairPort: server.port, code: server.code === '000000' ? '111111' : '000000' })
check('a wrong code is refused with the design words', !wrong.ok && wrong.reason === pairing.PAIRING_WORDS.wrong, JSON.stringify(wrong))
const right = await pairing.pairWithHost({ host: '127.0.0.1', pairPort: server.port, code: server.code })
check('the right code crosses the key, the base URL and the host facts', right.ok && right.reply.key === written.key && right.reply.baseUrl === 'http://127.0.0.1:8099' && right.reply.model === 'qwen3.8-27b' && right.reply.window === 131072 && right.reply.version === '1.2.2' && right.reply.chip === 'Apple M3 Ultra' && right.reply.name === NAME, JSON.stringify(right))
const spent = await pairing.pairWithHost({ host: '127.0.0.1', pairPort: server.port, code: server.code })
check('the code is spent after one crossing', !spent.ok && spent.reason === pairing.PAIRING_WORDS.spent, JSON.stringify(spent))
if (right.ok) {
  await hosts.rememberTensorFoldHost({ name: right.reply.name, baseUrl: right.reply.baseUrl, origin: 'lan-paired', key: right.reply.key, version: right.reply.version, chip: right.reply.chip, serving: right.reply.model })
  const remembered = hosts.tensorFoldHosts().find(host => host.name === NAME)
  check('the paired host is remembered under TENSORFOLD HOST with its key kept aside', remembered?.origin === 'lan-paired' && remembered.keyRef === 'stored' && remembered.version === '1.2.2' && hosts.tensorFoldHostKey(right.reply.baseUrl) === written.key, JSON.stringify(remembered))
  check('the paired host is pairable; an app host would not be', hosts.pairableTensorFoldHosts().some(host => host.name === NAME))
}
await server.stop()

section('§3 the announcer: the CLI\'s own process announces over Bonjour (never a launchd agent); a loopback browse lists it')
const command = announcer.announcerCommand({ name: NAME, port: 8098, txt: { model: 'qwen3.8-27b', window: 131072, version: '1.2.2', chip: 'Apple M3 Ultra', engine: 8099, pair: 8098, keyed: '1' } }, 'darwin')
check('on macOS the announcement is dns-sd -R with the service type and the TXT facts', command?.file === 'dns-sd' && command.args[0] === '-R' && command.args[2] === announcer.MERCURY_TENSORFOLD_SERVICE_TYPE && command.args.includes('model=qwen3.8-27b') && command.args.includes('chip=Apple_M3_Ultra'), JSON.stringify(command))
check('the service type is Mercury\'s own, not his cluster node\'s', announcer.MERCURY_TENSORFOLD_SERVICE_TYPE === '_mercury-tf._tcp')
check('on Linux the announcement is avahi-publish-service', announcer.announcerCommand({ name: NAME, port: 1, txt: {} }, 'linux')?.file === 'avahi-publish-service')
check('on Windows there is no announcer', announcer.announcerCommand({ name: NAME, port: 1, txt: {} }, 'win32') === undefined)
check('the browse listing parser reads instance names', JSON.stringify(announcer.parseBrowseNames('Timestamp     A/R    Flags  if Domain               Service Type         Instance Name\n20:09:02.096  Add        3   1 local.               _mercury-tf._tcp.    Mercury test\n20:09:02.096  Add        2  16 local.               _mercury-tf._tcp.    Mercury test\n')) === JSON.stringify(['Mercury test']))
check('the browse listing parser reads a single-digit hour (dns-sd pads it with a space; red on the fold: the browse found nothing after midnight)', JSON.stringify(announcer.parseBrowseNames(' 2:53:37.511  Add        3   1 local.               _mercury-tf._tcp.    Mercury proof\n 2:53:37.511  Add        2  16 local.               _mercury-tf._tcp.    Mercury proof\n')) === JSON.stringify(['Mercury proof']))
const lookup = announcer.parseLookup('20:09:02.097  Mercury\\032test._mercury-tf._tcp.local. can be reached at studio.local.:8098 (interface 16) Flags: 1\n model=qwen3.8-27b window=131072 version=1.2.2\n')
check('the lookup parser reads host, port and TXT', lookup?.host === 'studio.local' && lookup.port === 8098 && lookup.txt.model === 'qwen3.8-27b' && lookup.txt.window === '131072', JSON.stringify(lookup))
const dnssd = ((): boolean => {
  try {
    execFileSync('/usr/bin/dns-sd', ['-V'], { stdio: ['ignore', 'pipe', 'pipe'], timeout: 3000 })
    return process.platform === 'darwin'
  } catch {
    return false
  }
})()
if (!dnssd) {
  console.log('  [SKIP] dns-sd is not on this machine — the loopback Bonjour browse is not proven in this run')
} else {
  const live = await pairing.startPairingServer(offer, { listenHost: '127.0.0.1' })
  check('the announcer started from this process', live.announcer !== undefined && live.announcer.pid !== undefined, JSON.stringify(live.announcer?.command))
  if (live.announcer?.pid !== undefined) {
    const parent = Number(execFileSync('ps', ['-o', 'ppid=', '-p', String(live.announcer.pid)], { encoding: 'utf8' }).trim())
    const comm = execFileSync('ps', ['-o', 'comm=', '-p', String(live.announcer.pid)], { encoding: 'utf8' }).trim()
    check('the announcing process is a child of the CLI process itself (TN3179: a Terminal-run tool and its children are exempt from the Local Network prompt)', parent === process.pid, `ppid ${parent} vs ${process.pid}`)
    check('the announcing process is dns-sd', /dns-sd$/.test(comm), comm)
    const launchdParent = Number(execFileSync('ps', ['-o', 'ppid=', '-p', String(process.pid)], { encoding: 'utf8' }).trim())
    check('this process is not launchd\'s own child (pid 1) — not a launchd agent', launchdParent !== 1, String(launchdParent))
    const chain: string[] = []
    for (let pid = process.pid, depth = 0; pid > 1 && depth < 32; depth++) {
      const row = execFileSync('ps', ['-o', 'ppid=,comm=', '-p', String(pid)], { encoding: 'utf8' }).trim()
      const match = /^(\d+)\s+(.*)$/.exec(row)
      if (!match) break
      chain.push(match[2]!.split('/').pop() ?? match[2]!)
      pid = Number(match[1])
    }
    check('the ancestry runs through a shell, login or sshd (a Terminal- or SSH-run tool: TN3179 grants local network access without a prompt; no grant was consulted)', chain.some(name => /^(-?zsh|-?bash|-?sh|login|sshd|sshd-session|Terminal|iTerm2|tmux|screen)$/.test(name)), chain.join(' ← '))
  }
  const found = await announcer.browseAnnouncements({ browseMs: 2500, lookupMs: 2000 })
  const mine = found.find(row => row.name === NAME)
  check('a loopback Bonjour browse lists the announcement by name', mine !== undefined, `found ${found.length}: ${found.map(row => row.name).join(', ')}`)
  check('the browse resolves the pairing port and the TXT facts', mine !== undefined && mine.port === live.port && mine.txt.model === 'qwen3.8-27b' && mine.txt.window === '131072' && mine.txt.version === '1.2.2' && mine.txt.engine === '8099' && mine.txt.pair === String(live.port) && mine.txt.keyed === '1', JSON.stringify(mine?.txt))
  check('the resolved host is a .local name, never printed here', mine !== undefined && /\.local$/.test(mine.host))
  const leashPid = live.announcer?.leashPid
  check('a leash runs beside the announcer: a shell that ends the announcement once this process is gone, a child of this process', leashPid !== undefined && Number(execFileSync('ps', ['-o', 'ppid=', '-p', String(leashPid)], { encoding: 'utf8' }).trim()) === process.pid, String(leashPid))
  await live.stop()
  await new Promise(resolve => setTimeout(resolve, 500))
  const gone = await announcer.browseAnnouncements({ browseMs: 1500, lookupMs: 1000 })
  check('after stop the announcement is gone', !gone.some(row => row.name === NAME))
  const alive = (pid: number | undefined): boolean => {
    if (pid === undefined) return false
    try {
      process.kill(pid, 0)
      return true
    } catch {
      return false
    }
  }
  check('stop ends the leash with the announcer', leashPid !== undefined && !alive(leashPid) && !alive(live.announcer?.pid))
  const leash = announcer.announcerLeashCommand(4242, 4343)
  check('the leash is one shell line of pids only, and it watches both the parent and the announcer, so it ends with whichever goes first', leash.file === 'sh' && leash.args[1] === 'while kill -0 4343 2>/dev/null && kill -0 4242 2>/dev/null; do sleep 2; done; kill 4242 2>/dev/null', leash.args[1])

  section('§4 a Mercury process cut without warning (SIGKILL: a crash, a pool cut) leaves no announcement behind: the leash ends it')
  const ORPHAN = `Mercury proof ${randomBytes(3).toString('hex')}`
  const { spawn } = await import('node:child_process')
  const script = `const a = await import(${JSON.stringify(join(process.cwd(), 'src/services/lan/announcer.ts'))}); const h = a.startAnnouncer({ name: ${JSON.stringify(ORPHAN)}, port: 8097, txt: { model: 'x' } }); console.log(JSON.stringify({ pid: h?.pid ?? null, leash: h?.leashPid ?? null })); setInterval(() => {}, 1000)`
  const cut = spawn(process.execPath, ['-e', script], { cwd: process.cwd(), env: { ...process.env }, stdio: ['ignore', 'pipe', 'inherit'] })
  const pids = await new Promise<{ pid: number | null; leash: number | null }>(resolve => {
    let out = ''
    cut.stdout.on('data', chunk => {
      out += String(chunk)
      const line = out.split('\n').find(row => row.startsWith('{'))
      if (line !== undefined) resolve(JSON.parse(line) as { pid: number | null; leash: number | null })
    })
    setTimeout(() => resolve({ pid: null, leash: null }), 8_000)
  })
  check('the cut process announced (its announcer and leash have pids)', pids.pid !== null && pids.leash !== null, JSON.stringify(pids))
  cut.kill('SIGKILL')
  const deadline = Date.now() + 6_000
  while (alive(pids.pid ?? undefined) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 250))
  check('within seconds of the SIGKILL the announcer and its leash are both gone (an exit handler never runs on a kill; the base leaves dns-sd advertising under pid 1)', !alive(pids.pid ?? undefined) && !alive(pids.leash ?? undefined), `announcer alive ${String(alive(pids.pid ?? undefined))}, leash alive ${String(alive(pids.leash ?? undefined))}`)
  const own = announcer.startAnnouncer({ name: `Mercury proof ${randomBytes(3).toString('hex')}`, port: 8096, txt: { model: 'y' } })
  if (own?.pid !== undefined) try { process.kill(own.pid, 'SIGTERM') } catch {}
  const leashDeadline = Date.now() + 6_000
  while (alive(own?.leashPid) && Date.now() < leashDeadline) await new Promise(resolve => setTimeout(resolve, 250))
  check('an announcer that ends on its own takes its leash with it within seconds (no leash polls for the rest of the session)', own !== undefined && !alive(own.pid) && !alive(own.leashPid), `announcer alive ${String(alive(own?.pid))}, leash alive ${String(alive(own?.leashPid))}`)
  own?.stop()
  if (alive(pids.pid ?? undefined)) try { process.kill(pids.pid!, 'SIGTERM') } catch {}
  if (alive(pids.leash ?? undefined)) try { process.kill(pids.leash!, 'SIGTERM') } catch {}
}

console.log(`\nprove-tensorfold-pairing: ${failures === 0 ? 'ALL PASS' : `${failures} FAILED`}`)
process.exit(failures === 0 ? 0 : 1)
