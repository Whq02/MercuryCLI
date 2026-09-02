// scripts/lib/goldenReplay.ts — the shared golden-replay harness core for the
// parity oracles (messages, attachments,
// …). Extracted from scripts/messages/prove-messages-parity.ts once R3 needed
// the same machinery.
//
// Guarantees the oracles depend on:
// - uuid/ISO-timestamp SUBSTRINGS are normalized inside strings, first-seen
//   numbered, so identity relations survive while self-generated ids stay
//   stable; wall-clock timestamps flatten to a constant («ts») because
//   same-millisecond collisions would make first-seen numbering racy —
//   PINNED fixture timestamps (2026-01-01T00:…) keep numbering.
// - function/symbol/bigint values snapshot as sentinels (JSON.stringify
//   silently DROPS function-valued keys — several "constants" are builders).
// - undefined snapshots as '«undefined»' (a dropped key silently diverges
//   verify-time accounting from the recorded file).
// - Maps/Sets serialize sorted; object keys sort; throws record as
//   deterministic '«throws»' entries.

export const UUID_SUB_RE =
  /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi
export const ISO_SUB_RE = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z/g

export function makeNormalizer() {
  const uuids = new Map<string, string>()
  const times = new Map<string, string>()
  const normScalar = (v: unknown): unknown => {
    if (typeof v === 'function') return `«fn/${(v as { length: number }).length}»`
    if (typeof v === 'symbol') return `«symbol:${String(v)}»`
    if (typeof v === 'bigint') return `«bigint:${v}»`
    if (typeof v !== 'string') return v
    return v
      // Windows lane: goldens are recorded /-spelled; the
      // platform separator is presentation, not semantics — normalize so
      // one golden adjudicates on every OS. Linux/macOS values carry no
      // backslash path spellings, so this is a Windows-only rewrite.
      .replaceAll('\\', '/')
      .replace(UUID_SUB_RE, m => {
        const k = m.toLowerCase()
        if (!uuids.has(k)) uuids.set(k, `«u${uuids.size + 1}»`)
        return uuids.get(k)!
      })
      .replace(ISO_SUB_RE, m => {
        if (!m.startsWith('2026-01-01T00:')) return '«ts»'
        if (!times.has(m)) times.set(m, `«t${times.size + 1}»`)
        return times.get(m)!
      })
  }
  const norm = (v: unknown): unknown => {
    if (v === null || typeof v !== 'object') return normScalar(v)
    if (Array.isArray(v)) return v.map(norm)
    if (v instanceof Map) {
      return {
        '«map»': [...v.entries()]
          .map(([k, val]) => [norm(k), norm(val)])
          .sort((a, b) => JSON.stringify(a[0]).localeCompare(JSON.stringify(b[0]))),
      }
    }
    if (v instanceof Set) {
      return {
        '«set»': [...v]
          .map(norm)
          .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
      }
    }
    const out: Record<string, unknown> = {}
    for (const k of Object.keys(v as object).sort()) {
      const val = (v as Record<string, unknown>)[k]
      if (val === undefined || typeof val === 'function') continue
      out[k] = norm(val)
    }
    return out
  }
  return norm
}

export function snap(fn: () => unknown): unknown {
  const norm = makeNormalizer()
  try {
    const v = norm(fn())
    return v === undefined ? '«undefined»' : v
  } catch (e) {
    return { '«throws»': e instanceof Error ? e.message.slice(0, 200) : String(e) }
  }
}

/** Async variant: awaits the value before normalizing. */
export async function snapAsync(fn: () => unknown): Promise<unknown> {
  const norm = makeNormalizer()
  try {
    const v = norm(await fn())
    return v === undefined ? '«undefined»' : v
  } catch (e) {
    return { '«throws»': e instanceof Error ? e.message.slice(0, 200) : String(e) }
  }
}

export const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v)) as T

/** Record/verify driver shared by the parity oracles. Returns the exit code. */
export function recordOrVerify(opts: {
  goldenPath: string
  results: Record<string, unknown>
  record: boolean
  coverageFailures: string[]
  passLabel: string
  readFileSync: (p: string, e: string) => string
  writeFileSync: (p: string, c: string) => void
  existsSync: (p: string) => boolean
}): number {
  const {
    goldenPath,
    results,
    record,
    coverageFailures,
    passLabel,
    readFileSync,
    writeFileSync,
    existsSync,
  } = opts
  let failures = 0

  if (coverageFailures.length) {
    console.log(
      `  [FAIL] ${coverageFailures.length} export(s) neither covered nor skip-listed:`,
    )
    for (const k of coverageFailures) console.log(`      - ${k}`)
    failures++
  }

  if (record) {
    writeFileSync(goldenPath, JSON.stringify(results, null, 1) + '\n')
    console.log(
      `  [RECORDED] ${Object.keys(results).length} golden case(s) → ${goldenPath}`,
    )
  } else if (!existsSync(goldenPath)) {
    console.log('  [FAIL] goldens missing — run with --record first')
    failures++
  } else {
    const golden = JSON.parse(readFileSync(goldenPath, 'utf-8')) as Record<
      string,
      unknown
    >
    for (const k of Object.keys(golden)) {
      if (!(k in results)) {
        console.log(`  [FAIL] golden case disappeared: ${k}`)
        failures++
        continue
      }
      const a = JSON.stringify(golden[k])
      const b = JSON.stringify(results[k])
      if (a !== b) {
        failures++
        console.log(`  [FAIL] parity broke: ${k}`)
        let i = 0
        while (i < Math.min(a.length, b.length) && a[i] === b[i]) i++
        console.log(`      golden:  …${a.slice(Math.max(0, i - 60), i + 90)}…`)
        console.log(`      current: …${b.slice(Math.max(0, i - 60), i + 90)}…`)
      }
    }
    for (const k of Object.keys(results)) {
      if (!(k in golden)) {
        console.log(`  [FAIL] new un-recorded case (re-run --record deliberately): ${k}`)
        failures++
      }
    }
    if (!failures) console.log(`  [PASS] ${passLabel}`)
  }
  return failures
}
