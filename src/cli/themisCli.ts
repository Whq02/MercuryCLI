// `mercury themis lock|verify|approve` — the THEMIS control plane's CLI verbs
// (paper-triad Slice A, docs/THEMIS-CONTROL-PLANE.md). Contract
// (cli-design-system): plain FACTS on stdout, one line each, no ANSI, no
// brand chrome; refusals, errors and usage go to STDERR like every other
// subcommand (FC-045 — they all rode stdout here, against the channel
// discipline the rest of the CLI honours). Exit codes: 0 = clean /
// re-stamped, 1 = an integrity problem was found or the verb refused,
// 2 = usage. Every path exits — never falls through to the REPL.
//
// Level gate: `lock` and `approve` WRITE trust state and refuse while the
// plane is off, so the OFF ⇒ no-.mercury/themis contract stays absolute on
// every path (passive AND explicit). `verify` is read-only and always
// answers (the /ledger doctrine — past records stay inspectable), reporting
// the live level alongside.

/* eslint-disable custom-rules/no-process-exit -- CLI subcommand handler intentionally exits */

const out = (s: string): void => {
  try {
    process.stdout.write(s + '\n')
  } catch {
    /* EPIPE */
  }
}

/** Refusals, errors and usage — stderr, per the CLI channel discipline. */
const err = (s: string): void => {
  try {
    process.stderr.write(s + '\n')
  } catch {
    /* EPIPE */
  }
}

export async function runThemisCli(verb: string, extraPaths: string[]): Promise<never> {
  const { binaryName } = await import('../utils/config.js')
  const cli = binaryName()
  const { themisLevel } = await import('../substrate/themis/level.js')
  const level = themisLevel()

  switch (verb) {
    case 'lock': {
      if (level === 'off') {
        err('themis lock: refused — MERCURY_THEMIS=off in this environment (the default is enforce; unset it or set warn|enforce — the plane writes no state while off)')
        process.exit(1)
      }
      const { DEFAULT_ENROLLED, enrollLockfile, lockfilePath } = await import('../substrate/themis/integrity.js')
      const { enrollDriftBaselines } = await import('../substrate/themis/drift.js')
      const { DEFAULT_DRIFT_ENROLLED } = await import('../substrate/themis/boot.js')
      const { appendAuditRow } = await import('../substrate/themis/auditChain.js')
      const lockPaths = [...new Set([...DEFAULT_ENROLLED, ...extraPaths])]
      // Lock REPLACES the enrolled set (the only un-enroll path) — read the
      // prior set first so a narrowing re-lock is loud, never silent.
      let priorPaths: string[] = []
      try {
        const { readFile } = await import('node:fs/promises')
        const prior = JSON.parse(await readFile(lockfilePath(), 'utf8')) as { files?: Record<string, unknown> }
        priorPaths = Object.keys(prior?.files ?? {})
      } catch {
        /* first lock */
      }
      const lock = await enrollLockfile(lockPaths)
      const drift = await enrollDriftBaselines([...new Set([...DEFAULT_DRIFT_ENROLLED, ...extraPaths])])
      await appendAuditRow({
        actor: 'cli',
        action: 'lock',
        details: `enrolled ${lock.enrolled.length} lock + ${drift.enrolled.length} drift baseline(s)`,
      })
      out(`locked ${lock.enrolled.length} file(s): ${lock.enrolled.join(', ')}`)
      if (lock.missing.length) out(`skipped (missing): ${lock.missing.join(', ')}`)
      const dropped = priorPaths.filter(p => !lockPaths.includes(p))
      if (dropped.length) out(`no longer enrolled (lock replaces the set): ${dropped.join(', ')}`)
      out(`drift baselines: ${drift.enrolled.join(', ') || '(none present)'}`)
      process.exit(0)
    }

    case 'verify': {
      const { themisBootVerify } = await import('../substrate/themis/boot.js')
      const { lockfileExists, verifyLockfile } = await import('../substrate/themis/integrity.js')
      const { checkDriftBaselines } = await import('../substrate/themis/drift.js')
      const { verifyAllChains } = await import('../substrate/themis/auditChain.js')
      out(`level: ${level}`)
      // Read-only sweep, valid at any level (audit rows only while active —
      // themisBootVerify covers that path when warn|enforce).
      if (level !== 'off') {
        const boot = await themisBootVerify()
        // CLEAN is earned only by CHECKING something (FC-156): with the
        // trust state absent the sweep verifies nothing, and a wiped state
        // is indistinguishable from a never-enrolled one BY DATA — the verb
        // must say so instead of certifying clean over an empty check.
        const enrolled = boot.lock !== null
        out(
          boot.problems.length === 0
            ? enrolled
              ? 'verify: CLEAN'
              : `verify: NOTHING ENROLLED — no lockfile exists, so nothing was checked (a wiped trust state and a never-enrolled project read identically; enroll: ${cli} themis lock)`
            : `verify: ${boot.problems.length} problem(s)`,
        )
        for (const p of boot.problems) out(`  ! ${p}`)
        process.exit(boot.problems.length === 0 ? 0 : 1)
      }
      let problems = 0
      if (await lockfileExists()) {
        const lock = await verifyLockfile()
        out(lock.ok ? `lockfile: ok (${lock.checked} files)` : `lockfile: ${lock.kind} — ${lock.detail}`)
        if (!lock.ok) problems++
      } else {
        out(`lockfile: none enrolled (run: ${cli} themis lock)`)
      }
      const drift = await checkDriftBaselines()
      for (const d of drift) {
        out(`drift: ${d.path} J=${d.jaccard} (${d.severity})`)
        if (d.severity === 'high') problems++
      }
      const chains = await verifyAllChains()
      const bad = chains.chains.filter(c => !c.verdict.ok)
      out(`audit chains: ${chains.chains.length} swept, ${bad.length} tamper-flagged`)
      for (const c of bad) {
        out(`  ! ${c.file}: ${(c.verdict as { kind?: string; detail?: string }).kind} — ${(c.verdict as { detail?: string }).detail}`)
      }
      problems += bad.length
      process.exit(problems === 0 ? 0 : 1)
    }

    case 'approve': {
      if (level === 'off') {
        err('themis approve: refused — MERCURY_THEMIS=off in this environment (the default is enforce; unset it or set warn|enforce — the plane writes no state while off)')
        process.exit(1)
      }
      const { themisApprove } = await import('../substrate/themis/boot.js')
      const { verifyLockfile } = await import('../substrate/themis/integrity.js')
      const r = await themisApprove()
      const after = await verifyLockfile()
      out(`re-stamped at current content: ${r.lockPaths.length} lock file(s), ${r.driftPaths.length} drift baseline(s)`)
      out(after.ok ? `lockfile verifies (${after.checked} files)` : `lockfile STILL refuses: ${after.detail}`)
      process.exit(after.ok ? 0 : 1)
    }

    default: {
      err(`Usage: ${cli} themis <lock|verify|approve> [extra paths...]`)
      err('  lock     Enroll the config trust anchor (defaults + any extra paths) and drift baselines.')
      err('  verify   Read-only integrity sweep: lockfile, drift, audit chains. Exit 1 on any problem.')
      err('  approve  Re-stamp both baselines at CURRENT content (after reviewing a reported change).')
      process.exit(2)
    }
  }
}
