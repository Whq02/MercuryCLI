import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'

export function boxFixture(parent) {
  const home = mkdtempSync(join(parent, 'box-fixture-'))
  const bin = join(home, 'bin')
  mkdirSync(bin)
  const registry = join(home, 'service.json')
  const server = join(bin, 'llama-server')
  writeFileSync(server, `#!/usr/bin/env node
import { createServer } from 'node:http'
const arg=(key)=>process.argv[process.argv.indexOf(key)+1]
if(process.argv.includes('--version')) {console.log('fixture-llama');process.exit(0)}
const model=arg('--alias'), slots=Number(arg('--parallel')), window=Number(arg('--ctx-size'))/slots
createServer(async(req,res)=>{
 const path=new URL(req.url,'http://localhost').pathname
 const json=x=>{res.setHeader('content-type','application/json');res.end(JSON.stringify(x))}
 if(path==='/v1/models') return json({data:[{id:model,owned_by:'llamacpp'}]})
 if(path==='/props') return json({default_generation_settings:{n_ctx:window},total_slots:slots})
 if(path==='/slots') return json(Array.from({length:slots},(_,id)=>({id,is_processing:false, timings:{predicted_per_second:9.5}})))
 if(path==='/health') return json({status:'ok'})
 if(path==='/v1/chat/completions') { for await(const part of req){}; res.setHeader('content-type','text/event-stream');res.end('data: '+JSON.stringify({model,choices:[{index:0,delta:{content:'BOX-FIXTURE-READY'},finish_reason:null}]})+'\\n\\ndata: '+JSON.stringify({model,choices:[{index:0,delta:{},finish_reason:'stop'}],usage:{prompt_tokens:20,completion_tokens:4}})+'\\n\\ndata: [DONE]\\n\\n');return }
 res.statusCode=404;res.end('fixture not found')
}).listen(Number(arg('--port')),'127.0.0.1')
`, { mode: 0o700 })
  writeFileSync(join(bin, 'launchctl'), `#!/usr/bin/env node
import {readFileSync,writeFileSync,existsSync,unlinkSync,openSync} from 'node:fs'
import {spawn} from 'node:child_process'
const args=process.argv.slice(2), action=args[0]
const label=action==='bootstrap'?readFileSync(args[2],'utf8').split('<key>Label</key><string>')[1].split('</string>')[0]:args.at(-1).split('/').at(-1)
const path=${JSON.stringify(registry)}+'.'+label
const read=()=>{try{return JSON.parse(readFileSync(path,'utf8'))}catch{return {}}}
const alive=p=>{try{process.kill(p,0);return true}catch{return false}}
const stop=()=>{const r=read();if(r.pid&&alive(r.pid))process.kill(r.pid,'SIGTERM');try{unlinkSync(path)}catch{}}
if(action==='enable'||action==='disable')process.exit(0)
if(action==='print'){const r=read();if(r.pid&&alive(r.pid)){console.log('state = running');process.exit(0)}process.exit(1)}
if(action==='bootout'){stop();process.exit(0)}
const unit=action==='bootstrap'?args[2]:read().unit
if(!unit)throw new Error('fixture has no unit')
const xml=readFileSync(unit,'utf8'), decode=s=>s.replaceAll('&amp;','&').replaceAll('&lt;','<').replaceAll('&gt;','>').replaceAll('&quot;','"').replaceAll('&apos;',"'")
const script=decode(xml.split('<array><string>/bin/sh</string><string>')[1].split('</string>')[0])
const log=decode(xml.split('<key>StandardOutPath</key><string>')[1].split('</string>')[0])
stop()
const fd=openSync(log,'a'), child=spawn('/bin/sh',[script],{stdio:['ignore',fd,fd],detached:true,env:process.env})
writeFileSync(path,JSON.stringify({pid:child.pid,unit}));child.unref()
`, { mode: 0o700 })
  writeFileSync(join(bin, 'ssh'), `#!/usr/bin/env node
import {createServer,connect} from 'node:net'
if(!process.argv.includes('fixture.invalid')) throw new Error('No real SSH in a proof')
const spec=process.argv[process.argv.indexOf('-L')+1].split(':')
createServer(client=>{const remote=connect(Number(spec[3]),spec[2]);client.pipe(remote).pipe(client);remote.on('error',()=>client.destroy());client.on('error',()=>remote.destroy())}).listen(Number(spec[1]),spec[0])
`, {mode:0o700})
  const bank = join(home, 'bank')
  mkdirSync(bank)
  const content = 'a fixture weight file, never a downloaded model'
  writeFileSync(join(bank, 'model.gguf'), content)
  writeFileSync(join(bank, 'SHA256SUMS'), createHash('sha256').update(content).digest('hex') + '  model.gguf\n')
  const env = { ...process.env, HOME: home, PATH: bin + ':' + process.env.PATH }
  const commands = []
  const runner = {
    run(command, args, signal, timeout = 30000) {
      commands.push({ command, args })
      if (command === 'ssh') {
        if (!args.includes('fixture.invalid')) throw new Error('A proof cannot SSH to a real computer')
        command = '/bin/sh'; args = ['-c', args.at(-1)]
      }
      return new Promise((resolve, reject) => {
        const child = spawn(command, args, { env, signal, stdio: ['ignore','pipe','pipe'] })
        let output = ''
        const timer = setTimeout(()=>child.kill(),timeout)
        child.stdout.on('data',d=>output+=d); child.stderr.on('data',d=>output+=d)
        child.on('error',reject);child.on('exit',code=>{clearTimeout(timer);code===0?resolve(output):reject(new Error('fixture command exited '+code+' '+output))})
      })
    },
    tunnel() { throw new Error('Use the SSH forwarder fixture for tunnels') },
  }
  return { home, bank, bin, server, env, commands, runner,
    async close() {
      for (const file of readdirSync(home).filter(name => name.startsWith('service.json.'))) { const row=JSON.parse(readFileSync(join(home,file),'utf8')); try { process.kill(row.pid,'SIGTERM') } catch {} }
      rmSync(home,{recursive:true,force:true})
    },
  }
}
