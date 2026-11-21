#!/usr/bin/env bun
import { join } from 'node:path'

process.env.NODE_ENV = 'test'
;(globalThis as Record<string, unknown>).MACRO ??= { VERSION: '1.0.0' }

let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ' — ' + detail : ''}`)
  if (!cond) failures++
}
const section = (t: string): void => console.log('\n' + '─'.repeat(76) + '\n' + t)

section('§1 N-04 · NATIVE TOOL-RESULT IMAGES CLAMPED AT THE ONE BOUNDARY')
{
  const { clampToolResultImageBlocks } = await import('../../src/utils/imageResizer.ts')
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
  const { ANTHROPIC_IMAGE_LIMITS } = await import('../../src/constants/apiLimits.ts')
  await clampToolResultImageBlocks(block, { limits: ANTHROPIC_IMAGE_LIMITS, model: 'claude-sonnet-5' })
  const clamped = block.content[1] as { source: { data: string } }
  const meta = await sharp(Buffer.from(clamped.source.data, 'base64')).metadata()
  check(
    'an oversized native capture clamps to the high-resolution tier long edge (≤2576px)',
    Math.max(meta.width ?? 9999, meta.height ?? 9999) <= ANTHROPIC_IMAGE_LIMITS.nativeLongEdgePx.highResolution &&
      Math.max(meta.width ?? 0, meta.height ?? 0) > 2000,
    `${meta.width}×${meta.height}`,
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
  )
  const untouchedSmall = block.content[2] as { source: { data: string } }
  check('an under-limit image passes through byte-identical', untouchedSmall.source.data === small.toString('base64'))
  check('text blocks pass through untouched', (block.content[0] as { text: string }).text === 'screenshot captured')

  const stringContent = { tool_use_id: 't2', type: 'tool_result', content: 'plain text result' }
  await clampToolResultImageBlocks(stringContent)
  check('string-content results are untouched', stringContent.content === 'plain text result')

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
  )

}

section('§2 N-04 · THE SINGLE-IMAGE DIMENSION 400 MATCHER')
{
  const { isMediaSizeError } = await import('../../src/services/api/errors.ts')
  check(
    'the field phrasing now matches (single-image "max allowed size")',
    isMediaSizeError(
      'messages.5.content.237.image.source.base64.data: image dimensions exceed max allowed size: 8412 pixels > 8000 pixels',
    ),
  )
  check(
    'the byte-size phrasing still matches',
    isMediaSizeError('image exceeds 5 MB maximum: 5316852 bytes > 5242880 bytes'),
  )
  check(
    'the many-image phrasing still matches',
    isMediaSizeError('image dimensions exceed the limit for many-image requests'),
  )
  check('unrelated 400s still do NOT match', !isMediaSizeError('invalid_request: model not found'))
}

section('§4 H-19 · ONE FILESYSTEM PERMISSION ENGINE ACROSS THE THREE TOOLS')
{

  const { pathInAllowedWorkingPath } = await import('../../src/utils/permissions/filesystem.ts')
  const { getOriginalCwd } = await import('../../src/bootstrap/state.ts')
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
  )
  check(
    'an outside path stays OUT of scope',
    !pathInAllowedWorkingPath('/definitely/not/in/scope/file.ts', ctx),
  )
}

if (failures > 0) {
  console.error(`\nprove-ingestion-truths: ${failures} FAILURE(S)`)
  process.exit(1)
}
console.log('\nprove-ingestion-truths: all green')
