import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { chmodSync, closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { connect } from 'node:net'
import { homedir, tmpdir, userInfo } from 'node:os'
import { delimiter, join } from 'node:path'
import { removeScratch } from '../lib/removeScratch.ts'

type RemoteTransport = 'sshd' | 'local'

export type RemoteWorld = {
  transport: RemoteTransport
  scratch: string
  clientHome: string
  remoteHome: string
  data: string
  argvLog: string
  serverLog: string | null
  env: Record<string, string>
  argvLines(): string[]
  connectLines(): string[]
  serverLines(): string[]
  stop(): Promise<void>
}

const SSHD = ['/usr/sbin/sshd', Bun.which('sshd') ?? ''].find(path => path !== '' && existsSync(path))
const SSH = Bun.which('ssh')
const KEYGEN = Bun.which('ssh-keygen')

export function underScratchHome(script: string): string {
  const given = process.env.REMOTE_KIT_HOME
  if (given !== undefined && given !== '') {
    if (homedir() === given) return given
    console.log(`  [FAIL] this proof was given a home of its own and the runtime did not take it: it does not go on`)
    process.exit(1)
  }
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'remote-files-home-')))
  const ran = spawnSync(process.execPath, [script, ...process.argv.slice(2)], { stdio: 'inherit', env: { ...process.env, HOME: home, USERPROFILE: home, REMOTE_KIT_HOME: home } })
  removeScratch(home)
  process.exit(ran.status ?? 1)
}

export function sshdUnavailable(): string | null {
  if (process.platform === 'win32') return 'the private sshd of this proof is a POSIX one'
  if (SSHD === undefined) return 'no sshd on this machine'
  if (SSH === null || KEYGEN === null) return 'no ssh or ssh-keygen on this machine'
  return null
}

export function localTransportUnavailable(): string | null {
  return process.platform === 'win32' || Bun.which('sh') === null ? 'no POSIX sh on this machine' : null
}

function lines(path: string): string[] {
  return existsSync(path) ? readFileSync(path, 'utf8').split('\n').filter(Boolean) : []
}

function writeShim(path: string, rows: string[]): void {
  writeFileSync(path, `${rows.join('\n')}\n`)
  chmodSync(path, 0o755)
}

function listening(port: number): Promise<boolean> {
  return new Promise(resolve => {
    const socket = connect(port, '127.0.0.1')
    socket.once('connect', () => {
      socket.destroy()
      resolve(true)
    })
    socket.once('error', () => resolve(false))
  })
}

export async function remoteWorld(transport: RemoteTransport, port = 0, options: { noise?: boolean; clientHome?: string } = {}): Promise<RemoteWorld> {
  const scratch = realpathSync(mkdtempSync(join(tmpdir(), `remote-files-${transport}-`)))
  const clientHome = options.clientHome ?? join(scratch, 'client-home')
  const remoteHome = join(scratch, 'remote-home')
  const data = join(scratch, 'remote-data')
  const bin = join(scratch, 'bin')
  const keys = join(scratch, 'keys')
  for (const dir of [join(clientHome, '.ssh'), remoteHome, data, bin, keys]) mkdirSync(dir, { recursive: true })
  for (const dir of [clientHome, join(clientHome, '.ssh'), keys]) chmodSync(dir, 0o700)
  const argvLog = join(scratch, 'ssh-argv.log')
  const config = join(clientHome, '.ssh', 'config')
  let server: ChildProcess | null = null
  let serverLog: string | null = null
  if (transport === 'local') {
    writeFileSync(config, ['Host box', '  HostName 127.0.0.1', '  User kituser', ''].join('\n'))
    writeShim(join(bin, 'ssh'), [
      '#!/bin/sh',
      `printf '%s\\n' "$*" >> '${argvLog}'`,
      'count=$#',
      'host=',
      'word=',
      'user=',
      'before=',
      'i=0',
      'for arg in "$@"; do',
      '  i=$((i + 1))',
      '  if [ "$i" -eq "$((count - 1))" ]; then host=$arg; fi',
      '  if [ "$i" -eq "$count" ]; then word=$arg; fi',
      '  if [ "$before" = -l ]; then user=$arg; fi',
      '  before=$arg',
      'done',
      "case $user in *'\\'*) printf '%s\\n' 'remote username contains invalid characters' >&2; exit 255 ;; esac",
      'case " $* " in',
      "  *' -G '*)",
      '    case $word in box*) name=127.0.0.1 ;; *) name=$word ;; esac',
      "    printf 'hostname %s\\nuser kituser\\nport 22\\n' \"$name\"",
      '    exit 0 ;;',
      'esac',
      'case $host in',
      "  stranger) printf '%s\\n' 'No ED25519 host key is known for stranger and you have requested strict checking.' 'Host key verification failed.' >&2; exit 255 ;;",
      "  nobody) printf '%s\\n' 'ssh: connect to host nobody port 22: Connection refused' >&2; exit 255 ;;",
      `  windows) printf '%s\\n' "'$word' is not recognized as an internal or external command," 'operable program or batch file.' >&2; exit 1 ;;`,
      'esac',
      `HOME='${remoteHome}'; export HOME`,
      'cd "$HOME" || exit 1',
      "if [ -n \"$REMOTE_KIT_NOISE\" ]; then printf 'login noise on stdout\\n'; printf 'login noise on stderr\\n' >&2; fi",
      'if [ -n "$REMOTE_KIT_COUNT" ]; then "$word" | tee -a "$REMOTE_KIT_COUNT"; exit; fi',
      'if [ -n "$REMOTE_KIT_SHELL" ]; then exec $REMOTE_KIT_SHELL; fi',
      'exec "$word"',
    ])
  } else {
    const hostKey = join(keys, 'host_ed25519')
    const clientKey = join(keys, 'client_ed25519')
    const wrappedKey = join(keys, 'wrapped_ed25519')
    for (const [file, comment] of [[hostKey, 'remote-files-host'], [clientKey, 'remote-files-client'], [wrappedKey, 'remote-files-wrapped']] as const) {
      const made = spawnSync(KEYGEN!, ['-q', '-t', 'ed25519', '-N', '', '-C', comment, '-f', file], { encoding: 'utf8' })
      if (made.status !== 0) throw new Error(`ssh-keygen failed: ${made.stderr}`)
    }
    const authorized = join(keys, 'authorized_keys')
    writeFileSync(authorized, `${readFileSync(`${clientKey}.pub`, 'utf8')}command="/bin/sh -c \\"$SSH_ORIGINAL_COMMAND\\"" ${readFileSync(`${wrappedKey}.pub`, 'utf8')}`, { mode: 0o600 })
    const serverConfig = join(scratch, 'sshd_config')
    writeFileSync(serverConfig, [
      `Port ${port}`,
      'ListenAddress 127.0.0.1',
      `HostKey ${hostKey}`,
      `PidFile ${join(scratch, 'sshd.pid')}`,
      `AuthorizedKeysFile ${authorized}`,
      'AuthorizedKeysCommand none',
      'PasswordAuthentication no',
      'KbdInteractiveAuthentication no',
      'UsePAM no',
      'StrictModes no',
      'PermitUserEnvironment no',
      'PermitUserRC no',
      `SetEnv HOME="${remoteHome}" PATH="${bin}${delimiter}${process.env.PATH ?? ''}"`,
      'LogLevel VERBOSE',
      '',
    ].join('\n'))
    const known = join(clientHome, '.ssh', 'known_hosts')
    const unknown = join(clientHome, '.ssh', 'known_hosts_empty')
    writeFileSync(known, `[127.0.0.1]:${port} ${readFileSync(`${hostKey}.pub`, 'utf8').split(' ').slice(0, 2).join(' ')}\n`)
    writeFileSync(unknown, '')
    const shared = [`  User ${userInfo().username}`, '  IdentitiesOnly yes', '  IdentityAgent none', '  GlobalKnownHostsFile /dev/null', '  StrictHostKeyChecking yes']
    const common = [`  IdentityFile ${clientKey}`, ...shared]
    writeFileSync(config, [
      'Host box',
      '  HostName 127.0.0.1',
      `  Port ${port}`,
      `  UserKnownHostsFile ${known}`,
      ...common,
      'Host stranger',
      '  HostName 127.0.0.1',
      `  Port ${port}`,
      `  UserKnownHostsFile ${unknown}`,
      ...common,
      'Host nobody',
      '  HostName 127.0.0.1',
      '  Port 1',
      `  UserKnownHostsFile ${known}`,
      ...common,
      'Host wrapped',
      '  HostName 127.0.0.1',
      `  Port ${port}`,
      `  UserKnownHostsFile ${known}`,
      `  IdentityFile ${wrappedKey}`,
      ...shared,
      '',
    ].join('\n'))
    if (options.noise === true) writeFileSync(join(remoteHome, '.zshenv'), 'echo login noise on stdout\necho login noise on stderr >&2\n')
    writeShim(join(bin, 'ssh'), ['#!/bin/sh', `printf '%s\\n' "$*" >> '${argvLog}'`, `exec '${SSH}' -F '${config}' "$@"`])
    serverLog = join(scratch, 'sshd.log')
    const logFd = openSync(serverLog, 'a')
    server = spawn(SSHD!, ['-D', '-e', '-f', serverConfig], { stdio: ['ignore', logFd, logFd] })
    closeSync(logFd)
    const running = server
    process.once('exit', () => {
      try {
        running.kill()
      } catch {
      }
    })
    let up = false
    for (let attempt = 0; attempt < 80 && !up && server.exitCode === null; attempt++) {
      up = await listening(port)
      if (!up) await new Promise(resolve => setTimeout(resolve, 50))
    }
    if (!up) {
      const said = lines(serverLog).slice(-5).join(' · ')
      server.kill()
      removeScratch(scratch)
      throw new Error(`the private sshd did not listen on 127.0.0.1:${port}: ${said}`)
    }
  }
  writeShim(join(bin, 'rg'), ['#!/bin/sh', 'exit 127'])
  const env: Record<string, string> = {
    PATH: `${bin}${delimiter}${process.env.PATH ?? ''}`,
    HOME: clientHome,
    ...(options.noise === true ? { REMOTE_KIT_NOISE: '1' } : {}),
  }
  return {
    transport,
    scratch,
    clientHome,
    remoteHome,
    data,
    argvLog,
    serverLog,
    env,
    argvLines: () => lines(argvLog),
    connectLines: () => lines(argvLog).filter(line => !/^-G( |$)/.test(line)),
    serverLines: () => (serverLog === null ? [] : lines(serverLog)),
    async stop() {
      if (server !== null && server.exitCode === null) {
        const gone = new Promise<void>(resolve => server!.once('exit', () => resolve()))
        server.kill()
        await gone
      }
      removeScratch(scratch)
    },
  }
}

export function enterWorld(world: RemoteWorld): () => void {
  const before = new Map<string, string | undefined>()
  for (const name of [...Object.keys(world.env), 'SSH_AUTH_SOCK', 'SSH_ASKPASS', 'REMOTE_KIT_SHELL', 'REMOTE_KIT_COUNT']) before.set(name, process.env[name])
  for (const name of ['SSH_AUTH_SOCK', 'SSH_ASKPASS', 'REMOTE_KIT_SHELL', 'REMOTE_KIT_NOISE', 'REMOTE_KIT_COUNT']) delete process.env[name]
  for (const [name, value] of Object.entries(world.env)) process.env[name] = value
  return () => {
    for (const [name, value] of before) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
  }
}
