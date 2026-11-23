import { createHash } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const root = process.env.PROVE_ROOT ?? resolve(import.meta.dir, '../..')
let passed = 0, failed = 0
const check = (name: string, ok: boolean, detail = '', hint = ''): void => { ok ? passed++ : failed++; console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}${ok ? '' : ` ${detail}${hint ? ` | ${hint}` : ''}`}`) }
const lockPath = join(root, 'vendor/json-query.lock.json')
check('the JSON query engine has a checked-in lock', existsSync(lockPath), '', 'restore vendor/json-query.lock.json, the lock that scripts/vendor/jsonQuery.ts reads')
if (existsSync(lockPath)) {
  const lock = JSON.parse(readFileSync(lockPath, 'utf8'))
  const pack = join(root, 'dist/vendor/json-query')
  const manifest = JSON.parse(readFileSync(join(root, 'dist/manifest.json'), 'utf8'))
  check('the build declares the pinned engine without degradation', manifest.jsonQuery?.vendored === true && manifest.jsonQuery.version === lock.version && !manifest.degraded.includes('json-query'), '', 'run bun run setup then bun run build.ts so dist/manifest.json declares the pack at the version in vendor/json-query.lock.json')
  let present = true
  for (const file of lock.files) {
    const named = join(pack, file.path)
    const ok = existsSync(named) && createHash('sha256').update(readFileSync(named)).digest('hex') === file.sha256
    check(`shipped bytes match the lock: ${file.path}`, ok, '', 'rebuild dist/vendor/json-query with bun run build.ts, or update the sha256 in vendor/json-query.lock.json if the pin moved on purpose')
    present &&= ok
  }
  for (const script of ['jsonQueryProcess.mjs', 'jsonQueryWorker.mjs']) {
    const copied = join(pack, script)
    check(`shipped runner matches its source: ${script}`, existsSync(copied) && readFileSync(copied).equals(readFileSync(join(root, 'src/tools/read', script))), '', `rebuild so dist/vendor/json-query/${script} is a copy of src/tools/read/${script}`)
  }
  const notices = readFileSync(join(root, 'THIRD_PARTY_NOTICES.md'), 'utf8')
  for (const component of lock.components) check(`notices retain ${component.name}`, notices.includes(component.name), '', `add ${component.name} to THIRD_PARTY_NOTICES.md`)
  if (present) {
    const { loadJq } = await import(pathToFileURL(join(pack, 'dist/index.mjs')).href)
    const compiled = await WebAssembly.compile(readFileSync(join(pack, 'dist/build/jq.wasm')))
    const source = Buffer.from('{"n":9007199254740993123456789,"s":"x  \\n"}\n')
    let memory: WebAssembly.Memory, offset = 0
    const out: Buffer[] = [], err: Buffer[] = []
    const jq = await loadJq({ instantiateWasm(imports: Record<string, Record<string, Function>>, ready: Function) {
      check('pinned read/write ABI is present', typeof imports[lock.abi.imports]?.[lock.abi.read] === 'function' && typeof imports[lock.abi.imports]?.[lock.abi.write] === 'function', '', 'the abi block of vendor/json-query.lock.json must name the import module and the read and write functions the shipped jq.wasm imports')
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
      check('pinned memory ABI is present', memory instanceof WebAssembly.Memory, '', 'the abi.memory name in vendor/json-query.lock.json must match the memory export of the shipped jq.wasm')
      ready(instance)
    } })
    const result = jq.raw('', '.n, .s', ['-r', '--'])
    check('stream hooks preserve exact large literals and raw trailing whitespace', result.exitCode === 0 && Buffer.concat(out).toString() === '9007199254740993123456789\nx  \n\n' && err.length === 0, `exit ${result.exitCode}, stdout ${JSON.stringify(Buffer.concat(out).toString())}, stderr bytes ${err.length}`, 'the shipped jq.wasm or its loader in dist/vendor/json-query is not the pinned engine; refetch with bun run setup')
    const base = process.env.RP_SCRATCH ?? process.env.MERCURY_TMPDIR ?? process.env.MERCURY_CONFIG_DIR
    if (!base) throw new Error('The proof needs its scratch root')
    const vendor = await import(pathToFileURL(join(root, 'scripts/vendor/jsonQuery.ts')).href)
    const stops = (run: () => unknown): boolean => { try { run(); return false } catch (error) { return /not where its pin expects it/.test(String(error)) } }
    const shippedWasm = readFileSync(join(pack, 'dist/build/jq.wasm')), shippedLoader = readFileSync(join(pack, 'dist/index.mjs'), 'utf8')
    const edited = lock.files.filter((file: { edit?: string }) => file.edit !== undefined) as Array<{ sha256: string; upstream?: { sha256: string } }>
    check('the lock pins the published and the shipped bytes of the two edited files and names both maxima', edited.length === 2 && edited.every(file => /^[0-9a-f]{64}$/.test(file.upstream?.sha256 ?? '') && file.upstream!.sha256 !== file.sha256) && lock.memory?.upstreamMaximum === 256 * 1024 * 1024 && lock.memory?.maximum === 2 * 1024 * 1024 * 1024, '', 'vendor/json-query.lock.json must give two edited files each an upstream sha256 different from its own, and memory.upstreamMaximum 256 MiB with memory.maximum 2 GiB')
    check('the shipped module declares the raised maximum and the shipped loader agrees', vendor.raiseWasmMemoryMaximum(shippedWasm, lock.memory.maximum, lock.memory.maximum).equals(shippedWasm) && shippedLoader.includes(`getHeapMax = () => ${lock.memory.maximum};`) && !shippedLoader.includes(String(lock.memory.upstreamMaximum)), '', 'raiseWasmMemoryMaximum and raiseLoaderMemoryMaximum in scripts/vendor/jsonQuery.ts must apply the raised maximum to the wasm and the loader; refetch with bun run setup')
    check('the edit stops when the maximum is not where the pin expects it', stops(() => vendor.raiseWasmMemoryMaximum(shippedWasm, lock.memory.upstreamMaximum, lock.memory.maximum)) && stops(() => vendor.raiseWasmMemoryMaximum(Buffer.from('not a module'), lock.memory.upstreamMaximum, lock.memory.maximum)) && stops(() => vendor.raiseWasmMemoryMaximum(shippedWasm, lock.memory.maximum, 2 * lock.memory.maximum)) && stops(() => vendor.raiseLoaderMemoryMaximum(shippedLoader, lock.memory.upstreamMaximum, lock.memory.maximum)) && stops(() => vendor.raiseLoaderMemoryMaximum(`${shippedLoader}\n${shippedLoader}`, lock.memory.maximum, lock.memory.maximum)), '', 'raiseWasmMemoryMaximum and raiseLoaderMemoryMaximum in scripts/vendor/jsonQuery.ts must throw not where its pin expects it when the maximum is not exactly where expected')
    const archives = { npm: join(root, 'vendor/json-query/npm.tgz'), jq: join(root, 'vendor/json-query/jq.tgz') }
    const refetch = async (change: (text: string) => string): Promise<string> => {
      const again = mkdtempSync(join(base, 'query-fetch-'))
      try {
        mkdirSync(join(again, 'vendor'), { recursive: true })
        writeFileSync(join(again, 'vendor/json-query.lock.json'), change(readFileSync(lockPath, 'utf8')))
        await vendor.fetchJsonQuery(again, archives)
        return lock.files.every((file: { path: string; sha256: string }) => createHash('sha256').update(readFileSync(join(again, 'vendor/json-query/extracted', file.path))).digest('hex') === file.sha256) ? 'fetched' : 'fetched other bytes'
      } catch (error) { return String(error) } finally { rmSync(again, { recursive: true, force: true }) }
    }
    check('a fetch from the published archives yields exactly the shipped bytes', await refetch(text => text) === 'fetched', '', 'fetchJsonQuery in scripts/vendor/jsonQuery.ts must reproduce the bytes in vendor/json-query.lock.json from vendor/json-query/npm.tgz and jq.tgz')
    const publishedWasm = lock.files.find((file: { edit?: string }) => file.edit === 'wasm-memory-maximum')
    check('a fetch whose published bytes differ from their pin stops and says so', (await refetch(text => text.replace(publishedWasm.upstream.sha256, '0'.repeat(64)))).includes('JSON query pack differs from its upstream pin: dist/build/jq.wasm'), '', 'fetchJsonQuery in scripts/vendor/jsonQuery.ts must stop with that message when the published bytes differ from upstream.sha256 in the lock')
    check('a fetch whose edited bytes differ from their pin stops and says so', (await refetch(text => text.replace(publishedWasm.sha256, '0'.repeat(64)))).includes('JSON query pack differs from its lock: dist/build/jq.wasm'), '', 'fetchJsonQuery in scripts/vendor/jsonQuery.ts must stop with that message when the edited bytes differ from sha256 in the lock')
    check('the notices say what was changed and no longer call the engine unmodified', notices.includes('memory maximum raised from 256 MiB to 2 GiB by two edits at fetch time') && !/JSON query engine[^\n]*unmodified/.test(notices), '', 'THIRD_PARTY_NOTICES.md must state the memory maximum change and not call the JSON query engine unmodified')
    const scratch = mkdtempSync(join(base, 'query-pack-'))
    try {
      mkdirSync(join(scratch, 'vendor'), { recursive: true })
      cpSync(pack, join(scratch, 'vendor/json-query'), { recursive: true })
      writeFileSync(join(scratch, 'manifest.json'), JSON.stringify(manifest))
      const contract = await import(pathToFileURL(join(root, 'scripts/release/payloadContract.mjs')).href)
      check('a complete staged pack passes the archive contract', contract.checkJsonQueryPack(scratch).ok, JSON.stringify(contract.checkJsonQueryPack(scratch)), 'checkJsonQueryPack in scripts/release/payloadContract.mjs must accept the built pack')
      writeFileSync(join(scratch, 'vendor/json-query/dist/build/jq.wasm'), 'changed')
      check('a changed wasm cannot ship with an unchanged record', !contract.checkJsonQueryPack(scratch).ok, '', 'checkJsonQueryPack in scripts/release/payloadContract.mjs must compare jq.wasm against the recorded hash')
      cpSync(join(pack, 'dist/build/jq.wasm'), join(scratch, 'vendor/json-query/dist/build/jq.wasm'))
      rmSync(join(scratch, 'vendor/json-query/LICENSE.jq'))
      check('missing component notices fail the archive contract', !contract.checkJsonQueryPack(scratch).ok, '', 'checkJsonQueryPack in scripts/release/payloadContract.mjs must fail when a component license file such as LICENSE.jq is missing')
    } finally { rmSync(scratch, { recursive: true, force: true }) }
  }
}
console.log(`${passed}/${passed + failed} checks`)
process.exitCode = failed ? 1 : 0
