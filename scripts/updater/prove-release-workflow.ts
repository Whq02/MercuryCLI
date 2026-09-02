#!/usr/bin/env bun
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(import.meta.dir, '..', '..')
let failures = 0
const check = (name: string, cond: boolean, detail = ''): void => {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${name}${cond || !detail ? '' : ` — ${detail}`}`)
  if (!cond) failures++
}

const WORKFLOWS = ['private-release.yml', 'windows-launcher.yml', 'windows-functional.yml', 'windows-ui.yml']

const REFERENCE = /(?<![\w./-])(scripts\/[A-Za-z0-9_./-]+|\.node-version|bun\.lock|build\.ts|package\.json)/g

const bunPins = new Map<string, string[]>()
for (const name of WORKFLOWS) {
  const path = join(ROOT, '.github', 'workflows', name)
  check(`${name} exists`, existsSync(path))
  if (!existsSync(path)) continue
  const text = readFileSync(path, 'utf8')
  const refs = new Set<string>()
  for (const m of text.matchAll(REFERENCE)) {
    const ref = m[1]!
    if (ref.includes('$')) continue
    refs.add(ref.replace(/[.,;:]+$/, ''))
  }
  const missing = [...refs].filter(r => !existsSync(join(ROOT, r)))
  check(`${name}: every path it references exists (${refs.size} refs)`, missing.length === 0, `missing: ${missing.join(', ')}`)
  const setupNode = [...text.matchAll(/uses: actions\/setup-node@[^\n]*\n((?:[ \t]+[^\n]*\n)*)/g)]
  const literalNode = setupNode.some(m => /\n[ \t]+node-version:/.test('\n' + (m[1] ?? '')))
  check(`${name}: setup-node selects the product Node through .node-version only`, setupNode.length > 0 && !literalNode && text.includes('node-version-file: .node-version'))
  bunPins.set(name, [...text.matchAll(/bun-version:\s*([\d.]+)/g)].map(m => m[1]!))
}

const allPins = [...bunPins.values()].flat()
const distinct = [...new Set(allPins)]
check('the four workflows pin exactly one bun version between them', allPins.length > 0 && distinct.length === 1, `pins: ${[...bunPins.entries()].map(([n, p]) => `${n}=${p.join('/') || '(none)'}`).join(' · ')}`)

const release = readFileSync(join(ROOT, '.github', 'workflows', 'private-release.yml'), 'utf8')
const suiteSteps = [...release.matchAll(/bash (scripts\/[A-Za-z0-9_-]+\/run-all\.sh)/g)].map(m => m[1]!)
check('private-release verify job names at least the build + substrate suites', suiteSteps.includes('scripts/build/run-all.sh') && suiteSteps.includes('scripts/substrate/run-all.sh'), suiteSteps.join(', '))
check('every suite step in private-release resolves to a run-all.sh on disk', suiteSteps.every(s => existsSync(join(ROOT, s))), suiteSteps.filter(s => !existsSync(join(ROOT, s))).join(', '))
check('private-release runs the packager for each target it publishes', release.includes('node scripts/release/package.mjs --target ${{ matrix.target }}'))
check('private-release runs the bridge gate (previous shipped reader consumes the candidate)', release.includes('scripts/updater/prove-release-bridge.ts'))
check('private-release checks hosted-verdict eligibility through the gate ledger', release.includes('scripts/gate/ledger.ts check'))
for (const f of ['scripts/vscode/build-vsix.sh', 'THIRD_PARTY_NOTICES.md', 'scripts/release/compat-floor.json', 'assets/splash/mercury-splash.mjs', 'assets/splash/splash-core.mjs']) {
  check(`packager input exists: ${f}`, existsSync(join(ROOT, f)))
}

console.log('')
if (failures === 0) {
  console.log('PASS prove-release-workflow')
  process.exit(0)
}
console.log(`FAIL prove-release-workflow (${failures})`)
process.exit(1)
