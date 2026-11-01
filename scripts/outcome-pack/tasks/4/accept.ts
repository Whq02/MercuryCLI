import { evaluate, execute, type Acceptance, type Context } from '../../runtime.ts'

export function accept(ctx: Context): Acceptance {
  return evaluate(ctx, () => {
    const run = execute(ctx.cwd, ['--input-type=module', '-e', 'import {score} from "./score.mjs";const inputs=[-Infinity,Infinity,NaN,undefined,null,"5",{},-0,-0.1,-4,0.5,12.49,12.5,99.6,120];console.log(JSON.stringify(inputs.map(x=>[score(x),Object.is(score(x),-0)])));'])
    const expected = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 12, 13, 100, 100].map(value => [value, false])
    const stale = ctx.facts.effects.afterRestart as { state?: string } | undefined
    const fresh = ctx.facts.effects.afterFresh as { state?: string } | undefined
    return [
      { id: 'bounded-score', ok: run.code === 0 && run.stdout.trim() === JSON.stringify(expected), witness: JSON.stringify(run) },
      { id: 'late-A-stale-after-restart', ok: stale?.state === 'stale', witness: JSON.stringify(stale) },
      { id: 'fresh-B-verifies', ok: fresh?.state === 'verified', witness: JSON.stringify(fresh) },
      { id: 'delivered-B', ok: ctx.facts.effects.deliveredBytes === true, witness: String(ctx.facts.effects.deliveredBytes) },
    ]
  })
}
