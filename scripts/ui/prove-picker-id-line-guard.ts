
process.env.NODE_ENV = 'test'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ' — ' + detail : ''}`)
  if (!cond) failures++
}

const { isProviderActionRow, keyConnectValue, GPT_CONNECT_OPTION_VALUE } = (await import(
  '../../src/services/model/modelOptions.ts'
)) as unknown as {
  isProviderActionRow: (v: string) => boolean
  keyConnectValue: (p: string) => string
  GPT_CONNECT_OPTION_VALUE: string
}

console.log('§1 the predicate covers every sentinel spelling')
{
  for (const sentinel of [
    '__mercury_anthropic_connect__',
    '__mercury_zai_connect__',
    '__mercury_openrouter_expand__',
    '__mercury_huggingface_expand__',
    GPT_CONNECT_OPTION_VALUE,
    keyConnectValue('zai'),
    keyConnectValue('compat'),
  ]) {
    check(`${sentinel} is an action row`, isProviderActionRow(sentinel))
  }
  for (const real of ['claude-opus-5', 'gpt-5.1', 'claude-fable-5']) {
    check(`${real} is not`, !isProviderActionRow(real))
  }
}

const { isModelRow } = await import('../../src/utils/model/modelPickerGroups.ts')
for (const id of ['host-run:Fixture Model', 'host-retry:fixture', 'host-remove:fixture']) {
  check(id + ' is an action, never a model id', !isModelRow({ id, name: 'Fixture action', group: 'Run a model', tag: '', action: true, searchableAction: true }))
}

console.log(failures === 0 ? '\nprove-picker-id-line-guard: all green' : `\nprove-picker-id-line-guard: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
