#!/usr/bin/env bun

import { join } from 'node:path'

const ROOT = join(import.meta.dir, '..', '..')
const { realNdjsonChild, awaitLine } = await import(
  join(ROOT, 'src/services/crew/adapters/ndjsonChild.ts')
)

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ' — ' + detail : ''}`)
}
const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms))

console.log('============================================================')
console.log(' ndjsonChild settlement bounds — proof')
console.log('============================================================')

{
  const child = realNdjsonChild('sh', ['-c', 'printf \'{"tail":"no-newline"}\''], {})
  const lines: string[] = []
  child.onLine(l => lines.push(l))
  const settle = await new Promise<{ code: number | null }>(resolve => {
    child.onExit(code => resolve({ code }))
  })
  check('trailing line without newline is delivered', lines.some(l => l.includes('no-newline')), `lines=${JSON.stringify(lines)}`)
  check('settlement carries the real exit code', settle.code === 0, `code=${settle.code}`)
}

if (process.versions.bun) {
  console.log('  [SKIP] live stdin-EPIPE leg (bun swallows child-stdin EPIPE; production Node fires it — verified by hand under node v24.14.0)')
  const { readFileSync } = await import('node:fs')
  const src = readFileSync(join(ROOT, 'src/services/crew/adapters/ndjsonChild.ts'), 'utf8')
  check("stdin 'error' handler settles the child (structural pin)", src.includes("stdin error — settling as failed") && /stdin\?\.on\('error'[\s\S]{0,300}?settle\(null, `stdin error/m.test(src))
} else {
  const child = realNdjsonChild('sh', ['-c', 'exec 0<&-; sleep 3'], {})
  await sleep(150)
  const t0 = Date.now()
  child.write('{"ping":1}')
  await sleep(50)
  child.write('{"ping":2}')
  const result = await awaitLine(child, () => false, 2_000)
  const elapsed = Date.now() - t0
  check('stdin failure fails awaitLine FAST (no timeout idle)', !result.ok && elapsed < 1_500, `elapsed=${elapsed}ms result=${JSON.stringify(result)}`)
  check('the failure reason names the stdin error', !result.ok && result.reason.includes('stdin error'), JSON.stringify(result))
  child.kill()
}

{
  const child = realNdjsonChild(
    'sh',
    ['-c', 'head -c 9000000 /dev/zero | tr "\\0" "x"; printf \'\\n{"after":"oversize"}\\n\''],
    {},
  )
  const got = await awaitLine(
    child,
    p => typeof p === 'object' && p !== null && (p as { after?: string }).after === 'oversize',
    8_000,
  )
  check('frame AFTER an oversized line still arrives (resync)', got.ok === true, JSON.stringify(got).slice(0, 120))
  child.kill()
}

{
  const child = realNdjsonChild('sh', ['-c', 'printf "not-json\\nalso-not\\n"; sleep 2'], {})
  const result = await awaitLine(child, () => true, 900)
  check('unparseable frames are named, never silent', !result.ok && /2 unparseable line\(s\) seen/.test(result.reason), JSON.stringify(result))
  child.kill()
}

{
  const child = realNdjsonChild('sh', ['-c', 'trap "" TERM; sleep 30'], {})
  await sleep(150)
  const t0 = Date.now()
  await child.killAndWait?.(800)
  const elapsed = Date.now() - t0
  const exited = await Promise.race([
    new Promise<boolean>(resolve => child.onExit(() => resolve(true))),
    sleep(500).then(() => false),
  ])
  check('killAndWait resolves bounded against a TERM-trapping child', elapsed < 3_500, `elapsed=${elapsed}ms`)
  check('the child actually settled (SIGKILL landed)', exited === true)
}

{
  const child = realNdjsonChild('sh', ['-c', 'echo diag-note >&2; exit 3'], {})
  await new Promise<void>(resolve => child.onExit(() => resolve()))
  check('stderrTail carries the failure diagnosis', child.stderrTail?.().includes('diag-note') === true, JSON.stringify(child.stderrTail?.()))
}

{
  const { readFileSync } = await import('node:fs')
  const src = readFileSync(join(ROOT, 'src/services/crew/adapters/ndjsonChild.ts'), 'utf8')
  check('line buffer is bounded (MAX_LINE_BUFFER_BYTES + resync flag)', src.includes('MAX_LINE_BUFFER_BYTES') && src.includes('discardingOversizedLine'))
  check("settlement rides 'close' with an exit backstop", src.includes("child.on('close'") && src.includes('EXIT_CLOSE_BACKSTOP_MS'))
}

console.log('\n' + '='.repeat(60))
if (failures === 0) {
  console.log(' ✅ ALL NDJSON-CHILD SETTLEMENT PROOFS PASS')
} else {
  console.log(` ❌ ${failures} NDJSON-CHILD SETTLEMENT PROOF(S) FAILED`)
}
console.log('='.repeat(60))
process.exit(failures === 0 ? 0 : 1)
