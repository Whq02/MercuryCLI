#!/usr/bin/env bun
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createFrameReader, createFrameWriter, type JsonRpcMessage } from '../../src/services/lsp/sidecarFraming.ts'

const ROOT = join(import.meta.dir, '..', '..')
const ENTRY = join(ROOT, 'src', 'services', 'lsp', 'tsSidecar', 'entry.ts')
const VENDOR = join(ROOT, 'dist', 'vendor', 'typescript')
const COMPILER = join(VENDOR, 'typescript.js')
if (!existsSync(COMPILER)) {
  console.error('✗ dist/vendor/typescript/typescript.js missing — run `bun run build.ts` first')
  process.exit(1)
}

let failures = 0
function check(label: string, ok: boolean, detail = ''): void {
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
}
const clip = (text: string, limit = 240): string => JSON.stringify(text.length > limit ? `${text.slice(0, limit)}…` : text)

console.log('§1 the vendored compiler ships its library types beside it')
const libs = readdirSync(VENDOR).filter(name => /^lib\..*\.d\.ts$/.test(name) || name === 'lib.d.ts').sort()
const sourceLibs = readdirSync(join(ROOT, 'node_modules', 'typescript', 'lib')).filter(name => /^lib(\..*)?\.d\.ts$/.test(name)).sort()
check(`every lib.*.d.ts of the pinned compiler rides beside typescript.js (${libs.length} of ${sourceLibs.length})`, libs.length === sourceLibs.length && libs.every((name, i) => name === sourceLibs[i]), `missing ${sourceLibs.filter(n => !libs.includes(n)).slice(0, 5).join(', ')}`)
check('the core libraries are among them (es5, es2015 core, dom, esnext, decorators, the full lib.d.ts)', ['lib.es5.d.ts', 'lib.es2015.core.d.ts', 'lib.dom.d.ts', 'lib.esnext.d.ts', 'lib.decorators.d.ts', 'lib.d.ts'].every(name => libs.includes(name)))
check('each copied library is byte-identical to the pinned compiler\'s', libs.every(name => readFileSync(join(VENDOR, name)).equals(readFileSync(join(ROOT, 'node_modules', 'typescript', 'lib', name)))))
const vendorJson = JSON.parse(readFileSync(join(VENDOR, 'vendor.json'), 'utf8')) as { package?: string; version?: string; libraries?: { count?: number; bytes?: number } }
check('vendor.json records the library set (count and bytes)', vendorJson.package === 'typescript' && typeof vendorJson.version === 'string' && vendorJson.libraries?.count === libs.length && typeof vendorJson.libraries?.bytes === 'number' && vendorJson.libraries.bytes === libs.reduce((sum, name) => sum + statSync(join(VENDOR, name)).size, 0), JSON.stringify(vendorJson))

console.log('§2 the sidecar on the packaged compiler: a no-tsconfig scratch file using the globals reads zero diagnostics')
const ws = mkdtempSync(join(tmpdir(), 'packaged-ts-libs-'))
const filePath = join(ws, 'probe.ts')
const source = [
  'export const smallest = Math.min(1, 2)',
  "export const loud: string = 'ok'.toUpperCase()",
  'export const later: Promise<number> = Promise.resolve(3)',
  'export const keys = Object.keys({ a: 1 })',
  '',
].join('\n')
writeFileSync(filePath, source)
const bun = process.env.BUN ?? `${process.env.HOME}/.bun/bin/bun`
const child = spawn(bun, [ENTRY], { cwd: ws, stdio: ['pipe', 'pipe', 'pipe'] })
const write = createFrameWriter(child.stdin!)
const pending = new Map<number, (msg: JsonRpcMessage) => void>()
const published: Array<{ uri?: string; diagnostics?: Array<{ message: string; code?: unknown }> }> = []
let nextId = 1
const readChunk = createFrameReader(
  msg => {
    if (msg.method === 'textDocument/publishDiagnostics') published.push(msg.params as never)
    if (msg.id !== undefined && msg.id !== null && msg.method === undefined) {
      const r = pending.get(msg.id as number)
      if (r) { pending.delete(msg.id as number); r(msg) }
    }
  },
  err => { console.error(`client protocol error: ${err.message}`); process.exit(1) },
)
child.stdout!.on('data', (c: Buffer) => readChunk(c))
let stderr = ''
child.stderr!.on('data', (c: Buffer) => { stderr += c.toString() })
function request(method: string, params: unknown): Promise<JsonRpcMessage> {
  const id = nextId++
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => { pending.delete(id); reject(new Error(`${method} timed out`)) }, 30_000)
    pending.set(id, m => { clearTimeout(t); resolve(m) })
    write({ jsonrpc: '2.0', id, method, params })
  })
}
const notify = (method: string, params: unknown): void => write({ jsonrpc: '2.0', method, params })
const uri = pathToFileURL(filePath).toString()
try {
  const init = await request('initialize', { rootUri: pathToFileURL(ws).toString(), capabilities: {}, initializationOptions: { typescriptPath: COMPILER } })
  check('the sidecar initialises on dist/vendor/typescript/typescript.js (no tsconfig, no node_modules in the workspace)', init.error === undefined && (init.result as { capabilities?: unknown })?.capabilities !== undefined, JSON.stringify(init.error ?? null))
  notify('initialized', {})
  notify('textDocument/didOpen', { textDocument: { uri, languageId: 'typescript', version: 1, text: source } })
  const pulled = await request('textDocument/diagnostic', { textDocument: { uri } })
  const items = ((pulled.result as { items?: Array<{ message: string; code?: unknown }> })?.items ?? [])
  console.log(`        diagnostics: ${items.length === 0 ? 'none' : items.map(d => `${String(d.code)} ${d.message}`).join(' | ').slice(0, 400)}`)
  check('Math, String.prototype, Promise and Object resolve: zero diagnostics', pulled.error === undefined && items.length === 0, items.map(d => d.message).join(' | ') || JSON.stringify(pulled.error ?? null))
  check("no 'Cannot find name' and no 'Cannot find global type' in the answer", !items.some(d => /Cannot find (name|global type)/.test(d.message)))
  const wrong = 'export const broken: number = Math.min(1, 2).toUpperCase()\n'
  notify('textDocument/didChange', { textDocument: { uri, version: 2 }, contentChanges: [{ text: wrong }] })
  const again = await request('textDocument/diagnostic', { textDocument: { uri } })
  const wrongItems = ((again.result as { items?: Array<{ message: string }> })?.items ?? [])
  check('control: a real type error on the same globals is still reported (toUpperCase on a number)', wrongItems.length === 1 && /toUpperCase/.test(wrongItems[0]!.message) && !/Cannot find name 'Math'/.test(wrongItems[0]!.message), wrongItems.map(d => d.message).join(' | '))
  await request('shutdown', null)
  notify('exit', null)
} catch (error) {
  check('the sidecar round trip completes', false, `${String(error)} · stderr ${clip(stderr)}`)
  child.kill('SIGKILL')
}
await new Promise<void>(resolve => { child.once('exit', () => resolve()); setTimeout(() => { child.kill('SIGKILL'); resolve() }, 5000) })

console.log('§3 the build step and the facility agree on the layout')
const buildSrc = readFileSync(join(ROOT, 'build.ts'), 'utf8')
const vendoring = buildSrc.slice(buildSrc.indexOf("const typescriptRelPath = 'vendor/typescript'"), buildSrc.indexOf('// Post-build: vendor the IMAGE PROCESSOR pack'))
check('build.ts copies lib/lib.*.d.ts beside typescript.js in the same vendoring step and records them in vendor.json', vendoring.includes("readDir(tsLibDir).filter(name => /^lib(\\..*)?\\.d\\.ts$/.test(name)).sort()") && vendoring.includes('copyFileSync(resolve(tsLibDir, name), resolve(tsDest, name))') && vendoring.includes('libraries: { count: libraryFiles.length, bytes: libraryBytes }'))
check('the build report names what the libraries added', /VENDORED typescript \$\{typescriptVersion\}[^\n]*librar/.test(buildSrc))

rmSync(ws, { recursive: true, force: true })
console.log(failures === 0 ? '\nprove-packaged-ts-lib-types: ALL PASS' : `\nprove-packaged-ts-lib-types: ${failures} FAIL`)
process.exit(failures === 0 ? 0 : 1)
