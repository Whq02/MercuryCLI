#!/usr/bin/env bun
// ============================================================================
//  scripts/api/prove-node-transport-lane.ts — the NODE-lane transport battery
//  driver.
//
//  The packaged product runs under Node, where src/utils/proxy.ts takes its
//  undici arms (the explicit API dispatcher, the environment-aware proxy
//  dispatcher, the tunnelling agent, the global dispatcher).
//  Every other transport prover runs under Bun and therefore exercises only
//  the Bun arms. This driver:
//
//    1. bundles the proxy module for Node with Bun.build — undici, axios and
//       https-proxy-agent stay EXTERNAL so the battery and the module share
//       ONE library instance (the runtime pairing invariant of §F5 is
//       exactly about that);
//    2. runs scripts/api/node-transport-lane.mjs under the pinned `node`
//       (.node-version) against an in-process proxy fixture;
//    3. relays its exit code.
//
//  Local only: no network, no credentials.
// ============================================================================
import { spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const repo = resolve(import.meta.dir, '..', '..')
const outDir = join(repo, 'node_modules', '.cache', 'mercury-node-transport-lane')
mkdirSync(outDir, { recursive: true })

// One entry re-exporting the proxy module AND the mTLS owner so the battery
// compares against the same memoised instances the module uses.
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
