#!/usr/bin/env bun
import { spawn, spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync, mkdtempSync, readdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { enterWorld, localTransportUnavailable, remoteWorld, sshdUnavailable, underScratchHome, type RemoteWorld } from './remoteKit.ts'

const HOME = underScratchHome(import.meta.path)
process.env.NODE_ENV = 'test'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

const { closeRemoteConnections, remoteRun, RemoteConnectionError, resolveRemoteAuthority } = await import('../../src/services/remoteFiles/connection.ts')
const { remotePrelude, remoteQuote } = await import('../../src/services/remoteFiles/prelude.ts')
const { resolvedAuthority, RemotePathError } = await import('../../src/services/remoteFiles/target.ts')

const PORT = 27061
const watchdog = setTimeout(() => {
  console.log('  [FAIL] the proof did not finish within 420 seconds')
  process.exit(1)
}, 420_000)
watchdog.unref()
let failures = 0
let checks = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  checks++
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail.slice(0, 500)}` : ''}`)
}
const section = (title: string): void => console.log(`\n${'─'.repeat(76)}\n${title}`)
const pause = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))
const box = { host: 'box' }
const run = (script: string, extra: Record<string, unknown> = {}) => remoteRun(box, { script, ...extra })
const failure = async (work: () => Promise<unknown>): Promise<Error | null> => {
  try {
    await work()
    return null
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error))
  }
}
const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
const gone = async (pid: number, withinMs: number): Promise<boolean> => {
  for (const until = Date.now() + withinMs; Date.now() < until; ) {
    if (!alive(pid)) return true
    await pause(50)
  }
  return !alive(pid)
}

type RawOutcome = { code: number | null; out: string; err: string }

function rawSession(world: RemoteWorld, feed: (token: string, write: (bytes: string | Uint8Array) => void, seen: () => string, end: () => void) => Promise<void>): Promise<RawOutcome> {
  return new Promise(resolve => {
    const token = randomBytes(16).toString('hex')
    const ready = randomBytes(16).toString('hex')
    const child = spawn('ssh', ['-T', '-oBatchMode=yes', '--', 'box', 'sh'], { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, ...world.env } })
    let out = ''
    let err = ''
    child.stdout.on('data', chunk => { out += String(chunk) })
    child.stderr.on('data', chunk => { err += String(chunk) })
    child.stdin.on('error', () => {})
    const timer = setTimeout(() => {
      child.stdin.end()
      child.kill('SIGKILL')
    }, 15_000)
    child.on('close', code => {
      clearTimeout(timer)
      resolve({ code, out, err })
    })
    child.stdin.write(remotePrelude(token, ready, 15))
    void (async () => {
      for (const until = Date.now() + 10_000; Date.now() < until && !out.includes(`${ready}\n`); ) await pause(20)
      await feed(token, bytes => child.stdin.write(bytes), () => out, () => child.stdin.end())
    })()
  })
}

async function hostilePayload(world: RemoteWorld, shell: string): Promise<void> {
  const pwned = join(world.data, `PWNED-${shell.replace(/\W+/g, '-')}`)
  const landed = join(world.data, `landed-${shell.replace(/\W+/g, '-')}`)
  const payload = `touch ${pwned}-inside\n${'A'.repeat(64)}\n`
  const after = `touch ${pwned}-after\n`
  const short = await rawSession(world, async (token, write, seen) => {
    write(`${token} m_put ${payload.length + 9} ${remoteQuote(landed)} ACKWORD; m_end endmark\n`)
    for (const until = Date.now() + 5_000; Date.now() < until && !seen().includes('ACKWORD\n'); ) await pause(20)
    write(payload + after.slice(0, 9))
    for (const until = Date.now() + 5_000; Date.now() < until && !seen().includes('endmark 0\n'); ) await pause(20)
    write(after.slice(9))
  })
  check(`${shell}: a payload nine bytes short is filled by the bytes that follow, and the rest of that line, having no token, ends the remote shell with 98`, short.code === 98 && short.out.includes('\nendmark 0\n'), `exit ${short.code} ${JSON.stringify(short.out.slice(-80))}`)
  check(`${shell}: neither the payload's own line nor the line after it ran`, !existsSync(`${pwned}-inside`) && !existsSync(`${pwned}-after`))
  const atOnce = await rawSession(world, async (token, write, seen, end) => {
    write(`${token} m_put ${payload.length + 9} ${remoteQuote(landed)} ACKWORD; m_end endmark\n`)
    for (const until = Date.now() + 5_000; Date.now() < until && !seen().includes('ACKWORD\n'); ) await pause(20)
    write(payload + after)
    for (const until = Date.now() + 5_000; Date.now() < until && !seen().includes('endmark 0\n'); ) await pause(20)
    end()
  })
  check(`${shell}: the same bytes sent in one piece run nothing either`, (atOnce.code === 98 || atOnce.code === 0) && !existsSync(`${pwned}-inside`) && !existsSync(`${pwned}-after`), `exit ${atOnce.code}`)
  const forged = await rawSession(world, async (_token, write) => {
    write(`${'0'.repeat(32)} touch ${pwned}-forged; m_end endmark\n`)
  })
  check(`${shell}: a request under another token ends the shell with 98 and runs nothing`, forged.code === 98 && !existsSync(`${pwned}-forged`), `exit ${forged.code}`)
  const cut = await rawSession(world, async (token, write, seen, end) => {
    write(`${token} m_put 100 ${remoteQuote(`${landed}-cut`)} ACKWORD; m_end endmark\n`)
    for (const until = Date.now() + 5_000; Date.now() < until && !seen().includes('ACKWORD\n'); ) await pause(20)
    write('only ten b')
    await pause(100)
    end()
  })
  check(`${shell}: a payload cut off by the end of the connection ends the shell with 97`, cut.code === 97, `exit ${cut.code}`)
  check(`${shell}: and the file it was landing in is removed`, !existsSync(`${landed}-cut`))
  const refused = await rawSession(world, async (token, write, seen) => {
    write(`${token} m_put 5 ${remoteQuote(join(world.data, 'no-such-folder', 'x'))} ACKWORD; m_end endmark\n`)
    for (const until = Date.now() + 5_000; Date.now() < until && !seen().includes('endmark 73\n'); ) await pause(20)
    write(`${token} { printf still-in-step; } </dev/null; m_end second\n`)
    for (const until = Date.now() + 5_000; Date.now() < until && !seen().includes('second 0\n'); ) await pause(20)
  })
  check(`${shell}: a destination that cannot be opened answers 73 before any acknowledgement, and the loop goes on`, !refused.out.includes('ACKWORD') && refused.out.includes('\nendmark 73\n') && refused.out.includes('still-in-step\nsecond 0\n'), JSON.stringify(refused.out.slice(-160)))
}

async function leg(world: RemoteWorld): Promise<void> {
  const name = world.transport
  section(`${name} · the handshake and one request`)
  const first = await run(`printf 'a\\0b\\nno-newline-end'`)
  check(`${name}: bytes come back exact, with a null byte and no final newline, past the login noise`, first.stdout.equals(Buffer.from('a\0b\nno-newline-end')) && first.status === 0 && first.stderr === '', JSON.stringify(first.stdout.toString('latin1')))
  const mixed = await run(`printf out; printf err >&2; sh -c 'exit 7'`)
  check(`${name}: the status, stdout and stderr of a request are three things`, mixed.status === 7 && mixed.stdout.toString() === 'out' && mixed.stderr === 'err', JSON.stringify(mixed))
  const home = await run(`printf %s "$HOME"`)
  check(`${name}: the remote shell runs in the remote account's home`, home.stdout.toString() === world.remoteHome, home.stdout.toString())
  const swallow = await run('cat; printf after')
  check(`${name}: a command that reads its input reads nothing of the requests`, swallow.stdout.toString() === 'after' && swallow.status === 0, JSON.stringify(swallow.stdout.toString()))

  section(`${name} · a write: bytes after the acknowledgement`)
  const weird = join(world.data, `we'ird "name" $(touch INJECTED) \`id\`\nline2 -rf *`)
  const payload = randomBytes(1024 * 1024 + 7)
  const put = await remoteRun(box, { script: ack => `m_put ${payload.length} ${remoteQuote(weird)} ${ack}`, payload })
  const back = await run(`cat ${remoteQuote(weird)}`)
  check(`${name}: 1 MiB + 7 bytes land under a name with quotes, a command substitution and a newline, and read back identical`, put.status === 0 && back.stdout.equals(payload), `status ${put.status} ${put.stderr} ${back.stdout.length} bytes`)
  check(`${name}: the name ran nothing`, !existsSync(join(world.data, 'INJECTED')) && !existsSync(join(world.remoteHome, 'INJECTED')))
  const empty = join(world.data, 'empty')
  const zero = await remoteRun(box, { script: ack => `m_put 0 ${remoteQuote(empty)} ${ack}`, payload: new Uint8Array(0) })
  const zeroBack = await run(`cat ${remoteQuote(empty)}; printf done`)
  check(`${name}: a write of no bytes`, zero.status === 0 && zeroBack.stdout.toString() === 'done', `status ${zero.status}`)
  const closed = await remoteRun(box, { script: ack => `m_put 5 ${remoteQuote(join(world.data, 'no-such-folder', 'x'))} ${ack}`, payload: Buffer.from('hello') })
  const still = await run('printf still')
  check(`${name}: a destination that cannot be opened is answered before any byte is sent, and the connection stays in step`, closed.status === 73 && /no-such-folder/.test(closed.stderr) && still.stdout.toString() === 'still', `status ${closed.status} ${closed.stderr}`)
  const big = await run(`head -c 33554432 /dev/zero | tr '\\0' 'x'`)
  check(`${name}: 32 MiB through one reply`, big.stdout.length === 33554432 && big.stdout[0] === 0x78 && big.stdout[33554431] === 0x78, `${big.stdout.length}`)
  let streamed = 0
  const sunk = await remoteRun(box, { script: `head -c 8388608 /dev/zero | tr '\\0' 'y'`, sink: chunk => { streamed += chunk.length } })
  check(`${name}: a reply handed on as it arrives is not kept`, streamed === 8388608 && sunk.stdout.length === 0 && sunk.status === 0, `${streamed}`)

  section(`${name} · many requests, one connection`)
  const before = world.connectLines().length
  const many = await Promise.all(Array.from({ length: 24 }, (_, index) => run(`printf 'reply %s' ${index}`)))
  check(`${name}: twenty-four requests at once each get their own reply`, many.every((reply, index) => reply.stdout.toString() === `reply ${index}` && reply.status === 0))
  check(`${name}: and no new connection was opened for them`, world.connectLines().length === before, `${before} -> ${world.connectLines().length}`)
  const pids = await Promise.all([run('printf %s $$'), run('printf %s $$')])
  check(`${name}: the requests are answered by one remote shell`, pids[0]!.stdout.toString() === pids[1]!.stdout.toString() && /^\d+$/.test(pids[0]!.stdout.toString()))

  section(`${name} · a request that is stopped, one that goes quiet, a connection that is lost`)
  const controller = new AbortController()
  const startedAt = Date.now()
  const stopping = failure(() => run('sleep 30', { signal: controller.signal }))
  await pause(300)
  controller.abort()
  const stopped = await stopping
  check(`${name}: an interrupted request ends at once`, stopped !== null && stopped.name === 'AbortError' && Date.now() - startedAt < 5_000, `${stopped?.name}: ${stopped?.message} after ${Date.now() - startedAt} ms`)
  const afterStop = await run('printf again')
  check(`${name}: and the next request is answered on a new connection`, afterStop.stdout.toString() === 'again')
  closeRemoteConnections()
  const slowAt = Date.now()
  const slow = await run('sleep 9; printf whole', { quietMs: 4_000 }).catch((error: Error) => error)
  check(`${name}: a command silent for nine seconds on a live link, under a quiet time of four, comes back whole`, !(slow instanceof Error) && slow.status === 0 && slow.stdout.toString() === 'whole' && Date.now() - slowAt >= 9_000, slow instanceof Error ? `${slow.message} after ${Date.now() - slowAt} ms` : `${slow.status} after ${Date.now() - slowAt} ms`)
  const worded = await run('sleep 3; echo words >&2; (exit 3)', { quietMs: 4_000 })
  check(`${name}: the beats that kept it alive are not in what the command said`, worded.status === 3 && worded.stderr === 'words\n' && worded.stdout.length === 0, JSON.stringify(worded.stderr))
  const busyShell = Number((await run('printf %s $$')).stdout.toString())
  const hurried = Date.now()
  for (let index = 0; index < 100; index++) await run('true')
  console.log(`  [info] ${name}: one hundred requests in a row took ${Date.now() - hurried} ms`)
  const family = spawnSync('ps', ['-eo', 'pid=,ppid='], { encoding: 'utf8' })
  if (family.status !== 0) console.log(`  [SKIP] ${name}: no ps on this machine, the children of the remote shell were not counted`)
  else {
    const children = family.stdout.split('\n').map(row => row.trim().split(/\s+/)).filter(row => row[1] === String(busyShell)).map(row => row[0])
    check(`${name}: a hundred requests later the remote shell has one child, the one that beats`, Number.isInteger(busyShell) && busyShell > 1 && alive(busyShell) && children.length === 1, children.join(' '))
  }
  const lostAt = Date.now()
  const lost = await failure(() => run('kill -9 $$', { quietMs: 4_000 }))
  check(`${name}: a remote shell that dies under a request, and again under its one retry, is a lost connection, said so within a beat each time`, lost instanceof RemoteConnectionError && lost.failure === 'lost' && lost.message.startsWith('The connection to box was lost') && Date.now() - lostAt < 6_000, `${lost?.message} after ${Date.now() - lostAt} ms`)
  const beaterFile = join(world.data, `beater-${name}`)
  const quietAt = Date.now()
  const quiet = await failure(() => run(`printf %s "$b" > ${remoteQuote(beaterFile)}; kill -STOP "$b"; sleep 12`, { quietMs: 4_000 }))
  const quietFor = Date.now() - quietAt
  check(`${name}: a link with neither an answer nor a beat for the quiet time is said to be dead`, quiet instanceof RemoteConnectionError && quiet.failure === 'timeout' && quiet.message === 'box did not answer for 4 seconds.' && quietFor >= 4_000 && quietFor < 9_000, `${quiet?.message} after ${quietFor} ms`)
  const frozen = existsSync(beaterFile) ? Number(readFileSync(beaterFile, 'utf8')) : 0
  if (Number.isInteger(frozen) && frozen > 1) {
    try {
      process.kill(frozen, 'SIGKILL')
    } catch {
    }
  }
  const afterQuiet = await run('printf again')
  check(`${name}: and the next request is answered`, afterQuiet.stdout.toString() === 'again')

  section(`${name} · the end of the session`)
  const shellPid = Number((await run('printf %s $$')).stdout.toString())
  check(`${name}: the remote shell is alive while the session is`, alive(shellPid), String(shellPid))
  const open = closeRemoteConnections()
  check(`${name}: closing the session's connections ends the remote shell`, open >= 1 && (await gone(shellPid, 5_000)), `${open} open, pid ${shellPid} ${alive(shellPid) ? 'alive' : 'gone'}`)
  const child = spawn(process.execPath, [join(import.meta.dir, 'connectionChild.ts')], { stdio: ['ignore', 'pipe', 'inherit'], env: { ...process.env, ...world.env } })
  let printed = ''
  child.stdout.on('data', chunk => { printed += String(chunk) })
  const childExit = await new Promise<NodeJS.Signals | number | null>(resolve => child.on('exit', (code, signal) => resolve(signal ?? code)))
  const orphan = Number(printed.trim())
  check(`${name}: a process that dies without closing leaves no remote shell behind`, childExit === 'SIGKILL' && Number.isInteger(orphan) && orphan > 0 && (await gone(orphan, 5_000)), `child ${childExit}, pid ${printed.trim()}`)

  section(`${name} · what ssh is given, and what it is never given`)
  const argv = world.argvLines()
  const connects = world.connectLines().filter(line => / -- box sh$/.test(line))
  const wanted = ['-T', '-x', '-oBatchMode=yes', '-oForwardAgent=no', '-oPermitLocalCommand=no', '-oClearAllForwardings=yes', '-oRemoteCommand=none', '-oControlMaster=no']
  check(`${name}: every connection carries the options scp and sftp hand to ssh`, connects.length > 0 && connects.every(line => wanted.every(option => line.split(' ').includes(option))), connects[0])
  check(`${name}: no call to ssh, of any kind, names an option about host keys, an agent, or a forwarding of its own`, argv.every(line => !/StrictHostKeyChecking|UserKnownHostsFile|GlobalKnownHostsFile|HostKeyAlias|CheckHostIP|VerifyHostKeyDNS|UpdateHostKeys/i.test(line) && !/ -[AXYLRDW] /.test(` ${line} `)), argv.find(line => /StrictHostKeyChecking|UserKnownHostsFile/i.test(line) || / -[AXYLRDW] /.test(` ${line} `)))
  check(`${name}: the remote command is the one word sh`, connects.every(line => line.endsWith(' -- box sh')))

  section(`${name} · hosts that cannot be used`)
  const acceptedBefore = world.serverLines().filter(line => /Accepted publickey|Starting session/.test(line)).length
  const stranger = await failure(() => remoteRun({ host: 'stranger' }, { script: 'printf never' }))
  check(`${name}: a host whose key is not known is refused in ssh's own words`, stranger instanceof RemoteConnectionError && stranger.failure === 'ssh' && /^ssh could not reach stranger: .*Host key verification failed\.$/.test(stranger.message), String(stranger?.message))
  if (world.transport === 'sshd') {
    const acceptedAfter = world.serverLines().filter(line => /Accepted publickey|Starting session/.test(line)).length
    check(`${name}: and nothing was sent to it: the server saw no sign-in and no session`, acceptedAfter === acceptedBefore, `${acceptedBefore} -> ${acceptedAfter}`)
    check(`${name}: and its key was not written down`, !readdirSync(join(world.clientHome, '.ssh')).some(file => file.endsWith('.old')) && Bun.file(join(world.clientHome, '.ssh', 'known_hosts_empty')).size === 0)
  }
  const nobody = await failure(() => remoteRun({ host: 'nobody' }, { script: 'printf never' }))
  check(`${name}: a host that does not answer fails in ssh's own words`, nobody instanceof RemoteConnectionError && nobody.failure === 'ssh' && /^ssh could not reach nobody: .*Connection refused/.test(nobody.message), String(nobody?.message))
  const signIns = (): number => world.connectLines().filter(line => / -- nobody /.test(line)).length
  const signedIn = signIns()
  const waiting = await Promise.all(Array.from({ length: 5 }, () => failure(() => remoteRun({ host: 'nobody' }, { script: 'printf never' }))))
  check(`${name}: five requests waiting on a host that cannot be reached all fail with its one failure, after one try at it`, waiting.every(refusal => refusal instanceof RemoteConnectionError && refusal.failure === 'ssh') && new Set(waiting.map(refusal => refusal?.message)).size === 1 && signIns() - signedIn === 1, `${signIns() - signedIn} tries: ${waiting[0]?.message}`)
  await failure(() => remoteRun({ host: 'nobody' }, { script: 'printf never' }))
  check(`${name}: and a request made after that failure tries the host again`, signIns() - signedIn === 2, String(signIns() - signedIn))
  if (world.transport === 'local') {
    const windows = await failure(() => remoteRun({ host: 'windows' }, { script: 'printf never' }))
    check(`${name}: a remote with no POSIX shell is said to have none, after sh, bash and zsh were asked for`, windows instanceof RemoteConnectionError && windows.failure === 'shell' && windows.message === "windows has no POSIX shell that answers ('sh' is not recognized as an internal or external command, operable program or batch file.); a path that begins ssh:// needs sh, bash or zsh on the remote machine." && ['sh', 'bash', 'zsh'].every(word => world.argvLines().some(line => line.endsWith(` -- windows ${word}`))), String(windows?.message))
  }
  await resolveRemoteAuthority(box)
  const facts = resolvedAuthority(box)
  check(`${name}: the configuration is asked what a name resolves to, with no connection`, facts?.hostname === '127.0.0.1' && typeof facts.user === 'string' && facts.port === (world.transport === 'sshd' ? PORT : 22) && world.argvLines().some(line => line === '-G -- box'), JSON.stringify(facts))
  closeRemoteConnections()
}

if (localTransportUnavailable() === null) {
  const world = await remoteWorld('local', 0, { noise: true, clientHome: HOME })
  const leave = enterWorld(world)
  try {
    await leg(world)
    section('local · the hostile payload, shell by shell')
    const shells = ['sh', 'dash', 'bash', 'zsh', 'busybox ash'].filter(shell => Bun.which(shell.split(' ')[0]!) !== null)
    for (const shell of shells) {
      process.env.REMOTE_KIT_SHELL = shell
      await hostilePayload(world, shell)
      closeRemoteConnections()
      const answered = await run('printf %s "$0"')
      check(`${shell}: the product's own connection speaks to this shell`, answered.status === 0 && answered.stdout.length > 0, `${answered.status} ${answered.stderr}`)
      closeRemoteConnections()
      const kept = await run('sleep 6; printf whole', { quietMs: 4_000 }).catch((error: Error) => error)
      check(`${shell}: its beats carry a command that is silent past the quiet time, and leave no word behind`, !(kept instanceof Error) && kept.stdout.toString() === 'whole' && kept.stderr === '', kept instanceof Error ? kept.message : JSON.stringify(kept.stderr))
      closeRemoteConnections()
    }
    delete process.env.REMOTE_KIT_SHELL
    for (const absent of ['dash', 'busybox ash'].filter(shell => !shells.includes(shell))) console.log(`  [SKIP] ${absent}: not on this machine, the hostile payload was not read on it`)
    section('local · a host or a user a shell would act on starts no ssh at all')
    const started = world.argvLines().length
    const marker = join(world.data, 'ran-by-a-name')
    const shellNames = [{ host: `$(touch ${marker})` }, { host: '`id`' }, { host: 'a;b' }, { host: 'a|b' }, { host: 'web1', user: '$(id)' }, { host: 'web1', user: 'a;b' }, { host: 'web1', user: 'a -oProxyCommand=id' }]
    const refusals = await Promise.all(shellNames.flatMap(authority => [failure(() => resolveRemoteAuthority(authority)), failure(() => remoteRun(authority, { script: 'printf never' }))]))
    check('each is refused as a path, in words', refusals.every(refusal => refusal instanceof RemotePathError), refusals.map(refusal => `${refusal?.name}: ${refusal?.message}`).join(' | '))
    check('the sentence names the character and not a host that cannot be reached', refusals.slice(4, 6).every(refusal => refusal?.message === 'ssh://a;b has a character in its host or its user that a shell would act on.'), String(refusals[4]?.message))
    check('no ssh was started for any of them: no question to the configuration, no connection', world.argvLines().length === started, world.argvLines().slice(started).join(' | '))
    check('and nothing a name spelled was run', !existsSync(marker))
    section('local · no ssh on the machine')
    const path = process.env.PATH
    process.env.PATH = mkdtempSync(join(tmpdir(), 'remote-files-nopath-'))
    const missing = await failure(() => remoteRun({ host: 'elsewhere' }, { script: 'printf never' }))
    process.env.PATH = path
    check('with no ssh to run, the failure names what is missing', missing instanceof RemoteConnectionError && missing.failure === 'ssh' && missing.message === 'ssh was not found on this machine; a path that begins ssh:// needs the OpenSSH client.', String(missing?.message))
  } finally {
    closeRemoteConnections()
    leave()
    await world.stop()
  }
} else {
  console.log(`  [SKIP] the local transport: ${localTransportUnavailable()}`)
}

if (sshdUnavailable() === null) {
  const world = await remoteWorld('sshd', PORT, { noise: true, clientHome: HOME })
  const leave = enterWorld(world)
  try {
    await leg(world)
    section('sshd · the hostile payload over a real connection')
    await hostilePayload(world, 'sh')
    section('sshd · a server that wraps every command in a shell of its own')
    const wrapped = { host: 'wrapped' }
    const through = await remoteRun(wrapped, { script: `printf 'a\\0b'` })
    check('the one long-lived shell starts and answers through the wrapper', through.status === 0 && through.stdout.equals(Buffer.from('a\0b')), `${through.status} ${through.stderr}`)
    const carried = randomBytes(70_000)
    const target = join(world.data, 'through the wrapper')
    const landed = await remoteRun(wrapped, { script: ack => `m_put ${carried.length} ${remoteQuote(target)} ${ack}`, payload: carried })
    const read = await remoteRun(wrapped, { script: `cat ${remoteQuote(target)}` })
    check('bytes go both ways through it unchanged', landed.status === 0 && read.stdout.equals(carried), `${landed.status} ${landed.stderr}`)
  } finally {
    closeRemoteConnections()
    leave()
    await world.stop()
  }
} else {
  console.log(`  [SKIP] the private sshd: ${sshdUnavailable()}`)
}

console.log(`\nremote connection: ${checks - failures} of ${checks} ${failures === 0 ? 'PASS' : 'FAIL'}`)
process.exit(failures === 0 ? 0 : 1)
