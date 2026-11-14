#!/usr/bin/env bun
import { createHash } from 'node:crypto'
import * as fs from 'node:fs'
import type http from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ROOT, check, decide, detect, detectionHtml, finish, lead, ownerOf, pageOf, permission, requireBrowser, run, section, serve, sessions } from './harness.ts'

await requireBrowser()
const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
const acceptedAuth = `Basic ${Buffer.from('hist:secret-auth').toString('base64')}`

interface SeenReq {
  tag: string
  path: string
  rawHeaders: string[]
}
const reqs: SeenReq[] = []
const receivedUploads: Array<{ name: string; bytes: Buffer }> = []
let currentTag = 'init'

const A = await serve(0, (req: http.IncomingMessage, res: http.ServerResponse) => {
  const url = new URL(req.url ?? '/', 'http://fixture')
  if (url.pathname !== '/favicon.ico' && req.method === 'GET') {
    reqs.push({ tag: currentTag, path: url.pathname + url.search, rawHeaders: [...req.rawHeaders] })
  }
  if (url.pathname === '/auth-dl' && req.headers.authorization !== acceptedAuth) {
    res.writeHead(401, { 'www-authenticate': 'Basic realm="hist"' })
    res.end('auth required')
    return
  }
  if (url.pathname === '/dl' || url.pathname === '/auth-dl') {
    const body = Buffer.from(`dl:${url.searchParams.get('n') ?? '1'}`)
    res.writeHead(200, {
      'content-type': 'application/octet-stream',
      'content-disposition': `attachment; filename="${url.searchParams.get('name') ?? 'std.bin'}"`,
      'content-length': String(body.length),
    })
    res.end(body)
    return
  }
  if (url.pathname === '/upload-sink' && req.method === 'POST') {
    const chunks: Buffer[] = []
    req.on('data', c => chunks.push(c as Buffer))
    req.on('end', () => {
      receivedUploads.push({ name: String(req.headers['x-name'] ?? ''), bytes: Buffer.concat(chunks) })
      res.writeHead(200, { 'content-type': 'text/plain' })
      res.end('ok')
    })
    return
  }
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
  if (url.pathname === '/detect') {
    res.end(detectionHtml(req.headers, tz))
    return
  }
  res.end(`<!doctype html><title>page-${url.pathname.slice(1) || 'home'}</title>
<a id="plain" href="/detect">plain</a>
<a id="dl" href="/dl?n=link">dl</a>
<input id="one" type="file">
<input id="many" type="file" multiple>
<button id="post-files" onclick="(async () => {
  const el = document.getElementById('many').files.length ? document.getElementById('many') : document.getElementById('one');
  for (const f of el.files) {
    await fetch('/upload-sink', { method: 'POST', headers: { 'x-name': f.name }, body: f });
  }
  document.title = 'uploaded-' + el.files.length;
})()">post</button>`)
})

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

section('S1 unused session sends 56 protocol commands and creates no transfer folder; download requests keep full stealth')
{
  const { Connection } = (await import(join(ROOT, 'node_modules/puppeteer-core/lib/puppeteer/cdp/Connection.js'))) as {
    Connection: { prototype: { _rawSend: (...args: unknown[]) => unknown } }
  }
  const origSend = Connection.prototype._rawSend
  const sent: Array<{ method: string; params: Record<string, unknown> | undefined; session: string | undefined }> = []
  Connection.prototype._rawSend = function (this: unknown, cb: unknown, method: unknown, params: unknown, session: unknown, ...rest: unknown[]) {
    sent.push({ method: String(method), params: params as Record<string, unknown> | undefined, session: typeof session === 'string' ? session : undefined })
    return origSend.call(this, cb, method, params, session, ...rest)
  }
  const knownSessions = new Set<string>()
  try {
    await run({ op: 'open', url: `${A.origin}/` })
    const driverId = (pageOf() as unknown as { _client?: () => { id(): string } })._client?.().id()
    const ownId = sessions.pageKitOf(pageOf())?.cdp?.id()
    const watchId = sent.find(c => c.method === 'Target.setAutoAttach' && JSON.stringify(c.params?.filter) === '[{"type":"page","exclude":false}]')?.session
    for (const id of [driverId, ownId, watchId]) if (id) knownSessions.add(id)
    await run({ op: 'screenshot', label: 'no-transfer' })
    await run({ op: 'close' })
  } finally {
    Connection.prototype._rawSend = origSend
  }
  const ownCommands = sent.filter(c => c.session === undefined || knownSessions.has(c.session))
  const dlBehaviours = ownCommands.filter(c => c.method === 'Browser.setDownloadBehavior')
  const anyFolders = pads().some(p => fs.existsSync(join(p, 'browser-downloads')) || fs.existsSync(join(p, 'browser-uploads')))
  check(
    'open, screenshot, close sends 52 protocol commands on the root, driver, page-kit, and watch sessions (56 with default background targets; the one over the tabs row is the page-kit session’s auto-attach for frames of another site; 2 download-behavior commands, 0 extra) and creates no transfer folder',
    ownCommands.length === 52 && ownCommands.filter(c => c.method === 'Target.setAutoAttach' && JSON.stringify(c.params?.filter) === '[{"type":"iframe","exclude":false}]').length === 1 && dlBehaviours.length === 2 && !anyFolders,
    `commands=${ownCommands.length} dlBehaviours=${dlBehaviours.length} folders=${anyFolders}`,
  )

  await run({ op: 'open', url: `${A.origin}/` })
  await pageOf().evaluate(() => { document.cookie = 'dlstealth=1; max-age=3600; path=/' })
  currentTag = 'plain-nav'
  await run({ op: 'click', selector: '#plain' })
  currentTag = 'reset'
  await run({ op: 'open', url: `${A.origin}/` })

  currentTag = 'click-dl'
  await run({ op: 'click', selector: '#dl' })
  currentTag = 'op-dl-sel'
  await run({ op: 'download', selector: '#dl' })
  currentTag = 'op-dl-url'
  await run({ op: 'download', url: `${A.origin}/dl?n=url` })
  currentTag = 'op-dl-detect'
  await run({ op: 'download', url: `${A.origin}/detect`, timeoutMs: 300 })
  const nineFollowed = await detect(lead)

  const plainRaw = reqs.find(r => r.tag === 'plain-nav')!.rawHeaders
  const clickDlRaw = reqs.find(r => r.tag === 'click-dl')!.rawHeaders
  const selDlRaw = reqs.find(r => r.tag === 'op-dl-sel')!.rawHeaders
  const urlDlRaw = reqs.find(r => r.tag === 'op-dl-url')!.rawHeaders
  const stripNavContext = (h: string[]): Array<[string, string]> => {
    const out: Array<[string, string]> = []
    for (let i = 0; i < h.length; i += 2) {
      const k = h[i]!
      if (k.toLowerCase() !== 'referer' && k.toLowerCase() !== 'sec-fetch-site') out.push([k, h[i + 1]!])
    }
    return out
  }
  check(
    'click download and download(selector) carry byte-for-byte identical headers, order, client hints, and cookie as plain navigation',
    JSON.stringify(clickDlRaw) === JSON.stringify(plainRaw) && JSON.stringify(selDlRaw) === JSON.stringify(plainRaw),
    JSON.stringify({ plainRaw, clickDlRaw, selDlRaw }),
  )
  check(
    'download(url) navigation carries the exact same header set, order, client hints, and cookie (minus Referer/Sec-Fetch-Site)',
    JSON.stringify(stripNavContext(urlDlRaw)) === JSON.stringify(stripNavContext(plainRaw)),
    JSON.stringify({ plainRaw, urlDlRaw }),
  )
  check('9/9 stealth holds on a tab followed by op:"download"', nineFollowed.passed === 9 && nineFollowed.total === 9, JSON.stringify(nineFollowed.checks))
  await run({ op: 'close' })
}

section('S2 uploads: Read decisions across modes (including Mercury credentials), send-moment bytes, 128 MiB streaming, and many files')
{
  await run({ op: 'open', url: `${A.origin}/` })
  const work = fs.mkdtempSync(join(tmpdir(), 'mercury-up-bound-'))
  const deniedFolder = join(work, 'denied')
  fs.mkdirSync(deniedFolder)
  fs.writeFileSync(join(deniedFolder, 'secret.txt'), 'secret-bytes')
  fs.writeFileSync(join(work, 'changing.txt'), 'bytes-at-ask')
  const credFile = join(process.env.MERCURY_CONFIG_DIR!, '.credentials.json')
  const browserSecFile = join(process.env.MERCURY_CONFIG_DIR!, 'browser-secrets.json')
  fs.writeFileSync(credFile, '{"oauth":"never-upload"}')
  fs.writeFileSync(browserSecFile, '{"secret":"never-upload"}')
  let madeLinks = false
  try {
    fs.symlinkSync(join(deniedFolder, 'secret.txt'), join(work, 'denied-link.txt'))
    fs.symlinkSync(credFile, join(work, 'cred-link.json'))
    madeLinks = true
  } catch {}

  const denyRule = process.platform === 'win32' ? `Read(${deniedFolder.replace(/\\/g, '/')}/**)` : `Read(//${deniedFolder.replace(/^\/+/, '')}/**)`
  for (const mode of ['default', 'implement', 'sovereign'] as const) {
    const credVerdict = await decide({ op: 'upload', selector: '#one', files: [credFile] }, { mode, allow: ['Browser'] })
    const bsecVerdict = await decide({ op: 'upload', selector: '#one', files: [browserSecFile] }, { mode, allow: ['Browser'] })
    const ruleVerdict = await decide({ op: 'upload', selector: '#one', files: [join(deniedFolder, 'secret.txt')] }, { mode, deny: [denyRule], allow: ['Browser'] })
    const outVerdict = await decide({ op: 'upload', selector: '#one', files: [join(work, 'changing.txt')] }, { mode, allow: ['Browser'] })
    check(
      `mode ${mode}: Mercury credential files and Read deny rules are refused with Read’s own sentence, and outside files ask except in sovereign`,
      credVerdict.behavior === 'deny' &&
        (credVerdict.message ?? '').startsWith(`Reading ${credFile} is refused:`) &&
        (credVerdict.message ?? '').includes("holds Mercury's own credentials") &&
        bsecVerdict.behavior === 'deny' &&
        (bsecVerdict.message ?? '').includes("holds Mercury's own credentials") &&
        ruleVerdict.behavior === 'deny' &&
        (ruleVerdict.message ?? '').startsWith(`Reading ${join(deniedFolder, 'secret.txt')} is denied by`) &&
        outVerdict.behavior === (mode === 'sovereign' ? 'allow' : 'ask'),
      JSON.stringify({ mode, credVerdict, bsecVerdict, ruleVerdict, outVerdict }),
    )
    if (madeLinks) {
      const linkRule = await decide({ op: 'upload', selector: '#one', files: [join(work, 'denied-link.txt')] }, { mode, deny: [denyRule], allow: ['Browser'] })
      const linkCred = await decide({ op: 'upload', selector: '#one', files: [join(work, 'cred-link.json')] }, { mode, allow: ['Browser'] })
      check(
        `mode ${mode}: symlinks to a denied folder or to Mercury’s own credential file are denied with Read’s sentence`,
        linkRule.behavior === 'deny' &&
          (linkRule.message ?? '').startsWith(`Reading ${join(work, 'denied-link.txt')} is denied by`) &&
          linkCred.behavior === 'deny' &&
          (linkCred.message ?? '').includes("holds Mercury's own credentials"),
        JSON.stringify({ mode, linkRule, linkCred }),
      )
    }
  }

  const asked = await permission({ op: 'upload', selector: '#one', files: [join(work, 'changing.txt')] })
  fs.writeFileSync(join(work, 'changing.txt'), 'bytes-at-the-moment-of-upload')
  const uploaded = await run({ op: 'upload', selector: '#one', files: [join(work, 'changing.txt')] })
  receivedUploads.length = 0
  await run({ op: 'click', selector: '#post-files' })
  for (let i = 0; i < 40 && receivedUploads.length < 1; i++) await new Promise(r => setTimeout(r, 50))
  check(
    'a file edited between the ask and the upload sends the bytes present at the moment of the upload',
    asked.behavior === 'ask' && uploaded.outcome === 'succeeded' && receivedUploads[0]?.bytes.toString('utf8') === 'bytes-at-the-moment-of-upload',
    `${uploaded.result} | got=${receivedUploads[0]?.bytes.toString('utf8')}`,
  )

  const batch: string[] = []
  for (let i = 0; i < 8; i++) {
    const f = join(work, `item-${i}.txt`)
    fs.writeFileSync(f, `content-${i}`)
    batch.push(f)
  }
  receivedUploads.length = 0
  const manyUp = await run({ op: 'upload', selector: '#many', files: batch })
  await run({ op: 'click', selector: '#post-files' })
  for (let i = 0; i < 40 && receivedUploads.length < 8; i++) await new Promise(r => setTimeout(r, 50))
  const cleared = await run({ op: 'upload', selector: '#many', files: [] })
  check(
    'many files upload in order and reach the server, and files: [] clears the input',
    manyUp.outcome === 'succeeded' &&
      manyUp.result.includes('holds 8 files — ') &&
      receivedUploads.length === 8 &&
      receivedUploads.map(u => u.bytes.toString('utf8')).join(',') === batch.map((_, i) => `content-${i}`).join(',') &&
      cleared.result.includes('#many cleared') &&
      cleared.result.includes('(it held 8 files)'),
    `${manyUp.result} | ${cleared.result}`,
  )

  const largeFile = join(work, 'large-128m.bin')
  const fh = await fs.promises.open(largeFile, 'w')
  await fh.truncate(128 * 1024 * 1024)
  await fh.write(Buffer.from('START'), 0, 5, 0)
  await fh.write(Buffer.from('FINISH'), 0, 6, 128 * 1024 * 1024 - 6)
  await fh.close()
  Bun.gc(true)
  const mem0 = process.memoryUsage().heapUsed
  const largeUp = await run({ op: 'upload', selector: '#one', files: [largeFile] })
  Bun.gc(true)
  const mem1 = process.memoryUsage().heapUsed
  check(
    'a 128 MiB file stages by streaming without loading whole into the JS heap',
    largeUp.outcome === 'succeeded' && largeUp.result.includes('large-128m.bin (128 MB,') && mem1 - mem0 < 48 * 1024 * 1024,
    `${largeUp.result} | heapDelta=${Math.round((mem1 - mem0) / (1024 * 1024))}MiB`,
  )

  await run({ op: 'close' })
  fs.rmSync(work, { recursive: true, force: true })
}

section('S3 History files: quartet removed only on download-following launches and never under heldElsewhere; cookies, storage, and auth survive')
{
  await run({ op: 'open', url: `${A.origin}/hist-seed-marker` })
  await pageOf().evaluate(() => {
    document.cookie = 'hcookie=survives; max-age=3600; path=/'
    localStorage.setItem('hstore', 'survives-too')
  })
  await run({ op: 'viewport', emulation: { credentials: { username: 'hist', password: 'secret-auth' } } })
  const dl1 = await run({ op: 'download', url: `${A.origin}/auth-dl?n=1&name=auth1.bin` })
  const prof = sessions.browserProfileDirForOrigin(A.origin, ownerOf(lead)) as string
  await run({ op: 'close' })
  const hasSeedMarker = (): boolean =>
    fs.existsSync(join(prof, 'Default', 'History')) && fs.readFileSync(join(prof, 'Default', 'History')).includes('hist-seed-marker')
  fs.writeFileSync(join(prof, 'Default', 'KeepOtherProfileFile'), 'untouched')

  const plainOwner = ownerOf({ agentId: 'plain-no-dl' })
  await sessions.ensureBrowserSession(plainOwner, { origin: A.origin })
  await sessions.disposeBrowserOwner(plainOwner)
  check('a launch that does not follow downloads preserves History', hasSeedMarker())

  for (const sidecar of ['History-journal', 'History-wal', 'History-shm']) {
    fs.rmSync(join(prof, 'Default', sidecar), { recursive: true, force: true })
    fs.mkdirSync(join(prof, 'Default', sidecar))
  }
  await run({ op: 'open', url: `${A.origin}/after-clean` })
  const kept = await pageOf().evaluate(() => [document.cookie, localStorage.getItem('hstore')])
  await run({ op: 'viewport', emulation: { credentials: { username: 'hist', password: 'secret-auth' } } })
  const dl2 = await run({ op: 'download', url: `${A.origin}/auth-dl?n=2&name=auth2.bin` })
  const walDirLeft = ['History-journal', 'History-wal', 'History-shm'].some(
    sidecar => fs.existsSync(join(prof, 'Default', sidecar)) && fs.statSync(join(prof, 'Default', sidecar)).isDirectory(),
  )
  const markerStillInLiveHistory = hasSeedMarker()
  check(
    'a download-following launch removes History, History-journal, History-wal, and History-shm while keeping cookies, storage, other files, and authenticated downloads',
    dl1.outcome === 'succeeded' &&
      !markerStillInLiveHistory &&
      !walDirLeft &&
      fs.readFileSync(join(prof, 'Default', 'KeepOtherProfileFile'), 'utf8') === 'untouched' &&
      String(kept[0]).includes('hcookie=survives') &&
      kept[1] === 'survives-too' &&
      dl2.outcome === 'succeeded' &&
      dl2.result.includes(`sha256 ${createHash('sha256').update(Buffer.from('dl:2')).digest('hex')}`),
    JSON.stringify({ markerStillInLiveHistory, walDirLeft, kept, dl2: dl2.result }),
  )

  const dup1 = { agentId: 'hist-dup-a/b' }
  const dup2 = { agentId: 'hist-dup-a?b' }
  await run({ op: 'open', url: `${A.origin}/` }, dup1)
  const dupProf1 = sessions.browserProfileDirForOrigin(A.origin, ownerOf(dup1)) as string
  const dupProf2 = sessions.browserProfileDirForOrigin(A.origin, ownerOf(dup2)) as string
  fs.writeFileSync(join(dupProf1, 'Default', 'History-journal'), 'live-owner-history-sentinel')
  await run({ op: 'open', url: `${A.origin}/` }, dup2)
  check(
    'History files are never removed when another live owner holds that profile directory',
    dupProf1 === dupProf2 &&
      fs.existsSync(join(dupProf1, 'Default', 'History-journal')) &&
      fs.readFileSync(join(dupProf1, 'Default', 'History-journal'), 'utf8') === 'live-owner-history-sentinel',
    `${dupProf1} vs ${dupProf2}`,
  )
  await sessions.disposeBrowserOwner(ownerOf(dup1))
  await sessions.disposeBrowserOwner(ownerOf(dup2))
}

await finish('prove-browser-transfer-boundaries')
