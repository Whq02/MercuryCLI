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

console.log('\n§2 the row paints the raw id only for a model row (call-shaped)')
{
  const src = readFileSync(join(ROOT, 'src', 'components', 'MercuryModelPicker.tsx'), 'utf-8')
  const pure = readFileSync(join(ROOT, 'src', 'utils', 'model', 'modelPickerGroups.ts'), 'utf-8')
  check(
    'a model row is one that is neither an action, a door nor a choice',
    pure.includes('export function isModelRow(row: PickerRow): boolean {') && pure.includes('return row.action !== true && row.expand === undefined && row.choice === undefined'),
  )
  const painter = src.slice(src.indexOf('const model = isModelRow(m)'), src.indexOf('{on && !compact && m.tag !== \'\''))
  check(
    'the id column paints m.id only on the model arm; the action arm paints the name across both columns and never the value',
    painter.includes('{model ? (') && painter.includes('cell(m.id, columns.id)') && painter.includes('cell(m.name, columns.alias + columns.id)') && !painter.slice(painter.indexOf('</>')).includes('cell(m.id'),
    painter.length > 0 ? '' : '(painter not found)',
  )
  check(
    'the printed ids-are-real sentence is retired: the raw id stands beside its alias on every model row instead',
    !src.includes('model IDs are real, never themed') && !src.includes('model ids are real'),
  )
}

console.log(failures === 0 ? '\nprove-picker-id-line-guard: all green' : `\nprove-picker-id-line-guard: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
