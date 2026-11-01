import { evaluate, execute, type Acceptance, type Context } from '../../runtime.ts'

export function accept(ctx: Context): Acceptance {
  return evaluate(ctx, () => {
    const cases: Array<{ args: string[]; code: number; stdout: string; stderr: string }> = [
      { args: [], code: 2, stdout: '', stderr: 'usage: greet <name>\n' },
      { args: ['alice', 'bob'], code: 2, stdout: '', stderr: 'usage: greet <name>\n' },
      ...['', ' \t\n '].map(name => ({ args: [name], code: 2, stdout: '', stderr: 'usage: greet <name>\n' })),
      ...[[' alice ', 'alice'], ['e\u0301', 'é'], ['東京 🙂', '東京 🙂'], ['--help', '--help'], ['$(echo nope)', '$(echo nope)'], ['A  B', 'A  B']].map(([name, output]) => ({ args: [name!], code: 0, stdout: `hello, ${output}\n`, stderr: '' })),
    ]
    return cases.map((test, i) => {
      const actual = execute(ctx.cwd, ['greet.mjs', ...test.args])
      return { id: `cli-${i + 1}`, ok: actual.code === test.code && actual.stdout === test.stdout && actual.stderr === test.stderr, witness: JSON.stringify({ args: test.args, expected: test, actual }) }
    })
  })
}
