#!/usr/bin/env bun
import { existsSync, readFileSync } from 'node:fs'
import type http from 'node:http'
import { check, finish, pageOf, requireBrowser, run, section, serve } from './harness.ts'

await requireBrowser()
process.env.MERCURY_MODEL = 'claude-opus-4-8'

const handler = (req: http.IncomingMessage, res: http.ServerResponse): void => {
  const url = new URL(req.url ?? '/', 'http://fixture')
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
  if (url.pathname === '/noise') {
    res.end(
      `<!doctype html><meta name="viewport" content="width=device-width, initial-scale=1"><title>noise</title><body style="margin:0"><canvas id="c"></canvas><button id="hit" style="position:fixed;left:600px;top:380px;width:80px;height:40px" onclick="document.title='hit'">hit</button><script>const c=document.getElementById('c');c.width=innerWidth*devicePixelRatio;c.height=innerHeight*devicePixelRatio;c.style.width=innerWidth+'px';c.style.height=innerHeight+'px';const g=c.getContext('2d');const d=g.createImageData(c.width,c.height);for(let i=0;i<d.data.length;i++)d.data[i]=i%4===3?255:(i*2654435761>>>((i%13)+3))&255;g.putImageData(d,0,0)</script>`,
    )
    return
  }
  res.end(
    '<!doctype html><meta name="viewport" content="width=device-width, initial-scale=1"><title>scale</title><body style="margin:0"><div id="box" style="width:100px;height:50px;background:#246"></div><div style="height:1950px"></div>',
  )
}
const A = await serve(27285, handler)

const size = (file: string): [number, number] => {
  if (!existsSync(file)) return [0, 0]
  const bytes = readFileSync(file)
  if (bytes[0] === 0x89 && bytes[1] === 0x50) return [bytes.readUInt32BE(16), bytes.readUInt32BE(20)]
  for (let at = 2; at + 9 < bytes.length; ) {
    const marker = bytes[at + 1]!
    if (bytes[at] === 0xff && marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) return [bytes.readUInt16BE(at + 7), bytes.readUInt16BE(at + 5)]
    at += 2 + bytes.readUInt16BE(at + 2)
  }
  return [0, 0]
}
const fileOf = (result: string): string => /screenshot: (\S+\.png)/.exec(result)?.[1] ?? ''
const noteOf = (result: string): string => / — the image is .*$/.exec(result.split('\n')[0] ?? '')?.[0] ?? ''

section('S0 control: where image pixels are CSS pixels the answer is today’s (holds on the parent too)')
{
  const opened = await run({ op: 'open', url: `${A.origin}/` })
  check('the fixture opens', opened.outcome === 'succeeded', opened.result)
  const shot = await run({ op: 'screenshot', label: 'plain' })
  const file = fileOf(shot.result)
  check('a 1280x800 page at scale 1 answers in today’s words', shot.outcome === 'succeeded' && shot.result === `screenshot: ${file} (${A.origin}/, viewport 1280x800)` && JSON.stringify(size(file)) === '[1280,800]', shot.result)
}

section('S1 a plain scale: the saved image has more pixels than the page has CSS pixels')
{
  await run({ op: 'viewport', width: 600, height: 400, deviceScaleFactor: 2 })
  const shot = await run({ op: 'screenshot', label: 'scale2' })
  check('[E6] the answer says the factor', JSON.stringify(size(fileOf(shot.result))) === '[1200,800]' && noteOf(shot.result) === ' — the image is 1200x800 px for 600x400 CSS px: 1 image px = 0.5 CSS px', shot.result)
  await run({ op: 'viewport', width: 1280, height: 800 })
  const back = await run({ op: 'screenshot', label: 'scale1' })
  check('[E6] and says nothing once they are equal again', noteOf(back.result) === '', back.result)
}

section('S2 a device: the viewport, an element and the full page')
{
  await run({ op: 'viewport', emulation: { device: 'Pixel 5' } })
  const view = await run({ op: 'screenshot', label: 'device' })
  check('[E6][B03] the viewport image of a 3x device', JSON.stringify(size(fileOf(view.result))) === '[1179,2553]' && noteOf(view.result) === ' — the image is 1179x2553 px for 393x851 CSS px: 1 image px = 0.333 CSS px', view.result)
  const element = await run({ op: 'screenshot', selector: '#box', label: 'element' })
  check('[B03] an element image', JSON.stringify(size(fileOf(element.result))) === '[300,150]' && noteOf(element.result) === ' — the image is 300x150 px for 100x50 CSS px: 1 image px = 0.333 CSS px', element.result)
  const full = await run({ op: 'screenshot', fullPage: true, label: 'full' })
  const [fullWidth, fullHeight] = size(fileOf(full.result))
  const [seenWidth, seenHeight] = existsSync(`${fileOf(full.result)}.inline`) ? size(`${fileOf(full.result)}.inline`) : [fullWidth, fullHeight]
  check('[B03] the full page image: the saved file is the whole page at 3x, and the factor is that of the copy that is shown', fullWidth === 1179 && fullHeight === 6000 && noteOf(full.result) === ` — the image is ${seenWidth}x${seenHeight} px for 393x2000 CSS px: 1 image px = ${Number((393 / seenWidth).toFixed(3))} CSS px`, `${full.result} ${fullWidth}x${fullHeight} ${seenWidth}x${seenHeight}`)
  await run({ op: 'viewport', emulation: { reset: true } })
}

section('S3 the copy a model is shown, downscaled to the image budget')
{
  await run({ op: 'viewport', width: 1280, height: 800, deviceScaleFactor: 2 })
  await run({ op: 'open', url: `${A.origin}/noise` })
  const shot = await run({ op: 'screenshot', label: 'noise' })
  const file = fileOf(shot.result)
  const inline = `${file}.inline`
  const [shownWidth, shownHeight] = existsSync(inline) ? size(inline) : [0, 0]
  const factor = Number((1280 / shownWidth).toFixed(3))
  check('the saved image is the full one and a downscaled copy is shown', JSON.stringify(size(file)) === '[2560,1600]' && shot.result.includes('inlined copy downscaled to the image budget') && shownWidth > 0 && shownWidth < 2560, `${shot.result} ${shownWidth}x${shownHeight}`)
  check('[E6][B03] the factor is that of the copy the model sees, not of the file', noteOf(shot.result) === ` — the image is ${shownWidth}x${shownHeight} px for 1280x800 CSS px: 1 image px = ${factor} CSS px`, shot.result)
  const centre = { x: 640 / factor, y: 400 / factor }
  const clicked = await run({ op: 'click', x: Math.round(centre.x * factor), y: Math.round(centre.y * factor) })
  check('[B03] a point read off that image and multiplied by the factor lands on the control it shows', clicked.outcome === 'succeeded' && (await pageOf().title()) === 'hit', clicked.result)
  process.env.MERCURY_MODEL = 'local/never-listed'
  const textOnly = await run({ op: 'screenshot', label: 'text-only' })
  check('[M12] for a model that takes no image the factor is that of the saved file', !existsSync(`${fileOf(textOnly.result)}.inline`) && noteOf(textOnly.result) === ' — the image is 2560x1600 px for 1280x800 CSS px: 1 image px = 0.5 CSS px', textOnly.result)
}

await finish('prove-browser-screenshot-scale')
