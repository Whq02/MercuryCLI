// ============================================================================
//  primitives/runtimeKernel — Mercury's measured kernel boundary (
//
//
//  ONE narrow contract for performance-sensitive/platform-specific
//  mechanics, with capability negotiation and explicit unavailability. The
//  inventory + benchmarks (docs/RUNTIME-KERNEL.md,
//  scripts/primitives-kernel/bench-kernel.ts) found the hot mechanics ALREADY on
//  native-backed facilities, so the ratified surface is deliberately small:
//
//    · hash    — PROVIDED. Selected impl: node:crypto (native). Reference
//                impl: pure-TS SHA-256 (parity-gated). Consumers: content
//                anchors (snapshotAnchor), context-plan digests.
//    · text    — NOT PROVIDED here. Unicode/ANSI measurement is the owned
//                Mercury Cell Layout (src/ink/layout/cellLayout.ts) and
//                terminal-fluidity work belongs to, not.
//    · search  — NOT PROVIDED as in-process capability. Workspace search is
//                the vendored ripgrep binary (BUILD-NOTES.md) — already a
//                measured native implementation behind one seam.
//    · process — NOT PROVIDED here. Process observation (pid liveness +
//                start tokens) is daemon/ownerWatch.ts (ps-based, the only
//                portable macOS+Linux answer); reconciliation-frequency
//                call rates showed no migration payoff.
//    · pty     — NOT PROVIDED. Mercury allocates no runtime PTYs (the PTY
//                harness is test-side tooling).
//
//  A future native module lands BEHIND this contract with a parity gate
//  against the reference — never as a second ad-hoc seam.
// ============================================================================

import { createHash } from 'node:crypto'

export interface RuntimeKernelCapabilities {
  hash: boolean
  text: boolean
  search: boolean
  process: boolean
  pty: boolean
  /** One line per absent capability naming the owning facility. */
  notes: Record<string, string>
}

export interface HashKernel {
  /** The implementation identity ('node:crypto' | 'reference-ts' | …). */
  id: string
  sha256Hex(data: string | Uint8Array): string
}

export interface RuntimeKernel {
  capabilities(): RuntimeKernelCapabilities
  hash: HashKernel
}

// ── selected implementation: node:crypto (native, measured) ────────────────

const nodeCryptoHash: HashKernel = {
  id: 'node:crypto',
  sha256Hex(data: string | Uint8Array): string {
    const h = createHash('sha256')
    if (typeof data === 'string') h.update(data, 'utf8')
    else h.update(data)
    return h.digest('hex')
  },
}

// ── reference implementation: pure-TS SHA-256 (the parity target) ──────────
// Deterministic, dependency-free, deliberately unoptimized-but-clear. The
// parity proof (scripts/primitives-kernel/prove-primitives-kernel-kernel.ts) pins reference ===
// selected across a hostile corpus; a future native hash must pass the
// same gate.

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1,
  0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
  0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
  0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147,
  0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
  0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
  0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
  0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
])

function rotr(x: number, n: number): number {
  return (x >>> n) | (x << (32 - n))
}

function sha256Reference(data: string | Uint8Array): string {
  const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data
  const bitLen = bytes.length * 8
  // Padding: 0x80, zeros, 64-bit big-endian length.
  const padded = new Uint8Array((((bytes.length + 8) >> 6) + 1) << 6)
  padded.set(bytes)
  padded[bytes.length] = 0x80
  const view = new DataView(padded.buffer)
  view.setUint32(padded.length - 8, Math.floor(bitLen / 0x100000000), false)
  view.setUint32(padded.length - 4, bitLen >>> 0, false)

  const h = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c,
    0x1f83d9ab, 0x5be0cd19,
  ])
  const w = new Uint32Array(64)
  for (let block = 0; block < padded.length; block += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(block + i * 4, false)
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(w[i - 15]!, 7) ^ rotr(w[i - 15]!, 18) ^ (w[i - 15]! >>> 3)
      const s1 = rotr(w[i - 2]!, 17) ^ rotr(w[i - 2]!, 19) ^ (w[i - 2]! >>> 10)
      w[i] = (w[i - 16]! + s0 + w[i - 7]! + s1) >>> 0
    }
    let [a, b, c, d, e, f, g, hh] = [h[0]!, h[1]!, h[2]!, h[3]!, h[4]!, h[5]!, h[6]!, h[7]!]
    for (let i = 0; i < 64; i++) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)
      const ch = (e & f) ^ (~e & g)
      const temp1 = (hh + S1 + ch + K[i]! + w[i]!) >>> 0
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)
      const maj = (a & b) ^ (a & c) ^ (b & c)
      const temp2 = (S0 + maj) >>> 0
      hh = g
      g = f
      f = e
      e = (d + temp1) >>> 0
      d = c
      c = b
      b = a
      a = (temp1 + temp2) >>> 0
    }
    h[0] = (h[0]! + a) >>> 0
    h[1] = (h[1]! + b) >>> 0
    h[2] = (h[2]! + c) >>> 0
    h[3] = (h[3]! + d) >>> 0
    h[4] = (h[4]! + e) >>> 0
    h[5] = (h[5]! + f) >>> 0
    h[6] = (h[6]! + g) >>> 0
    h[7] = (h[7]! + hh) >>> 0
  }
  return [...h].map(x => x.toString(16).padStart(8, '0')).join('')
}

export const referenceHashKernel: HashKernel = {
  id: 'reference-ts',
  sha256Hex: sha256Reference,
}

// ── the negotiated kernel ───────────────────────────────────────────────────

const kernel: RuntimeKernel = {
  capabilities: () => ({
    hash: true,
    text: false,
    search: false,
    process: false,
    pty: false,
    notes: {
      text: 'owned Mercury Cell Layout (src/ink/layout/cellLayout.ts) — FLUX-owned surface',
      search: 'vendored ripgrep binary (BUILD-NOTES.md) — native behind one seam',
      process: 'daemon/ownerWatch.ts ps-based tokens — reconcile-frequency, no payoff measured',
      pty: 'no runtime PTY allocation exists (test harnesses are out-of-process)',
    },
  }),
  hash: nodeCryptoHash,
}

/** The negotiated runtime kernel (node-backed today; a native module lands
 *  behind this same contract with the parity gate). */
export function runtimeKernel(): RuntimeKernel {
  return kernel
}
