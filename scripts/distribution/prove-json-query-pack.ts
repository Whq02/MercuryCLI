import { createHash } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const root = process.env.PROVE_ROOT ?? resolve(import.meta.dir, '../..')
let passed = 0, failed = 0
const check = (name: string, ok: boolean, detail = ''): void => { ok ? passed++ : failed++; console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}${ok ? '' : ` ${detail}`}`) }
const lockPath = join(root, 'vendor/json-query.lock.json')
check('the JSON query engine has a checked-in lock', existsSync(lockPath))
if (existsSync(lockPath)) {
  const lock = JSON.parse(readFileSync(lockPath, 'utf8'))
  const pack = join(root, 'dist/vendor/json-query')
  const manifest = JSON.parse(readFileSync(join(root, 'dist/manifest.json'), 'utf8'))
  check('the build declares the pinned engine without degradation', manifest.jsonQuery?.vendored === true && manifest.jsonQuery.version === lock.version && !manifest.degraded.includes('json-query'))
  let present = true
  for (const file of lock.files) {
    const named = join(pack, file.path)
    const ok = existsSync(named) && createHash('sha256').update(readFileSync(named)).digest('hex') === file.sha256
    check(`shipped bytes match the lock: ${file.path}`, ok)
    present &&= ok
  }
  for (const script of ['jsonQueryProcess.mjs', 'jsonQueryWorker.mjs']) {
    const copied = join(pack, script)
    check(`shipped runner matches its source: ${script}`, existsSync(copied) && readFileSync(copied).equals(readFileSync(join(root, 'src/tools/FileReadTool', script))))
  }
  for (const file of ['package.json', 'Dockerfile', 'scripts/release/release-local.sh', '.github/workflows/gate.yml', '.github/workflows/drives.yml', '.github/workflows/private-release.yml', '.github/workflows/windows-launcher.yml', '.github/workflows/windows-ui.yml', '.github/workflows/shell-windows-probe.yml']) {
    check(`existing preparation road fetches the engine: ${file}`, readFileSync(join(root, file), 'utf8').includes('scripts/vendor/fetch-json-query.ts'))
  }
  check('packager checks the query pack', readFileSync(join(root, 'scripts/release/package.mjs'), 'utf8').includes('checkJsonQueryPack(pkgDir)'))
  check('archive verifier checks the query pack', readFileSync(join(root, 'scripts/release/verifyArchive.mjs'), 'utf8').includes('checkJsonQueryPack(payload)'))
  const notices = readFileSync(join(root, 'THIRD_PARTY_NOTICES.md'), 'utf8')
  for (const component of lock.components) check(`notices retain ${component.name}`, notices.includes(component.name))
  if (present) {
    const { loadJq } = await import(pathToFileURL(join(pack, 'dist/index.mjs')).href)
    const compiled = await WebAssembly.compile(readFileSync(join(pack, 'dist/build/jq.wasm')))
    const source = Buffer.from('{"n":9007199254740993123456789,"s":"x  \\n"}\n')
    let memory: WebAssembly.Memory, offset = 0
    const out: Buffer[] = [], err: Buffer[] = []
    const jq = await loadJq({ instantiateWasm(imports: Record<string, Record<string, Function>>, ready: Function) {
      check('pinned read/write ABI is present', typeof imports[lock.abi.imports]?.[lock.abi.read] === 'function' && typeof imports[lock.abi.imports]?.[lock.abi.write] === 'function')
      imports[lock.abi.imports]![lock.abi.read] = (_fd: number, vectors: number, count: number, got: number) => {
        const words = new Uint32Array(memory.buffer), bytes = new Uint8Array(memory.buffer)
        let total = 0
        for (let i = 0; i < count; i++) {
          const start = words[(vectors >> 2) + i * 2]!, size = Math.min(words[(vectors >> 2) + i * 2 + 1]!, source.length - offset)
          bytes.set(source.subarray(offset, offset + size), start)
          total += size; offset += size
        }
        words[got >> 2] = total
        return 0
      }
      imports[lock.abi.imports]![lock.abi.write] = (fd: number, vectors: number, count: number, got: number) => {
        const words = new Uint32Array(memory.buffer), bytes = new Uint8Array(memory.buffer)
        let total = 0
        for (let i = 0; i < count; i++) {
          const start = words[(vectors >> 2) + i * 2]!, size = words[(vectors >> 2) + i * 2 + 1]!
          ;(fd === 1 ? out : err).push(Buffer.from(bytes.subarray(start, start + size)))
          total += size
        }
        words[got >> 2] = total
        return 0
      }
      const instance = new WebAssembly.Instance(compiled, imports as WebAssembly.Imports)
      memory = instance.exports[lock.abi.memory] as WebAssembly.Memory
      check('pinned memory ABI is present', memory instanceof WebAssembly.Memory)
      ready(instance)
    } })
    const result = jq.raw('', '.n, .s', ['-r', '--'])
    check('stream hooks preserve exact large literals and raw trailing whitespace', result.exitCode === 0 && Buffer.concat(out).toString() === '9007199254740993123456789\nx  \n\n' && err.length === 0)
    const base = process.env.RP_SCRATCH ?? process.env.MERCURY_TMPDIR ?? process.env.MERCURY_CONFIG_DIR
    if (!base) throw new Error('The proof needs its scratch root')
    const scratch = mkdtempSync(join(base, 'query-pack-'))
    try {
      mkdirSync(join(scratch, 'vendor'), { recursive: true })
      cpSync(pack, join(scratch, 'vendor/json-query'), { recursive: true })
      writeFileSync(join(scratch, 'manifest.json'), JSON.stringify(manifest))
      const contract = await import(pathToFileURL(join(root, 'scripts/release/payloadContract.mjs')).href)
      check('a complete staged pack passes the archive contract', contract.checkJsonQueryPack(scratch).ok)
      writeFileSync(join(scratch, 'vendor/json-query/dist/build/jq.wasm'), 'changed')
      check('a changed wasm cannot ship with an unchanged record', !contract.checkJsonQueryPack(scratch).ok)
      cpSync(join(pack, 'dist/build/jq.wasm'), join(scratch, 'vendor/json-query/dist/build/jq.wasm'))
      rmSync(join(scratch, 'vendor/json-query/LICENSE.jq'))
      check('missing component notices fail the archive contract', !contract.checkJsonQueryPack(scratch).ok)
    } finally { rmSync(scratch, { recursive: true, force: true }) }
  }
}
console.log(`${passed}/${passed + failed} checks`)
process.exitCode = failed ? 1 : 0
