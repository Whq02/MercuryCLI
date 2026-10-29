import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { realpathSync } from 'node:fs'
import { verifyPayloadDir } from './artifactVerify.js'
import { describeSignatureVerdict } from './artifactSigning.js'
import { provenanceNoticeIsOnce, provenanceNoticeMarkerPath, provenanceNoticeSaid, recordProvenanceNotice } from './provenanceNotice.js'

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

export { archiveBaseNameFor, archiveNameFor, isReleaseTarget, releaseTargetFor, RELEASE_TARGETS, type ReleaseTarget } from './releaseTarget.js'

const EXIT_BY_STATE: Record<string, number> = {
  signed: 0,
  unsigned: 3,
  'unrecognized-key': 4,
  tampered: 5,
  malformed: 6,
}

const EXIT_FLUSH_FALLBACK_MS = 2_000

function sayAndLeave(stream: NodeJS.WriteStream, text: string, code: number): void {
  process.exitCode = code
  let left = false
  const leave = (): void => {
    if (left) return
    left = true
    process.exit(code)
  }
  const fallback = setTimeout(leave, EXIT_FLUSH_FALLBACK_MS)
  fallback.unref()
  if (text === '' || stream.destroyed) {
    leave()
    return
  }
  stream.write(text, leave)
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
    const state = result.verdict.state

    const once = provenanceNoticeIsOnce(state)
    let notice = ''
    if (state !== 'signed' && (!once || !provenanceNoticeSaid(dir, state))) {
      const onceWords = once && provenanceNoticeMarkerPath(dir) !== null ? 'said once for this install; ' : ''
      notice = state === 'unsigned'
        ? 'mercury: this installation is unsigned — mercury health\n'
        : `mercury: provenance — ${line} (${onceWords}\`mercury health\` shows the full record)\n`
      if (once) recordProvenanceNotice(dir, state)
    }
    sayAndLeave(process.stderr, notice, 0)
    return
  }
  const text = args.includes('--json')
    ? JSON.stringify({ dir, ...result }, null, 2) + '\n'
    : `artifact provenance (${result.depth}) at ${dir}\n  ${line}\n${result.unevaluated.map(u => `  unevaluated: ${u}\n`).join('')}`
  sayAndLeave(process.stdout, text, EXIT_BY_STATE[result.verdict.state] ?? 6)
}

try {
  const invoked = process.argv[1] ? realpathSync(process.argv[1]) : ''
  if (invoked && realpathSync(fileURLToPath(import.meta.url)) === invoked) cliMain()
} catch {
}
