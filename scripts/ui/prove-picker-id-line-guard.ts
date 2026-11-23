
process.env.NODE_ENV = 'test'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

let failures = 0
const check = (label: string, cond: boolean, detail = '', hint = ''): void => {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ' — ' + detail : ''}${!cond && hint ? ' — ' + hint : ''}`)
  if (!cond) failures++
}

const { isProviderActionRow, keyConnectValue, GPT_CONNECT_OPTION_VALUE } = (await import(
  '../../src/models/catalogue/modelOptions.ts'
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
    check(`${sentinel} is an action row`, isProviderActionRow(sentinel), '', 'isProviderActionRow in src/models/catalogue/modelOptions.ts must return true for this sentinel spelling; add its prefix or pattern there')
  }
  for (const real of ['claude-opus-5', 'gpt-5.1', 'claude-fable-5']) {
    check(`${real} is not`, !isProviderActionRow(real), '', 'isProviderActionRow in src/models/catalogue/modelOptions.ts must return false for a real model id; narrow the pattern there')
  }
}

const { isModelRow } = await import('../../src/models/facts/modelPickerGroups.ts')
for (const id of ['host-run:Fixture Model', 'host-retry:fixture', 'host-remove:fixture']) {
  check(id + ' is an action, never a model id', !isModelRow({ id, name: 'Fixture action', group: 'Run a model', tag: '', action: true, searchableAction: true }), '', 'isModelRow in src/models/facts/modelPickerGroups.ts must return false for a row flagged action, so the picker never treats it as a model id')
}

console.log(failures === 0 ? '\nprove-picker-id-line-guard: all green' : `\nprove-picker-id-line-guard: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
