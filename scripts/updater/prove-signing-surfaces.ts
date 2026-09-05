#!/usr/bin/env bun
import { execFileSync, spawnSync } from 'node:child_process'
import { generateKeyPairSync } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { keyIdOf, signStatement, type SigningStatementV1 } from '../../src/services/privateChannel/artifactSigning.js'
import { artifactSignatureCheck } from '../../src/services/privateChannel/artifactVerify.js'
import { listInstalledVersions } from '../../src/services/privateChannel/installLayout.js'
import type { TrustedSigningKey } from '../../src/services/privateChannel/signingTrust.js'
// @ts-expect-error — packager-side authorities are plain .mjs (no types)
import { posixLauncher, cmdLauncher, ps1Launcher, parseEnginesNode } from '../release/launcherTemplates.mjs'
import { NODE_SUPPORT } from '../../src/utils/runtime/nodePolicy.js'
// @ts-expect-error — same
import { archiveFileName, readCompatFloor, releaseLayoutSection, topAllowlist } from '../release/payloadContract.mjs'

let failures = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  console.log(`  ${ok ? '✓' : '✗'} ${label}${ok || !detail ? '' : ` — ${detail}`}`)
  if (!ok) failures++
}

const ROOT = join(import.meta.dir, '..', '..')
const SCRATCH = mkdtempSync(join(tmpdir(), 'signing-surfaces-'))
const NODE = process.execPath.includes('bun') ? 'node' : process.execPath

console.log('signing surfaces — launcher + /health honesty, shipped verifier E2E')

const pair = generateKeyPairSync('ed25519')
const spki = pair.publicKey.export({ format: 'der', type: 'spki' }).toString('base64')
const roster: TrustedSigningKey[] = [{ keyId: keyIdOf(spki), publicKeySpkiB64: spki, label: 'ephemeral prover key' }]

function buildFixturePayload(name: string, opts: { sign?: boolean; tamper?: boolean } = {}): string {
  const dir = join(SCRATCH, name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'mercury.mjs'), `// fixture ${name}\n`)
  const manifest: Record<string, unknown> = {
    schema: 2,
    name: 'mercury',
    version: '9.9.9-beta.1',
    buildTree: null,
    bundle: 'mercury.mjs',
  }
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifest) + '\n')
  const rl = releaseLayoutSection(dir, 'macos-arm64', readCompatFloor()) as { primary: { sha256: string }; payloadDigest: string }
  manifest.releaseLayout = rl
  if (opts.sign !== false) {
    const statement: SigningStatementV1 = {
      schema: 1,
      name: 'mercury',
      version: '9.9.9-beta.1',
      channel: 'private',
      target: 'macos-arm64',
      packagedAt: '2026-08-22T00:00:00.000Z',
      buildTree: null,
      primarySha256: rl.primary.sha256,
      payloadDigest: rl.payloadDigest,
      licenseId: null,
    }
    manifest.signing = signStatement(statement, pair.privateKey.export({ format: 'pem', type: 'pkcs8' }).toString())
  }
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n')
  if (opts.tamper) writeFileSync(join(dir, 'mercury.mjs'), '// tampered\n')
  return dir
}

try {
  const policy = parseEnginesNode(NODE_SUPPORT.range)
  const posix = posixLauncher(policy) as string
  const cmd = cmdLauncher(policy) as string
  const ps1 = ps1Launcher(policy) as string

  check('POSIX launcher invokes the shipped verifier in --launcher mode', posix.includes('verify-artifact.mjs" --launcher'))
  check('POSIX verify is crash-harmless (`|| true`) — warn-dont-block is mechanical', posix.includes('verify-artifact.mjs" --launcher || true'))
  check('POSIX verify is interactive-gated (TTY test) + presence-guarded', /\[ -t 0 \] && \[ -t 2 \] && \[ -f "\$dir\/verify-artifact\.mjs" \]/.test(posix))
  check('POSIX verify runs BEFORE the runtime boot line', posix.indexOf('verify-artifact.mjs" --launcher') !== -1 && posix.indexOf('"$node_bin" "$dir/mercury.mjs" "$@"') !== -1 && posix.indexOf('verify-artifact.mjs" --launcher') < posix.indexOf('"$node_bin" "$dir/mercury.mjs" "$@"'))

  check('cmd launcher invokes the shipped verifier in --launcher mode', cmd.includes('verify-artifact.mjs" --launcher'))
  check('cmd verify is TTY-gated on the probe verdict + presence-guarded, on the resolved runtime', cmd.includes('if "%NODETTY%"=="1" if exist "%DIR%verify-artifact.mjs" "%NODEBIN%" "%DIR%verify-artifact.mjs" --launcher'))
  check(
    'cmd never consults errorlevel after the verify (no gate exists to fail)',
    !/verify-artifact\.mjs" --launcher\r\n(if errorlevel|if %errorlevel%)/i.test(cmd),
  )

  check('PS1 launcher invokes the shipped verifier in --launcher mode', ps1.includes("'verify-artifact.mjs')) --launcher") || /verify-artifact\.mjs'\) --launcher/.test(ps1))
  check('PS1 verify is interactive-gated, presence-guarded, crash-swallowed, on the resolved runtime', /if \(\$interactive -and \(Test-Path \(Join-Path \$dir 'verify-artifact\.mjs'\)\)\) \{\s*\n\s*try \{ & \$nodeBin \(Join-Path \$dir 'verify-artifact\.mjs'\) --launcher \} catch \{ \}/.test(ps1))

  check('the payload contract ships verify-artifact.mjs on every target', (topAllowlist('macos-arm64', readCompatFloor()) as string[]).includes('verify-artifact.mjs') && (topAllowlist('windows-x64', readCompatFloor()) as string[]).includes('verify-artifact.mjs'))

  const signedDir = buildFixturePayload('signed')
  const unsignedDir = buildFixturePayload('unsigned', { sign: false })
  const tamperedDir = buildFixturePayload('tampered', { tamper: true })

  const asManaged = (dir: string): { kind: 'managed'; activeRoot: string } => ({ kind: 'managed', activeRoot: dir })

  const devRow = artifactSignatureCheck({ kind: 'development', activeRoot: ROOT }, 'fast', roster)
  check('/health on a development build: info, names packaging as where signing enters', devRow.status === 'info' && devRow.evidence.includes('packaging'))
  const unknownRow = artifactSignatureCheck({ kind: 'unknown', activeRoot: '' }, 'fast', roster)
  check('/health on an unknown shape: info, never a fabricated verdict', unknownRow.status === 'info' && unknownRow.evidence.includes('unrecognized'))

  const signedRow = artifactSignatureCheck(asManaged(signedDir), 'fast', roster)
  check('/health signed row: ok + the word signed + key id', signedRow.status === 'ok' && signedRow.evidence.startsWith('signed — key'))
  check('/health fast row states its depth limit honestly', signedRow.evidence.includes('deep probe evaluates the whole payload tree'))
  const signedDeepRow = artifactSignatureCheck(asManaged(signedDir), 'deep', roster)
  check('/health deep row: ok + whole-tree bind stated', signedDeepRow.status === 'ok' && signedDeepRow.evidence.includes('whole payload tree bound'))

  const unsignedRow = artifactSignatureCheck(asManaged(unsignedDir), 'fast', roster)
  check('/health unsigned row: warn + the word unsigned, the fix naming the signed releases and the way to one', unsignedRow.status === 'warn' && unsignedRow.evidence.includes('unsigned') && (unsignedRow.fix ?? '').includes('signed at packaging') && (unsignedRow.fix ?? '').includes('mercury update'))

  const tamperedRow = artifactSignatureCheck(asManaged(tamperedDir), 'fast', roster)
  check('/health tampered row: FAIL + TAMPERED in the evidence', tamperedRow.status === 'fail' && tamperedRow.evidence.includes('TAMPERED'))

  const unrecognizedRow = artifactSignatureCheck(asManaged(signedDir), 'fast', [])
  check('/health unrecognized-key row: warn + names the roster gap', unrecognizedRow.status === 'warn' && unrecognizedRow.evidence.includes('NOT in this build') && (unrecognizedRow.fix ?? '').includes('signingTrust'))

  const healthSrc = readFileSync(join(ROOT, 'src/utils/healthReport.ts'), 'utf8')
  check('/health mounts artifact-signature (fast) + artifact-signature-payload (deep)', healthSrc.includes("id: 'artifact-signature'") && healthSrc.includes("id: 'artifact-signature-payload'") && healthSrc.includes('artifactSignatureCheck'))

  const shipped = join(ROOT, 'dist', 'verify-artifact.mjs')
  if (!existsSync(shipped)) {
    console.log('  · shipped-verifier E2E SKIPPED (no dist/verify-artifact.mjs — run bun run build.ts; the build suite covers it)')
  } else {
    const run = (args: string[]): { status: number; stdout: string; stderr: string } => {
      const r = spawnSync(NODE, [shipped, ...args], { encoding: 'utf8', timeout: 60_000 })
      return { status: r.status ?? -1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' }
    }
    const eSigned = run(['--dir', signedDir, '--json', '--deep'])
    check('shipped verifier: ephemeral-signed payload → unrecognized-key, exit 4', eSigned.status === 4 && eSigned.stdout.includes('"unrecognized-key"'))
    const eUnsigned = run(['--dir', unsignedDir, '--json'])
    check('shipped verifier: unsigned payload → exit 3, states unsigned', eUnsigned.status === 3 && eUnsigned.stdout.includes('"unsigned"'))
    const eTampered = run(['--dir', tamperedDir, '--json'])
    check('shipped verifier: tampered payload → exit 5, states tampered', eTampered.status === 5 && eTampered.stdout.includes('"tampered"'))

    const lSigned = run(['--dir', signedDir, '--launcher'])
    check('launcher mode on unrecognized-key: exit 0 + ONE stderr line naming the roster gap', lSigned.status === 0 && lSigned.stderr.trim().split('\n').length === 1 && lSigned.stderr.includes('trusted roster'))
    const lUnsigned = run(['--dir', unsignedDir, '--launcher'])
    check('launcher mode on unsigned: exit 0 + ONE stderr line with the plain fact', lUnsigned.status === 0 && lUnsigned.stderr.trim().split('\n').length === 1 && lUnsigned.stderr.includes('unsigned'))
    const lTampered = run(['--dir', tamperedDir, '--launcher'])
    check('launcher mode on tampered: exit 0 (warn-dont-block) + TAMPERED on stderr', lTampered.status === 0 && lTampered.stderr.includes('TAMPERED'))
    check('launcher mode points at the full record (mercury doctor)', lTampered.stderr.includes('mercury doctor'))

    check('launcher mode writes NOTHING to stdout', lSigned.stdout === '' && lUnsigned.stdout === '' && lTampered.stdout === '')

    const versions = join(SCRATCH, 'managed', 'versions')
    const vdir = join(versions, '9.9.9-beta.1')
    mkdirSync(versions, { recursive: true })
    cpSync(unsignedDir, vdir, { recursive: true })
    writeFileSync(join(versions, 'current.txt'), '9.9.9-beta.1\n')
    const marker = join(versions, 'provenance-noted-9.9.9-beta.1.txt')
    const first = run(['--dir', vdir, '--launcher'])
    const second = run(['--dir', vdir, '--launcher'])
    check('managed layout: the first launch says the unsigned line once, naming the once-per-install fact', first.status === 0 && first.stderr.trim().split('\n').length === 1 && first.stderr.includes('unsigned') && first.stderr.includes('said once for this install'))
    check('the marker sits beside the version pointer and records the verdict said', existsSync(marker) && readFileSync(marker, 'utf8').startsWith('unsigned\n'))
    check('the second launch says nothing (exit 0, no stderr, no stdout)', second.status === 0 && second.stderr === '' && second.stdout === '')
    cpSync(signedDir, vdir, { recursive: true })
    const changed = run(['--dir', vdir, '--launcher'])
    const again = run(['--dir', vdir, '--launcher'])
    check('a changed verdict says the line again (unrecognized-key after unsigned) and re-records it', changed.status === 0 && changed.stderr.includes('trusted roster') && readFileSync(marker, 'utf8').startsWith('unrecognized-key\n'))
    check('and once only', again.stderr === '' && again.stdout === '')
    const third = run(['--dir', unsignedDir, '--launcher'])
    const fourth = run(['--dir', unsignedDir, '--launcher'])
    check('a payload with no version pointer beside it says the line at every launch, without the once-per-install words', third.stderr.includes('unsigned') && fourth.stderr.includes('unsigned') && !third.stderr.includes('said once'))
    check('no marker is written outside a managed layout', !readdirSync(SCRATCH).some(n => n.startsWith('provenance-noted-')))
    check('the layout owner lists the version directories only — the marker is invisible to install/update/rollback', JSON.stringify(listInstalledVersions({ versionsDir: versions, binDir: '', shimPath: '', isWindows: false })) === JSON.stringify(['9.9.9-beta.1']))
  }

  const packager = readFileSync(join(ROOT, 'scripts/release/package.mjs'), 'utf8')
  check('packager signs via MERCURY_SIGNING_KEY_FILE and says UNSIGNED loudly otherwise', packager.includes('MERCURY_SIGNING_KEY_FILE') && packager.includes('UNSIGNED —'))
  check('unsigned is a decision: without a key the packager refuses unless --unsigned was passed', packager.includes("const UNSIGNED_BY_DECISION = process.argv.includes('--unsigned')") && packager.includes('no MERCURY_SIGNING_KEY_FILE and no --unsigned'))
  check('a key AND --unsigned together are refused (choose one)', packager.includes('--unsigned given with MERCURY_SIGNING_KEY_FILE set'))
  check('the archive name carries the decision (payloadContract.archiveFileName, -unsigned)', packager.includes('archiveFileName(VERSION, TARGET, { unsigned: UNSIGNED_BY_DECISION })') && archiveFileName('1.2.3', 'linux-x64', { unsigned: true }) === 'mercury-v1.2.3-linux-x64-unsigned.tar.gz' && archiveFileName('1.2.3', 'windows-x64') === 'mercury-v1.2.3-windows-x64.zip')
  check('packager self-verifies at deep depth after signing', packager.includes("verifyPayloadDir(pkgDir, { depth: 'deep' })"))
  check('packager refuses an unsigned --license-id (the seam is signature-covered)', packager.includes('--license-id given without MERCURY_SIGNING_KEY_FILE'))
  check('packager ships the verifier payload member', packager.includes("cpSync(verifierSrc, join(pkgDir, 'verify-artifact.mjs'))"))
} finally {
  rmSync(SCRATCH, { recursive: true, force: true })
}

if (failures > 0) {
  console.error(`\nprove-signing-surfaces: ${failures} FAILURE(S)`)
  process.exit(1)
}
console.log('\nprove-signing-surfaces: all green')
