import { run } from 'mercury-cli-sdk'
const outcome = await run({ prompt: 'Report the turn.' }).outcome
console.log((outcome.recoveries ?? []).map(recovery => recovery.kind))
console.log((outcome.wards ?? []).map(ward => `${ward.ward}:${ward.tool}:${ward.effect}`))
