#!/usr/bin/env bun
import { spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const repo = resolve(import.meta.dir, '..', '..')
const outDir = join(repo, 'node_modules', '.cache', 'mercury-node-transport-lane')
mkdirSync(outDir, { recursive: true })

const entry = join(outDir, 'entry.ts')
writeFileSync(
  entry,
  [
    `export * from '${join(repo, 'src/platform/network/proxy.ts')}'`,
    `export { getMTLSAgent, clearMTLSCache } from '${join(repo, 'src/platform/network/mtls.ts')}'`,
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
  console.error('❌ NODE TRANSPORT LANE — bundle failed — the bundle is built from src/platform/network/proxy.ts and src/platform/network/mtls.ts; fix the import or syntax error in the log below, or the external and resolver lists in the Bun.build options of this script if a new dependency needs marking external')
  for (const log of build.logs) console.error(String(log))
  process.exit(1)
}
const bundle = build.outputs[0]?.path
if (!bundle) {
  console.error('❌ NODE TRANSPORT LANE — no bundle output — Bun.build in this script returned no file; check outdir and naming in its options')
  process.exit(1)
}

const pinned = readFileSync(join(repo, '.node-version'), 'utf8').trim()
const nodeBin = process.env.MERCURY_NODE_BIN ?? 'node'
const version = spawnSync(nodeBin, ['--version'], { encoding: 'utf8' })
console.log(`node lane: ${nodeBin} ${version.stdout?.trim() ?? '(unknown)'} (pinned ${pinned}) · bundle ${bundle}`)

const result = spawnSync(nodeBin, [join(repo, 'scripts/api/node-transport-lane.mjs'), bundle], {
  cwd: repo,
  stdio: 'inherit',
  env: { ...process.env },
})
if (result.status !== 0) console.error(`❌ NODE TRANSPORT LANE — scripts/api/node-transport-lane.mjs exited ${result.status ?? 'without a status'} on ${nodeBin}; read its failed checks above, they exercise src/platform/network/proxy.ts and src/platform/network/mtls.ts under real Node`)
process.exit(result.status ?? 1)
