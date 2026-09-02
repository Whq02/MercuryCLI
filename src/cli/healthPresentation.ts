// ============================================================================
//  cli/healthPresentation — the ONE health/doctor presentation decision
//
//
//  The field `mercury doctor` under piped stdio mounted Ink unconditionally:
//  raw-mode setup crashed, the process lingered to a 180s guard kill, and the
//  crash artifact blamed the terminal. The presentation is now resolved at
//  CLI ingress BEFORE createRoot/Ink/raw-mode/alternate-screen/MCP-UI ever
//  load (HL-01):
//
//    · --json        ⇒ json  (one stable-schema record on stdout, HL-08)
//    · both stdio TTY ⇒ rich (the Ink certificate view)
//    · anything else ⇒ text  (bounded plain output that exits unaided —
//                             redirected stdin alone forfeits rich too: raw
//                             mode needs the input side, HL-04)
//
//  The drain-aware exit (HL-30/31): CLI handlers would otherwise write a potentially
//  large record and call process.exit in the same tick — a slow pipe observed
//  truncation even when the report itself completed.
//  writeOutAndExit awaits the stream drain before exiting; EPIPE settles
//  quietly (HL-09 — a closed pager is a normal end, never a crash).
// ============================================================================

export type HealthOutputMode = 'rich' | 'text' | 'json'

export interface HealthPresentation {
  output: HealthOutputMode
  depth: 'fast' | 'deep'
}

/**
 * The pure presentation decision — provable as a table (HL-04..06: redirected
 * stdin only, redirected stdout only, both, pipes, NUL//dev/null, no TERM,
 * CI all land 'text' through the same two booleans).
 */
export function resolveHealthPresentation(
  opts: { json?: boolean; deep?: boolean },
  io?: { stdoutIsTTY?: boolean; stdinIsTTY?: boolean },
): HealthPresentation {
  const depth: 'fast' | 'deep' = opts.deep === true ? 'deep' : 'fast'
  if (opts.json === true) return { output: 'json', depth }
  const stdoutTTY = io?.stdoutIsTTY ?? process.stdout.isTTY === true
  const stdinTTY = io?.stdinIsTTY ?? process.stdin.isTTY === true
  return { output: stdoutTTY && stdinTTY ? 'rich' : 'text', depth }
}

/**
 * Write `text` to stdout and exit AFTER the stream drains — never a same-tick
 * write+exit over a slow sink. EPIPE (closed pager/head) settles quietly with
 * the conventional exit for a closed pipe reader. Never throws.
 */
export function writeOutAndExit(text: string, code: number): void {
  try {
    process.stdout.on('error', (e: NodeJS.ErrnoException) => {
      // A closed reader is a normal end of output, never a crash (HL-09).
      process.exit(e.code === 'EPIPE' ? code : 1)
    })
    const flushed = process.stdout.write(text)
    if (flushed) {
      process.exit(code)
    } else {
      process.stdout.once('drain', () => process.exit(code))
      // A sink that never drains must not hold the process forever — the
      // bounded backstop is generous (a genuinely slow-but-live reader
      // finishes long before it) and names nothing false: the bytes were
      // handed to the OS; only the drain ack is outstanding.
      const guard = setTimeout(() => process.exit(code), 30_000)
      ;(guard as { unref?: () => void }).unref?.()
    }
  } catch {
    process.exit(code)
  }
}

/** The shared PLAIN certificate renderer (HL-02/07): section headers +
 *  status rows + verdict, zero ANSI/control bytes — the same shape the
 *  --deep path always printed, now the ONE text presentation. */
export function renderPlainCertificate(cert: {
  sections: Array<{ title: string; checks: Array<{ status: string; label: string; evidence: string }> }>
  verdict: string
  durationMs: number
}): string {
  const lines: string[] = []
  for (const section of cert.sections) {
    lines.push('', section.title)
    for (const c of section.checks) {
      lines.push(`  [${c.status.toUpperCase()}] ${c.label} — ${c.evidence}`)
    }
  }
  lines.push('', `verdict: ${cert.verdict.toUpperCase()} (${cert.durationMs}ms)`, '')
  return lines.join('\n')
}
