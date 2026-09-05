#!/usr/bin/env node
import { appendFileSync, copyFileSync } from 'node:fs'

const args = process.argv.slice(2)
if (process.env.GH_SHIM_LOG) appendFileSync(process.env.GH_SHIM_LOG, `gh ${args.join(' ')}\n`)

const verb = args[0]
if (verb === 'auth') {
  if ((process.env.GH_SHIM_AUTH ?? 'ok') === 'ok') {
    console.log('Logged in to github.com account fixture')
    process.exit(0)
  }
  console.error('You are not logged into any GitHub hosts.')
  process.exit(1)
}
if (verb === 'repo' && args[1] === 'view') {
  if ((process.env.GH_SHIM_REPO_ACCESS ?? 'ok') !== 'ok') {
    console.error('GraphQL: Could not resolve to a Repository with the name given.')
    process.exit(1)
  }
  console.log('{"name":"fixture"}')
  process.exit(0)
}
if (verb === 'issue' && args[1] === 'create') {
  const at = args.indexOf('--body-file')
  if (at !== -1 && process.env.GH_SHIM_BODY_OUT) copyFileSync(args[at + 1], process.env.GH_SHIM_BODY_OUT)
  console.log(process.env.GH_SHIM_ISSUE_URL ?? 'https://github.com/example/fixture/issues/1')
  process.exit(0)
}
console.error(`unexpected gh verb: ${verb ?? '(none)'}`)
process.exit(1)
