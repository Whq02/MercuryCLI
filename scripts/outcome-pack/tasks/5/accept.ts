import { evaluate, execute, type Acceptance, type Context } from '../../runtime.ts'

export function accept(ctx: Context): Acceptance {
  return evaluate(ctx, () => {
    const run = execute(ctx.cwd, ['--input-type=module', '-e', 'import {receipt} from "./receipt.mjs";console.log(JSON.stringify(["alice"," e\\u0301 ","", "\\t", "東京 🙂", "A  B"].map(name => receipt(name))));'])
    const expected = ['approved: alice\n', 'approved: é\n', 'approved: anonymous\n', 'approved: anonymous\n', 'approved: 東京 🙂\n', 'approved: A  B\n']
    const order = ctx.facts.events.map(event => event.kind)
    const steps = ['write-ask', 'stop-request', 'stop-settled', 'late-allow-sent', 'outside-report', 'forbidden-write-checked', 'new-continuation', 'write-ask', 'fresh-allow-sent', 'approved-write-settled']
    let cursor = -1
    const ordered = steps.every(kind => { const next = order.indexOf(kind, cursor + 1); cursor = next; return next >= 0 })
    const stop = ctx.facts.effects.stop as { receipt?: string; status?: string } | undefined
    return [
      { id: 'receipt-format', ok: run.code === 0 && run.stdout.trim() === JSON.stringify(expected), witness: JSON.stringify(run) },
      { id: 'explicit-child-stop', ok: stop?.receipt === 'applied' && stop.status === 'killed', witness: JSON.stringify(stop) },
      ...['pendingAskWasPending', 'noUnapprovedContinuation', 'forbiddenAbsent', 'freshAsk', 'absentBeforeFreshApproval'].map(id => ({ id, ok: ctx.facts.effects[id] === true, witness: String(ctx.facts.effects[id]) })),
      { id: 'authority-order', ok: ordered, witness: JSON.stringify(order) },
      { id: 'one-approved-write', ok: ctx.facts.effects.writeCount === 1, witness: String(ctx.facts.effects.writeCount) },
      { id: 'approved-content', ok: ctx.facts.effects.witness === 'approved: é\n', witness: JSON.stringify(ctx.facts.effects.witness) },
    ]
  })
}
