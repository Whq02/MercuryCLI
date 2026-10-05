import { appendFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const [splashPath, colsArg, rowsArg, teePath] = process.argv.slice(2)
if (!splashPath || !teePath) {
  process.stderr.write('usage: node screen-probe.mjs <splash.mjs> <cols> <rows> <tee>\n')
  process.exit(2)
}
const cols = Number(colsArg) || 120
const rows = Number(rowsArg) || 44
writeFileSync(teePath, '')

const onlcr = buf => {
  const out = []
  for (const byte of buf) {
    if (byte === 0x0a) out.push(0x0d)
    out.push(byte)
  }
  return Buffer.from(out)
}

const capture = (chunk, enc, cb) => {
  const done = typeof enc === 'function' ? enc : cb
  const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), typeof enc === 'string' ? enc : 'utf8')
  appendFileSync(teePath, onlcr(buf))
  if (typeof done === 'function') done()
  return true
}

Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true })
Object.defineProperty(process.stdout, 'columns', { get: () => cols, configurable: true })
Object.defineProperty(process.stdout, 'rows', { get: () => rows, configurable: true })
process.stdout.write = capture
const noop = (...a) => {
  const cb = a[a.length - 1]
  if (typeof cb === 'function') cb()
  return true
}
process.stdout.cursorTo = noop
process.stdout.clearLine = noop
process.stdout.clearScreenDown = noop
Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true })
process.stdin.setRawMode = () => process.stdin

process.on('exit', c => {
  process.stderr.write(`SCREEN-PROBE exited code=${c}\n`)
})

await import(pathToFileURL(resolve(splashPath)).href)

setTimeout(() => {
  process.stderr.write('SCREEN-PROBE HARNESS KILL: the splash never exited on its own\n')
  process.exit(99)
}, 12000).unref?.()
