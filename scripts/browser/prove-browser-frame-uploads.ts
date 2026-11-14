#!/usr/bin/env bun
import { mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import type http from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Frame } from 'puppeteer-core'
import { check, finish, lead, ownerOf, pageOf, permission, requireBrowser, run, section, serve, sessions } from './harness.ts'

await requireBrowser()

const dir = realpathSync(mkdtempSync(join(tmpdir(), 'mercury-frame-upload-proof-')))
const at = (name: string): string => join(dir, name)
writeFileSync(at('a.txt'), 'alpha file')
writeFileSync(at('b.txt'), 'second')

let port = 0
const WIDGET = (inner: string): string => `<!doctype html><title>widget</title>
<input id="plain" type="file">
<input id="hidden" type="file" style="display:none"><button id="choose" onclick="document.getElementById('hidden').click()">choose</button>
<button id="picker" onclick="window.showOpenFilePicker().then(() => log('picker filled'), error => log('picker ' + error.name))">picker</button>
<div id="zone" style="width:200px;height:30px;background:#ddd">zone</div>
<pre id="log"></pre>
<script>
const log = line => { document.getElementById('log').textContent += line + '\\n' }
for (const id of ['plain', 'hidden']) {
  const field = document.getElementById(id)
  field.addEventListener('change', async () => { log(id + ' ' + (await Promise.all(Array.from(field.files).map(async file => file.name + ':' + (await file.text())))).join(',')) })
  field.addEventListener('cancel', () => log(id + ' cancel'))
}
const zone = document.getElementById('zone')
zone.addEventListener('dragover', event => event.preventDefault())
zone.addEventListener('drop', event => { event.preventDefault(); log('zone ' + Array.from(event.dataTransfer.files).map(file => file.name + ':' + file.size).join(',')) })
</script>${inner}`
const A = await serve(0, (req: http.IncomingMessage, res: http.ServerResponse) => {
  const path = new URL(req.url ?? '/', 'http://fixture').pathname
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
  if (path === '/widget') return void res.end(WIDGET(`<iframe src="http://127.0.0.1:${port}/inner" style="width:420px;height:120px"></iframe>`))
  if (path === '/inner') return void res.end(WIDGET(''))
  res.end(`<!doctype html><title>outer</title><p>outer</p><iframe src="http://localhost:${port}/widget" style="width:480px;height:320px"></iframe>`)
})
port = A.port
const CROSS = `http://localhost:${port}`

type Answer = Awaited<ReturnType<typeof run>>
const frameOf = (part: string, tab?: string): Frame | null => pageOf(lead, tab).frames().find(frame => frame.parentFrame() !== null && frame.url().includes(part)) ?? null
const logOf = async (part: string, tab?: string): Promise<string> => ((await frameOf(part, tab)?.$eval('#log', el => el.textContent ?? '').catch(() => 'unreadable')) ?? 'no frame')
const logged = async (part: string, line: string, tab?: string): Promise<boolean> => {
  for (let waited = 0; waited < 40; waited++) {
    if ((await logOf(part, tab)).includes(line)) return true
    await new Promise(done => setTimeout(done, 100))
  }
  return false
}
const upload = async (input: Record<string, unknown>): Promise<Answer & { asked: string }> => {
  const call = { op: 'upload', ...input }
  const first = await permission(call)
  for (const origin of [CROSS, A.origin]) sessions.approveWebOrigin(ownerOf(lead), `${origin}/`)
  await permission(call)
  return { ...(await run(call)), asked: `${first.behavior} ${first.message ?? ''}` }
}
const WIDGET_FRAME = `localhost:${port}/widget`
const INNER_FRAME = `127.0.0.1:${port}/inner`

section('S0 controls: what already reaches a frame from another site (hold on the parent too)')
await run({ op: 'open', url: `${A.origin}/` })
{
  const direct = await upload({ frame: WIDGET_FRAME, selector: '#plain', files: [at('a.txt')] })
  check('the frame’s own origin is asked for, with Read’s sentence for the file', direct.asked.startsWith(`ask Browser upload ${at('a.txt')} to #plain on ${CROSS} — `), direct.asked)
  check('a file input in the frame takes the file', direct.outcome === 'succeeded' && direct.result.startsWith('upload: #plain holds 1 file — a.txt (10 bytes') && (await logged(WIDGET_FRAME, 'plain a.txt:alpha file')), `${direct.result} | ${await logOf(WIDGET_FRAME)}`)
  const dropped = await upload({ frame: WIDGET_FRAME, selector: '#zone', files: [at('a.txt')] })
  check('a zone in the frame takes a dropped file', dropped.outcome === 'succeeded' && dropped.result.startsWith('upload: 1 file dropped on #zone') && (await logged(WIDGET_FRAME, 'zone a.txt:10')), `${dropped.result} | ${await logOf(WIDGET_FRAME)}`)
}

section('S1 a control that opens a file chooser, in a frame from another site')
{
  const chosen = await upload({ frame: WIDGET_FRAME, selector: '#choose', files: [at('a.txt')] })
  check('[M03] the file is set through the chooser the control opened, and the answer says so', chosen.outcome === 'succeeded' && chosen.result.startsWith('upload: input#hidden holds 1 file — a.txt (10 bytes, text/plain), chosen through the file chooser that #choose opened at '), chosen.result)
  check('[M02] the frame’s page received the file with its bytes', await logged(WIDGET_FRAME, 'hidden a.txt:alpha file'), await logOf(WIDGET_FRAME))
  const two = await upload({ frame: WIDGET_FRAME, selector: '#choose', files: [at('a.txt'), at('b.txt')] })
  check('[M14] two files for an input that takes one are refused in the words of the page’s own road, and the page sees a cancelled pick', two.outcome === 'failed' && two.result === 'upload refused: input#hidden, which #choose opens a chooser for, takes one file (it has no multiple attribute) and 2 were given — nothing sent' && (await logged(WIDGET_FRAME, 'hidden cancel')), `${two.result} | ${await logOf(WIDGET_FRAME)}`)
  const picker = await upload({ frame: WIDGET_FRAME, selector: '#picker', files: [at('a.txt')] })
  check('the page’s own file picker is the browser’s to refuse in such a frame: none opens, and the answer says so (holds on the parent too)', picker.outcome === 'failed' && picker.result === 'upload: #picker is not a file input, took no dropped file and opened no file chooser when clicked — the click went through and nothing was sent' && (await logged(WIDGET_FRAME, 'picker SecurityError')), `${picker.result} | ${await logOf(WIDGET_FRAME)}`)
  const before = (await logOf(WIDGET_FRAME)).split('hidden cancel').length
  await permission({ op: 'click', frame: WIDGET_FRAME, selector: '#choose' })
  const clicked = await run({ op: 'click', frame: WIDGET_FRAME, selector: '#choose' })
  let after = before
  for (let waited = 0; waited < 30 && after === before; waited++) {
    await new Promise(done => setTimeout(done, 100))
    after = (await logOf(WIDGET_FRAME)).split('hidden cancel').length
  }
  check('[M03] nothing stays intercepted: a plain click on the control afterwards ends as a cancelled pick', clicked.outcome === 'succeeded' && after === before + 1, `${clicked.result} | ${await logOf(WIDGET_FRAME)}`)
}

section('S2 in a frame inside that frame')
{
  const chosen = await upload({ frame: INNER_FRAME, selector: '#choose', files: [at('b.txt')] })
  check('[M03] the chooser of a control two frames down is filled too', chosen.outcome === 'succeeded' && chosen.result.startsWith('upload: input#hidden holds 1 file — b.txt (6 bytes, text/plain), chosen through the file chooser that #choose opened at ') && (await logged(INNER_FRAME, 'hidden b.txt:second')), `${chosen.result} | ${await logOf(INNER_FRAME)}`)
}

section('S3 on a tab born beside another')
{
  await run({ op: 'open', tab: 'beside', url: `${A.origin}/` })
  const call = { op: 'upload', tab: 'beside', frame: WIDGET_FRAME, selector: '#choose', files: [at('a.txt')] }
  await permission(call)
  const chosen = await run(call)
  check('[M03] the chooser in the frame is filled there too', chosen.outcome === 'succeeded' && chosen.result.includes('chosen through the file chooser that #choose opened') && (await logged(WIDGET_FRAME, 'hidden a.txt:alpha file', 'beside')), `${chosen.result} | ${await logOf(WIDGET_FRAME, 'beside')}`)
}

await finish('prove-browser-frame-uploads')
