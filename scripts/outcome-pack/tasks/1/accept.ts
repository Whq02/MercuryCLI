import { evaluate, execute, type Acceptance, type Context } from '../../runtime.ts'

export function accept(ctx: Context): Acceptance {
  return evaluate(ctx, () => {
    const cases: Array<[string, string[]]> = [
      ['', []], [' \t\n ', []], [',,,', []], ['z,a,z,b', ['z', 'a', 'b']],
      [' e\u0301,é,É,東京,🙂,東京 ', ['é', 'É', '東京', '🙂']],
      ['\u2003beta\u2003,alpha, beta', ['beta', 'alpha']], ['A,a,A', ['A', 'a']],
      ['\u1100\u1161,가,각', ['가', '각']], ['__proto__,constructor,__proto__', ['__proto__', 'constructor']],
    ]
    const run = execute(ctx.cwd, ['--input-type=module', '-e', 'import { parseLabels } from "./labels.mjs"; let input=""; for await (const chunk of process.stdin) input+=chunk; console.log(JSON.stringify(JSON.parse(input).map(value => parseLabels(value))));'], JSON.stringify(cases.map(([input]) => input)))
    let values: unknown[] = []
    try { values = JSON.parse(run.stdout) } catch {}
    return cases.map(([input, expected], i) => ({ id: `labels-${i + 1}`, ok: run.code === 0 && JSON.stringify(values[i]) === JSON.stringify(expected), witness: JSON.stringify({ input, expected, actual: values[i], exitCode: run.code }) }))
  })
}
