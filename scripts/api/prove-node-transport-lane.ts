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
    `export * from '${join(repo, 'src/utils/proxy.ts')}'`,
    `export { getMTLSAgent, clearMTLSCache } from '${join(repo, 'src/utils/mtls.ts')}'`,
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
})
if (!build.success) {
  console.error('❌ NODE TRANSPORT LANE — bundle failed')
  for (const log of build.logs) console.error(String(log))
  process.exit(1)
}
const bundle = build.outputs[0]?.path
if (!bundle) {
  console.error('❌ NODE TRANSPORT LANE — no bundle output')
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
process.exit(result.status ?? 1)
