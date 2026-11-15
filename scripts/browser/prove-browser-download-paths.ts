#!/usr/bin/env bun
import { createHash } from 'node:crypto'
import * as fs from 'node:fs'
import type http from 'node:http'
import { tmpdir } from 'node:os'
import { basename, dirname, join, sep } from 'node:path'
import { BrowserTool, ROOT, check, finish, lead, ownerOf, requireBrowser, run, section, serve, sessions } from './harness.ts'

await requireBrowser()

const sha = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex')
const A = await serve(0, (req: http.IncomingMessage, res: http.ServerResponse) => {
  const url = new URL(req.url ?? '/', 'http://fixture')
  if (url.pathname === '/dl') {
    const rawName = url.searchParams.get('name') ?? 'item.bin'
    const slow = url.searchParams.get('slow') === '1'
    const body = slow ? Buffer.alloc(60_000, 'z') : Buffer.from(`bytes:${rawName}`)
    const ascii = rawName.replace(/[^\x20-\x7e]|["\\]/g, '_')
    res.writeHead(200, {
      'content-type': 'application/octet-stream',
      'content-disposition': `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(rawName)}`,
      'content-length': String(body.length),
    })
    if (slow) {
      let sent = 0
      const tick = setInterval(() => {
        res.write(Buffer.alloc(10_000, 'z'))
        sent += 10_000
        if (sent >= 60_000) {
          clearInterval(tick)
          res.end()
        }
      }, 400)
      res.on('close', () => clearInterval(tick))
      return
    }
    res.end(body)
    return
  }
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
  res.end(`<!doctype html><title>dl-paths</title>
<a id="slow" href="/dl?name=linked.bin&slow=1">slow</a>
<button id="colon" onclick="const a=document.createElement('a');a.href=window.URL.createObjectURL(new Blob(['colon-blob']));a.download='C:stream:$DATA';a.click()">colon</button>`)
})

const savedOf = (answer: { result: string }): { path: string; id: string } | null => {
  const hit = /saved to (.+?) \(.*\) — download (d\d+), in the session scratchpad/.exec(answer.result)
  return hit ? { path: hit[1]!, id: hit[2]! } : null
}

const waited: string[] = []
async function landed(answer: Awaited<ReturnType<typeof run>>): Promise<Awaited<ReturnType<typeof run>>> {
  const id = /download (d\d+) is still arriving/.exec(answer.result)?.[1]
  if (id === undefined) return answer
  const held = (sessions.browserTransfers(ownerOf(lead)) as Array<{ id: string; received: number; total: number | null; landing?: boolean }>).find(transfer => transfer.id === id)
  const facts = held === undefined ? 'no such transfer in the session' : `${held.received} of ${held.total ?? 'an unknown number of'} bytes received, ${held.landing === true ? 'the browser had reported it complete and the file was being put in place' : 'the browser had not yet reported it complete'}`
  const settled = await run({ op: 'download', downloadId: id, timeoutMs: 30_000 })
  waited.push(`${id} (${facts}): op:"download" with its id answered ${settled.result.startsWith('download: saved to ') ? 'saved' : 'not saved'} after ${settled.ms} ms`)
  return settled
}

const pads = (): string[] => {
  const root = fs.realpathSync(tmpdir())
  const found: string[] = []
  for (const top of fs.readdirSync(root)) {
    if (!/^mercury(-\d+)?$/.test(top)) continue
    for (const proj of fs.readdirSync(join(root, top))) {
      const at = join(root, top, proj)
      if (!fs.statSync(at).isDirectory()) continue
      for (const sess of fs.readdirSync(at)) found.push(join(at, sess, 'scratchpad'))
    }
  }
  return found
}
const dlHome = (): string => pads().map(p => join(p, 'browser-downloads')).find(p => fs.existsSync(p)) ?? ''

await run({ op: 'open', url: `${A.origin}/` })

section('S1 hostile, reserved, overlong, and duplicate suggested names stay inside their own scratchpad folder')
{
  const cases: Array<{ raw: string; checkBase: (b: string) => boolean }> = [
    { raw: '../../x', checkBase: b => !b.includes('..') || b === '_.._x' },
    { raw: '/etc/passwd', checkBase: b => b === '_etc_passwd' },
    { raw: 'C:\\Windows\\System32\\cmd.exe', checkBase: b => !/[:\\/]/.test(b) },
    { raw: 'C:colon:stream:$DATA', checkBase: b => !b.includes(':') },
    { raw: 'CON', checkBase: b => b === '_CON' },
    { raw: 'NUL.txt', checkBase: b => b === '_NUL.txt' },
    { raw: 'COM1.bin', checkBase: b => b === '_COM1.bin' },
    { raw: 'LPT9', checkBase: b => b === '_LPT9' },
    { raw: 'a'.repeat(300) + '.bin', checkBase: b => b.endsWith('.bin') && Buffer.byteLength(b, 'utf8') <= 200 },
    { raw: '漢'.repeat(110) + '.txt', checkBase: b => b.endsWith('.txt') && Buffer.byteLength(b, 'utf8') <= 200 && !b.includes('\ufffd') },
  ]
  for (const [idx, c] of cases.entries()) {
    const body = Buffer.from(`bytes:${c.raw}`)
    const ans = await landed(await run({ op: 'download', url: `${A.origin}/dl?name=${encodeURIComponent(c.raw)}&k=${idx}` }))
    const saved = savedOf(ans)
    const home = dlHome()
    const base = saved ? basename(saved.path) : ''
    check(
      `suggested name ${JSON.stringify(c.raw.slice(0, 28))} saves inside its own folder with safe bounded filename`,
      ans.outcome === 'succeeded' &&
        saved !== null &&
        dirname(saved.path) === join(home, saved.id) &&
        c.checkBase(base) &&
        fs.readFileSync(saved.path).equals(body) &&
        ans.result.includes(`sha256 ${sha(body)}`),
      `${ans.result} (base=${base}, bytes=${Buffer.byteLength(base, 'utf8')})`,
    )
  }

  const blobColon = await landed(await run({ op: 'download', selector: '#colon' }))
  const blobSaved = savedOf(blobColon)
  check(
    'a client-generated download attribute with colons has no colon on disk',
    blobSaved !== null && !basename(blobSaved.path).includes(':') && fs.readFileSync(blobSaved.path, 'utf8') === 'colon-blob',
    blobColon.result,
  )

  const dup1 = savedOf(await landed(await run({ op: 'download', url: `${A.origin}/dl?name=same.bin` })))
  const dup2 = savedOf(await landed(await run({ op: 'download', url: `${A.origin}/dl?name=same.bin` })))
  check(
    'two downloads of one name land in separate transfer folders without overwriting each other',
    dup1 !== null && dup2 !== null && dup1.path !== dup2.path && fs.existsSync(dup1.path) && fs.existsSync(dup2.path),
    `${dup1?.path} vs ${dup2?.path}`,
  )

  check(
    'Browser rejects a destination field so named-path exports must go through Write under Write’s own decision',
    !BrowserTool.inputSchema.safeParse({ op: 'download', url: `${A.origin}/dl`, destination: join(tmpdir(), 'out.bin') }).success,
  )
}

section('S2 links in the destination, dangling link ids, EXDEV copy fallback, and no partial under final name')
{
  const home = dlHome()
  const outsideDir = fs.mkdtempSync(join(tmpdir(), 'mercury-dl-outside-dir-'))
  const outsideVictim = join(outsideDir, 'victim.txt')
  fs.writeFileSync(outsideVictim, 'UNTOUCHED')

  const nextNum = fs.readdirSync(home).filter(n => /^d\d+$/.test(n)).length + 1
  const danglingSlot = join(home, `d${nextNum}`)
  let madeLinks = false
  let refused = ''
  try {
    fs.symlinkSync(join(outsideDir, 'nonexistent-target'), danglingSlot)
    madeLinks = true
  } catch (error) {
    refused = (error as NodeJS.ErrnoException).code ?? String(error)
  }

  if (!madeLinks) {
    for (const leg of [
      'beginTransfer skips a dangling symlink at dN rather than reusing or following it',
      'a symlink planted at the transfer folder during arrival refuses publication, writes nothing outside, and removes incoming/<guid>',
      'a pre-existing folder/symlink at the destination path is never overwritten and leaves the symlink target untouched',
    ]) {
      console.log(`  [SKIP] ${leg} — this account may not make a symbolic link (${refused})`)
    }
  } else {
    const afterDangling = savedOf(await landed(await run({ op: 'download', url: `${A.origin}/dl?name=after-dangling.bin` })))
    check(
      'beginTransfer skips a dangling symlink at dN rather than reusing or following it',
      afterDangling !== null && afterDangling.id !== `d${nextNum}` && dirname(afterDangling.path) === join(home, afterDangling.id),
      afterDangling?.path ?? '',
    )
    fs.rmSync(danglingSlot, { force: true })

    const slow1 = await run({ op: 'click', selector: '#slow' })
    const id1 = /download (d\d+) is still arriving/.exec(slow1.result)?.[1] ?? ''
    fs.symlinkSync(outsideDir, join(home, id1))
    const settled1 = await run({ op: 'download', downloadId: id1, timeoutMs: 10_000 })
    const incomingAfterFail1 = fs.existsSync(join(home, 'incoming')) ? fs.readdirSync(join(home, 'incoming')) : []
    check(
      'a symlink planted at the transfer folder during arrival refuses publication, writes nothing outside, and removes incoming/<guid>',
      settled1.outcome === 'failed' &&
        settled1.result.includes('the bytes arrived but the file could not be put in place') &&
        fs.readdirSync(outsideDir).join(',') === 'victim.txt' &&
        incomingAfterFail1.length === 0,
      `${settled1.result} | outside=${fs.readdirSync(outsideDir).join(',')} | incoming=${incomingAfterFail1.join(',')}`,
    )
    fs.rmSync(join(home, id1), { force: true })

    const slow2 = await run({ op: 'click', selector: '#slow' })
    const id2 = /download (d\d+) is still arriving/.exec(slow2.result)?.[1] ?? ''
    fs.mkdirSync(join(home, id2), { recursive: true })
    fs.symlinkSync(outsideVictim, join(home, id2, 'linked.bin'))
    const settled2 = await run({ op: 'download', downloadId: id2, timeoutMs: 10_000 })
    check(
      'a pre-existing folder/symlink at the destination path is never overwritten and leaves the symlink target untouched',
      settled2.outcome === 'failed' && fs.readFileSync(outsideVictim, 'utf8') === 'UNTOUCHED',
      settled2.result,
    )
  }

  const transfersMod = (await import(join(ROOT, 'src/services/browser/browserTransfers.ts'))) as typeof import('../../src/services/browser/browserTransfers.js')
  const scratchTransferHome = fs.mkdtempSync(join(tmpdir(), 'mercury-dl-unit-'))
  fs.mkdirSync(join(scratchTransferHome, 'incoming'), { recursive: true })
  const origRename = fs.promises.rename
  const origCopyFile = fs.promises.copyFile
  try {
    const book = transfersMod.newTransferBook()
    fs.writeFileSync(join(scratchTransferHome, 'incoming', 'guid-exdev-ok'), 'exdev-whole-bytes')
    const tOk = transfersMod.beginTransfer(book, {
      guid: 'guid-exdev-ok',
      tab: 'main',
      url: `${A.origin}/dl`,
      name: 'exdev.bin',
      type: 'application/octet-stream',
      home: scratchTransferHome,
    })
    fs.promises.rename = (async (from: fs.PathLike, to: fs.PathLike) => {
      if (String(from).includes('incoming')) {
        const err = Object.assign(new Error('EXDEV: cross-device link not permitted'), { code: 'EXDEV' })
        throw err
      }
      return origRename(from, to)
    }) as typeof fs.promises.rename
    transfersMod.moveTransfer(book, 'guid-exdev-ok', { state: 'completed', receivedBytes: 17, totalBytes: 17 })
    await tOk.done
    check(
      'EXDEV copy-and-remove fallback publishes whole verified file and removes incoming/<guid>',
      tOk.state === 'complete' &&
        tOk.path === join(scratchTransferHome, `d1${sep}exdev.bin`) &&
        fs.readFileSync(tOk.path, 'utf8') === 'exdev-whole-bytes' &&
        !fs.existsSync(join(scratchTransferHome, 'incoming', 'guid-exdev-ok')),
      JSON.stringify(tOk),
    )

    fs.writeFileSync(join(scratchTransferHome, 'incoming', 'guid-exdev-fail'), '0123456789abcdef')
    const tFail = transfersMod.beginTransfer(book, {
      guid: 'guid-exdev-fail',
      tab: 'main',
      url: `${A.origin}/dl`,
      name: 'never-partial.bin',
      type: 'application/octet-stream',
      home: scratchTransferHome,
    })
    fs.promises.copyFile = (async (_src: fs.PathLike, dest: fs.PathLike) => {
      fs.writeFileSync(dest, 'half')
      throw Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' })
    }) as typeof fs.promises.copyFile
    transfersMod.moveTransfer(book, 'guid-exdev-fail', { state: 'completed', receivedBytes: 16, totalBytes: 16 })
    await tFail.done
    const d2Entries = fs.existsSync(join(scratchTransferHome, 'd2')) ? fs.readdirSync(join(scratchTransferHome, 'd2')) : []
    check(
      'mid-copy failure never leaves a partial file under the final name or a .part remnant, and removes incoming/<guid>',
      tFail.state === 'failed' &&
        tFail.path === null &&
        d2Entries.length === 0 &&
        !fs.existsSync(join(scratchTransferHome, 'incoming', 'guid-exdev-fail')),
      `state=${tFail.state} d2=${d2Entries.join(',')}`,
    )
  } finally {
    fs.promises.rename = origRename
    fs.promises.copyFile = origCopyFile
    fs.rmSync(scratchTransferHome, { recursive: true, force: true })
  }
  fs.rmSync(outsideDir, { recursive: true, force: true })
}

console.log(
  waited.length === 0
    ? '\n    every download was saved when the act that started it answered'
    : `\n    ${waited.length} download(s) had not been saved when the act that started them answered, and each was waited for by the tool’s own road:\n${waited.map(line => `      ${line}`).join('\n')}`,
)
await finish('prove-browser-download-paths')
