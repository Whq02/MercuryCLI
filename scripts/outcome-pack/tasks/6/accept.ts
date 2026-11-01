import { evaluate, execute, type Acceptance, type Context } from '../../runtime.ts'

export function accept(ctx: Context): Acceptance {
  return evaluate(ctx, () => {
    const run = execute(ctx.cwd, ['--input-type=module', '-e', 'import {result} from "./result.mjs";console.log(JSON.stringify([[],["", "\\t"],[" z ","a","z"],["e\\u0301","é","É","🙂","東京","🙂"]].map(names => result(names))));'])
    const expected = ['saved: nobody\n', 'saved: nobody\n', 'saved: z, a\n', 'saved: é, É, 🙂, 東京\n']
    return [
      { id: 'saved-result', ok: run.code === 0 && run.stdout.trim() === JSON.stringify(expected), witness: JSON.stringify(run) },
      ...['compacted', 'sameBytes', 'sameSession', 'oneRetainedResult'].map(id => ({ id, ok: ctx.facts.effects[id] === true, witness: String(ctx.facts.effects[id]) })),
    ]
  })
}
