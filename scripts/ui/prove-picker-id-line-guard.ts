#!/usr/bin/env bun
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

process.env.NODE_ENV = 'test'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ' — ' + detail : ''}`)
  if (!cond) failures++
}
const ROOT = join(import.meta.dir, '..', '..')

const { isProviderActionRow, keyConnectValue, GPT_CONNECT_OPTION_VALUE } = (await import(
  '../../src/utils/model/modelOptions.ts'
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

console.log('\n§2 the id line guards before it prints (call-shaped)')
{
  const src = readFileSync(join(ROOT, 'src', 'components', 'MercuryModelPicker.tsx'), 'utf-8')
  const ladder = src.slice(src.indexOf('seat slot · precedence'), src.indexOf('model IDs are real') + 60)
  check(
    'the ladder consults isProviderActionRow before the gated/id arms',
    ladder.includes('isProviderActionRow(focusedModel!.id)') &&
      ladder.includes('isProviderActionRow') &&
      ladder.indexOf('isProviderActionRow') < ladder.indexOf('.gated'),
    ladder.length > 0 ? '' : '(ladder not found)',
  )
  check(
    'the action arm speaks the action, never the value',
    ladder.includes('connect action') && !/connect action[^']*\$\{focusedModel/.test(ladder),
  )
  check(
    'the ids-are-real promise still stands on real model rows',
    src.includes('model IDs are real, never themed'),
  )
}

console.log(failures === 0 ? '\nprove-picker-id-line-guard: all green' : `\nprove-picker-id-line-guard: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
