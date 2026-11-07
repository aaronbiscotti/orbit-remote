// GPL-3.0-only. Sunshine HTTPS session control + Moonlight native transport.
const fs = require('fs');
const path = require('path');
const https = require('https');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { EventEmitter } = require('events');
function xml(text, tag) {
 const value = text.match(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`))?.[1] || '';
 return value.replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"');
}
function request(host, port, identity, serverCertificate, endpoint, params={}) {
 return new Promise((resolve,reject) => {
  const expected = new crypto.X509Certificate(serverCertificate).fingerprint256;
  const query = new URLSearchParams({uniqueid:identity.uniqueid,uuid:crypto.randomUUID().replaceAll('-',''),...params});
  const req = https.request({host,port,method:'GET',path:`/${endpoint}?${query}`,cert:identity.certificate,key:identity.key,rejectUnauthorized:false,agent:false},res=>{
   let body='';res.setEncoding('utf8');res.on('data',c=>{body+=c;if(body.length>2e6)req.destroy(new Error('Oversized Sunshine response'));});
   res.on('end',()=>{const status=body.match(/status_code="(\d+)"/)?.[1];if(res.statusCode!==200||(status&&status!=='200'))reject(new Error(`Sunshine ${endpoint} failed (${status||res.statusCode})`));else resolve(body);});
  });
  req.on('socket',socket=>socket.once('secureConnect',()=>{
   if(socket.getPeerCertificate().fingerprint256!==expected)req.destroy(new Error('Video host certificate changed. Pair this PC again.'));
   else req.end();
  }));
  req.setTimeout(7000,()=>req.destroy(new Error('Video host connection timed out')));req.on('error',reject);
 });
}
class VideoSession extends EventEmitter {
 constructor({helper,identityPath,profile}) {super();this.helper=helper;this.identityPath=identityPath;this.profile=profile;this.pending=new Set();this.closed=false;this.buffer=Buffer.alloc(0);this.waitingKey=false;}
 async start(){
  if(!fs.existsSync(this.helper))throw new Error('Orbit video engine is missing. Reinstall the GPU-enabled Electron build.');
  const identity=JSON.parse(fs.readFileSync(this.identityPath,'utf8'));
  const p=this.profile;let info;let host=p.host;
  try {info=await request(host,p.port-5,identity,p.serverCertificate,'serverinfo');}
  catch(error){if(!p.fallbackHost||error.message.includes('certificate'))throw error;host=p.fallbackHost;info=await request(host,p.port-5,identity,p.serverCertificate,'serverinfo');}
  if(this.closed)return;
  const key=crypto.randomBytes(16),iv=Buffer.alloc(16);crypto.randomBytes(4).copy(iv);
  const width=p.width||1920,height=p.height||1080,fps=p.fps||120;
  const bitrate=Math.max(5000,Math.min(60000,p.bitrate||15000));
  const active=Number(xml(info,'currentgame'));
  const response=await request(host,p.port-5,identity,p.serverCertificate,active?'resume':'launch',{
   appid:String(p.appId),mode:`${width}x${height}x${fps}`,additionalStates:'1',sops:'0',rikey:key.toString('hex'),rikeyid:String(iv.readInt32BE()),localAudioPlayMode:'1',surroundAudioInfo:'196610',remoteControllersBitmap:'0',gcmap:'0',gcpersist:'0',corever:'1'});
  const url=xml(response,'sessionUrl0');if(!url)throw new Error('Sunshine did not return a video session.');
  if(this.closed)return;
  const child=this.child=spawn(this.helper,[],{stdio:['pipe','pipe','pipe']});
  child.on('error',err=>this.emit('failure',err.message));
  child.on('exit',code=>{clearInterval(this.timer);if(!this.closed)this.emit('failure',`Video engine stopped (${code}). Reconnect to try again.`);});
  child.stdin.on('error',()=>{});
  child.stdout.on('data',chunk=>this.consume(chunk));
  let stderr='';child.stderr.setEncoding('utf8');child.stderr.on('data',chunk=>{
   stderr+=chunk;let n;while((n=stderr.indexOf('\n'))>=0){const line=stderr.slice(0,n);stderr=stderr.slice(n+1);if(line.startsWith('{')){try{const msg=JSON.parse(line);this.emit('status',msg);if(msg.type==='terminated'||msg.type==='error'){this.emit('failure',`Video connection stopped (${msg.code}). Disconnect and reconnect to try again.`);this.stop();}}catch{}}}
   if(stderr.length>8192)stderr='';
  });
  const lines=[host,xml(info,'appversion'),xml(info,'GfeVersion'),url,key.toString('hex'),iv.toString('hex'),`${width} ${height} ${fps} ${bitrate} ${Number(xml(info,'ServerCodecModeSupport'))||1} ${p.codec==='hevc'?256:1}`];
  if(lines.some(x=>/[\r\n]/.test(x)))throw new Error('Invalid video session response');
  child.stdin.write(lines.join('\n')+'\n');
  this.timer=setInterval(()=>this.command('T'),1000);
  return {width,height,fps,bitrate,host,codec:p.codec==='hevc'?'HEVC':'H.264'};
 }
 consume(chunk){
  this.buffer=Buffer.concat([this.buffer,chunk]);
  while(this.buffer.length>=32){
   const length=this.buffer.readUInt32LE(4);if(length>16*1024*1024){this.emit('failure','Invalid video frame size');this.stop();return;}
   if(this.buffer.length<32+length)return;
   const b=this.buffer;this.buffer=b.subarray(32+length);
   const kind=b.readUInt32LE(0),id=b.readUInt32LE(8),key=Boolean(b.readUInt32LE(12));
   const meta={kind,id,key,timestamp:Number(b.readBigUInt64LE(16)),hostLatency:b.readUInt32LE(24)/10};
   if(kind===1){
    if(this.pending.size>=8){this.waitingKey=true;this.requestKey();continue;}
    if(this.waitingKey&&!key){this.requestKey();continue;}
    this.waitingKey=false;this.pending.add(id);
   }
   this.emit('packet',meta,b.subarray(32,32+length));
  }
 }
 requestKey(){if(!this.lastKeyRequest||Date.now()-this.lastKeyRequest>200){this.command('I');this.lastKeyRequest=Date.now();}}
 ack(id){this.pending.delete(id);if(this.waitingKey)this.requestKey();}
 selectMonitor(index){
  const mapped = this.profile.monitorMap?.[String(index)];
  if(!Number.isInteger(mapped)||mapped<0||mapped>11)throw new Error('GPU capture is not configured for this display.');
  // Sunshine consumes Ctrl+Alt+Shift+Fn to switch its capture output.
  for(const line of ['K 16 1 1','K 17 1 3','K 18 1 7',`K ${112+mapped} 1 7`,`K ${112+mapped} 0 7`,'K 18 0 3','K 17 0 1','K 16 0 0'])this.command(line);
 }
 command(line){if(this.child&&!this.closed&&this.child.stdin.writable)this.child.stdin.write(line+'\n');}
 input(p){
  const n=(v,min,max)=>Math.round(Math.max(min,Math.min(max,Number(v)||0)));
  if(p.type==='mouse'){
   if(p.action==='move'||p.action==='down'||p.action==='up')this.command(`M ${n(p.x*32766,0,32766)} ${n(p.y*32766,0,32766)} 32767 32767`);
   if(p.action==='down'||p.action==='up'||p.action==='release')this.command(`B ${p.action==='down'?1:0} ${{left:1,middle:2,right:3}[p.button]||1}`);
   if(p.action==='wheel')this.command(`W ${n(p.deltaY,-32768,32767)} 0`);
   if(p.action==='relative')this.command(`R ${n(p.dx,-32768,32767)} ${n(p.dy,-32768,32767)}`);
  }else if(p.type==='key')this.command(`K ${n(p.vk,0,255)} ${p.action==='down'?1:0} ${n(p.modifiers,0,7)}`);
 }
 stop(){this.closed=true;clearInterval(this.timer);this.pending.clear();if(this.child){const c=this.child;if(c.stdin.writable)c.stdin.end('Q\n');const timer=setTimeout(()=>c.kill('SIGKILL'),2000);c.once('exit',()=>clearTimeout(timer));this.child=null;}}
}
module.exports={VideoSession,xml,request};
