#!/usr/bin/env bun
import { spawnSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const repo = resolve(import.meta.dir, '..', '..')
const outDir = join(repo, 'node_modules', '.cache', 'mercury-transport-storm')
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
  console.error('❌ TRANSPORT STORM — bundle failed')
  for (const log of build.logs) console.error(String(log))
  process.exit(1)
}
const bundle = build.outputs[0]?.path
if (!bundle) {
  console.error('❌ TRANSPORT STORM — no bundle output')
  process.exit(1)
}

const nodeBin = process.env.MERCURY_NODE_BIN ?? 'node'
const version = spawnSync(nodeBin, ['--version'], { encoding: 'utf8' })
console.log(`transport storm lane: ${nodeBin} ${version.stdout?.trim() ?? '(unknown)'} · bundle ${bundle}`)

const result = spawnSync(nodeBin, [join(repo, 'scripts/api/transport-storm-lane.mjs'), bundle], {
  cwd: repo,
  stdio: 'inherit',
  env: { ...process.env },
})
process.exit(result.status ?? 1)
