// resources/adapters/test — durable test-run records.
// mercury://test/run/<id> · mercury://test/latest · mercury://test/failures —
// the addressable truth behind the Test tool (services/ide/pythonTests
// persists revisioned JSON under <projectRoot>/.mercury/test-runs/ via
// durableAtomicPublish). Registered like service/lane/ide: from this module,
// imported by tools.ts.

import {
  getRun,
  latestRun,
  listRuns,
  pythonTestsEnabled,
  type TestRunRecord,
} from '../../ide/pythonTests.js'
import { registerResourceAdapter } from '../registry.js'
import { GLYPH } from '../../../components/mercury-ui/glyphs.js'
import { boundedTextView, type ParsedRef, type ResourceAdapter, type ResourceChild, type ResourceResult } from '../contracts.js'

function recordResource(record: TestRunRecord, ref: string, selectors: ParsedRef['selectors']): ResourceResult {
  const c = record.counts
  const summary = `${record.framework} ${record.selection} — ${c.passed}✓ ${c.failed}✗ ${c.errored}${GLYPH.warn} ${c.skipped}→ (${record.durationMs}ms)`
  const view = boundedTextView(JSON.stringify(record, null, 2), selectors)
  return {
    state: 'ok',
    resource: {
      ref,
      kind: 'test',
      title: `test run ${record.id}`,
      summary,
      version: record.id,
      mutable: false,
      structured: record,
      text: view.text,
      page: view.page,
    },
  }
}

export const testAdapter: ResourceAdapter = {
  kind: 'test',
  describe: 'durable test-run records: run/<id> · latest · failures (the Test tool writes them)',
  async resolve(ref: ParsedRef): Promise<ResourceResult> {
    if (!pythonTestsEnabled()) {
      return { state: 'unavailable', note: 'test transactions are disabled (MERCURY_TESTS=0)' }
    }
    if (ref.id === '' ) {
      const runs = listRuns()
      return {
        state: 'ok',
        resource: {
          ref: 'mercury://test',
          kind: 'test',
          title: 'test runs',
          summary: `${runs.length} recorded run(s)`,
          mutable: false,
          children: runs.slice(0, 25).map(r => ({
            ref: `mercury://test/run/${r.id}`,
            title: r.id,
            summary: `${r.counts.passed}✓ ${r.counts.failed}✗ ${r.counts.errored}${GLYPH.warn}`,
          })),
        },
      }
    }
    if (ref.id === 'latest') {
      const record = latestRun()
      if (!record) return { state: 'absent', note: 'no recorded test run yet — Test op:"run" first' }
      return recordResource(record, 'mercury://test/latest', ref.selectors)
    }
    if (ref.id === 'failures') {
      const record = latestRun()
      if (!record) return { state: 'absent', note: 'no recorded test run yet — Test op:"run" first' }
      const failing = record.cases.filter(x => x.outcome === 'failed' || x.outcome === 'errored')
      return {
        state: 'ok',
        resource: {
          ref: 'mercury://test/failures',
          kind: 'test',
          title: `failures of ${record.id}`,
          summary: `${record.failures.length} failing node(s)`,
          version: record.id,
          mutable: false,
          structured: { runId: record.id, failures: record.failures, cases: failing },
          text: failing
            .map(x => `${x.id}${x.file ? ` (${x.file}${x.line ? `:${x.line}` : ''})` : ''}\n  ${(x.message ?? '').slice(0, 300)}`)
            .join('\n'),
        },
      }
    }
    if (ref.id.startsWith('run/')) {
      const record = getRun(ref.id.slice('run/'.length))
      if (!record) return { state: 'absent', note: `no run record '${ref.id}' — known: ${listRuns().map(r => r.id).slice(0, 6).join(', ') || '(none)'}` }
      return recordResource(record, `mercury://test/${ref.id}`, ref.selectors)
    }
    return { state: 'absent', note: `unknown test ref '${ref.id}' — the grammar is run/<id> · latest · failures` }
  },
  async list(): Promise<ResourceChild[]> {
    return listRuns()
      .slice(0, 25)
      .map(r => ({
        ref: `mercury://test/run/${r.id}`,
        title: r.id,
        summary: `${r.counts.passed}✓ ${r.counts.failed}✗ ${r.counts.errored}${GLYPH.warn}`,
      }))
  },
}

registerResourceAdapter(testAdapter)
