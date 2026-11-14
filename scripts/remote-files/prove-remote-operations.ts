#!/usr/bin/env bun
import { spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { enterWorld, localTransportUnavailable, remoteWorld, sshdUnavailable, underScratchHome, type RemoteWorld } from './remoteKit.ts'

const HOME = underScratchHome(import.meta.path)
process.env.NODE_ENV = 'test'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

const { closeRemoteConnections } = await import('../../src/services/remoteFiles/connection.ts')
const ops = await import('../../src/services/remoteFiles/ops.ts')
const { parseRemotePath, remoteGeneration } = await import('../../src/services/remoteFiles/target.ts')
const { readFileInRange, FileTooLargeError } = await import('../../src/utils/readFileInRange.ts')
const { fileGeneration } = await import('../../src/services/changeTransaction/seenLines.ts')

const PORT = 27062
const watchdog = setTimeout(() => {
  console.log('  [FAIL] the proof did not finish within 300 seconds')
  process.exit(1)
}, 300_000)
watchdog.unref()
let failures = 0
let checks = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  checks++
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail.slice(0, 600)}` : ''}`)
}
const section = (title: string): void => console.log(`\n${'─'.repeat(76)}\n${title}`)
const at = (path: string) => parseRemotePath(`ssh://box${path.replaceAll('%', '%25')}`)!
const failure = async (work: () => Promise<unknown>): Promise<(Error & { code?: string }) | null> => {
  try {
    await work()
    return null
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error))
  }
}

const FILES: Array<[string, Buffer]> = [
  ['empty', Buffer.alloc(0)],
  ['one-no-newline', Buffer.from('a')],
  ['one-newline', Buffer.from('a\n')],
  ['two-no-newline', Buffer.from('a\nb')],
  ['two-newline', Buffer.from('a\nb\n')],
  ['only-newline', Buffer.from('\n')],
  ['two-newlines', Buffer.from('\n\n')],
  ['crlf', Buffer.from('a\r\nb\r\nc')],
  ['utf8-bom', Buffer.from('\uFEFFfirst\nsecond\n')],
  ['utf16le', Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('uno\ndos\ntres\n', 'utf16le')])],
  ['utf16le-open', Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('uno\r\ndos', 'utf16le')])],
  ['accents', Buffer.from('café\nnaïve\n日本語\n')],
  ['not-utf8', Buffer.from([0x61, 0xff, 0x62, 0x0a, 0x63, 0x0a])],
  ['long-line', Buffer.from(`${'x'.repeat(300_000)}\nshort\n`)],
  ['many', Buffer.from(Array.from({ length: 5000 }, (_, index) => `line ${index + 1} ${'y'.repeat(index % 70)}`).join('\n') + '\n')],
]

async function reads(world: RemoteWorld): Promise<void> {
  const name = world.transport
  section(`${name} · a page of a remote file is the page of the same file read locally`)
  for (const [file, bytes] of FILES) {
    const path = join(world.data, file)
    writeFileSync(path, bytes)
    const total = bytes.toString('utf8').split('\n').length
    const windows: Array<[number, number | undefined]> = [[0, undefined], [0, 0], [0, 1], [1, 1], [0, 2], [1, undefined], [2, 5], [Math.max(0, total - 1), 5], [total, 5], [total + 3, 2], [0, 100000]]
    const wrong: string[] = []
    for (const [offset, maxLines] of windows) {
      const local = await readFileInRange(path, offset, maxLines)
      const remote = await ops.remoteReadRange(at(path), offset, maxLines)
      const same =
        remote.content === local.content &&
        remote.lineCount === local.lineCount &&
        remote.totalLines === local.totalLines &&
        remote.totalBytes === local.totalBytes &&
        remote.readBytes === local.readBytes &&
        remote.endsWithNewline === local.endsWithNewline &&
        remote.mtimeMs === Math.floor(local.mtimeMs / 1000) * 1000
      if (!same) wrong.push(`(${offset}, ${maxLines}): remote ${JSON.stringify({ ...remote, content: remote.content.slice(0, 40) })} local ${JSON.stringify({ ...local, content: local.content.slice(0, 40) })}`)
    }
    check(`${name}: ${file} (${bytes.length} bytes), ${windows.length} windows`, wrong.length === 0, wrong.join(' | '))
  }
  const big = join(world.data, 'many')
  const tooLocal = await failure(() => readFileInRange(big, 0, undefined, 1000))
  const tooRemote = await failure(() => ops.remoteReadRange(at(big), 0, undefined, 1000))
  check(`${name}: a file over the size given for a whole read is refused by its size, before its bytes travel`, tooLocal instanceof FileTooLargeError && tooRemote instanceof FileTooLargeError && tooRemote.sizeInBytes === tooLocal.sizeInBytes && tooRemote.maxSizeBytes === 1000 && tooRemote.lineCount === 5000, `${tooRemote?.message}`)
  const whole = await ops.remoteReadBytes(at(big))
  check(`${name}: the whole bytes of a file, with their checksum`, whole.bytes.equals(readFileSync(big)) && whole.sum === ops.remoteSum(readFileSync(big)))

  section(`${name} · what a path is`)
  const fifo = join(world.data, 'a-pipe')
  spawnSync('mkfifo', [fifo])
  symlinkSync(join(world.data, 'many'), join(world.data, 'link-to-many'))
  symlinkSync(join(world.data, 'nothing-here'), join(world.data, 'link-to-nothing'))
  mkdirSync(join(world.data, 'folder'), { recursive: true })
  symlinkSync(join(world.data, 'folder'), join(world.data, 'link-to-folder'))
  chmodSync(join(world.data, 'one-newline'), 0o640)
  const kinds = await Promise.all(['many', 'folder', 'a-pipe', 'link-to-many', 'link-to-nothing', 'link-to-folder', 'nothing-here'].map(file => ops.remoteStat(at(join(world.data, file)))))
  check(`${name}: a file, a folder, a named pipe, a link to each, a link to nothing, and nothing`, kinds[0]?.kind === 'file' && kinds[0].size === statSync(big).size && !kinds[0].link && kinds[1]?.kind === 'folder' && (kinds[2]?.kind === 'a named pipe' || !existsSync(fifo)) && kinds[3]?.kind === 'file' && kinds[3].link && kinds[4]?.kind === 'dangling' && kinds[5]?.kind === 'folder' && kinds[5].link && kinds[6] === null, JSON.stringify(kinds))
  const mode = await ops.remoteStat(at(join(world.data, 'one-newline')))
  check(`${name}: the mode and the time of a file`, mode?.mode === '640' && mode.mtimeMs === Math.floor(statSync(join(world.data, 'one-newline')).mtimeMs / 1000) * 1000, JSON.stringify(mode))
  const pipeRead = await failure(() => ops.remoteReadRange(at(fifo), 0, 5))
  check(`${name}: a named pipe is not opened`, !existsSync(fifo) || pipeRead?.code === 'ENOTREG', String(pipeRead?.message))
  const folderRead = await failure(() => ops.remoteReadRange(at(join(world.data, 'folder')), 0, 5))
  const missingRead = await failure(() => ops.remoteReadRange(at(join(world.data, 'nothing-here')), 0, 5))
  check(`${name}: a folder and a missing file fail as they do locally`, folderRead?.code === 'EISDIR' && missingRead?.code === 'ENOENT', `${folderRead?.code} ${missingRead?.code}`)

  section(`${name} · the home and the real path`)
  const home = await ops.remoteAbsolutePath(parseRemotePath('ssh://box/~')!)
  const under = await ops.remoteAbsolutePath(parseRemotePath('ssh://box/~/notes/a.md')!)
  const bare = await ops.remoteAbsolutePath(parseRemotePath('ssh://box')!)
  check(`${name}: ~ is the remote account's home`, home === world.remoteHome && under === `${world.remoteHome}/notes/a.md` && bare === world.remoteHome, `${home} ${under}`)
  const literal = await ops.remoteAbsolutePath(parseRemotePath('ssh://box/%7E/x')!)
  check(`${name}: an escaped tilde is a folder of that name`, literal === '/~/x', literal)
  const nobody = await failure(() => ops.remoteAbsolutePath(parseRemotePath('ssh://box/~no-such-user-here/x')!))
  check(`${name}: the home of an account that does not exist is said so`, nobody?.message === 'box has no account named no-such-user-here.', String(nobody?.message))
  mkdirSync(join(world.data, 'deep', 'er'), { recursive: true })
  writeFileSync(join(world.data, 'deep', 'er', 'file.txt'), 'x\n')
  symlinkSync(join(world.data, 'deep'), join(world.data, 'door'))
  symlinkSync('door', join(world.data, 'door-to-door'))
  const real = await ops.remoteRealPath(at(join(world.data, 'door-to-door', 'er', 'file.txt')))
  const dotted = await ops.remoteRealPath(at(join(world.data, 'door', 'er', '..', 'er', 'file.txt')))
  const fresh = await ops.remoteRealPath(at(join(world.data, 'door', 'new-file')))
  const linked = await ops.remoteRealPath(at(join(world.data, 'link-to-many')))
  check(`${name}: links and .. are resolved on the remote machine`, real === join(world.data, 'deep', 'er', 'file.txt') && dotted === real && fresh === join(world.data, 'deep', 'new-file') && linked === big, `${real} · ${dotted} · ${fresh} · ${linked}`)

  section(`${name} · a folder`)
  const dir = join(world.data, 'listed')
  mkdirSync(join(dir, 'sub'), { recursive: true })
  const odd = [`we'ird "name" $(touch INJECTED)`, 'two\nlines', ' leading', 'trailing ', '-rf', '.hidden', '..twodots', 'ünï', '*', 'a\\b']
  for (const file of odd) writeFileSync(join(dir, file), '')
  symlinkSync('sub', join(dir, 'link'))
  const listed = await ops.remoteList(at(dir))
  const names = listed.map(entry => `${entry.kind}:${entry.name}`).sort()
  const wanted = [...odd.map(file => `file:${file}`), 'folder:sub', 'link:link'].sort()
  check(`${name}: every name whole, hidden ones included, each with its kind`, JSON.stringify(names) === JSON.stringify(wanted), JSON.stringify(names))
  check(`${name}: a name ran nothing`, !existsSync(join(dir, 'INJECTED')) && !existsSync(join(world.remoteHome, 'INJECTED')))
  symlinkSync(join(world.data, 'many'), join(dir, 'link-out'))
  symlinkSync(join(world.data, 'door-to-door', 'er', 'file.txt'), join(dir, 'link-through-links'))
  symlinkSync('no-such-name', join(dir, 'link-nowhere'))
  const plain = await ops.remoteList(at(dir))
  const followed = await ops.remoteList(at(dir), undefined, true)
  const realOf = (file: string): string | undefined => followed.find(entry => entry.name === file)?.real
  check(`${name}: asked to, the listing says where each link leads, through other links and for one that leads nowhere`, realOf('link') === join(dir, 'sub') && realOf('link-out') === big && realOf('link-through-links') === join(world.data, 'deep', 'er', 'file.txt') && realOf('link-nowhere') === join(dir, 'no-such-name') && followed.filter(entry => entry.kind !== 'link').every(entry => entry.real === undefined), JSON.stringify(followed.filter(entry => entry.kind === 'link')))
  check(`${name}: unasked, a listing resolves nothing`, plain.length === followed.length && plain.every(entry => entry.real === undefined))
  mkdirSync(join(world.data, 'empty-folder'))
  const none = await ops.remoteList(at(join(world.data, 'empty-folder')))
  const noFolder = await failure(() => ops.remoteList(at(join(world.data, 'nothing-here'))))
  const notFolder = await failure(() => ops.remoteList(at(big)))
  check(`${name}: an empty folder, a missing one and a file are three answers`, none.length === 0 && noFolder?.code === 'ENOENT' && notFolder?.code === 'ENOTDIR', `${none.length} ${noFolder?.code} ${notFolder?.code}`)
  if (process.getuid?.() !== 0) {
    const shut = join(world.data, 'shut')
    mkdirSync(shut)
    writeFileSync(join(shut, 'inside'), '')
    chmodSync(shut, 0o000)
    const closed = await failure(() => ops.remoteList(at(shut)))
    chmodSync(shut, 0o755)
    check(`${name}: a folder that cannot be read is not an empty one, and fails as a local folder does`, closed?.code === 'EACCES' && closed.message === `EACCES: permission denied, scandir 'ssh://box${shut}'`, String(closed?.message))
    const sealed = join(world.data, 'sealed.txt')
    writeFileSync(sealed, 'not for this account\n')
    chmodSync(sealed, 0o000)
    const unread = await failure(() => ops.remoteReadRange(at(sealed), 0, 5))
    const unfetched = await failure(() => ops.remoteReadBytes(at(sealed)))
    chmodSync(sealed, 0o644)
    check(`${name}: a file the account may not read fails as a local file does, and is neither missing nor empty`, unread?.code === 'EACCES' && unread.message === `EACCES: permission denied, open 'ssh://box${sealed}'` && unfetched?.code === 'EACCES', `${unread?.message} | ${unfetched?.message}`)
  }
  const crowd = join(world.data, 'crowd')
  mkdirSync(crowd)
  for (let index = 0; index < 3000; index++) writeFileSync(join(crowd, `file-${String(index).padStart(5, '0')}-${'n'.repeat(60)}`), '')
  const crowded = await ops.remoteList(at(crowd))
  check(`${name}: three thousand names of a folder, none dropped`, crowded.length === 3000 && new Set(crowded.map(entry => entry.name)).size === 3000, String(crowded.length))
}

async function writes(world: RemoteWorld): Promise<void> {
  const name = world.transport
  section(`${name} · the checksum`)
  for (const bytes of [Buffer.alloc(0), Buffer.from('a'), Buffer.from('hello world\n'), randomBytes(70_001)]) {
    const path = join(world.data, `sum-${bytes.length}`)
    writeFileSync(path, bytes)
    const system = spawnSync('cksum', [path], { encoding: 'utf8' }).stdout.trim().split(/\s+/).slice(0, 2).join(' ')
    check(`${name}: ${bytes.length} bytes: the sum computed here is the remote cksum`, ops.remoteSum(bytes) === system && (await ops.remoteReadBytes(at(path))).sum === system, `${ops.remoteSum(bytes)} against ${system}`)
  }

  section(`${name} · a write lands whole or not at all`)
  const made = join(world.data, 'new', 'folders', 'made.txt')
  const first = Buffer.from('first\n')
  const created = await ops.remoteCommit(at(made), first, null, null)
  check(`${name}: a new file in folders that did not exist`, readFileSync(made).equals(first) && created.mtimeMs > 0 && created.generation !== null && created.generation === remoteGeneration(`ssh://box${made}`), JSON.stringify(created))
  check(`${name}: nothing is left beside it`, readdirSync(join(world.data, 'new', 'folders')).join() === 'made.txt', readdirSync(join(world.data, 'new', 'folders')).join())
  const again = await failure(() => ops.remoteCommit(at(made), Buffer.from('second\n'), null, null))
  check(`${name}: a write that expected no file is refused where one stands`, again instanceof ops.RemoteChangedError && readFileSync(made).equals(first), String(again?.message))
  chmodSync(made, 0o600)
  const before = await ops.remoteReadBytes(at(made))
  const second = Buffer.from('second\nline\n')
  const replaced = await ops.remoteCommit(at(made), second, before.sum, before.mode)
  check(`${name}: a replacement lands and keeps the file's mode`, readFileSync(made).equals(second) && (statSync(made).mode & 0o777) === 0o600 && replaced.generation !== created.generation, `${(statSync(made).mode & 0o777).toString(8)}`)
  writeFileSync(made, 'changed underneath\n')
  const stale = await failure(() => ops.remoteCommit(at(made), Buffer.from('third\n'), ops.remoteSum(second), '600'))
  check(`${name}: a file changed after it was read is not written, and says so`, stale instanceof ops.RemoteChangedError && stale.message === `ssh://box${made} changed on the remote machine after it was read.` && readFileSync(made, 'utf8') === 'changed underneath\n', String(stale?.message))
  check(`${name}: and the bytes that were on their way are gone`, readdirSync(join(world.data, 'new', 'folders')).join() === 'made.txt', readdirSync(join(world.data, 'new', 'folders')).join())
  const sameSize = Buffer.from('changed underneatH\n')
  writeFileSync(made, sameSize)
  utimesSync(made, new Date(1_700_000_000_000), new Date(1_700_000_000_000))
  const sly = await failure(() => ops.remoteCommit(at(made), Buffer.from('fourth\n'), ops.remoteSum(Buffer.from('changed underneath\n')), '600'))
  check(`${name}: a change of one byte with the same size is seen`, sly instanceof ops.RemoteChangedError && readFileSync(made).equals(sameSize))

  const target = join(world.data, 'link-target.txt')
  writeFileSync(target, 'through\n')
  symlinkSync(target, join(world.data, 'link.txt'))
  const viaLink = await ops.remoteReadBytes(at(join(world.data, 'link.txt')))
  await ops.remoteCommit(at(join(world.data, 'link.txt')), Buffer.from('written through\n'), viaLink.sum, viaLink.mode)
  check(`${name}: a link is written through, and stays a link`, lstatSync(join(world.data, 'link.txt')).isSymbolicLink() && readFileSync(target, 'utf8') === 'written through\n')
  const isFolder = await failure(() => ops.remoteCommit(at(join(world.data, 'new', 'folders')), Buffer.from('x'), null, null))
  check(`${name}: a folder is not written over`, isFolder !== null && statSync(join(world.data, 'new', 'folders')).isDirectory(), String(isFolder?.message))
  const large = randomBytes(5 * 1024 * 1024 + 3)
  await ops.remoteCommit(at(join(world.data, 'large.bin')), large, null, null)
  check(`${name}: five mebibytes of every byte value land identical`, readFileSync(join(world.data, 'large.bin')).equals(large))
  if (process.getuid?.() !== 0) {
    const locked = join(world.data, 'locked')
    mkdirSync(locked)
    const inside = join(locked, 'inside.txt')
    writeFileSync(inside, 'old\n')
    chmodSync(locked, 0o555)
    const held = await ops.remoteReadBytes(at(inside))
    const direct = await failure(() => ops.remoteCommit(at(inside), Buffer.from('new through the file itself\n'), held.sum, held.mode))
    const wrote = readFileSync(inside, 'utf8')
    const refused = await failure(() => ops.remoteCommit(at(inside), Buffer.from('never\n'), ops.remoteSum(Buffer.from('old\n')), held.mode))
    const kept = readFileSync(inside, 'utf8')
    chmodSync(locked, 0o755)
    check(`${name}: a folder that refuses a new file beside it gets the write through the file itself`, direct === null && wrote === 'new through the file itself\n', `${direct?.message} ${JSON.stringify(wrote)}`)
    check(`${name}: and that road also refuses a file that changed`, refused instanceof ops.RemoteChangedError && kept === 'new through the file itself\n', String(refused?.message))
  }

  section(`${name} · what the read ledger is told`)
  const tracked = join(world.data, 'tracked.txt')
  writeFileSync(tracked, 'one\ntwo\n')
  const identity = `ssh://box${tracked}`
  check(`${name}: a remote file never read has no generation`, fileGeneration(identity) === null)
  await ops.remoteReadRange(at(tracked), 0, 1)
  const afterRead = fileGeneration(identity)
  check(`${name}: a read records the generation of what was read`, /^m\d+:8:\d+$/.test(afterRead ?? ''), String(afterRead))
  writeFileSync(tracked, 'one\ntwo!\n')
  check(`${name}: nothing local is consulted for it`, fileGeneration(identity) === afterRead)
  await ops.remoteReadRange(at(tracked), 0, 0)
  check(`${name}: the next look at the remote file moves it`, fileGeneration(identity) !== afterRead && /^m\d+:9:\d+$/.test(fileGeneration(identity) ?? ''), String(fileGeneration(identity)))
  check(`${name}: a local path is read as before`, fileGeneration(tracked) !== null && fileGeneration(tracked) !== fileGeneration(identity))

  section(`${name} · whether the remote machine is this one`)
  const probesBefore = readdirSync(tmpdir()).filter(file => file.startsWith('.mercury-remote-')).length
  check(`${name}: a file of ours is seen from there, so it is`, (await ops.remoteIsThisMachine({ host: 'box' })) === true)
  check(`${name}: and the file is gone again`, readdirSync(tmpdir()).filter(file => file.startsWith('.mercury-remote-')).length === probesBefore)
}

async function underAChange(world: RemoteWorld): Promise<void> {
  section('local · a file that changes between the count of its lines and the page')
  const realSed = Bun.which('sed')
  if (realSed === null) {
    console.log('  [SKIP] no sed on this machine: a file changing under a page was not read')
    return
  }
  const grow = join(world.scratch, 'grow-this')
  const shrink = join(world.scratch, 'shrink-this')
  writeFileSync(
    join(world.scratch, 'bin', 'sed'),
    [
      '#!/bin/sh',
      `if [ -e '${grow}' ]; then printf 'a line that arrived late\\n' >> "$(cat '${grow}')"; fi`,
      `if [ -e '${shrink}' ]; then f=$(cat '${shrink}'); '${realSed}' '$d' "$f" > "$f.less" && cat "$f.less" > "$f"; fi`,
      `exec '${realSed}' "$@"`,
      '',
    ].join('\n'),
    { mode: 0o755 },
  )
  closeRemoteConnections()
  const log = join(world.data, 'growing.log')
  writeFileSync(log, 'one\ntwo\nthree\n')
  const asItStood = await readFileInRange(log, 0, 100)
  writeFileSync(grow, log)
  const grown = await ops.remoteReadRange(at(log), 0, 100).catch((error: Error) => error)
  rmSync(grow)
  check('a file that grew under the page is read as it stood when its lines were counted', !(grown instanceof Error) && grown.content === asItStood.content && grown.lineCount === asItStood.lineCount && grown.totalLines === asItStood.totalLines && readFileSync(log, 'utf8').split('\n').length > 4, grown instanceof Error ? grown.message : JSON.stringify({ content: grown.content, lines: grown.totalLines, now: readFileSync(log, 'utf8') }))
  const tail = join(world.data, 'shrinking.log')
  writeFileSync(tail, Array.from({ length: 40 }, (_, index) => `row ${index + 1}`).join('\n') + '\n')
  writeFileSync(shrink, tail)
  const shrunk = await failure(() => ops.remoteReadRange(at(tail), 30, 100))
  rmSync(shrink)
  check('a file that lost lines under the page, twice running, is said to have changed, and how to go on', shrunk instanceof ops.RemoteChangedError && shrunk.message === `ssh://box${tail} changed on the remote machine while it was being read; Read it again.`, String(shrunk?.message))
  const settledNow = await ops.remoteReadRange(at(tail), 30, 100)
  const local = await readFileInRange(tail, 30, 100)
  check('and the next read of it, the file at rest, is the local read again', settledNow.content === local.content && settledNow.totalLines === local.totalLines, JSON.stringify(settledNow.content))
  rmSync(join(world.scratch, 'bin', 'sed'))
  closeRemoteConnections()
}

for (const transport of ['local', 'sshd'] as const) {
  const unavailable = transport === 'local' ? localTransportUnavailable() : sshdUnavailable()
  if (unavailable !== null) {
    console.log(`  [SKIP] the ${transport} transport: ${unavailable}`)
    continue
  }
  const world = await remoteWorld(transport, PORT, { clientHome: HOME })
  const leave = enterWorld(world)
  try {
    await reads(world)
    await writes(world)
    if (transport === 'local') await underAChange(world)
  } finally {
    closeRemoteConnections()
    leave()
    await world.stop()
  }
}

console.log(`\nremote operations: ${checks - failures} of ${checks} ${failures === 0 ? 'PASS' : 'FAIL'}`)
process.exit(failures === 0 ? 0 : 1)
