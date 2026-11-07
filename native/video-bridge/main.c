// GPL-3.0-only. Orbit's stdio adapter for the pinned Moonlight transport.
// No window, credential storage, listener, or shell is exposed by this helper.
#include <Limelight.h>
#include <stdio.h>
#include <stdlib.h>
#include <stdint.h>
#include <string.h>
#include <stdarg.h>
#include <pthread.h>
#include <signal.h>
#include <unistd.h>
#include <time.h>
static pthread_mutex_t outputLock = PTHREAD_MUTEX_INITIALIZER;
static volatile sig_atomic_t stopped;
static uint64_t audioTime;
static int audioSamples;
static void put32(unsigned char* p, uint32_t n) { for(int i=0;i<4;i++) p[i]=(n>>(i*8))&255; }
static void put64(unsigned char* p, uint64_t n) { for(int i=0;i<8;i++) p[i]=(n>>(i*8))&255; }
static void header(unsigned char* b, int kind, int len, int frame, int key, uint64_t pts, int latency) {
 memset(b,0,32); put32(b,kind);put32(b+4,len);put32(b+8,frame);put32(b+12,key);put64(b+16,pts);put32(b+24,latency);
}
static void logMessage(const char* fmt, ...) { va_list ap; va_start(ap,fmt); vfprintf(stderr,fmt,ap); va_end(ap); }
static void failed(int stage,int code){fprintf(stderr,"\n{\"type\":\"error\",\"stage\":%d,\"code\":%d}\n",stage,code);}
static void terminated(int code){fprintf(stderr,"\n{\"type\":\"terminated\",\"code\":%d}\n",code);stopped=1;}
static void status(int value){fprintf(stderr,"\n{\"type\":\"connectionStatus\",\"status\":%d}\n",value);}
static int setup(int fmt,int w,int h,int fps,void* c,int flags){
 fprintf(stderr,"\n{\"type\":\"videoSetup\",\"format\":%d,\"width\":%d,\"height\":%d,\"fps\":%d}\n",fmt,w,h,fps);return 0;
}
static int video(PDECODE_UNIT du){
 if(stopped) return DR_OK;
 unsigned char b[32]; header(b,1,du->fullLength,du->frameNumber,du->frameType==FRAME_TYPE_IDR,du->presentationTimeUs,du->frameHostProcessingLatency);
 pthread_mutex_lock(&outputLock);
 int ok=fwrite(b,1,32,stdout)==32;
 for(PLENTRY p=du->bufferList;p&&ok;p=p->next) ok=fwrite(p->data,1,p->length,stdout)==(size_t)p->length;
 pthread_mutex_unlock(&outputLock);
 if(!ok)stopped=1;return DR_OK;
}
static int audioInit(int cfg,const POPUS_MULTISTREAM_CONFIGURATION op,void* c,int flags){
 audioSamples=op->samplesPerFrame;
 fprintf(stderr,"\n{\"type\":\"audioSetup\",\"rate\":%d,\"channels\":%d,\"samples\":%d}\n",op->sampleRate,op->channelCount,op->samplesPerFrame);return op->channelCount==2?0:-1;
}
static void audio(char* data,int len){
 unsigned char b[32]; header(b,2,len,0,1,audioTime,0);audioTime+=(uint64_t)audioSamples*1000000/48000;
 pthread_mutex_lock(&outputLock);fwrite(b,1,32,stdout);fwrite(data,1,len,stdout);pthread_mutex_unlock(&outputLock);
}
static void signalHandler(int sig){stopped=1;}
static int readLine(char* p,size_t n){if(!fgets(p,(int)n,stdin))return 0;p[strcspn(p,"\r\n")]=0;return 1;}
static int hex(const char* s,char* out){if(strlen(s)!=32)return 0;for(int i=0;i<16;i++){unsigned n;if(sscanf(s+2*i,"%2x",&n)!=1)return 0;out[i]=(char)n;}return 1;}
int main(void){
 setvbuf(stdout,NULL,_IONBF,0);setvbuf(stderr,NULL,_IONBF,0);signal(SIGPIPE,SIG_IGN);signal(SIGTERM,signalHandler);signal(SIGINT,signalHandler);
 char host[256],version[128],gfe[128],url[2048],key[64],iv[64],opts[128];
 if(!readLine(host,sizeof(host))||!readLine(version,sizeof(version))||!readLine(gfe,sizeof(gfe))||!readLine(url,sizeof(url))||!readLine(key,sizeof(key))||!readLine(iv,sizeof(iv))||!readLine(opts,sizeof(opts)))return 2;
 SERVER_INFORMATION si;LiInitializeServerInformation(&si);si.address=host;si.serverInfoAppVersion=version;si.serverInfoGfeVersion=gfe;si.rtspSessionUrl=url;
 STREAM_CONFIGURATION sc;LiInitializeStreamConfiguration(&sc);int codec=1;
 if(sscanf(opts,"%d %d %d %d %d %d",&sc.width,&sc.height,&sc.fps,&sc.bitrate,&si.serverCodecModeSupport,&codec)!=6)return 2;
 if(!hex(key,sc.remoteInputAesKey)||!hex(iv,sc.remoteInputAesIv))return 2;
 sc.packetSize=(!strncmp(host,"192.168.",8)||!strncmp(host,"10.",3))?1392:1024;sc.streamingRemotely=STREAM_CFG_AUTO;sc.audioConfiguration=AUDIO_CONFIGURATION_STEREO;
 sc.supportedVideoFormats=codec;sc.clientRefreshRateX100=sc.fps*100;sc.colorSpace=COLORSPACE_REC_709;sc.colorRange=COLOR_RANGE_FULL;sc.encryptionFlags=ENCFLG_ALL;
 DECODER_RENDERER_CALLBACKS dr;LiInitializeVideoCallbacks(&dr);dr.setup=setup;dr.submitDecodeUnit=video;
 AUDIO_RENDERER_CALLBACKS ar;LiInitializeAudioCallbacks(&ar);ar.init=audioInit;ar.decodeAndPlaySample=audio;ar.capabilities=CAPABILITY_SUPPORTS_ARBITRARY_AUDIO_DURATION;
 CONNECTION_LISTENER_CALLBACKS cl;LiInitializeConnectionCallbacks(&cl);cl.logMessage=logMessage;cl.stageFailed=failed;cl.connectionTerminated=terminated;cl.connectionStatusUpdate=status;
 int err=LiStartConnection(&si,&sc,&cl,&dr,&ar,NULL,0,NULL,0);if(err)return 3;
 fprintf(stderr,"\n{\"type\":\"connected\"}\n");
 char line[256];
 while(!stopped&&fgets(line,sizeof(line),stdin)){
  int a=0,b=0,c=0,d=0;
  switch(line[0]){
   case 'M': if(sscanf(line+1,"%d %d %d %d",&a,&b,&c,&d)==4)LiSendMousePositionEvent(a,b,c,d);break;
   case 'R': if(sscanf(line+1,"%d %d",&a,&b)==2)LiSendMouseMoveEvent(a,b);break;
   case 'B': if(sscanf(line+1,"%d %d",&a,&b)==2)LiSendMouseButtonEvent(a?BUTTON_ACTION_PRESS:BUTTON_ACTION_RELEASE,b);break;
   case 'K': if(sscanf(line+1,"%d %d %d",&a,&b,&c)==3)LiSendKeyboardEvent2(a,b?KEY_ACTION_DOWN:KEY_ACTION_UP,c,0);break;
   case 'W': if(sscanf(line+1,"%d %d",&a,&b)==2){LiSendHighResScrollEvent(a);LiSendHighResHScrollEvent(b);}break;
   case 'I': LiRequestIdrFrame();break;
   case 'T': {uint32_t rtt=0,var=0;LiGetEstimatedRttInfo(&rtt,&var);fprintf(stderr,"\n{\"type\":\"network\",\"rtt\":%u,\"variance\":%u}\n",rtt,var);break;}
   case 'Q': stopped=1;break;
  }
 }
 LiStopConnection();return 0;
}
