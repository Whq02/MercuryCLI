import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { option } from './viewportFixture.ts'

const out = option('--out')
const before = option('--old')
const after = option('--new')
const compact = process.argv.includes('--old-compact') ? option('--old-compact') : before
const oldNotice = process.argv.includes('--old-notice') ? option('--old-notice') : before
const newNotice = process.argv.includes('--new-notice') ? option('--new-notice') : after
const esc = (s: string) => s.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]!))
const image = (label: string, scene: string, size: string, mark: string, title: string) => {
  const name = `${label}-${scene}-${size}-${mark}`
  const file = join(out, `${name}.json`)
  if (!existsSync(file)) return `<figure><figcaption>${esc(title)}</figcaption><p>Not captured: ${esc(name)}</p></figure>`
  const { cols, rows } = JSON.parse(readFileSync(file, 'utf8'))
  return `<figure><figcaption>${esc(title)} · ${cols}x${rows} · 8x16 px cells</figcaption><img src="${esc(name)}.png" width="${cols * 8}" height="${rows * 16}" alt="${esc(title)}"><p><a href="${esc(name)}.txt">Text</a> · <a href="${esc(name)}.json">Cells</a></p></figure>`
}
let sections = ''
for (const size of ['120x40', '80x24']) {
  const oldBoot = size === '80x24' ? compact : before
  sections += `<section><h2>Boot round trip · ${size}</h2><div class="pair">${image(oldBoot, 'boot', size, 'after', 'Old: after Concourse')}${image(after, 'boot', size, 'after', 'New: after Concourse')}</div><details><summary>Old Boot before travel</summary>${image(oldBoot, 'boot', size, 'before', 'Old: before Concourse')}</details></section>`
  sections += `<section><h2>Session with long notice · ${size}</h2><div class="pair">${image(oldNotice, 'notice', size, 'notice', 'Old: actual session notice')}${image(newNotice, 'notice', size, 'notice', 'New: actual session notice')}</div></section>`
}
writeFileSync(join(out, 'viewport.html'), `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Viewport frames</title><style>body{margin:24px;background:#111;color:#eee;font:14px system-ui}h1,h2{font-weight:500}.pair{display:flex;gap:24px;align-items:flex-start}figure{margin:0}figcaption{margin:12px 0}img{display:block;max-width:none;image-rendering:pixelated}a{color:#a9d5ef}section{border-top:1px solid #444;padding:12px 0 24px}details{margin-top:16px}</style><h1>Viewport frames</h1><p>Local captures, one terminal cell per 8x16 pixels. Images are not scaled. Scroll sideways to compare. Missing frames remain missing; no rail crop or head loss is drawn into them.</p>${sections}</html>`)
console.log(join(out, 'viewport.html'))
