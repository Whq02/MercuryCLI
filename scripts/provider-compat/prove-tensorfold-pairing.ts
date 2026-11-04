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
  }
  const found = await announcer.browseAnnouncements({ browseMs: 2500, lookupMs: 2000 })
  const mine = found.find(row => row.name === NAME)
  check('a loopback Bonjour browse lists the announcement by name', mine !== undefined, `found ${found.length}: ${found.map(row => row.name).join(', ')}`)
  check('the browse resolves the pairing port and the TXT facts', mine !== undefined && mine.port === live.port && mine.txt.model === 'qwen3.8-27b' && mine.txt.window === '131072' && mine.txt.version === '1.2.2' && mine.txt.engine === '8099' && mine.txt.pair === String(live.port) && mine.txt.keyed === '1', JSON.stringify(mine?.txt))
  check('the resolved host is a .local name, never printed here', mine !== undefined && /\.local$/.test(mine.host))
  await live.stop()
  await new Promise(resolve => setTimeout(resolve, 500))
  const gone = await announcer.browseAnnouncements({ browseMs: 1500, lookupMs: 1000 })
  check('after stop the announcement is gone', !gone.some(row => row.name === NAME))
}

console.log(`\nprove-tensorfold-pairing: ${failures === 0 ? 'ALL PASS' : `${failures} FAILED`}`)
process.exit(failures === 0 ? 0 : 1)
