#!/usr/bin/env bun
import type http from 'node:http'
import { check, finish, lead, ownerOf, permission, requireBrowser, run, section, serve, sessions } from './harness.ts'

await requireBrowser()

const peer = { agentId: 'redirect-peer-owner' }

const destA = await serve(0, (_req: http.IncomingMessage, res: http.ServerResponse) => {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
  res.end('<!doctype html><title>Dest A</title><body><button id="act">Act A</button></body>')
})

const destC = await serve(0, (_req: http.IncomingMessage, res: http.ServerResponse) => {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
  res.end('<!doctype html><title>Dest C</title><body><button id="act-c">Act C</button></body>')
})

const redirB = await serve(0, (req: http.IncomingMessage, res: http.ServerResponse) => {
  const url = new URL(req.url ?? '/', 'http://fixture')
  if (url.pathname === '/to-a') {
    res.writeHead(302, { location: `${destA.origin}/dest` })
    res.end()
    return
  }
  if (url.pathname === '/to-c') {
    res.writeHead(302, { location: `${destC.origin}/unapproved` })
    res.end()
    return
  }
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
  res.end('<!doctype html><title>Redir B</title><body><p>Origin B</p></body>')
})

section('S1 redirect to an origin already approved for this owner does not falsely predict an ask')
{
  const approvedOpen = await run({ op: 'open', url: `${destA.origin}/dest` }, lead)
  check('destination origin A opens and is approved for lead', approvedOpen.outcome === 'succeeded' && sessions.originApproved(ownerOf(lead), destA.origin), approvedOpen.result)

  const redirected = await run({ op: 'open', url: `${redirB.origin}/to-a` }, lead)
  check('redirect from B to approved A succeeds and reports crossed origin', redirected.outcome === 'succeeded' && redirected.result.includes(`landed on ${destA.origin}`) && redirected.result.includes('a redirect crossed origins'), redirected.result)
  check('receipt does not falsely say acts there will ask', !redirected.result.includes('acts there will ask'), redirected.result)
  const actPerm = await permission({ op: 'click', selector: '#act' }, lead)
  check('an act on already-approved A is allowed without asking', actPerm.behavior === 'allow', JSON.stringify(actPerm))
}

section('S2 redirect to an unapproved origin still warns, grants nothing, and still asks')
{
  const redirected = await run({ op: 'open', url: `${redirB.origin}/to-c` }, lead)
  check('redirect from B to unapproved C warns that acts there will ask', redirected.outcome === 'succeeded' && redirected.result.includes(`landed on ${destC.origin}`) && redirected.result.includes('a redirect crossed origins — acts there will ask'), redirected.result)
  check('redirect never grants destination origin C', !sessions.originApproved(ownerOf(lead), destC.origin), `approved=${sessions.originApproved(ownerOf(lead), destC.origin)}`)
  const actPerm = await permission({ op: 'click', selector: '#act-c' }, lead)
  check('an act on unapproved destination C still asks', actPerm.behavior === 'ask', JSON.stringify(actPerm))
}

section('S3 owners remain independent when redirecting into an origin another owner approved')
{
  const peerRedirect = await run({ op: 'open', url: `${redirB.origin}/to-a` }, peer)
  check('peer owner redirecting to A still gets the unapproved ask warning', peerRedirect.outcome === 'succeeded' && peerRedirect.result.includes(`landed on ${destA.origin}`) && peerRedirect.result.includes('a redirect crossed origins — acts there will ask'), peerRedirect.result)
  check('peer owner is not granted A by redirect or by lead', !sessions.originApproved(ownerOf(peer), destA.origin), `peerApproved=${sessions.originApproved(ownerOf(peer), destA.origin)}`)
  const peerAct = await permission({ op: 'click', selector: '#act' }, peer)
  check('peer owner acting on A still asks', peerAct.behavior === 'ask', JSON.stringify(peerAct))
  check('lead owner keeps its grant for A', sessions.originApproved(ownerOf(lead), destA.origin))
}

await finish('prove-browser-redirect-note', [lead, peer])
