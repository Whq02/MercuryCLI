#!/usr/bin/env bun
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.NODE_ENV = 'test'
process.env['MERCURY_CONFIG_DIR'] = mkdtempSync(join(tmpdir(), 'hook-detail-prove-'))
process.env['FORCE_COLOR'] = '0'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ' — ' + detail : ''}`)
  if (!cond) failures++
}

const { enableConfigs } = await import('../../src/utils/config/globalConfig.js')
enableConfigs()
const React = (await import('react')).default
const { renderToString } = await import('../../src/utils/staticRender.tsx')
const { ViewHookMode } = await import('../../src/components/hooks/ViewHookMode.js')
const { SelectEventMode } = await import('../../src/components/hooks/SelectEventMode.js')
const { hookEventCard } = await import('../../src/utils/hooks/hooksConfigManager.js')
const { HOOK_EVENTS, hookEventTable } = await import('../../src/utils/hooks/contract.js')

const flat = (frame: string): string => frame.replace(/[│╭╮╰╯─]/g, ' ').replace(/\s+/g, ' ')
const mount = async (event: string, entry: Record<string, unknown>, source: Record<string, unknown> = { kind: 'settings', layer: 'project' }): Promise<string> =>
  flat(
    await renderToString(
      React.createElement(ViewHookMode, {
        event,
        card: hookEventCard(event as never, ['Bash', 'Read']),
        hook: { id: 'h1', event, entry, source, match: String(entry.match ?? '') },
        onBack: () => {},
      } as never),
      100,
    ),
  )

console.log('§1 the adorned run hook — every field that decides how it runs')
{
  const frame = await mount('tool.after', { run: 'echo done', name: 'lint', match: 'Bash', timeout: 45, shell: 'powershell', background: true, wake: true, once: true })
  check('Event: names the event and its moment', frame.includes('Event:') && frame.includes('tool.after') && frame.includes(hookEventTable['tool.after'].moment.slice(0, 20)), frame.slice(0, 200))
  check('Match: shows the match and the field it is matched against', frame.includes('Match:') && frame.includes('Bash') && frame.includes("(the event's tool)"))
  check('Kind: run', frame.includes('Kind:') && /Kind:\s*run/.test(frame))
  check('Name: the entry\'s name', frame.includes('Name:') && frame.includes('lint'))
  check('Source: the project layer, with its file', frame.includes('Source:') && frame.includes('Project settings'))
  check('Timeout: in seconds', frame.includes('Timeout:') && frame.includes('45s') && !frame.includes('(the default)'))
  check('Shell: renders', frame.includes('Shell:') && frame.includes('powershell'))
  check('Background: renders with the next-turn fact and the wake fact', frame.includes('Background:') && frame.includes('never holds the moment') && frame.includes('a block wakes the model'))
  check('Once: renders the once-per-session law', frame.includes('Once:') && frame.includes('runs once in this session, then stands down'))
  check('An answer may: lists what tool.after reads', frame.includes('An answer may:') && frame.includes('block the moment') && frame.includes("rewrite the tool's result"))
  check('the boxed text is the command', frame.includes('Command') && frame.includes('echo done'))
}

console.log('§2 the bare hook — the defaults are named, nothing invented')
{
  const frame = await mount('turn.answer', { question: 'Did the answer run its tests?' })
  check('no Match row on an event with no match field', !frame.includes('Match:'))
  check('Kind: question and the boxed text is the question', /Kind:\s*question/.test(frame) && frame.includes('Question') && frame.includes('Did the answer run its tests?'))
  check('Name: falls back to the question\'s first line', frame.includes('Name:') && frame.split('Name:')[1]?.includes('Did the answer run its tests?') === true)
  check('Timeout: the kind\'s default, named as the default', frame.includes('30s') && frame.includes('(the default)'))
  check('no Shell, Background, Once or Watch rows when unset', !frame.includes('Shell:') && !frame.includes('Background:') && !frame.includes('Once:') && !frame.includes('Watch:'))
  const record = await mount('session.end', { run: 'bye' }, { kind: 'extension', name: 'ping', id: 'ping-id', root: '/x' })
  check('a record event says an answer may nothing', record.includes('nothing — the hook is a record'))
  check('an extension source is named by its extension', record.includes('Extension ping'))
  const crew = await mount('crewmate.start', { crewmate: 'Check the brief', match: 'verifier' }, { kind: 'agent', type: 'verifier' })
  check('a crewmate hook: Kind crewmate, the boxed Brief, the 60s default, the agent source', /Kind:\s*crewmate/.test(crew) && crew.includes('Brief') && crew.includes('60s') && crew.includes('Agent verifier'))
  const watched = await mount('file.changed', { run: 'reload', watch: ['.env', 'config.json'] })
  check('Watch: lists the files', watched.includes('Watch:') && watched.includes('.env, config.json'))
}

console.log('§3 the event list names every event with its moment')
{
  const frame = await renderToString(
    React.createElement(SelectEventMode, {
      events: HOOK_EVENTS,
      moments: Object.fromEntries(HOOK_EVENTS.map(e => [e, hookEventTable[e].moment])),
      countsByEvent: { 'tool.before': 2 },
      totalCount: 2,
      onSelect: () => {},
      onExit: () => {},
    } as never),
    120,
  )
  const visible = HOOK_EVENTS.filter(e => frame.includes(e))
  check('the list opens on the first events in table order, with more below', visible.length >= 5 && JSON.stringify(visible) === JSON.stringify(HOOK_EVENTS.slice(0, visible.length)) && frame.includes('↓'), JSON.stringify(visible))
  check('each listed event carries its moment', visible.every(e => frame.includes(hookEventTable[e].moment.slice(0, 24))))
  check('an event with hooks carries its count', frame.includes('tool.before (2)'))
  check('the subtitle counts the hooks', frame.includes('2 configured hooks'))
}

console.log(failures === 0 ? '\nprove-hook-detail-fields: all green' : `\nprove-hook-detail-fields: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
