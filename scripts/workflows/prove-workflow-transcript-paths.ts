#!/usr/bin/env bun
import { DIST, makeTally } from '../daemon/dupline-world.ts'
import { workflowStopWorld } from './workflow-stop-world.ts'

const tally = makeTally('prove-workflow-transcript-paths')
console.log(`build under proof: ${DIST}`)
const world = await workflowStopWorld()
tally.check('a real worker returns four tools before stopping', world.returned.length === 4 && world.returned.some(result => result.isError), JSON.stringify(world.returned.map(result => ({ id: result.toolUseId, error: result.isError }))))
tally.check('the workflow settles stopped', world.turn.exitCode === 0 && world.terminal?.status === 'killed' && world.stopResult?.isError === false, `${world.turn.stderr.slice(-500)}; ${world.stopResult?.text}`)
tally.check('the launch receipt names the recorded transcript directory', world.receipt.includes(`Transcript dir: ${world.terminal?.transcriptDir}\n`), world.receipt)
tally.check('the launch receipt names orchestration state separately', world.stateExists && world.receipt.includes(`Run dir: ${world.terminal?.runDir}\n`), world.receipt)
tally.check('the stop recovery names the recorded transcript directory', world.notification.includes(`Agent transcripts: ${world.terminal?.transcriptDir}`), world.notification)
tally.check('the stop recovery names orchestration state separately', world.notification.includes(`Run state: ${world.terminal?.runDir}`), world.notification)
tally.check('every advertised agent transcript resolves', world.advertised.length >= 2 && world.pathsResolve && world.transcripts.every((t: any) => t.exists), JSON.stringify({ advertised: world.advertised, actual: world.transcripts.map((t: any) => t.file) }))
tally.finish()
