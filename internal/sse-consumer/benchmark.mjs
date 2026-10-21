import { pathToFileURL } from 'node:url'
const [file, sizeArg, chunkArg] = process.argv.slice(2)
const { readSSE } = await import(pathToFileURL(file).href)
const size = Number(sizeArg), chunkSize = Number(chunkArg)
const bytes = new TextEncoder().encode('data: ' + 'x'.repeat(size) + '\n\n')
let offset=0
const response = new Response(new ReadableStream({pull(controller) {
 if(offset===bytes.length) {controller.close();return}
 const end=Math.min(offset+chunkSize,bytes.length)
 controller.enqueue(bytes.subarray(offset,end));offset=end
}}))
const start=performance.now()
let eventLoopDelay=0
const timer=new Promise(resolve=>setTimeout(()=>{eventLoopDelay=performance.now()-start;resolve()},0))
let received=0
for await(const event of readSSE(response)) received+=event.data.length
const elapsed=performance.now()-start
await timer
if(received!==size) throw new Error('Data mismatch')
console.log(JSON.stringify({file,size,chunkSize,elapsedMs:Math.round(elapsed),timerDelayMs:Math.round(eventLoopDelay),peakRssKiB:process.resourceUsage().maxRSS}))
