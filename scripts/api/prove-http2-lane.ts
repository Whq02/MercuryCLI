#!/usr/bin/env bun
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const repo = resolve(import.meta.dir, '..', '..')
const outDir = join(repo, 'node_modules', '.cache', 'mercury-http2-lane')
mkdirSync(outDir, { recursive: true })

const entry = join(outDir, 'entry.ts')
writeFileSync(
  entry,
  [
    `export * from '${join(repo, 'src/utils/proxy.ts')}'`,
    `export { deepestErrorDetail, isStaleSocketCode, transportCutOf } from '${join(repo, 'src/services/api/transportEvidence.ts')}'`,
    '',
  ].join('\n'),
)

const build = await Bun.build({
  entrypoints: [entry],
  target: 'node',
  format: 'esm',
  outdir: outDir,
  naming: 'proxy.node.mjs',
  external: ['undici', 'axios', 'https-proxy-agent'],
  plugins: [
    {
      name: 'jsonc-parser-esm-as-dist',
      setup(b) {
        b.onResolve({ filter: /^jsonc-parser$/ }, () => ({ path: join(repo, 'node_modules', 'jsonc-parser', 'lib', 'esm', 'main.js') }))
      },
    },
  ],
})
if (!build.success) {
  console.error('❌ HTTP2 LANE — bundle failed')
  for (const log of build.logs) console.error(String(log))
  process.exit(1)
}
const bundle = build.outputs[0]?.path
if (!bundle) {
  console.error('❌ HTTP2 LANE — no bundle output')
  process.exit(1)
}

const tlsDir = mkdtempSync(join(tmpdir(), 'http2-lane-'))
const minted = spawnSync(
  'openssl',
  ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-keyout', join(tlsDir, 'key.pem'), '-out', join(tlsDir, 'cert.pem'), '-days', '2', '-subj', '/CN=127.0.0.1', '-addext', 'subjectAltName=IP:127.0.0.1'],
  { encoding: 'utf8' },
)
if (minted.status !== 0 || !existsSync(join(tlsDir, 'cert.pem'))) {
  console.error(`❌ HTTP2 LANE — openssl minted no certificate: ${(minted.error?.message ?? minted.stderr ?? '').trim().slice(0, 200)}`)
  process.exit(1)
}

const pinned = readFileSync(join(repo, '.node-version'), 'utf8').trim()
const nodeBin = process.env.MERCURY_NODE_BIN ?? 'node'
const version = spawnSync(nodeBin, ['--version'], { encoding: 'utf8' })
console.log(`http2 lane: ${nodeBin} ${version.stdout?.trim() ?? '(unknown)'} (pinned ${pinned}) · bundle ${bundle}`)

const result = spawnSync(nodeBin, [join(repo, 'scripts/api/http2-lane.mjs'), bundle, tlsDir], {
  cwd: repo,
  stdio: 'inherit',
  env: { ...process.env },
})
rmSync(tlsDir, { recursive: true, force: true })
process.exit(result.status ?? 1)
