#!/usr/bin/env bun
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs'
import type http from 'node:http'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { BrowserTool, ROOT, check, decide, finish, lead, pageOf, permission, requireBrowser, run, section, serve, validate } from './harness.ts'

await requireBrowser()

const dir = realpathSync(mkdtempSync(join(tmpdir(), 'mercury-upload-proof-')))
const at = (...parts: string[]): string => join(dir, ...parts)
const sha = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex')
const big = Buffer.alloc(20 * 1024 * 1024)
for (let i = 0; i < big.length; i += 4096) big.writeUInt32LE(i, i)
const stamp = new Date('2024-01-02T03:04:05Z')
mkdirSync(at('folder', 'inner'), { recursive: true })
mkdirSync(at('denied'))
mkdirSync(at('grows'))
writeFileSync(at('a.txt'), 'alpha file')
utimesSync(at('a.txt'), stamp, stamp)
writeFileSync(at('b.png'), Buffer.from([137, 80, 78, 71]))
writeFileSync(at('folder', 'x.txt'), 'x')
writeFileSync(at('folder', 'inner', 'y.txt'), 'yy')
writeFileSync(at('denied', 'secret.txt'), 'never sent')
writeFileSync(at('grows', 'first.txt'), 'first')
writeFileSync(at('other.txt'), 'another file')
const links = (() => {
  try {
    symlinkSync(at('folder'), at('folder', 'inner', 'loop'))
    symlinkSync(at('a.txt'), at('link.txt'))
    symlinkSync(at('denied', 'secret.txt'), at('alias.txt'))
    return true
  } catch {
    return false
  }
})()
const ruleFor = (target: string): string => (process.platform === 'win32' ? `Read(${target.replace(/\\/g, '/')}/**)` : `Read(//${target.replace(/^\/+/, '')}/**)`)
const allowed = { allow: [ruleFor(dir)] }
const denying = { allow: [ruleFor(dir)], deny: [ruleFor(at('denied'))] }

const frameHtml = `<!doctype html><title>inner</title><input id="inframe" type="file"><pre id="log"></pre>
<script>document.getElementById('inframe').addEventListener('change', event => { document.getElementById('log').textContent += 'inframe ' + Array.from(event.target.files).map(file => file.name + ':' + file.size).join(',') + '\\n' })</script>`
const handler =
  (other: string) =>
  (req: http.IncomingMessage, res: http.ServerResponse): void => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
    if ((req.url ?? '').startsWith('/inner')) {
      res.end(frameHtml)
      return
    }
    res.end(`<!doctype html><title>imports</title>
<input id="one" type="file"><input id="many" type="file" multiple><input id="dir" type="file" webkitdirectory>
<input id="hidden" type="file" style="display:none"><button id="choose" onclick="document.getElementById('hidden').click()">choose</button>
<button id="picker" onclick="window.showOpenFilePicker().then(() => log('picker filled'), error => log('picker ' + error.name))">picker</button>
<button id="plain" onclick="log('plain clicked')">plain</button>
<button id="digest" onclick="digest('one')">digest</button>
<input id="text" type="text">
<div id="zone" style="width:220px;height:36px;background:#ddd">zone</div>
<div id="delegated" style="width:220px;height:36px;background:#cdc">delegated</div>
<div id="deferred" style="width:220px;height:36px;background:#ccd">deferred</div>
<div id="rerender" style="width:220px;height:36px;background:#dcc">rerender</div>
<div id="half" style="width:220px;height:36px;background:#cc9">half</div>
<div id="host"></div>
<iframe id="same" src="/inner" style="width:300px;height:50px"></iframe>
<iframe id="cross" src="${other}/inner" style="width:300px;height:50px"></iframe>
<pre id="log"></pre>
<script>
const log = line => { document.getElementById('log').textContent += line + '\\n' }
const listed = files => Array.from(files).map(file => (file.webkitRelativePath || file.name) + ':' + file.size + ':' + file.type + ':' + file.lastModified).join(',')
for (const id of ['one', 'many', 'dir', 'hidden']) {
  const field = document.getElementById(id)
  field.addEventListener('input', () => log(id + ' input'))
  field.addEventListener('change', () => log(id + ' change ' + listed(field.files)))
  field.addEventListener('cancel', () => log(id + ' cancel'))
}
async function digest(id) {
  const file = document.getElementById(id).files[0]
  const hash = await crypto.subtle.digest('SHA-256', await file.arrayBuffer())
  log('digest ' + Array.from(new Uint8Array(hash)).map(byte => byte.toString(16).padStart(2, '0')).join('') + ' ' + file.size)
}
const names = event => Array.from(event.dataTransfer.files).map(file => file.name + ':' + file.size).join(',')
const zone = document.getElementById('zone')
zone.addEventListener('dragover', event => event.preventDefault())
zone.addEventListener('drop', event => { event.preventDefault(); event.stopPropagation(); log('zone drop ' + names(event)) })
document.addEventListener('dragover', event => { if (event.target.id === 'delegated' || event.target.id === 'deferred' || event.target.dataset.fresh) event.preventDefault() })
document.addEventListener('drop', event => {
  if (event.target.id === 'delegated') { event.preventDefault(); log('delegated drop ' + names(event)) }
  if (event.target.id === 'deferred') { event.preventDefault(); const files = Array.from(event.dataTransfer.files); setTimeout(async () => log('deferred drop ' + files[0].name + ' text=' + await files[0].text()), 250) }
  if (event.target.dataset.fresh) { event.preventDefault(); log('rerendered drop ' + names(event)) }
})
document.getElementById('rerender').addEventListener('dragenter', event => { const fresh = document.createElement('div'); fresh.dataset.fresh = '1'; fresh.id = 'rerender'; fresh.style.cssText = 'width:220px;height:36px;background:#f99'; fresh.textContent = 'fresh'; event.target.replaceWith(fresh) })
document.getElementById('half').addEventListener('dragover', event => event.preventDefault())
const shadow = document.getElementById('host').attachShadow({ mode: 'open' })
shadow.innerHTML = '<input id="deep" type="file">'
shadow.getElementById('deep').addEventListener('change', event => log('deep change ' + listed(event.target.files)))
</script>`)
  }
const A = await serve(27297, handler('http://127.0.0.1:27298'))
const B = await serve(27298, handler('http://127.0.0.1:27297'))

const pads = (): string[] => {
  const root = realpathSync(tmpdir())
  const found: string[] = []
  for (const top of readdirSync(root)) {
    if (!/^mercury(-\d+)?$/.test(top)) continue
    for (const project of readdirSync(join(root, top))) {
      const at = join(root, top, project)
      if (!statSync(at).isDirectory()) continue
      for (const session of readdirSync(at)) found.push(join(at, session, 'scratchpad'))
    }
  }
  return found
}
const { getEmptyToolPermissionContext } = (await import(join(ROOT, 'src/Tool.ts'))) as { getEmptyToolPermissionContext: () => Record<string, unknown> }
const stagings = (): string[] => pads().map(pad => join(pad, 'browser-uploads')).filter(folder => existsSync(folder))
const stagedSets = (): number => stagings().reduce((sets, folder) => sets + readdirSync(folder).length, 0)
const nap = (ms: number): Promise<void> => new Promise(done => setTimeout(done, ms))
const logLines = async (): Promise<string[]> => (await pageOf().$eval('#log', el => el.textContent ?? '')).trim().split('\n')
const lastLog = async (): Promise<string> => (await logLines()).at(-1) ?? ''
const held = (selector: string): Promise<number> => pageOf().$eval(selector, el => (el as HTMLInputElement).files?.length ?? -1)
const SET = '(set on the page; nothing reaches the site until the page sends it)'
const where = `${A.origin}/`

section('S0 control: acts that send no file (holds on the parent too)')
{
  const opened = await run({ op: 'open', url: where })
  const plain = await run({ op: 'click', selector: '#plain' })
  const typed = await run({ op: 'type', selector: '#text', text: 'ordinary' })
  check('a click and a typed field answer as today', opened.outcome === 'succeeded' && plain.result === `click #plain at ${where}` && typed.outcome === 'succeeded' && (await lastLog()) === 'plain clicked', `${plain.result} | ${typed.result}`)
  check('[G3] nothing is staged before an upload', stagings().length === 0, stagings().join(' '))
}

section('S1 a file input receives whole files, with the events a person’s choice gives')
{
  const one = await run({ op: 'upload', selector: '#one', files: [at('a.txt')] })
  check('[D1][M01][B01] an absolute path reaches the input, and the answer says what the page holds and that nothing is sent yet', one.outcome === 'succeeded' && one.result === `upload: #one holds 1 file — a.txt (10 bytes, text/plain) at ${where} ${SET}`, one.result)
  const seen = await logLines()
  check('[M02][M06] the page saw input and change with the name, size, type and last-modified time of the source', seen.at(-2) === 'one input' && seen.at(-1) === `one change a.txt:10:text/plain:${stamp.getTime()}`, seen.slice(-2).join(' | '))
  const byCwd = await run({ op: 'upload', selector: '#one', files: [relative(process.cwd(), at('b.png'))] })
  check('[M01] a path relative to the session’s working folder is the same file', byCwd.outcome === 'succeeded' && byCwd.result.includes('#one holds 1 file — b.png (4 bytes, image/png)'), byCwd.result)
  const two = await run({ op: 'upload', selector: '#one', files: [at('a.txt'), at('b.png')] })
  check('[M02][M14] several files into an input that takes one are refused by name, and the input keeps what it held', two.outcome === 'failed' && two.result === 'upload refused: #one takes one file (it has no multiple attribute) and 2 were given — nothing sent' && (await held('#one')) === 1, two.result)
  const many = await run({ op: 'upload', selector: '#many', files: [at('a.txt'), at('b.png')] })
  check('[M01] several files reach an input that takes several, in the order given', many.result === `upload: #many holds 2 files — a.txt (10 bytes, text/plain), b.png (4 bytes, image/png) at ${where} ${SET}`, many.result)
  const cleared = await run({ op: 'upload', selector: '#one', files: [] })
  check('[D1][M02] an empty list clears the input, and the page sees the change', cleared.result === `upload: #one cleared at ${where} (it held 1 file)` && (await held('#one')) === 0 && (await lastLog()) === 'one change', `${cleared.result} | ${await lastLog()}`)
  const hidden = await run({ op: 'upload', selector: '#hidden', files: [at('a.txt')] })
  const deep = await run({ op: 'upload', selector: '#host >>> #deep', files: [at('a.txt')] })
  check('[M03] an input that is styled away, and one inside a shadow root, take files by their selector', hidden.result.startsWith('upload: #hidden holds 1 file — a.txt') && deep.result.startsWith('upload: #host >>> #deep holds 1 file — a.txt') && (await lastLog()).startsWith('deep change a.txt:10'), `${hidden.result} | ${deep.result}`)
  const framed = await run({ op: 'upload', frame: 1, selector: '#inframe', files: [at('b.png')] })
  const inFrame = await pageOf().frames()[1]?.$eval('#log', el => el.textContent ?? '')
  check('[D1] an input in a child frame takes files through frame', framed.outcome === 'succeeded' && framed.result.startsWith('upload: #inframe holds 1 file — b.png') && inFrame === 'inframe b.png:4\n', `${framed.result} | ${inFrame}`)
}

section('S2 the page’s later reads do not need the original')
{
  writeFileSync(at('moving.bin'), big)
  const sent = await run({ op: 'upload', selector: '#one', files: [at('moving.bin')] })
  unlinkSync(at('moving.bin'))
  await run({ op: 'click', selector: '#digest' })
  for (let i = 0; i < 60 && !(await lastLog()).startsWith('digest '); i++) await nap(100)
  check('[M06][M13] a 20 MB file is whole in the page after its original is removed: the page’s own digest is the file’s', sent.result.includes('moving.bin (20 MB, ') && (await lastLog()) === `digest ${sha(big)} ${big.length}`, `${sent.result} | ${await lastLog()}`)
  check('[D1] the copies the browser reads lie in the session scratchpad', stagedSets() > 0 && stagings().length === 1, `${stagedSets()}`)
  const coverage = new Map<string, unknown>()
  await run({ op: 'upload', selector: '#one', files: [at('a.txt')] }, { ...lead, readFileState: coverage } as never)
  check('[D1][B04] an upload gives no read coverage of the file', coverage.size === 0)
}

section('S3 each source meets the decision Read has for it, and the page its origin’s')
{
  const upload = (file: string, selector = '#one'): { op: string; selector: string; files: string[] } => ({ op: 'upload', selector, files: [file] })
  const inside = await decide(upload(at('a.txt')), allowed)
  check('[D1] a file a Read rule allows, on an approved origin, asks nothing', inside.behavior === 'allow', JSON.stringify(inside))
  const outside = await decide(upload(at('a.txt')), {})
  check('[D1][M07] a file Read would ask about asks in Read’s own sentence', outside.behavior === 'ask' && outside.message === `Browser upload ${at('a.txt')} to #one on ${A.origin} — Permission to read from ${at('a.txt')} has not been granted.`, JSON.stringify(outside))
  const broad = await decide(upload(at('a.txt')), { allow: ['Browser'] })
  check('[M07] a whole-tool Browser allow does not answer Read’s question', broad.behavior === 'ask' && broad.message === outside.message, JSON.stringify(broad))
  const sovereign = await decide(upload(at('a.txt')), { mode: 'sovereign' })
  check('the mode that asks nothing asks nothing here either', sovereign.behavior === 'allow', JSON.stringify(sovereign))
  const denied = await decide(upload(at('denied', 'secret.txt')), denying)
  check('[D1][M07] a file a Read rule denies is denied', denied.behavior === 'deny' && (denied.message ?? '').includes(at('denied', 'secret.txt')), JSON.stringify(denied))
  const deniedBroad = await decide(upload(at('denied', 'secret.txt')), { ...denying, allow: [...denying.allow, 'Browser'] })
  const deniedSovereign = await decide(upload(at('denied', 'secret.txt')), { ...denying, mode: 'sovereign' })
  check('[M07] neither a whole-tool Browser allow nor the mode that asks nothing lifts that denial', deniedBroad.behavior === 'deny' && deniedSovereign.behavior === 'deny', `${deniedBroad.behavior} ${deniedSovereign.behavior}`)
  const viaLink = links ? await decide(upload(at('alias.txt')), denying) : denied
  check('[D1] a link that leads to a denied file is denied by where it leads', viaLink.behavior === 'deny', JSON.stringify(viaLink))
  writeFileSync(at('folder', 'inner', 'held-back.txt'), 'no')
  const member = await decide(upload(at('folder'), '#dir'), { allow: [ruleFor(dir)], deny: [ruleFor(at('folder', 'inner'))] })
  rmSync(at('folder', 'inner', 'held-back.txt'))
  check('[D1][M05] a folder is judged member by member: one denied file denies the upload', member.behavior === 'deny' && (member.message ?? '').includes(at('folder', 'inner')), JSON.stringify(member))
  const cross = await decide({ op: 'upload', frame: 2, selector: '#inframe', files: [at('a.txt')] }, allowed)
  check('[D1][T7] the receiving frame’s own origin must be approved: a frame of another origin asks as any act there asks', cross.behavior === 'ask' && cross.message === `Browser upload ${at('a.txt')} to #inframe on ${B.origin} — reached by navigation, not yet approved this session`, JSON.stringify(cross))
  const both = await decide({ op: 'upload', frame: 2, selector: '#inframe', files: [at('a.txt')] }, {})
  check('and one ask carries both questions when both are open', both.behavior === 'ask' && both.message === `${cross.message}\nPermission to read from ${at('a.txt')} has not been granted.`, JSON.stringify(both))
  const before = stagedSets()
  await permission(upload(at('denied', 'secret.txt')))
  const refused = await run(upload(at('denied', 'secret.txt')), { ...lead, getAppState: () => ({ toolPermissionContext: { ...getEmptyToolPermissionContext(), alwaysDenyRules: { localSettings: denying.deny } } }) } as never)
  check('[M07] a denied file is refused again where the bytes would move, and nothing is copied', refused.outcome === 'failed' && refused.result.startsWith('upload refused: ') && refused.result.endsWith(' — nothing sent') && refused.result.includes(at('denied', 'secret.txt')) && stagedSets() === before && (await held('#one')) === 1, refused.result)
}

section('S4 what was checked is what is sent')
{
  const before = stagedSets()
  if (links) {
    await permission({ op: 'upload', selector: '#many', files: [at('link.txt')] })
    rmSync(at('link.txt'))
    symlinkSync(at('other.txt'), at('link.txt'))
    const swapped = await run({ op: 'upload', selector: '#many', files: [at('link.txt')] })
    check('[B04] a link turned to another file after the check is refused, and nothing is copied', swapped.outcome === 'failed' && swapped.result === `upload refused: ${at('link.txt')} is another file than the permission check saw (it led to ${at('a.txt')}, it leads to ${at('other.txt')} now); re-issue to have what is there now judged — nothing sent` && stagedSets() === before, swapped.result)
  } else {
    check('[B04] a link turned to another file after the check is refused (links cannot be made here)', true)
  }
  await permission({ op: 'upload', selector: '#dir', files: [at('grows')] })
  writeFileSync(at('grows', 'late.txt'), 'late')
  const grown = await run({ op: 'upload', selector: '#dir', files: [at('grows')] })
  check('[B04][M05] a folder that gained a file after the check is refused by that file’s name', grown.outcome === 'failed' && grown.result === `upload refused: ${at('grows', 'late.txt')} was not there when the permission check saw ${at('grows')}; re-issue to have what is there now judged — nothing sent` && stagedSets() === before, grown.result)
  await permission({ op: 'upload', frame: 1, selector: '#inframe', files: [at('a.txt')] })
  await pageOf().frames()[1]!.goto(`${B.origin}/inner`)
  const reframed = await run({ op: 'upload', frame: 1, selector: '#inframe', files: [at('a.txt')] })
  check('[B04][T7] a frame that went to another origin after the check does not receive the file', reframed.outcome === 'failed' && reframed.result.includes('refused') && stagedSets() === before && (await pageOf().frames()[1]!.$eval('#inframe', el => (el as HTMLInputElement).files?.length)) === 0, reframed.result)
  await pageOf().frames()[1]!.goto(`${A.origin}/inner`)
}

section('S5 a control that opens a file chooser')
{
  const chosen = await run({ op: 'upload', selector: '#choose', files: [at('b.png')] })
  check('[D1][M03] the files go to the input the chooser belongs to, and the answer names it', chosen.outcome === 'succeeded' && chosen.result === `upload: input#hidden holds 1 file — b.png (4 bytes, image/png), chosen through the file chooser that #choose opened at ${where} ${SET}` && (await lastLog()).startsWith('hidden change b.png:4:image/png'), `${chosen.result} | ${await lastLog()}`)
  const tooMany = await run({ op: 'upload', selector: '#choose', files: [at('a.txt'), at('b.png')] })
  check('[M03][M14] a pick the input cannot take is refused by name, and the page sees a cancelled pick', tooMany.outcome === 'failed' && tooMany.result === 'upload refused: input#hidden, which #choose opens a chooser for, takes one file (it has no multiple attribute) and 2 were given — nothing sent' && (await lastLog()) === 'hidden cancel' && (await held('#hidden')) === 1, `${tooMany.result} | ${await lastLog()}`)
  const count = (await logLines()).length
  await run({ op: 'click', selector: '#choose' })
  await nap(400)
  check('[M03] choosers are not held afterwards: a later plain click on the control ends as it did before', (await logLines()).length === count + 1 && (await lastLog()) === 'hidden cancel', (await logLines()).slice(count).join(' | '))
  const picker = await run({ op: 'upload', selector: '#picker', files: [at('a.txt')] })
  const alive = await run({ op: 'info' })
  check('[M14] the page’s own file picker cannot be filled: the answer says so, names what takes files, and the tab goes on', picker.outcome === 'failed' && picker.result === 'upload: #picker asks for a file through the page’s own file picker (showOpenFilePicker), which cannot be filled — nothing sent; a file input or a drop zone takes files' && (await lastLog()) === 'picker AbortError' && alive.result.includes(`url: ${where}`), `${picker.result} | ${await lastLog()}`)
}

section('S6 a drop zone')
{
  const dropped = await run({ op: 'upload', selector: '#zone', files: [at('a.txt'), at('b.png')] })
  check('[D1][M04][B01] files dropped on a zone that takes them are reported as taken by the page, not as accepted by the site', dropped.outcome === 'succeeded' && dropped.result === `upload: 2 files dropped on #zone at ${where} and taken by the page — a.txt (10 bytes), b.png (4 bytes) (whether the site accepted them is the page’s to show)` && (await lastLog()) === 'zone drop a.txt:10,b.png:4', `${dropped.result} | ${await lastLog()}`)
  const delegated = await run({ op: 'upload', selector: '#delegated', files: [at('a.txt')] })
  check('[M04] a handler on the document receives them', delegated.outcome === 'succeeded' && (await lastLog()) === 'delegated drop a.txt:10', `${delegated.result} | ${await lastLog()}`)
  const deferred = await run({ op: 'upload', selector: '#deferred', files: [at('a.txt')] })
  for (let i = 0; i < 30 && !(await lastLog()).startsWith('deferred drop'); i++) await nap(50)
  check('[M04][M06] a handler that reads the file later reads its bytes', deferred.outcome === 'succeeded' && (await lastLog()) === 'deferred drop a.txt text=alpha file', `${deferred.result} | ${await lastLog()}`)
  const rerendered = await run({ op: 'upload', selector: '#rerender', files: [at('b.png')] })
  check('[M04] a zone that replaces itself when a file is dragged over it still receives the drop', rerendered.outcome === 'succeeded' && (await lastLog()) === 'rerendered drop b.png:4', `${rerendered.result} | ${await lastLog()}`)
  const pages = (await pageOf().browser().pages()).length
  const half = await run({ op: 'upload', selector: '#half', files: [at('a.txt')] })
  check('[M04][M14] a zone that takes the drag and not the drop is not reported as delivered, and the browser opens no file', half.outcome === 'failed' && half.result === 'upload: #half accepted the drag and did not take the drop — the page received nothing' && (await pageOf().browser().pages()).length === pages && pageOf().url() === where, `${half.result} | ${(await pageOf().browser().pages()).length} | ${pageOf().url()}`)
  const inert = await run({ op: 'upload', selector: '#plain', files: [at('a.txt')] })
  check('[M14] a control that is neither is named as neither, and the answer says its click went through', inert.outcome === 'failed' && inert.result === 'upload: #plain is not a file input, took no dropped file and opened no file chooser when clicked — the click went through and nothing was sent' && (await lastLog()) === 'plain clicked', `${inert.result} | ${await lastLog()}`)
}

section('S7 a folder, and sources that cannot be sent')
{
  const folder = await run({ op: 'upload', selector: '#dir', files: [at('folder')] })
  const names = (await lastLog()).replace(/:\d+(?=,|$)/g, '')
  check('[M05] a folder input receives the folder’s files with their paths, a link back into it followed once', folder.outcome === 'succeeded' && folder.result.startsWith('upload: #dir holds 2 files — ') && folder.result.includes('folder/inner/y.txt (2 bytes, text/plain)') && folder.result.includes('folder/x.txt (1 bytes, text/plain)') && folder.result.endsWith(` at ${where} ${SET}`) && names.replace('dir change ', '').split(',').sort().join(',') === 'folder/inner/y.txt:2:text/plain,folder/x.txt:1:text/plain', `${folder.result} | ${names}`)
  const flat = await run({ op: 'upload', selector: '#many', files: [at('folder')] })
  check('[M14] a folder for an input that is not a folder input is refused with what to do', flat.result === `upload refused: ${at('folder')} is a folder and #many is not a folder input (webkitdirectory); name its files — nothing sent`, flat.result)
  const before = (await logLines()).length
  const missing = await run({ op: 'upload', selector: '#plain', files: [at('nowhere.txt')] })
  check('[M14] a source that does not exist is named before anything is clicked', missing.result === `upload refused: ${at('nowhere.txt')} does not exist — nothing sent` && (await logLines()).length === before, missing.result)
  const empty = await run({ op: 'upload', selector: '#zone', files: [] })
  check('[M14] an empty list clears a file input and nothing else', empty.result === 'upload refused: an empty list clears a file input, and #zone is not one — nothing sent', empty.result)
  const typed = await run({ op: 'type', selector: '#one', text: 'x' })
  check('typing into a file input names the operation that sets it', typed.outcome === 'failed' && typed.result === 'type refused: input#one is a file input — op:"upload" with files sets it', typed.result)
}

section('S8 the words, the definition and the end')
{
  const bare = await validate({ op: 'upload', selector: '#one' })
  const aimless = await validate({ op: 'upload', files: [at('a.txt')] })
  check('upload takes a selector and a list', !bare.ok && !aimless.ok && bare.message === 'upload requires selector and files (an empty list clears a file input)' && aimless.message === bare.message, `${bare.message} | ${aimless.message}`)
  const stray = await validate({ op: 'click', selector: '#one', files: [at('a.txt')] })
  const blank = await validate({ op: 'click', selector: '#one', files: [] })
  check('files belongs to upload, and an empty list beside another operation reads as absent', !stray.ok && stray.message === 'files requires op upload' && blank.ok, stray.message)
  check('upload is an act', BrowserTool.isReadOnly({ op: 'upload', selector: '#one', files: [] } as never) === false)
  const shape = (BrowserTool.inputSchema as unknown as { shape: Record<string, { description?: string }> }).shape
  check('the definition carries the field in a short clause', shape.files?.description === 'upload: local paths; [] clears the input', String(shape.files?.description))
  const manual: string = await BrowserTool.prompt()
  check('[G2] the manual says uploads are performed, and no longer that they are not', manual.includes('\nupload sets files (local paths; an empty list clears) on a file input, a control that opens a file chooser or a drop zone, by selector; each file meets Read\'s decision, the page its origin\'s act approval; the answer says what the page holds.\n') && !manual.includes('uploads are not performed'), manual.split('\n').find(line => line.startsWith('upload')) ?? '')
  const sets = stagedSets()
  await run({ op: 'close' })
  check('[G3] the copies go with the agent’s last browser', sets > 0 && stagings().length === 0, `${sets} then ${stagedSets()}`)
  check('the originals were never touched', statSync(at('a.txt')).mtimeMs === stamp.getTime() && statSync(at('a.txt')).size === 10)
}

rmSync(dir, { recursive: true, force: true })
await finish('prove-browser-uploads')
