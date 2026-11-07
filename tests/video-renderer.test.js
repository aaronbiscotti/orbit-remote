const {test}=require('node:test');const assert=require('node:assert/strict');const vm=require('node:vm');const fs=require('node:fs');
function setup(){
 const ack=[],events={},requests=[];
 class Decoder{constructor(callbacks){this.callbacks=callbacks;this.state='unconfigured';this.decodeQueueSize=0;}configure(config){this.config=config;this.state='configured';}decode(chunk){requests.push(chunk);}close(){this.state='closed';}}
 class AudioContext{constructor(){this.state='running';}resume(){this.state='running';return Promise.resolve();}suspend(){this.state='suspended';return Promise.resolve();}close(){return Promise.resolve();}}
 const context={window:{},performance:{now:()=>1000},setInterval:()=>1,clearInterval:()=>{},VideoDecoder:Decoder,AudioDecoder:Decoder,AudioContext,EncodedVideoChunk:class{constructor(v){Object.assign(this,v)}},EncodedAudioChunk:class{},orbit:{onVideoPacket:f=>(events.packet=f,()=>{}),onVideoStatus:f=>(events.status=f,()=>{}),ackVideo:id=>ack.push(id),requestVideoKeyframe:()=>ack.push('IDR'),videoMetrics:()=>{}}};
 vm.runInNewContext(fs.readFileSync(require.resolve('../electron/video-renderer.js'),'utf8'),context);
 const v=new context.window.OrbitVideo({getContext:()=>({drawImage(){}})},{frame(){},error(){},stats(){}},'hevc');return {v,ack,events,requests};
}
test('hidden desktops acknowledge frames without decoding, then request a keyframe on return',()=>{const {v,ack,events,requests}=setup();v.setVisible(false);events.packet({kind:1,id:1,key:true,timestamp:0},new Uint8Array([1]));assert.deepEqual(ack,[1]);assert.equal(requests.length,0);v.setVisible(true);assert.equal(ack.at(-1),'IDR');events.packet({kind:1,id:2,key:false,timestamp:1},new Uint8Array([1]));assert.equal(requests.length,0);v.close();});
test('closing a decoder releases all outstanding transport credits',()=>{const {v,ack,events,requests}=setup();events.packet({kind:1,id:7,key:true,timestamp:10},new Uint8Array([1]));assert.equal(requests.length,1);v.close();assert.deepEqual(ack,[7]);assert.equal(v.decoder.state,'closed');});
