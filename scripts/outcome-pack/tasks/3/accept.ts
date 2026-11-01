import { evaluate, execute, type Acceptance, type Context } from '../../runtime.ts'

export function accept(ctx: Context): Acceptance {
  return evaluate(ctx, () => {
    const run = execute(ctx.cwd, ['--input-type=module', '-e', 'import {limit} from "./config.mjs";import {renderLimit} from "./view.mjs";console.log(JSON.stringify([limit,...["alice"," bob ","", "\\t", "東京", "A  B"].map(name => renderLimit(name))]));'])
    const expected = [8, 'alice: 8', 'bob: 8', 'anonymous: 8', 'anonymous: 8', '東京: 8', 'A  B: 8']
    return [
      { id: 'two-file-result', ok: run.code === 0 && run.stdout.trim() === JSON.stringify(expected), witness: JSON.stringify(run) },
      ...['staleRefused', 'noPartialWrite', 'correctedApplied'].map(id => ({ id, ok: ctx.facts.effects[id] === true, witness: String(ctx.facts.effects[id]) })),
    ]
  })
}
