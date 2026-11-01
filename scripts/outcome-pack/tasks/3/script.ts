import { appendFileSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { digest, drive, event, type Change, type Context } from '../../runtime.ts'

export async function script(ctx: Context, changes: Change[]): Promise<void> {
  const paths = ['config.mjs', 'view.mjs']
  const before = paths.map(path => readFileSync(join(ctx.cwd, path), 'utf8'))
  const desired = paths.map((path, i) => changes.find(change => change.path === path)?.after ?? before[i]!)
  const anchors: string[] = []
  let oldPlan = ''
  const member = (i: number, fresh: boolean) => ({ file_path: join(ctx.cwd, paths[i]!), expected_anchor: anchors[i], edits: [{ old_string: before[i]! + (fresh && i === 1 ? ' ' : ''), new_string: desired[i] }] })
  await drive(ctx, req => {
    const last = req.results.at(-1)
    const tool = (name: string, input: Record<string, unknown>) => [{ type: 'tool_use' as const, name, input }]
    const anchor = () => { const value = /\(anchor: ([^)]+)\)/.exec(last?.text ?? '')?.[1]; if (!value) throw new Error('Read supplied no anchor'); return value }
    const plan = () => { const value = /\bcs-[a-f0-9]+\b/.exec(last?.text ?? '')?.[0]; if (!value) throw new Error('ChangeSet supplied no plan'); return value }
    switch (req.step) {
      case 0: return tool('Read', { file_path: join(ctx.cwd, paths[0]!) })
      case 1: anchors[0] = anchor(); return tool('Read', { file_path: join(ctx.cwd, paths[1]!) })
      case 2: anchors[1] = anchor(); return tool('ChangeSet', { op: 'preview', changes: [member(0, false), member(1, false)] })
      case 3:
        oldPlan = plan()
        appendFileSync(join(ctx.cwd, paths[1]!), ' ')
        event(ctx.facts, 'external-target-change')
        return tool('ChangeSet', { op: 'apply', plan_id: oldPlan })
      case 4:
        ctx.facts.effects.staleRefused = last?.isError === true
        ctx.facts.effects.noPartialWrite = paths.every((path, i) => readFileSync(join(ctx.cwd, path), 'utf8') === before[i]! + (i === 1 ? ' ' : ''))
        event(ctx.facts, 'stale-plan-settled', { refused: ctx.facts.effects.staleRefused, unchanged: ctx.facts.effects.noPartialWrite })
        return tool('Read', { file_path: join(ctx.cwd, paths[0]!) })
      case 5: anchors[0] = anchor(); return tool('Read', { file_path: join(ctx.cwd, paths[1]!) })
      case 6: anchors[1] = anchor(); return tool('ChangeSet', { op: 'preview', changes: [member(0, true), member(1, true)] })
      case 7: return tool('ChangeSet', { op: 'apply', plan_id: plan() })
      case 8:
        ctx.facts.effects.correctedApplied = last?.isError === false && paths.every((path, i) => readFileSync(join(ctx.cwd, path), 'utf8') === desired[i])
        ctx.facts.effects.firstCandidateHash = digest(ctx.cwd)
        event(ctx.facts, 'corrected-plan-settled', ctx.facts.effects.correctedApplied)
        return tool('Bash', { command: 'npm test', cwd: ctx.cwd, description: 'Check the two delivered modules' })
      default:
        ctx.facts.ordinaryCheck = last?.isError === false
        return [{ type: 'text', text: 'Done.' }]
    }
  })
}
