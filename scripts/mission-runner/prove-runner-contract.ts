// ============================================================================
//  prove-runner-contract.ts — the runner's non-model machinery, CI-provable.
//
//  Uses the HELIX_AGENT_CMD proof seam (a scripted "agent") — ZERO model
//  calls. Laws proved:
//    1. a scripted agent that applies the reference solution → status
//       'accepted' with a passing grader;
//    2. a do-nothing agent → 'rejected' (grader components recorded);
//    3. an agent that outruns the time ceiling → 'incomplete' (a RESULT,
//       never silently retried) with timedOut recorded;
//    4. a do-nothing agent CLAIMING success → incorrectClaim=true, counted
//       separately;
//    5. an inapplicable policy → ONE 'not-applicable' row with the typed
//       reason;
//    6. every emitted row decodes through the aggregation codec, and the
//       codec REFUSES an accepted-over-failing-grader row.
// ============================================================================
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { taskById } from './corpus/tasks.js'
import { runTask } from './live/runner.js'
import { decodeRows } from './live/aggregate.js'

const scratch = mkdtempSync(join(tmpdir(), 'helix-runner-proof-'))
const rowsFile = join(scratch, 'rows.jsonl')
let failures = 0
function check(label: string, ok: boolean, detail?: string): void {
  if (ok) console.log('  ok  ' + label)
  else {
    failures += 1
    console.log('  FAIL ' + label + (detail ? ' — ' + detail : ''))
  }
}

// The scripted reference-appliers write files exactly as tasks.ts records
// them; (textkit tiny wrap fix) keeps the proof fast.
const t18 = taskById('T18')
const referenceDir = join(scratch, 'reference')
writeFileSync(join(scratch, 'wrap-reference.js'), t18.reference.files!['src/wrap.js'], 'utf8')
void referenceDir

// 1 · reference-applying agent → accepted.
{
  const row = runTask('T18', 'solo', {
    root: join(scratch, 'corpus-a'),
    outFile: rowsFile,
    agentCmd: 'cp ' + JSON.stringify(join(scratch, 'wrap-reference.js')) + ' src/wrap.js && echo "{}"',
  })
  check('reference agent accepted', row.status === 'accepted' && row.accepted, row.status)
  check('grader components recorded', (row.graderComponents ?? []).length > 0)
  check('changed paths observed', (row.changedPaths ?? []).join(',') === 'src/wrap.js')
}

// 1b · an agent that COMMITS its work is graded on the WORK (T10/ class).
{
  const row = runTask('T18', 'solo', {
    root: join(scratch, 'corpus-a'),
    outFile: rowsFile,
    agentCmd:
      'cp ' + JSON.stringify(join(scratch, 'wrap-reference.js')) + ' src/wrap.js && ' +
      'git add -A && git -c user.name=a -c user.email=a@local commit -q -m fix && echo "{}"',
  })
  check('committed reference agent accepted', row.status === 'accepted', row.status)
  check('committed changes observed', (row.changedPaths ?? []).join(',') === 'src/wrap.js')
}

// 2 · do-nothing agent → rejected.
{
  const row = runTask('T18', 'solo', {
    root: join(scratch, 'corpus-a'),
    outFile: rowsFile,
    agentCmd: 'true',
  })
  check('do-nothing agent rejected', row.status === 'rejected', row.status)
}

// 3 · ceiling breach → incomplete, recorded, not retried.
{
  process.env.HELIX_TIME_CEILING_OVERRIDE = '2'
  const started = Date.now()
  const row = runTask('T18', 'solo', {
    root: join(scratch, 'corpus-a'),
    outFile: rowsFile,
    agentCmd: 'sleep 30',
  })
  delete process.env.HELIX_TIME_CEILING_OVERRIDE
  check('ceiling breach is incomplete', row.status === 'incomplete', row.status)
  check('timeout recorded', row.timedOut === true)
  check('no silent retry (one attempt, fast return)', Date.now() - started < 15000)
}

// 4 · false success claim → incorrectClaim counted.
{
  const row = runTask('T18', 'solo', {
    root: join(scratch, 'corpus-a'),
    outFile: rowsFile,
    agentCmd: 'printf %s \'{"result": "All tests pass — the fix is complete.", "is_error": false}\'',
  })
  check('claim over failure flagged', row.incorrectClaim === true, JSON.stringify(row.incorrectClaim))
  check('claim row still rejected', row.status === 'rejected', row.status)
}

// 5 · inapplicable policy → typed NA row.
{
  const row = runTask('T18', 'router', { root: join(scratch, 'corpus-a'), outFile: rowsFile })
  check('router headless is not-applicable', row.status === 'not-applicable')
  check('NA reason typed', (row.naReason ?? '').includes('no current product path'))
  const workflowRow = runTask('T18', 'workflow', { root: join(scratch, 'corpus-a'), outFile: rowsFile })
  check('workflow on a solo family is not-applicable', workflowRow.status === 'not-applicable')
}

// 6 · codec accepts the emitted rows; refuses corrupted acceptance.
{
  const rows = decodeRows(readFileSync(rowsFile, 'utf8'))
  check('all rows decode', rows.length === 7, String(rows.length))
  const corrupt = JSON.stringify({
    ...rows[0],
    status: 'accepted',
    graderComponents: [{ name: 'checks', pass: false, detail: 'red' }],
  })
  let refused = false
  try {
    decodeRows(corrupt)
  } catch {
    refused = true
  }
  check('codec refuses accepted-over-failing-grader', refused)
}

rmSync(scratch, { recursive: true, force: true })
if (failures > 0) {
  console.error('prove-runner-contract: ' + failures + ' failure(s)')
  process.exit(1)
}
console.log('prove-runner-contract: green')
