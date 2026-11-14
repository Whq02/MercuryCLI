#!/usr/bin/env bun
import { check, finish, pageOf, requireBrowser, run, serve } from './harness.ts'

await requireBrowser()
const fixture = await serve(27289, (_req, res) => { res.end('<title>cancel</title>') })
await run({ op: 'open', url: fixture.origin })
const before = await pageOf().evaluate(() => Intl.DateTimeFormat().resolvedOptions().timeZone)
const abortController = new AbortController()
abortController.abort()
const answer = await run({ op: 'viewport', emulation: { timezone: 'Asia/Tokyo', headers: { 'x-cancelled': 'yes' } } }, { abortController })
check('a pre-cancelled emulation answers with the existing interruption sentence', answer.outcome === 'failed' && answer.result.startsWith('viewport interrupted'), answer.result)
check('the cancelled call did not change the page or its reported environment', (await pageOf().evaluate(() => Intl.DateTimeFormat().resolvedOptions().timeZone)) === before && !(await run({ op: 'info' })).result.includes('emulation:'))
check('the cancelled call releases its waiter immediately', answer.ms < 1000, String(answer.ms))
await finish('prove-browser-emulation-cancel')
