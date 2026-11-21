import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { check, cleanup, finish, loadEval, makeContext, setup } from './lib.js'

const { work } = setup()
const { enableConfigs } = await import('../../src/utils/config/globalConfig.ts')
enableConfigs()
const { evalKernelManager } = await loadEval()
const { EvalTool } = await import('../../src/tools/EvalTool/EvalTool.ts')
const { FileReadTool } = await import('../../src/tools/FileReadTool/FileReadTool.ts')
const { BashTool } = await import('../../src/tools/BashTool/BashTool.tsx')
const { setCwd } = await import('../../src/utils/Shell.ts')
setCwd(work)
const path = join(work, 'large.json')
const json = JSON.stringify({ text: 'x'.repeat(200_000), end: 42 }) + '\n'
writeFileSync(path, json)
const context = await makeContext({ tools: [FileReadTool, BashTool, EvalTool] })
const allow = async (_tool: unknown, input: unknown) => ({ behavior: 'allow', updatedInput: input })
const file = JSON.stringify(path)
try {
  const cells = [
    ['js', `JSON.parse(await read_file(${file})).text.length`],
    ['js', `JSON.parse((await read_file(${file}, {bytes:true})).toString('utf8')).end`],
    ['py', `import json\nlen(json.loads(read_file(${file}))["text"])`],
    ['py', `json.loads(read_file(${file}, bytes=True))["end"]`],
    ['js', `JSON.parse((await tool.Bash({command: ${JSON.stringify(`cat "${path}"`)}})).stdout).text.length`],
    ['py', `len(json.loads(tool.Bash(command=${JSON.stringify(`cat "${path}"`)})["stdout"])["text"])`],
  ] as const
  for (const [index, [language, code]] of cells.entries()) {
    const result = await EvalTool.call({ language, code, timeoutSeconds: 60 }, context, allow as never)
    check(`${language} ${index}: unframed complete file`, result.data.status === 'ok' && result.data.resultRepr === (index === 1 || index === 3 ? '42' : '200000'), result.data.error?.value ?? result.data.resultRepr)
  }
  const denied = await EvalTool.call({ language: 'js', code: `await read_file(${file})` }, context, (async () => ({ behavior: 'deny', message: 'fixture denial' })) as never)
  check('raw read still obeys the Read permission denial', denied.data.status === 'error' && /denied|denial|permission/i.test(denied.data.error?.value ?? ''), denied.data.error?.value)
} finally {
  await evalKernelManager.disposeAll()
  cleanup()
}
finish('RAW FILE VALUES')
