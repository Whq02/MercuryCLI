#!/usr/bin/env bun
process.env.NODE_ENV = 'test'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const { describeTransportFailure } = await import('../../src/services/providers/openaicompat/compatChatClient.ts')

let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ' — ' + detail : ''}`)
  if (!cond) failures++
}

const withCause = (cause: unknown): Error => {
  const outer = new TypeError('fetch failed')
  ;(outer as { cause?: unknown }).cause = cause
  return outer
}
const errno = (props: Record<string, unknown>): Error => Object.assign(new Error(String(props.code ?? 'E')), props)

const refused = describeTransportFailure(
  withCause(errno({ code: 'ECONNREFUSED', syscall: 'connect', address: '127.0.0.1', port: 9111 })),
  'http://127.0.0.1:9111/v1',
)
check('a refused connection names errno + address + port', /ECONNREFUSED/.test(refused) && /9111/.test(refused), refused)
check('and the endpoint host', /endpoint 127\.0\.0\.1:9111/.test(refused), refused)

const nxdomain = describeTransportFailure(
  withCause(errno({ code: 'ENOTFOUND', syscall: 'getaddrinfo', hostname: 'api.wrong.invalid' })),
  'https://api.wrong.invalid/v1',
)
check('NXDOMAIN names the hostname', /ENOTFOUND/.test(nxdomain) && /api\.wrong\.invalid/.test(nxdomain), nxdomain)

const aggregate = (() => {
  const agg = new AggregateError([errno({ code: 'ECONNREFUSED', syscall: 'connect', address: '::1', port: 9 })], 'aggregate')
  return describeTransportFailure(withCause(agg), 'http://localhost:9/v1')
})()
check('a Happy-Eyeballs AggregateError yields its first inner errno', /ECONNREFUSED/.test(aggregate), aggregate)

const tls = describeTransportFailure(
  withCause(errno({ code: 'EPROTO', syscall: 'write', message: 'wrong version number' })),
  'https://127.0.0.1:8977/v1',
)
check('a TLS-onto-plain-HTTP failure names EPROTO', /EPROTO/.test(tls), tls)

const distinct = new Set([refused, nxdomain, aggregate, tls])
check('the five shapes stop collapsing to one sentence', distinct.size === 4, `${distinct.size} distinct`)

if (failures > 0) {
  console.error(`\nprove-transport-fault-names: ${failures} FAILURE(S)`)
  process.exit(1)
}
console.log('\nprove-transport-fault-names: all green')
