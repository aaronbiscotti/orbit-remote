/* global orbit, VideoDecoder, EncodedVideoChunk, AudioDecoder, EncodedAudioChunk */
// Decode directly into Orbit's existing canvas; never buffer a movie-sized queue.
class OrbitVideo {
 constructor(canvas, callbacks, codec) {
  this.selectedCodec=codec;this.visible=true;
  this.canvas=canvas;this.ctx=canvas.getContext('2d',{alpha:false,desynchronized:true});this.callbacks=callbacks;
  this.pending=new Map();this.received=0;this.rendered=0;this.started=performance.now();this.needKey=true;
  this.unsubscribe=orbit.onVideoPacket((meta,data)=>this.packet(meta,data));
  this.unstatus=orbit.onVideoStatus(status=>{if(status.type==='network')this.network=status;if(status.type==='error')callbacks.error(status.message||`Video connection failed (${status.code})`);});
  this.timer=setInterval(()=>this.stats(),2000);
  this.audioContext=new AudioContext({sampleRate:48000,latencyHint:'interactive'});
  this.audioContext.resume().catch(()=>{});
  this.audioDecoder=new AudioDecoder({output:frame=>this.playAudio(frame),error:()=>{}});
  this.audioDecoder.configure({codec:'opus',sampleRate:48000,numberOfChannels:2});
 }
 codec(bytes){
  // Moonlight supplies Annex B including SPS/PPS with every IDR.
  for(let i=0;i<bytes.length-7;i++){
   let start=-1;
   if(bytes[i]===0&&bytes[i+1]===0&&bytes[i+2]===1)start=i+3;
   else if(bytes[i]===0&&bytes[i+1]===0&&bytes[i+2]===0&&bytes[i+3]===1)start=i+4;
   if(start>=0&&(bytes[start]&31)===7)return 'avc1.'+[bytes[start+1],bytes[start+2],bytes[start+3]].map(n=>n.toString(16).padStart(2,'0')).join('');
  }
  throw new Error('The video keyframe is missing its H.264 configuration.');
 }
 packet(meta,data){
  if(this.closed)return;
  if(!this.visible){if(meta.kind===1)orbit.ackVideo(meta.id);return;}
  if(meta.kind===2){
   if(this.audioDecoder.state==='configured'&&this.audioDecoder.decodeQueueSize<15)this.audioDecoder.decode(new EncodedAudioChunk({type:'key',timestamp:meta.timestamp,data}));
   return;
  }
  if(meta.kind!==1)return;
  this.received++;
  if(this.needKey&&!meta.key){orbit.ackVideo(meta.id);return;}
  try {
   if(!this.decoder){
    const codec=this.selectedCodec==='hevc'?'hev1.1.6.L153.B0':this.codec(data);
    this.decoder=new VideoDecoder({output:frame=>this.draw(frame),error:error=>this.recover(error)});
    this.config={codec,hardwareAcceleration:'prefer-hardware',optimizeForLatency:true};
    this.decoder.configure(this.config);
   }
   if(this.decoder.decodeQueueSize>(this.hasFrame?3:20)){this.recover();orbit.ackVideo(meta.id);return;}
   this.needKey=false;
   this.pending.set(meta.timestamp,{...meta,arrived:performance.now()});
   this.decoder.decode(new EncodedVideoChunk({type:meta.key?'key':'delta',timestamp:meta.timestamp,data}));
  }catch(error){orbit.ackVideo(meta.id);this.recover(error);}
 }
 draw(frame){
  const meta=this.pending.get(frame.timestamp);this.pending.delete(frame.timestamp);
  try{
   if(this.closed)return;
   if(this.canvas.width!==frame.displayWidth||this.canvas.height!==frame.displayHeight){this.canvas.width=frame.displayWidth;this.canvas.height=frame.displayHeight;}
   this.ctx.drawImage(frame,0,0);this.rendered++;this.hasFrame=true;
   this.decodeTime=meta?performance.now()-meta.arrived:0;this.hostLatency=meta?.hostLatency||0;
   this.callbacks.frame(frame.displayWidth,frame.displayHeight);
  }finally{frame.close();if(meta)orbit.ackVideo(meta.id);}
 }
 recover(error){
  for(const meta of this.pending.values())orbit.ackVideo(meta.id);this.pending.clear();
  if(this.decoder&&this.decoder.state!=='closed')this.decoder.close();this.decoder=null;this.needKey=true;orbit.requestVideoKeyframe();
  if(error){this.errors=(this.errors||0)+1;if(this.errors===1||this.errors%120===0)this.callbacks.error(error.message||'Video decoding failed');}
 }
 playAudio(frame){
  try{
   if(this.closed||this.audioContext.state!=='running')return;
   const now=this.audioContext.currentTime;
   if(!this.audioAt||this.audioAt<now||this.audioAt>now+.15)this.audioAt=now+.025;
   const buffer=this.audioContext.createBuffer(frame.numberOfChannels,frame.numberOfFrames,frame.sampleRate);
   for(let channel=0;channel<frame.numberOfChannels;channel++)frame.copyTo(buffer.getChannelData(channel),{planeIndex:channel,format:'f32-planar'});
   const source=this.audioContext.createBufferSource();source.buffer=buffer;source.connect(this.audioContext.destination);source.start(this.audioAt);this.audioAt+=buffer.duration;
  }finally{frame.close();}
 }
 stats(){
  const now=performance.now(),seconds=(now-this.started)/1000;
  if(!this.visible){this.started=now;this.received=0;this.rendered=0;return;}
  const stats={receivedFps:Math.round(this.received/seconds),renderedFps:Math.round(this.rendered/seconds),networkMs:this.network?.rtt||0,jitterMs:this.network?.variance||0,decodeMs:Math.round((this.decodeTime||0)*10)/10,hostMs:this.hostLatency||0};
  this.callbacks.stats(stats);orbit.videoMetrics(stats);this.started=now;this.received=0;this.rendered=0;
 }
 setVisible(visible){
  if(this.visible===visible)return;
  this.visible=visible;
  if(!visible){
   for(const meta of this.pending.values())orbit.ackVideo(meta.id);this.pending.clear();
   if(this.decoder&&this.decoder.state!=='closed')this.decoder.close();this.decoder=null;this.needKey=true;
   this.audioContext.suspend();
  }else{this.audioAt=0;this.audioContext.resume();orbit.requestVideoKeyframe();}
 }
 close(){
  this.closed=true;clearInterval(this.timer);this.unsubscribe();this.unstatus();
  for(const meta of this.pending.values())orbit.ackVideo(meta.id);this.pending.clear();
  if(this.decoder&&this.decoder.state!=='closed')this.decoder.close();
  if(this.audioDecoder.state!=='closed')this.audioDecoder.close();
  this.audioContext.close();
 }
}
window.OrbitVideo=OrbitVideo;
