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

const t18 = taskById('T18')
const referenceDir = join(scratch, 'reference')
writeFileSync(join(scratch, 'wrap-reference.js'), t18.reference.files!['src/wrap.js'], 'utf8')
void referenceDir

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

{
  const row = runTask('T18', 'solo', {
    root: join(scratch, 'corpus-a'),
    outFile: rowsFile,
    agentCmd: 'true',
  })
  check('do-nothing agent rejected', row.status === 'rejected', row.status)
}

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

{
  const row = runTask('T18', 'solo', {
    root: join(scratch, 'corpus-a'),
    outFile: rowsFile,
    agentCmd: 'printf %s \'{"result": "All tests pass — the fix is complete.", "is_error": false}\'',
  })
  check('claim over failure flagged', row.incorrectClaim === true, JSON.stringify(row.incorrectClaim))
  check('claim row still rejected', row.status === 'rejected', row.status)
}

{
  const row = runTask('T18', 'router', { root: join(scratch, 'corpus-a'), outFile: rowsFile })
  check('router headless is not-applicable', row.status === 'not-applicable')
  check('NA reason typed', (row.naReason ?? '').includes('no current product path'))
  const workflowRow = runTask('T18', 'workflow', { root: join(scratch, 'corpus-a'), outFile: rowsFile })
  check('workflow on a solo family is not-applicable', workflowRow.status === 'not-applicable')
}

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
