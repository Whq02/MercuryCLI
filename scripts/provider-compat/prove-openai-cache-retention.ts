import { mkdtempSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const root=resolve(process.argv[2]??join(import.meta.dir,'../..'))
const home=mkdtempSync(join(tmpdir(),'openai-retention-'))
process.env.MERCURY_CONFIG_DIR=home
process.env.MERCURY_CREDENTIAL_STORE='file'
process.env.MERCURY_LOCAL_PROBE_TARGETS='none'
process.env.OPENAI_API_KEY='sk-fixture-retention-key'
process.env.BROWSER='/usr/bin/true'
delete process.env.MERCURY_HOME
let mode='accept'
const requests:any[]=[]
const server=Bun.serve({hostname:'127.0.0.1',port:0,async fetch(req){
 if(req.method==='GET')return Response.json({data:['gpt-5.5','gpt-5.6-sol'].map(id=>({id,supported_reasoning_levels:['low','medium','high','max'],visibility:'list',supported_in_api:true,context_window:200000}))})
 const body=await req.json() as any;requests.push(body)
 if(mode==='unrelated')return Response.json({error:{message:'Invalid unrelated field',code:'invalid_request_error'}},{status:400})
 if(mode==='reject'&&body.prompt_cache_retention!==undefined)return Response.json({error:{message:'Unsupported parameter prompt_cache_retention',param:'prompt_cache_retention',code:'invalid_request_error'}},{status:400})
 const events=[{type:'response.created',response:{id:randomUUID(),model:body.model}},{type:'response.output_text.delta',delta:'complete'},{type:'response.completed',response:{usage:{input_tokens:20,output_tokens:3,input_tokens_details:{cached_tokens:10}}}}]
 return new Response(events.map(e=>`data: ${JSON.stringify(e)}\n\n`).join(''),{headers:{'content-type':'text/event-stream'}})
}})
process.env.MERCURY_OPENAI_API_BASE=`http://127.0.0.1:${server.port}/v1`
const load=(p:string):Promise<any>=>import(join(root,p))
const {enableConfigs}=await load('src/utils/config.ts');enableConfigs()
const {openaiCallModel}=await load('src/services/providers/openai/openaiCallModel.ts')
const {asSystemPrompt}=await load('src/utils/systemPromptType.ts')
const {getEmptyToolPermissionContext}=await load('src/Tool.ts')
let failed=0
const check=(label:string,yes:boolean):void=>{if(!yes)failed++;console.log(`[${yes?'PASS':'FAIL'}] ${label}`)}
async function run(model:string):Promise<any[]>{const rows:any[]=[];for await(const row of openaiCallModel({messages:[{type:'user',uuid:randomUUID(),message:{role:'user',content:'answer complete'}}],systemPrompt:asSystemPrompt(['stable instructions']),tools:[],thinkingConfig:{type:'adaptive'},signal:new AbortController().signal,options:{model,querySource:'main_thread',isNonInteractiveSession:true,getToolPermissionContext:async()=>getEmptyToolPermissionContext(),agents:[],mcpTools:[],hasAppendSystemPrompt:false,effortValue:'high'}}))rows.push(row);return rows}
try{
 await run('gpt-5.5')
 check('a documented API-key model requests 24h retention',requests.at(-1)?.prompt_cache_retention==='24h')
 await run('gpt-5.6-sol')
 check('a model whose page lists another cache policy receives no 24h field',requests.at(-1)?.prompt_cache_retention===undefined)
 mode='reject';const before=requests.length;const result=await run('gpt-5.5');await run('gpt-5.5');const retry=requests.slice(before)
 check('a field refusal retries once and is remembered per model',retry.length===3&&retry[0].prompt_cache_retention==='24h'&&retry.slice(1).every(b=>b.prompt_cache_retention===undefined))
 check('the refused field costs no answer or usage',result.some(row=>row.type==='assistant'&&!row.isApiErrorMessage&&row.message.usage.output_tokens===3))
 if(retry.length>1){const {prompt_cache_retention,...first}=retry[0];check('the retry keeps every other request byte',JSON.stringify(first)===JSON.stringify(retry[1]))}
 console.log('\nrefusals')
 mode='unrelated';const unrelated=requests.length;await run('gpt-5.6-sol');check('an unrelated400 is not swallowed as a cache retry',requests.length===unrelated+1)
 const policy=await load('src/services/providers/openai/openaiCacheRetention.ts').catch(()=>null)
 check('retention policy is available for account-source controls',policy!==null)
 if(policy!==null){
  check('the subscription road receives no retention field',Object.keys(policy.openaiCacheRetention('gpt-5.5','chatgpt-subscription')).length===0)
  check('an unknown model and undocumented snapshot id receive no field',Object.keys(policy.openaiCacheRetention('gpt-unknown','api-key')).length===0&&Object.keys(policy.openaiCacheRetention('gpt-5.5-unknown-date','api-key')).length===0)
  check('one model refusal never disables another supported model',policy.openaiCacheRetention('gpt-4.1','api-key').prompt_cache_retention==='24h')
  check('a stream fault after content is not a cache-field retry', !policy.rejectOpenaiCacheRetention('gpt-4.1', { kind: 'response-failed', status: 400, message: 'prompt_cache_retention' }))
 }
}finally{server.stop(true);rmSync(home,{recursive:true,force:true})}
console.log(`${failed?'FAIL':'PASS'} openai-cache-retention: ${failed} failed`)
process.exit(failed?1:0)
