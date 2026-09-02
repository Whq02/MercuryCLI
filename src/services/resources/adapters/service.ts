// resources/adapters/service — named project services
// (mercury://service/<name>, ?child=logs for the cursored log view).
// Registered from the projectServices slice — the registry never imports a
// subsystem that isn't built. Reads are RECONCILED: a dead pid never reads
// live.

import {
  describeCondition,
  servicesEnabled,
} from '../../projectServices/contracts.js'
import {
  readLogs,
  reconcileAll,
  reconcileRecord,
} from '../../projectServices/serviceManager.js'
import { registerResourceAdapter } from '../registry.js'
import {
  formatRef,
  type ParsedRef,
  type ResourceAdapter,
  type ResourceContext,
  type ResourceResult,
} from '../contracts.js'

export const serviceAdapter: ResourceAdapter = {
  kind: 'service',
  describe: 'named project services + logs (mercury://service/<name>?child=logs)',
  async resolve(ref: ParsedRef, ctx: ResourceContext): Promise<ResourceResult> {
    if (!servicesEnabled()) {
      return { state: 'unavailable', note: 'project services are disabled (MERCURY_SERVICES=0)' }
    }
    if (ref.id === '') {
      const records = reconcileAll(ctx.cwd)
      return {
        state: 'ok',
        resource: {
          ref: 'mercury://service',
          kind: 'service',
          title: 'project services',
          summary: `${records.length} service(s) · ${records.filter(r => ['ready', 'running', 'starting'].includes(r.state)).length} live`,
          mutable: true,
          children: records.map(r => ({
            ref: formatRef('service', r.spec.name),
            title: r.spec.name,
            summary: `${r.state}${r.pid ? ` (pid ${r.pid})` : ''}`,
          })),
        },
      }
    }
    const record = reconcileRecord(ctx.cwd, ref.id)
    if (!record) {
      return { state: 'absent', note: `no service '${ref.id}' in this project` }
    }
    if (ref.selectors.child === 'logs') {
      const logs = await readLogs(ctx.cwd, ref.id, {
        cursor: ref.selectors.cursor,
        limitLines: ref.selectors.limit ?? 100,
        filterRegex: ref.selectors.q,
        tail: ref.selectors.cursor === undefined,
      })
      if ('error' in logs) return { state: 'busy', note: logs.error }
      return {
        state: 'ok',
        resource: {
          ref: `${ref.canonical}?child=logs`,
          kind: 'service',
          title: `${record.spec.name} logs`,
          summary: `${logs.totalBytes} bytes · cursor ${logs.nextCursor}${logs.eof ? ' (end)' : ''}`,
          mutable: false,
          text: logs.lines.join('\n'),
          page: { cursor: logs.nextCursor, hasMore: !logs.eof },
        },
      }
    }
    return {
      state: 'ok',
      resource: {
        ref: ref.canonical,
        kind: 'service',
        title: `${record.spec.name} (${record.state})`,
        summary: `${record.state}${record.pid ? ` · pid ${record.pid}` : ''} · ${record.spec.lifecycle} lifecycle · ${record.restartCount} restart(s)`,
        version: `u${record.updatedAt}`,
        mutable: true,
        text: [
          `command: ${record.spec.command} ${record.spec.args.join(' ')}`,
          `state: ${record.state}`,
          ...(record.lastExitCode !== null ? [`last exit: ${record.lastExitCode}`] : []),
          ...(record.spec.readiness.length > 0
            ? ['readiness:', ...record.spec.readiness.map(c => `  · ${describeCondition(c)}`)]
            : []),
          `log: ${record.logFile}`,
        ].join('\n'),
        children: [
          {
            ref: `${ref.canonical}?child=logs`,
            title: 'logs',
            summary: 'ordered cursored log view',
          },
          {
            // the stable relation to the canonical execution
            // record — an alias link, never a second identity (Δ7).
            ref: formatRef('execution', `service:${record.spec.name}`),
            title: 'execution',
            summary: 'the canonical execution record (lifecycle, generation)',
          },
        ],
        structured: {
          name: record.spec.name,
          state: record.state,
          pid: record.pid,
          restartCount: record.restartCount,
        },
      },
    }
  },
}

registerResourceAdapter(serviceAdapter)
