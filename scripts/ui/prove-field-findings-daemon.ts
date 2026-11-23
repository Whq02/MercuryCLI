#!/usr/bin/env bun


let failures = 0
const check = (name: string, ok: boolean, detail?: string): void => {
  if (ok) {
    console.log(`  ok  ${name}`)
  } else {
    failures++
    console.error(`  RED ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

console.log('§1 daemon roster — outcome first')
{
  const { deriveDaemonRows: deriveDaemonRows } = await import('../../src/screen/cockpit-gauges/daemonRows.ts')
  const status = {
    daemon: { pid: 4242, version: '0.0.0', uptimeSec: 10, dir: '/tmp/x' },
    controlSock: '/tmp/x/control.sock',
    controlReachable: true,
    workersLive: 1,
    workersTotal: 2,
    breakerOpen: false,
    maxInflight: 2,
    leaseCount: 0,
    proto: 1,
    degraded: false,
    warmRunners: 0,
    fireOutcomes: null,
    handshake: null,
    versionLine: null,
    workers: [
      { short: 'impl-1', sessionId: 's1', prompt: '', source: 'cron', state: 'crashed', startedAt: 0, cliVersion: '0', outcome: 'degraded', respawns: 3 },
      { short: 'impl-2', sessionId: 's2', prompt: '', source: 'cron', state: 'running', startedAt: 0, cliVersion: '0', busy: false },
    ],
  } as unknown as Parameters<typeof deriveDaemonRows>[0]
  const rows = deriveDaemonRows(status).workers
  check('the derive carries the wire outcome on the settled seat and none on the live one', rows[0]?.outcome === 'degraded' && rows[1]?.outcome === undefined, `${JSON.stringify(rows.map(r => r.outcome))} — deriveDaemonRows in src/screen/cockpit-gauges/daemonRows.ts must copy the wire outcome of each worker into its row and leave it off when the worker has none`)
  check('a settled seat is never busy', rows[0]?.busy === false, `busy ${String(rows[0]?.busy)} — deriveDaemonRows in src/screen/cockpit-gauges/daemonRows.ts sets busy from the worker busy flag; a crashed seat that reports none must read false`)
}


process.exit(failures === 0 ? 0 : 1)
