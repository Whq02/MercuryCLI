# THEMIS — the deterministic control plane

THEMIS is Mercury's deterministic trust machinery: an attack-shape blocklist
at the universal tool-execution gate, tamper-evident audit chains, an
HMAC-stamped config lockfile with drift detection at boot, and optional
tracked change missions. Every check is deterministic — hash, regex, state
machine, set arithmetic. An LLM may produce candidates; it never checks them
(a non-deterministic component cannot serve as a trustworthy control for
another non-deterministic component). It is on by default: you meet it as a
typed refusal when a command matches a known attack shape, and one setting
turns it down or off.

## The level — ON by default

`MERCURY_THEMIS` carries the one enforcement level the whole plane keys off
(read live on every call):

| level | meaning |
| --- | --- |
| `enforce` | **THE DEFAULT.** Blocklist hits are refused at the gate with a typed teaching message. Never a prompt. |
| `warn` | Every signal is audited and surfaced; nothing is denied. The one-line de-escalation when legitimate work matches the shapes. |
| `off` / `0` | Explicit opt-out. Byte-identical: no checks, no audit rows, `.mercury/themis/` never created. |

Unset or unrecognized values resolve to the **default (`enforce`)** — a
typo'd level must never silently disarm the trust plane. The startup menu's
"Run discipline (THEMIS)" row (trust combo) cycles the saved level; `/health`
carries the live row.

`warn` and `enforce` run the same path until a hit, so the level decides
only what a hit does. The tradeoff: `enforce` refuses benign-but-matching
interactive commands (`git config --global user.email …`, `npx -y …`,
`nohup … &`); the refusal names the rule, and `MERCURY_THEMIS=warn` is the
one-line de-escalation.

## What refuses, and where

The blocklist is a fixed set of regexes distilled from real supply-chain
incidents — auto-confirm execs, pipe-to-shell, self-daemonizing spawns,
cron/systemd/autostart persistence, git config/hooks mutation. It is
checked at the one gate every tool execution passes, so every path that
executes a tool meets it: direct model calls, every permission mode
including bypass, and Workshop cells reaching tools through the bridge.
There is no cooperative-hook gap to skip.

Deny-only by construction: the blocklist can only ever ADD a documented
refusal; the normal permission ladder still decides everything it doesn't
flag. THEMIS never prompts — a hit under `enforce` is a typed refusal
telling the model to surface it to the operator, not to rephrase around it.
Internal failure degrades to proceed (fail-open): THEMIS can never break
tool execution.

Honest scope: the regexes reason about literal command text. They catch the
known footgun shapes before they run; they do not defeat a determined
adversary with shell access, and an obfuscated command can evade them.

## The audit chain

`.mercury/themis/audit-<pid>-<boot>.jsonl` — one chain per process boot,
each row folding the previous row's hash into its own, with a head sidecar.
Four tamper classes are detectable: edited rows, deletion/reorder, tail
truncation, tail swap. Rows write only while the plane is active, and only
on signal (hits, boot verify findings, enrollment acts, applied menu env) —
a clean session in a virgin project writes nothing. Verification is
gate-independent: past records stay inspectable after opt-out.

## Lockfile + drift — the boot verify pair

`mercury themis lock` enrolls trust-relevant config files two ways at once:
exact SHA-256 digests in an HMAC-stamped lockfile (catches single-byte
edits; the HMAC key lives in the config home, 0600, machine-local), and
normalized token-set baselines for Jaccard drift scoring (catches structural
rewrites of prompt-bearing prose). The two are a designed pair — each
covers the other's blind spot — and boot verifies both, loudly, plus the
pairing invariant (a half-deleted store is a silent-disable attempt, not a
fresh state). Honest scope: a machine-local key detects accidental or
automated corruption, not same-user adversarial re-stamping.

Session boot runs the full sweep (`themisBootVerify`) whenever the plane is
active; problems surface as a high-priority notification and on `/health`,
which also carries the operator remedies (`themis approve` re-stamps after
review; tampered chains have no remedy — tamper evidence is history).

## CLI

```
mercury themis lock [extra paths…] # enroll/re-enroll both stores (replaces the set)
mercury themis verify # read-only sweep; exit 1 on any problem
mercury themis approve # re-stamp both baselines at current content
```

`lock` and `approve` refuse while the plane is explicitly off (the OFF ⇒
no-files contract stays absolute); `verify` always answers.

## Missions

`/mission` tracks a bounded change against criteria, expected paths and
checks. No mission ⇒ zero added restriction. Under `warn` an unexpected-path
edit is recorded once per path; under `enforce` it is refused with
add-to-contract directions. Completion demands fresh verification evidence.

## Workflows

While the plane is active, workflow scripts get the `themis` VM global
(deterministic SDS/scheduling/trace checks — see the workflow prompt).
The bundled DAEDALUS workflow requires it and refuses to run with THEMIS
switched off.
