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
for (const f of ['scripts/vscode/build-vsix.sh', 'THIRD_PARTY_NOTICES.md', 'scripts/release/compat-floor.json', 'assets/splash/mercury-splash.mjs', 'assets/splash/splash-core.mjs', 'LICENSE.md', 'TRADEMARKS.md', 'MERCURY-COMMUNITY-PRODUCTION-TERMS.md']) {
  check(`packager input exists: ${f}`, existsSync(join(ROOT, f)))
}

const packageJob = release.slice(release.indexOf('  package:\n'), release.indexOf('  bridge-gate:\n'))
const signingStep = packageJob.slice(packageJob.indexOf('- name: signing key'), packageJob.indexOf('- name: package + friend-path smoke'))
check('the dispatch input `unsigned` exists, boolean, default false', /unsigned:\n\s+description: [^\n]+\n\s+type: boolean\n\s+required: false\n\s+default: false/.test(release))
check('the package job reads the secret MERCURY_SIGNING_KEY into the signing step env only', signingStep.includes('MERCURY_SIGNING_KEY: ${{ secrets.MERCURY_SIGNING_KEY }}') && release.split('secrets.MERCURY_SIGNING_KEY').length === 2)
check('every line of the key is masked before anything else', signingStep.includes('echo "::add-mask::$line"'))
check('the key file is written under a 077 umask and chmod 600 in the runner temp', signingStep.includes('umask 077') && signingStep.includes('chmod 600 "$KEY_FILE"') && signingStep.includes('KEY_FILE="${RUNNER_TEMP//\\\\//}/mercury-signing.pem"'))
const keyUses = release.split('$MERCURY_SIGNING_KEY').length - 1
const tracesOn = release.split('\n').some(l => !l.trim().startsWith('#') && /\bset -x\b/.test(l))
check('nothing prints the key: no set -x, and the value is used only to test, mask and write the file', !tracesOn && keyUses === 3 && signingStep.includes('[ -n "$MERCURY_SIGNING_KEY" ]') && signingStep.includes('done <<< "$MERCURY_SIGNING_KEY"') && signingStep.includes(`printf '%s\\n' "$MERCURY_SIGNING_KEY" > "$KEY_FILE"`) && !release.includes('${MERCURY_SIGNING_KEY'), `uses: ${keyUses}`)
check('the key file is named to the packaging step alone (a step output into its env, never GITHUB_ENV)', packageJob.includes('MERCURY_SIGNING_KEY_FILE: ${{ steps.signing.outputs.key_file }}') && !packageJob.includes('GITHUB_ENV'))
check('with the secret absent the job fails — unless the dispatch input unsigned was given', signingStep.includes('elif [ "$UNSIGNED_DECISION" = "true" ]; then') && signingStep.includes('UNSIGNED_DECISION: ${{ github.event.inputs.unsigned }}') && /else\n\s+echo "::error::[^\n]*MERCURY_SIGNING_KEY[^\n]*"\n\s+exit 1/.test(signingStep))
check('an unsigned decision runs the packager with --unsigned and expects the verdict unsigned', signingStep.includes('echo "packager_flags=--unsigned" >> "$GITHUB_OUTPUT"') && signingStep.includes('echo "expect=unsigned" >> "$GITHUB_OUTPUT"') && packageJob.includes('${{ steps.signing.outputs.packager_flags }}'))
check('the key present expects the verdict signed', signingStep.includes('echo "expect=signed" >> "$GITHUB_OUTPUT"'))
check('the archive is read back and verified at full depth before publish, requiring the decided verdict', packageJob.includes('node scripts/release/verifyArchive.mjs --archive "$archive" --expect \'${{ steps.signing.outputs.expect }}\''))
check('the key file is removed in an always() step', /- name: remove the signing key file\n\s+if: always\(\)\n\s+shell: bash\n\s+run: \|\n\s+rm -f "\$\{RUNNER_TEMP\/\/\\\\\/\/\}\/mercury-signing\.pem"/.test(packageJob))
const verifyJob = release.slice(release.indexOf('  verify:\n'), release.indexOf('  package:\n'))
check('the verify job checks the licence documents for the tag before packaging', verifyJob.includes('node scripts/release/releaseDocuments.mjs check --version "${TAG#v}"'))
const releaseJob = release.slice(release.indexOf('  release:\n'))
check('the publish job says -unsigned in the notes when the archives are unsigned', releaseJob.includes('for f in assets/*-unsigned.tar.gz assets/*-unsigned.zip; do') && releaseJob.includes('UNSIGNED BUILD') && releaseJob.includes('printf \'%s\\n\\n\' "$PROVENANCE_NOTE"'))
check('the bridge gate names the unsigned candidate explicitly', release.includes('export MERCURY_BRIDGE_CANDIDATE="$PWD/$f"'))
check('the archive verifier and the documents owner exist', existsSync(join(ROOT, 'scripts/release/verifyArchive.mjs')) && existsSync(join(ROOT, 'scripts/release/releaseDocuments.mjs')))

console.log('')
if (failures === 0) {
  console.log('PASS prove-release-workflow')
  process.exit(0)
}
console.log(`FAIL prove-release-workflow (${failures})`)
process.exit(1)
