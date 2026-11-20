#!/usr/bin/env bun
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { check, decide, fill, finish, said, section } from '../permissions/floorsKit.ts'

const SECRET_RULE = { deny: [fill('Read(/<PROJECT>/secrets/**)')] }

section('a glob segment no reader translates does not reach the denied folder')
{
  const decision = await decide('Bash', { command: "sh -c 'cat secr[e-\\f]ts/k.txt'" }, 'implement', SECRET_RULE)
  check('cat secr[e-\\f]ts/k.txt, which bash expands into the denied secrets folder, is not allowed', decision.behavior !== 'allow', said(decision))
}

section('a file URL whose path does not decode does not reach the denied folder')
{
  const decision = await decide('Bash', { command: `sh -c 'curl ${fill('file://<PROJECT>/secrets/k.txt%')}'` }, 'implement', SECRET_RULE)
  check('curl file://<project>/secrets/k.txt%, a path in the denied folder that decodeURI refuses, is not allowed', decision.behavior !== 'allow', said(decision))
}

section('pathValidation: a grep --include glob the reader cannot translate keeps the env-file ask')
{
  mkdirSync(fill('<PROJECT>/envtree'), { recursive: true })
  writeFileSync(join(fill('<PROJECT>/envtree'), '.env'), 'SECRET=CANARY-ENVTREE\n')
  const plain = await decide('Bash', { command: "grep -r --include='.env' SECRET envtree" }, 'implement')
  const odd = await decide('Bash', { command: "grep -r --include='.en[v-\\z]' SECRET envtree" }, 'implement')
  check('the plain include of .env asks first (the floor this row leans on)', plain.behavior !== 'allow', said(plain))
  check('an include of .en[v-\\z], which grep matches to .env, asks first too', odd.behavior !== 'allow', said(odd))
}

finish('prove-faults-fo04')
