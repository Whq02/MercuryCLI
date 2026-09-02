
export type HealthOutputMode = 'rich' | 'text' | 'json'

export interface HealthPresentation {
  output: HealthOutputMode
  depth: 'fast' | 'deep'
}

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

export function writeOutAndExit(text: string, code: number): void {
  try {
    process.stdout.on('error', (e: NodeJS.ErrnoException) => {
      process.exit(e.code === 'EPIPE' ? code : 1)
    })
    const flushed = process.stdout.write(text)
    if (flushed) {
      process.exit(code)
    } else {
      process.stdout.once('drain', () => process.exit(code))
      const guard = setTimeout(() => process.exit(code), 30_000)
      ;(guard as { unref?: () => void }).unref?.()
    }
  } catch {
    process.exit(code)
  }
}

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
