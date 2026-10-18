import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const root = resolve(process.argv[2] ?? join(import.meta.dir, '../..'))
const home = mkdtempSync(join(tmpdir(), 'openrouter-cache-policy-'))
process.env.MERCURY_CONFIG_DIR = home
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.BROWSER = '/usr/bin/true'
delete process.env.MERCURY_HOME
const load = (file: string): Promise<any> => import(join(root, file))
const { enableConfigs } = await load('src/utils/config.ts'); enableConfigs()
const { openrouterLaneProfile } = await load('src/services/providers/openrouter/openrouterCallModel.ts')
const { openrouterResponsesTransport } = await load('src/services/providers/openrouter/openrouterResponsesTransport.ts')
const { createUserMessage } = await load('src/utils/messages.ts')
let failed=0
const check=(label:string,yes:boolean):void=>{if(!yes)failed++;console.log(`[${yes?'PASS':'FAIL'}] ${label}`)}
const captured:any[]=[]
const server=Bun.serve({hostname:'127.0.0.1',port:0,async fetch(req){
  const body=await req.json() as any; captured.push(body)
  const responses=new URL(req.url).pathname.endsWith('/responses')
  const events=responses?[{type:'response.created',response:{id:randomUUID(),model:body.model}},{type:'response.output_text.delta',delta:'done'},{type:'response.completed',response:{usage:{input_tokens:20,output_tokens:1}}}]:[{choices:[{delta:{content:'done'}}]},{choices:[{delta:{},finish_reason:'stop'}],usage:{prompt_tokens:20,completion_tokens:1}}]
  return new Response(events.map(e=>`data: ${JSON.stringify(e)}\n\n`).join('')+'data: [DONE]\n\n',{headers:{'content-type':'text/event-stream'}})
}})
function options(model:string,responses:boolean):any{return {url:`http://127.0.0.1:${server.port}/chat/completions`,request:{model,messages:[{role:'system',content:[{type:'text',text:'first system'},{type:'text',text:'last system'}]},{role:'user',content:'tail'}],tools:[{type:'function',function:{name:'Fixture',parameters:{type:'object',properties:{}}}}]},...(responses?{deferral:{form:'openrouter-native',deferredNames:new Set(),imagesSupported:false,cacheDomainKey:'fixture-domain'}}:{})}}
try{
  for(const model of ['anthropic/claude-fable-5-1','qwen/qwen3-coder-plus','qwen/qwen3.5-plus-02-15','google/gemini-4-argon-high','openai/gpt-6-astra']){
    const opt=options(model,false); const before=JSON.stringify(opt.request)
    const transport=openrouterLaneProfile.streamTransport(opt,[])
    if(transport!==undefined)for await(const _ of transport.events){}
    else {const {streamCompatChat}=await load('src/services/providers/openaicompat/compatChatClient.ts'); for await(const _ of streamCompatChat(opt)){} }
    const body=captured.at(-1); const count=(JSON.stringify(body).match(/cache_control/g)??[]).length
    const allowed=model.startsWith('anthropic/')?4:model==='qwen/qwen3-coder-plus'?2:0
    check(model+' chat receives exactly its documented breakpoints',count===allowed)
    check(model+' chat retains the source request without mutation',JSON.stringify(opt.request)===before)
    const flatten=(c:any):string=>typeof c==='string'?c:c.map((p:any)=>p.text??'').join('')
    check(model+' chat keeps system and conversation text unchanged',body.messages.map((m:any)=>flatten(m.content)).join('|')==='first systemlast system|tail')
  }
  console.log('\nrefusals and Responses road')
  {
    const opt=options('anthropic/claude-fable-5-1',false)
    opt.request.messages=[
      {role:'system',content:[{type:'text',text:''},{type:'text',text:'stable system'}]},
      {role:'user',content:'cacheable user tail'},
      {role:'assistant',content:'',reasoning_content:'thought only'},
    ]
    const transport=openrouterLaneProfile.streamTransport(opt,[])
    if(transport!==undefined)for await(const _ of transport.events){}
    else {const {streamCompatChat}=await load('src/services/providers/openaicompat/compatChatClient.ts'); for await(const _ of streamCompatChat(opt)){} }
    const body=captured.at(-1)
    const sysParts=Array.isArray(body?.messages?.[0]?.content)?body.messages[0].content:[]
    const userParts=Array.isArray(body?.messages?.[1]?.content)?body.messages[1].content:[]
    check('empty text blocks never receive cache_control',sysParts[0]?.cache_control===undefined&&sysParts[1]?.cache_control?.type==='ephemeral')
    check('tail breakpoint skips a trailing empty-content message to mark the last cacheable message',userParts[0]?.cache_control?.type==='ephemeral')
  }
  for(const model of ['anthropic/claude-fable-5-1','qwen/qwen3-coder-plus','google/gemini-4-argon-high','openai/gpt-6-astra']){
    const opt=options(model,true); opt.request.messages[0].content='stable instructions'
    const transport=openrouterResponsesTransport(opt,[createUserMessage({content:'tail'})])
    for await(const _ of transport.events){}
    const body=captured.at(-1)
    check(model+' Responses carries only the documented automatic control',model.startsWith('anthropic/')?JSON.stringify(body.cache_control)==='{"type":"ephemeral"}':body.cache_control===undefined)
    check(model+' Responses has no per-block cache_control',!JSON.stringify(body.input).includes('cache_control'))
    check(model+' Responses keeps instructions and tool declarations',body.instructions==='stable instructions'&&body.tools.some((t:any)=>t.name==='Fixture')&&body.tools.some((t:any)=>t.type==='openrouter:tool_search'))
  }
}finally{server.stop(true);rmSync(home,{recursive:true,force:true})}
console.log(`${failed?'FAIL':'PASS'} openrouter-cache-policy: ${failed} failed`)
process.exit(failed?1:0)
