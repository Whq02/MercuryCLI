// ============================================================================
//  verifyArtifactStandalone — the SHIPPED provenance verifier
//
//
//  build.ts bundles this entry to dist/verify-artifact.mjs — a dependency-free
//  single file that ships INSIDE every release payload beside mercury.mjs
//  (the splash.mjs precedent), so the launcher's verification and the
//  packager's signing/self-check run the SAME compiled implementation the
//  runtime's /health uses. No twin, no drift: one source, three consumers.
//
//  As a LIBRARY (imported by scripts/release/package.mjs from the built
//  file): re-exports the signing core + payload verification.
//
//  As a CLI (node verify-artifact.mjs [--dir <payload>] [--deep] [--json]
//  [--launcher]):
//    default   verdict lines on stdout; exit 0 signed · 3 unsigned ·
//              4 unrecognized-key · 5 tampered · 6 malformed (operator/prover
//              tool — the exit states the fact, it gates nothing itself).
//    --launcher  the boot-path mode: SILENT on 'signed', ONE stderr line on
//              anything else, exit 0 ALWAYS — warn-dont-block (the lane
//              mandate: signature absence is a fact, not a gate; the
//              launchers additionally `|| true` so even a crash here can
//              never cost a boot).
// ============================================================================
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { realpathSync } from 'node:fs'
import { verifyPayloadDir } from './artifactVerify.js'
import { describeSignatureVerdict } from './artifactSigning.js'

export {
  canonicalStatementBytes,
  describeSignatureVerdict,
  keyIdOf,
  parseStatement,
  signStatement,
  verifySignatureBlock,
  type SignatureBlockV1,
  type SignatureVerdict,
  type SigningStatementV1,
} from './artifactSigning.js'
export { verifyPayloadDir, type PayloadVerification } from './artifactVerify.js'
export { trustedSigningKeys, PRODUCTION_SIGNING_KEY, type TrustedSigningKey } from './signingTrust.js'

const EXIT_BY_STATE: Record<string, number> = {
  signed: 0,
  unsigned: 3,
  'unrecognized-key': 4,
  tampered: 5,
  malformed: 6,
}

function cliMain(): void {
  const args = process.argv.slice(2)
  const dirFlag = args.indexOf('--dir')
  const selfDir = dirname(fileURLToPath(import.meta.url))
  const dir = dirFlag !== -1 && args[dirFlag + 1] ? resolve(args[dirFlag + 1]!) : selfDir
  const depth = args.includes('--deep') ? ('deep' as const) : ('fast' as const)
  const launcherMode = args.includes('--launcher')

  const result = verifyPayloadDir(dir, { depth })
  const line = describeSignatureVerdict(result.verdict)

  if (launcherMode) {
    if (result.verdict.state !== 'signed') {
      process.stderr.write(`mercury: provenance — ${line} (\`mercury doctor\` shows the full record)\n`)
    }
    process.exit(0)
  }
  if (args.includes('--json')) {
    process.stdout.write(JSON.stringify({ dir, ...result }, null, 2) + '\n')
  } else {
    process.stdout.write(`artifact provenance (${result.depth}) at ${dir}\n  ${line}\n`)
    for (const u of result.unevaluated) process.stdout.write(`  unevaluated: ${u}\n`)
  }
  process.exit(EXIT_BY_STATE[result.verdict.state] ?? 6)
}

// Run the CLI only when executed directly (node dist/verify-artifact.mjs);
// importing this file as the signing library never triggers it.
try {
  const invoked = process.argv[1] ? realpathSync(process.argv[1]) : ''
  if (invoked && realpathSync(fileURLToPath(import.meta.url)) === invoked) cliMain()
} catch {
  // path probes only — an unresolvable argv[1] simply means "imported"
}
