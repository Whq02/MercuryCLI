import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = process.cwd()
let fail = 0
function check(label: string, cond: boolean, detail = ''): void {
  console.log(`  ${cond ? '✓' : '✗'} ${label}${cond || !detail ? '' : ` — ${detail}`}`)
  if (!cond) fail = 1
}
function walk(dir: string, out: string[]): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) walk(p, out)
    else if (/\.(ts|tsx)$/.test(name)) out.push(p)
  }
  return out
}
const task = (await import(join(ROOT, 'src/engine/tasks/taskBase.ts'))) as { createTaskStateBase: (start: unknown) => Record<string, unknown> }
const rows = (await import(join(ROOT, 'src/engine/rows/vocabulary.ts'))) as { TaskRowSchema: () => { shape: Record<string, unknown> } }
const rowFields = Object.keys(rows.TaskRowSchema().shape)
const start = { task_id: 'bproof001', task_type: 'local_bash', description: 'a proof task', call_id: 'toolu_proof' }
const before = Date.now()
const state = task.createTaskStateBase(start)
const minted = Object.keys(state).sort().join(',')
const kinds = walk(join(ROOT, 'src/engine/tasks'), []).filter(p => p !== join(ROOT, 'src/engine/tasks/taskBase.ts') && readFileSync(p, 'utf8').includes('createTaskStateBase('))
const callers = kinds.map(p => p.slice(ROOT.length + 1))

console.log(' the task record — one starting state, built from the task row\'s own fields')
check('the starting facts are named as the task row names them', ['task_id', 'task_type', 'description', 'call_id'].every(f => rowFields.includes(f)), `${rowFields.join(',')} — TaskRowSchema in src/engine/rows/vocabulary.ts must carry task_id, task_type, description and call_id, or createTaskStateBase in src/engine/tasks/taskBase.ts must stop taking them`)
check('one call takes the one shape', task.createTaskStateBase.length === 1, 'createTaskStateBase in src/engine/tasks/taskBase.ts must take exactly one parameter, the task row-shaped start object')
check('the state carries the id, the kind, the description and the call', state.id === 'bproof001' && state.type === 'local_bash' && state.description === 'a proof task' && state.toolUseId === 'toolu_proof', `${JSON.stringify(state)} — createTaskStateBase in src/engine/tasks/taskBase.ts must map task_id to id, task_type to type, description and call_id to toolUseId`)
check('it starts pending, now, with nothing consumed and nothing notified', state.status === 'pending' && typeof state.startTime === 'number' && (state.startTime as number) >= before && state.outputOffset === 0 && state.notified === false, `${JSON.stringify(state)} — createTaskStateBase in src/engine/tasks/taskBase.ts must return status pending, startTime now, outputOffset 0 and notified false`)
check('its output path is the task\'s own', typeof state.outputFile === 'string' && (state.outputFile as string).includes('bproof001'), `outputFile is ${String(state.outputFile)} — createTaskStateBase in src/engine/tasks/taskBase.ts must build outputFile from the task id`)
check('the minted fields are exactly the shared base', minted === 'description,id,notified,outputFile,outputOffset,startTime,status,toolUseId,type', `${minted} — createTaskStateBase in src/engine/tasks/taskBase.ts must mint exactly these fields; add a field to the expected list here only if the shared base should carry it`)
check('shell, agent and main-session tasks all mint through it', ['shellTask', 'crewmateTask', 'mainSessionTask', 'launchReceipts'].every(k => callers.some(c => c.includes(k))), `${callers.join(', ')} — each of shellTask, crewmateTask, mainSessionTask and launchReceipts under src/engine/tasks must call createTaskStateBase`)
check('no task kind mints a pending state beside it', kinds.every(p => !readFileSync(p, 'utf8').includes("status: 'pending'")), `a file under src/engine/tasks writes status: 'pending' itself: ${kinds.filter(p => readFileSync(p, 'utf8').includes("status: 'pending'")).map(p => p.slice(ROOT.length + 1)).join(', ')} — build the state through createTaskStateBase in src/engine/tasks/taskBase.ts instead`)

console.log(fail === 0 ? ' ✅ TASK START SHAPE PASS' : ' ❌ TASK START SHAPE FAILED')
process.exit(fail)
