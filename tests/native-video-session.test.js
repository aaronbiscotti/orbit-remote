const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { NativeVideoSession, streamArgs } = require('../electron/native-video-session');

const quiet = async () => ''; // never touch the real Moonlight preferences in tests

test('native player opens full screen with hardware decode and desktop mouse mapping', () => {
  const args = streamArgs({host:'192.168.1.64',port:48989,fps:120,bitrate:12000});
  assert.deepEqual(args.slice(0,3), ['stream','192.168.1.64:48989','Desktop']);
  for (const [flag, value] of [['--display-mode','borderless'],['--video-decoder','hardware'],['--fps','120']]) {
    assert.equal(args[args.indexOf(flag)+1], value);
  }
  assert.ok(args.includes('--absolute-mouse'));
  assert.ok(args.includes('--no-frame-pacing'));
  assert.ok(!args.includes('--quit-after'));
  assert.throws(() => streamArgs({host:'--untrusted'}));
});

test("uses the home address when it answers, else the Tailscale fallback, and makes it Moonlight's first choice", async () => {
  const prefs = '<key>hosts.1.localaddress</key>\n\t<string>100.108.42.59</string>\n\t<key>hosts.1.manualaddress</key>\n\t<string>192.168.1.64</string>';
  for (const [home, expected] of [[true, '192.168.1.64'], [false, '100.108.42.59']]) {
    const calls = [], spawned = [];
    const child = new EventEmitter(); child.stderr = new EventEmitter();
    const session = new NativeVideoSession({ executable: process.execPath,
      profile: { host: '192.168.1.64', fallbackHost: '100.108.42.59', port: 48989 },
      probe: async () => home,
      exec: async (_cmd, args) => { calls.push(args.join(' ')); return args[0] === 'export' ? prefs : ''; },
      spawnProcess: (_exe, args) => { spawned.push(args[1]); queueMicrotask(() => child.emit('spawn')); return child; } });
    await session.start();
    assert.equal(spawned[0], `${expected}:48989`);
    assert.ok(calls.includes(`write com.moonlight-stream.Moonlight hosts.1.localaddress -string ${expected}`));
    assert.ok(calls.includes('write com.moonlight-stream.Moonlight NSApplicationUpdateCycleEnabled -bool false'));
  }
});

test('shutdown waits for process exit before allowing replacement', async () => {
  const child = new EventEmitter(); child.stderr = new EventEmitter();
  let signal;
  child.kill = value => { signal = value; };
  const session = new NativeVideoSession({ executable:process.execPath, profile:{host:'192.168.1.64'}, exec:quiet,
    spawnProcess:() => { queueMicrotask(() => child.emit('spawn')); return child; } });
  await session.start();
  let stopped = false;
  const stopping = session.stop().then(() => {stopped=true;});
  await Promise.resolve();
  assert.equal(signal,'SIGTERM'); assert.equal(stopped,false);
  child.emit('close',0); await stopping;
  assert.equal(stopped,true); assert.equal(session.child,null);
});

test('closing stream reports closure and permits reopening without a phantom session', async () => {
  const child = new EventEmitter(); child.stderr = new EventEmitter();
  const session = new NativeVideoSession({executable:process.execPath,profile:{host:'192.168.1.64'},exec:quiet,
    spawnProcess:() => {queueMicrotask(() => child.emit('spawn'));return child;}});
  let status; session.on('status', value => {status=value;});
  await session.start(); child.emit('close',0);
  assert.equal(status.type,'closed'); assert.equal(session.child,null);
  await session.stop();
});
