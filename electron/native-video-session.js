// The native player owns decoding, presentation, input, and its independent window.
const fs = require('node:fs');
const net = require('node:net');
const { spawn, execFile } = require('node:child_process');
const { EventEmitter } = require('node:events');
const { SUNSHINE_BASE_PORT } = require('./ports');

const MOONLIGHT_PREFS = 'com.moonlight-stream.Moonlight';
const run = (cmd, args) => new Promise((resolve, reject) =>
  execFile(cmd, args, (error, stdout) => (error ? reject(error) : resolve(stdout))));

function streamArgs(profile) {
  const clamp = (v, fallback, min, max) => Math.round(Math.max(min, Math.min(max, Number(v) || fallback)));
  const host = String(profile.host || '');
  if (!/^[a-zA-Z0-9.:-]+$/.test(host) || host.startsWith('-')) throw new Error('Invalid streaming host.');
  return ['stream', `${host}:${clamp(profile.port, SUNSHINE_BASE_PORT, 1, 65535)}`, 'Desktop',
    '--resolution', `${clamp(profile.width,1920,640,3840)}x${clamp(profile.height,1080,480,2160)}`,
    '--fps', String(clamp(profile.fps,120,30,120)), '--bitrate', String(clamp(profile.bitrate,10000,3000,40000)),
    // Full screen lets macOS show frames without compositing the window first. Not 'borderless': that is a macOS
    // full-screen Space, where macOS 26 can report wrong pointer positions along the top edge (see SDL's mouseMoved).
    '--display-mode', 'fullscreen', '--video-codec', 'HEVC', '--video-decoder', 'hardware',
    '--absolute-mouse', '--no-vsync', '--no-frame-pacing', '--no-game-optimization',
    '--no-quit-after', '--capture-system-keys', 'fullscreen', '--no-hdr', '--no-yuv444'];
}

// True if something answers on host:port quickly. The PC's home-network address only answers at home.
function reachable(host, port, ms = 300) {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port, timeout: ms });
    const done = (ok) => { socket.destroy(); resolve(ok); };
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
  });
}

// Moonlight tries each PC's saved "local" address first, so store the route Orbit picked there.
// Also stop macOS 26 from handing Moonlight 6.2.0 the mouse only once per screen refresh (~150 updates/s).
// shortcut: remove the NSApplicationUpdateCycleEnabled write once a Moonlight release after 6.2.0 sets it itself.
async function prepareMoonlight(address, knownAddresses, exec) {
  await exec('defaults', ['write', MOONLIGHT_PREFS, 'NSApplicationUpdateCycleEnabled', '-bool', 'false']);
  const prefs = await exec('defaults', ['export', MOONLIGHT_PREFS, '-']);
  const saved = /<key>hosts\.(\d+)\.(?:local|manual|remote)address<\/key>\s*<string>([^<]*)<\/string>/g;
  const pc = [...prefs.matchAll(saved)].find((m) => knownAddresses.includes(m[2]));
  if (pc) await exec('defaults', ['write', MOONLIGHT_PREFS, `hosts.${pc[1]}.localaddress`, '-string', address]);
}

class NativeVideoSession extends EventEmitter {
  constructor({ executable, profile, spawnProcess = spawn, exec = run, probe = reachable }) {
    super(); this.executable = executable; this.profile = profile; this.spawnProcess = spawnProcess;
    this.exec = exec; this.probe = probe;
    this.external = true; this.closed = false;
  }
  async start() {
    if (!fs.existsSync(this.executable)) throw new Error('Install Moonlight in Applications to open the stream window.');
    const p = this.profile;
    // At home the PC's home-network address answers; away from home use the Tailscale fallback.
    const host = p.fallbackHost && !(await this.probe(p.host, Number(p.port) || SUNSHINE_BASE_PORT)) ? p.fallbackHost : p.host;
    await prepareMoonlight(host, [p.host, p.fallbackHost].filter(Boolean), this.exec)
      .catch((error) => console.log('ORBIT_MOONLIGHT_PREFS', error.message));
    const args = streamArgs({ ...p, host });
    await new Promise((resolve, reject) => {
      const child = this.child = this.spawnProcess(this.executable, args, { stdio: ['ignore','ignore','pipe'] });
      this.exited = new Promise(done => child.once('close', done));
      child.once('spawn', resolve);
      child.once('error', reject);
      child.stderr?.on('data', chunk => {
        // Moonlight writes a bounded private log. Keep only its log-file locator here.
        const log = String(chunk).match(/Redirecting log output to (.+)/)?.[1];
        if (log) console.log('ORBIT_NATIVE_LOG', log.trim());
      });
      child.once('close', (code) => {
        this.child = null;
        if (!this.closed) this.emit('status', { type:'closed', code,
          message: code ? `Stream window closed (${code}). Reopen it to try again.` : 'Stream window closed.' });
      });
    });
    return { external:true };
  }
  async stop() {
    this.closed = true;
    const child = this.child;
    if (!child) return;
    child.kill('SIGTERM');
    const timer = setTimeout(() => child.kill('SIGKILL'), 2500);
    await this.exited;
    clearTimeout(timer);
  }
  // Input belongs exclusively to the native window, never the manager's canvas.
  input() {}
}
module.exports = { NativeVideoSession, streamArgs };
