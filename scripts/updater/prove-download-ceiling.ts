#!/usr/bin/env bun
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createServer, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '9.9.9' }

const { downloadChannelAssets } = await import('../../src/platform/update-channel/channelTransport.js')
const { UPDATE_CEILINGS } = (await import('../../src/platform/update-channel/channelCore.js')) as { UPDATE_CEILINGS?: Record<string, number> }

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}${cond ? '' : " — to fix: bound the bytes anonymousDownloadAsset writes in src/platform/update-channel/channelTransport.ts by the asset's maxBytes, and keep the ceilings in UPDATE_CEILINGS in src/platform/update-channel/channelCore.ts"}`)
}

const CEILING = 64 * 1024
const CHUNK = Buffer.alloc(16 * 1024, 0x61)
const FLOOD_CHUNKS = 2048
const sent = { flood: 0 }

function flood(res: ServerResponse): void {
  res.writeHead(200, { 'content-type': 'application/octet-stream' })
  let left = FLOOD_CHUNKS
  const pump = (): void => {
    while (left > 0 && !res.destroyed) {
      left--
      sent.flood += CHUNK.byteLength
      if (!res.write(CHUNK)) {
        res.once('drain', pump)
        return
      }
    }
    if (!res.destroyed) res.end()
  }
  pump()
}

const server = createServer((req, res) => {
  if (req.url === '/flood') return flood(res)
  if (req.url === '/declared') {
    res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': String(CEILING + 1) })
    return void res.end(Buffer.alloc(CEILING + 1, 0x62))
  }
  if (req.url === '/exact') {
    res.writeHead(200, { 'content-type': 'application/octet-stream' })
    return void res.end(Buffer.alloc(CEILING, 0x63))
  }
  res.writeHead(404)
  res.end()
})
await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
const scratch = mkdtempSync(join(tmpdir(), 'mercury-o03-bytes-'))

try {
  const exact = await downloadChannelAssets('anonymous', 'o/r', 'v1', [{ name: 'exact.bin', url: `${base}/exact`, maxBytes: CEILING }], scratch)
  check('a file that holds exactly its ceiling arrives whole', exact.state === 'ok' && statSync(join(scratch, 'exact.bin')).size === CEILING && readFileSync(join(scratch, 'exact.bin')).every(byte => byte === 0x63), JSON.stringify(exact))

  const flooded = await downloadChannelAssets('anonymous', 'o/r', 'v1', [{ name: 'flood.bin', url: `${base}/flood`, maxBytes: CEILING }], scratch)
  check('a server that states no length and keeps sending is stopped at the ceiling', flooded.state === 'failed', JSON.stringify(flooded))
  check('what the stopped download wrote is removed', !existsSync(join(scratch, 'flood.bin')), existsSync(join(scratch, 'flood.bin')) ? `${statSync(join(scratch, 'flood.bin')).size} bytes stand on disk` : '')
  check('the server was cut off long before it had sent everything', sent.flood < (FLOOD_CHUNKS * CHUNK.byteLength) / 2, `sent ${sent.flood} of ${FLOOD_CHUNKS * CHUNK.byteLength}`)
  check(
    'the refusal is one plain sentence that names the file and the ceiling, and says what to do next',
    flooded.state === 'failed' && flooded.note === `download of flood.bin stopped: it holds more than ${CEILING} bytes, the most this release file may hold` && flooded.remedy === 'report the release as malformed — nothing was activated',
    JSON.stringify(flooded),
  )

  const declared = await downloadChannelAssets('anonymous', 'o/r', 'v1', [{ name: 'declared.bin', url: `${base}/declared`, maxBytes: CEILING }], scratch)
  check('a stated length past the ceiling is refused and nothing of it stands on disk', declared.state === 'failed' && !existsSync(join(scratch, 'declared.bin')), JSON.stringify(declared))

  const ghFixtures = join(scratch, 'gh-fixtures')
  const ghDest = join(scratch, 'gh-dest')
  mkdirSync(join(ghFixtures, 'assets', 'v1'), { recursive: true })
  mkdirSync(ghDest)
  writeFileSync(join(ghFixtures, 'assets', 'v1', 'big.bin'), Buffer.alloc(CEILING + 1, 0x64))
  writeFileSync(join(ghFixtures, 'assets', 'v1', 'small.bin'), Buffer.alloc(CEILING, 0x65))
  process.env.MERCURY_GH_CMD = JSON.stringify(['node', join(import.meta.dir, 'fake-gh.mjs')])
  process.env.GH_SHIM_FIXTURES = ghFixtures
  const ghSmall = await downloadChannelAssets('gh', 'o/r', 'v1', [{ name: 'small.bin', url: null, maxBytes: CEILING }], ghDest)
  check('through gh, a file at its ceiling arrives whole', ghSmall.state === 'ok' && statSync(join(ghDest, 'small.bin')).size === CEILING, JSON.stringify(ghSmall))
  const ghBig = await downloadChannelAssets('gh', 'o/r', 'v1', [{ name: 'big.bin', url: null, maxBytes: CEILING }], ghDest)
  check('through gh, a file past its ceiling is refused with the same sentence and removed', ghBig.state === 'failed' && ghBig.note === `download of big.bin stopped: it holds more than ${CEILING} bytes, the most this release file may hold` && !existsSync(join(ghDest, 'big.bin')), JSON.stringify(ghBig))

  check('the archive ceiling is a round figure of at least 1 GiB, in one named place', typeof UPDATE_CEILINGS?.archiveBytes === 'number' && UPDATE_CEILINGS.archiveBytes >= 1024 ** 3 && UPDATE_CEILINGS.archiveBytes % 1024 ** 3 === 0, String(UPDATE_CEILINGS?.archiveBytes))
  check('the sums file ceiling is a few megabytes', typeof UPDATE_CEILINGS?.checksumManifestBytes === 'number' && UPDATE_CEILINGS.checksumManifestBytes >= 1024 * 1024 && UPDATE_CEILINGS.checksumManifestBytes <= 16 * 1024 * 1024, String(UPDATE_CEILINGS?.checksumManifestBytes))
} finally {
  server.closeAllConnections()
  server.close()
  rmSync(scratch, { recursive: true, force: true })
}

console.log(`\nprove-download-ceiling: ${failures === 0 ? 'ALL HOLD' : `${failures} FAILURE(S)`}`)
process.exit(failures === 0 ? 0 : 1)
export {}
