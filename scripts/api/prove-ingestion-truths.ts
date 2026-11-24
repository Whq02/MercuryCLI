#!/usr/bin/env bun
import { join } from 'node:path'

process.env.NODE_ENV = 'test'
;(globalThis as Record<string, unknown>).MACRO ??= { VERSION: '1.0.0' }

let failures = 0
const check = (label: string, cond: boolean, detail = '', hint = ''): void => {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ' — ' + detail : ''}${!cond && hint ? ' — ' + hint : ''}`)
  if (!cond) failures++
}
const section = (t: string): void => console.log('\n' + '─'.repeat(76) + '\n' + t)

section('§1 N-04 · NATIVE TOOL-RESULT IMAGES CLAMPED AT THE ONE BOUNDARY')
{
  const { clampToolResultImageBlocks } = await import('../../src/platform/images/imageResizer.ts')
  const sharp = (await import('sharp')).default

  const oversized = await sharp({
    create: { width: 2600, height: 3200, channels: 3, background: { r: 200, g: 60, b: 60 } },
  })
    .png()
    .toBuffer()
  const small = await sharp({
    create: { width: 320, height: 200, channels: 3, background: { r: 60, g: 60, b: 200 } },
  })
    .png()
    .toBuffer()

  const block = {
    tool_use_id: 't1',
    type: 'tool_result',
    content: [
      { type: 'text', text: 'screenshot captured' },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: oversized.toString('base64') } },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: small.toString('base64') } },
    ],
  }
  const { ANTHROPIC_IMAGE_LIMITS } = await import('../../src/models/roads/mediaLimits.ts')
  await clampToolResultImageBlocks(block, { limits: ANTHROPIC_IMAGE_LIMITS, model: 'claude-sonnet-5' })
  const clamped = block.content[1] as { source: { data: string } }
  const meta = await sharp(Buffer.from(clamped.source.data, 'base64')).metadata()
  check(
    'an oversized native capture clamps to the high-resolution tier long edge (≤2576px)',
    Math.max(meta.width ?? 9999, meta.height ?? 9999) <= ANTHROPIC_IMAGE_LIMITS.nativeLongEdgePx.highResolution &&
      Math.max(meta.width ?? 0, meta.height ?? 0) > 2000,
    `${meta.width}×${meta.height}`,
    'clampToolResultImageBlocks in src/platform/images/imageResizer.ts must shrink a native capture to nativeLongEdgePx.highResolution in ANTHROPIC_IMAGE_LIMITS (src/models/roads/mediaLimits.ts)',
  )
  const standard = {
    tool_use_id: 't1s',
    type: 'tool_result',
    content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: oversized.toString('base64') } }],
  }
  await clampToolResultImageBlocks(standard, { limits: ANTHROPIC_IMAGE_LIMITS, model: 'claude-sonnet-4-5' })
  const standardMeta = await sharp(Buffer.from((standard.content[0] as { source: { data: string } }).source.data, 'base64')).metadata()
  check(
    'the same capture clamps to the standard tier long edge (≤1568px) for a standard-tier model',
    Math.max(standardMeta.width ?? 9999, standardMeta.height ?? 9999) <= ANTHROPIC_IMAGE_LIMITS.nativeLongEdgePx.standard,
    `${standardMeta.width}×${standardMeta.height}`,
    'clampToolResultImageBlocks in src/platform/images/imageResizer.ts must shrink to nativeLongEdgePx.standard in ANTHROPIC_IMAGE_LIMITS (src/models/roads/mediaLimits.ts) for a standard-tier model',
  )
  const untouchedSmall = block.content[2] as { source: { data: string } }
  check('an under-limit image passes through byte-identical', untouchedSmall.source.data === small.toString('base64'), '', 'clampToolResultImageBlocks in src/platform/images/imageResizer.ts must leave an image under the limit byte-identical')
  check('text blocks pass through untouched', (block.content[0] as { text: string }).text === 'screenshot captured', '', 'clampToolResultImageBlocks in src/platform/images/imageResizer.ts must not touch text blocks')

  const stringContent = { tool_use_id: 't2', type: 'tool_result', content: 'plain text result' }
  await clampToolResultImageBlocks(stringContent)
  check('string-content results are untouched', stringContent.content === 'plain text result', '', 'clampToolResultImageBlocks in src/platform/images/imageResizer.ts must leave a result whose content is a string untouched')

  const corruptPayload = Buffer.from('this is definitely not an image').toString('base64')
  const corrupt = {
    tool_use_id: 't3',
    type: 'tool_result',
    content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: corruptPayload } }],
  }
  await clampToolResultImageBlocks(corrupt)
  check(
    'a corrupt image FAILS OPEN (payload byte-identical, nothing throws)',
    (corrupt.content[0] as { source: { data: string } }).source.data === corruptPayload,
    '',
    'clampToolResultImageBlocks in src/platform/images/imageResizer.ts must catch a decode failure, keep the payload and not throw',
  )

}

section('§4 H-19 · ONE FILESYSTEM PERMISSION ENGINE ACROSS THE THREE TOOLS')
{

  const { pathInAllowedWorkingPath } = await import('../../src/permissions/rules/filesystem.ts')
  const { getOriginalCwd } = await import('../../src/boot/process-state/processState.ts')
  const ctx = {
    mode: 'default',
    alwaysAllowRules: {},
    alwaysDenyRules: {},
    alwaysAskRules: {},
    isBypassPermissionsModeAvailable: false,
  } as unknown as Parameters<typeof pathInAllowedWorkingPath>[1]
  check(
    'a primary-cwd file is IN scope by the shared predicate',
    pathInAllowedWorkingPath(join(getOriginalCwd(), 'src', 'Tool.ts'), ctx),
    '',
    'pathInAllowedWorkingPath in src/permissions/rules/filesystem.ts must accept a file under the original cwd',
  )
  check(
    'an outside path stays OUT of scope',
    !pathInAllowedWorkingPath('/definitely/not/in/scope/file.ts', ctx),
    '',
    'pathInAllowedWorkingPath in src/permissions/rules/filesystem.ts must refuse a path outside every working directory',
  )
}

if (failures > 0) {
  console.error(`\nprove-ingestion-truths: ${failures} FAILURE(S)`)
  process.exit(1)
}
console.log('\nprove-ingestion-truths: all green')
