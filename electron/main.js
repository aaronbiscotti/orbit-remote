const { app, BrowserWindow, ipcMain, clipboard, dialog, globalShortcut, powerSaveBlocker, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const net = require('net');
const tls = require('tls');
const https = require('https');
const crypto = require('crypto');
const { spawn, execFile, execFileSync } = require('child_process');
const { VideoSession } = require('./video-session');
const { NativeVideoSession } = require('./native-video-session');
const { ENGINE_ADMIN_PORT, ENGINE_TAKEOVER_PORT } = require('./ports');
const { isValidAccelerator } = require('./shortcut-keys');

// Mac stream shortcuts. The defaults are the keys Moonlight itself uses for the same two actions.
const DEFAULT_STREAM_SHORTCUTS = { release: 'Control+Alt+Shift+Z', close: 'Control+Alt+Shift+Q' };

const isSmokeTest = process.argv.includes('--smoke-test');
const isWindows = process.platform === 'win32';
if (isWindows) app.setAppUserModelId('local.orbit.remote');

let mainWindow = null;
if(!app.requestSingleInstanceLock())app.exit(0);
app.on('second-instance',()=>{if(mainWindow&&!mainWindow.isDestroyed()){if(mainWindow.isMinimized())mainWindow.restore();mainWindow.show();mainWindow.focus();}});
let powerBlockerId = null;

// ============================================================================
// Paths & Persistent Client Configuration
// ============================================================================
function getRepoOrResourceRoot() {
  if (app.isPackaged) {
    return process.resourcesPath;
  }
  return path.resolve(__dirname, '..');
}

function getWindowsWorkRoot() {
  const devRoot = path.resolve(__dirname, '..');
  if (!app.isPackaged && fs.existsSync(path.join(devRoot, 'scripts'))) {
    return devRoot;
  }
  const userRoot = path.join(app.getPath('userData'), 'host-workspace');
  fs.mkdirSync(userRoot, { recursive: true });
  return userRoot;
}

let cachedHostPaths = null;

// Stops Orbit's own engine running from this folder. Matching by folder, never by name: the real Sunshine,
// which Moonlight needs, is also called sunshine.exe, as were older Orbit copies.
function stopOrbitEngine(folder) {
  const prefix = folder.replace(/'/g, "''");
  const command = `Get-Process -Name 'Orbit.Host','sunshine' -ErrorAction SilentlyContinue | Where-Object { $_.Path -like '${prefix}\\*' } | Stop-Process -Force`;
  try {
    execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], { stdio: 'ignore', windowsHide: true, timeout: 20000 });
  } catch {}
}

// This computer's own SSH public key, if it has one (public keys are safe to share).
function readSshPublicKey() {
  for (const name of ['id_ed25519.pub', 'id_ecdsa.pub', 'id_rsa.pub']) {
    try {
      return fs.readFileSync(path.join(os.homedir(), '.ssh', name), 'utf8').trim();
    } catch {}
  }
  return '';
}

function ensureWindowsHostPrepared(force = false) {
  if (!isWindows) return null;
  if (cachedHostPaths && !force && hostAdminCredentials) {
    return cachedHostPaths;
  }
  const workRoot = getWindowsWorkRoot();
  const runtimeDir = path.join(workRoot, 'runtime', 'sunshine', 'Sunshine');
  const configDir = path.join(runtimeDir, 'config');
  const credDir = path.join(configDir, 'credentials');
  const scriptsDest = path.join(workRoot, 'scripts');

  fs.mkdirSync(credDir, { recursive: true });
  fs.mkdirSync(scriptsDest, { recursive: true });

  // Copy packaged scripts if running from installer
  const resourceRoot = getRepoOrResourceRoot();
  const srcScripts = path.join(resourceRoot, 'scripts');
  if (fs.existsSync(srcScripts) && path.resolve(srcScripts) !== path.resolve(scriptsDest)) {
    for (const file of fs.readdirSync(srcScripts)) {
      if (file.endsWith('.ps1')) {
        fs.copyFileSync(path.join(srcScripts, file), path.join(scriptsDest, file));
      }
    }
  }

  // Copy native AVX2 SIMD + SYSTEM UAC engine binaries into runtime/sunshine/Sunshine
  const srcEngine = fs.existsSync(path.join(resourceRoot, 'engine', 'Orbit.Host.exe'))
    ? path.join(resourceRoot, 'engine')
    : path.join(resourceRoot, 'dist', 'Orbit-Host');

  // This is the only place that copies the engine. It runs from this folder, not from the installed app,
  // so installing an update never has to overwrite files a running engine is using.
  const agentExe = path.join(runtimeDir, 'Orbit.Host.exe');
  const engineFingerprint = (dir) => ['Orbit.Core.dll', 'Orbit.Host.dll'].map((name) => {
    try {
      return crypto.createHash('sha256').update(fs.readFileSync(path.join(dir, name))).digest('hex');
    } catch {
      return '';
    }
  }).join(':');
  const staleEngine = !fs.existsSync(agentExe) || engineFingerprint(runtimeDir) !== engineFingerprint(srcEngine);
  if (fs.existsSync(path.join(srcEngine, 'Orbit.Host.exe')) && staleEngine) {
    // Stop the copy first: Windows won't overwrite running files, and a half-copied engine drops every connection.
    stopOrbitEngine(runtimeDir);
    let incomplete = false;
    for (const file of fs.readdirSync(srcEngine)) {
      const fullSrc = path.join(srcEngine, file);
      if (fs.statSync(fullSrc).isFile()) {
        try {
          fs.copyFileSync(fullSrc, path.join(runtimeDir, file));
        } catch {
          incomplete = true;
        }
      }
    }
    // A failed copy must not look current, so the next check copies again.
    if (incomplete) {
      try { fs.rmSync(path.join(runtimeDir, 'Orbit.Core.dll'), { force: true }); } catch {}
    }
    // Older versions also ran a renamed copy called sunshine.exe, the same name as the real Sunshine.
    for (const old of ['sunshine.exe', 'sunshine.runtimeconfig.json', 'sunshine.deps.json']) {
      try { fs.rmSync(path.join(runtimeDir, old), { force: true }); } catch {}
    }
  }

  const configFile = path.join(configDir, 'sunshine.conf');
  if (!fs.existsSync(configFile)) {
    fs.writeFileSync(
      configFile,
      [
        `sunshine_name = ${os.hostname()}`,
        'engine = orbit-takeover'
      ].join('\n'),
      'utf8'
    );
  }

  const stateFile = path.join(configDir, 'sunshine_state.json');
  const localKeyFile = path.join(configDir, 'local_admin_key.json');

  // Auto-provision loopback admin credentials so the user never has to set/type a password
  try {
    let localCreds = null;
    if (fs.existsSync(localKeyFile)) {
      localCreds = JSON.parse(fs.readFileSync(localKeyFile, 'utf8'));
    }
    if (!localCreds || !localCreds.username || !localCreds.password) {
      localCreds = {
        username: 'orbit',
        password: crypto.randomBytes(24).toString('hex')
      };
      fs.writeFileSync(localKeyFile, JSON.stringify(localCreds, null, 2), 'utf8');
    }

    let stateObj = { username: '', passwordSaltHex: '', passwordHashHex: '', clients: [] };
    if (fs.existsSync(stateFile)) {
      try {
        const parsed = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
        if (parsed && typeof parsed === 'object') {
          stateObj = {
            username: parsed.username || '',
            passwordSaltHex: parsed.passwordSaltHex || '',
            passwordHashHex: parsed.passwordHashHex || '',
            clients: Array.isArray(parsed.clients) ? parsed.clients : []
          };
        }
      } catch {}
    }

    const saltBuf =
      stateObj.passwordSaltHex && stateObj.passwordSaltHex.length === 32
        ? Buffer.from(stateObj.passwordSaltHex, 'hex')
        : crypto.randomBytes(16);
    const expectedHashHex = crypto
      .pbkdf2Sync(localCreds.password, saltBuf, 100000, 32, 'sha256')
      .toString('hex')
      .toUpperCase();

    if (
      stateObj.username !== localCreds.username ||
      stateObj.passwordHashHex.toUpperCase() !== expectedHashHex
    ) {
      stateObj.username = localCreds.username;
      stateObj.passwordSaltHex = saltBuf.toString('hex').toUpperCase();
      stateObj.passwordHashHex = expectedHashHex;
      fs.writeFileSync(stateFile, JSON.stringify(stateObj, null, 2), 'utf8');
    }

    hostAdminCredentials = { username: localCreds.username, password: localCreds.password };
  } catch {}

  cachedHostPaths = {
    workRoot,
    runtimeDir,
    configDir,
    configFile,
    agentExe,
    certFile: path.join(credDir, 'cacert.pem'),
    stateFile,
    adminPrefFile: path.join(configDir, 'administrator-control.enabled'),
    scriptsDir: scriptsDest
  };
  return cachedHostPaths;
}

function getClientConfigPath() {
  return path.join(app.getPath('userData'), 'orbit-client.json');
}

function loadClientConfig() {
  const cfgPath = getClientConfigPath();
  let cfg = {};
  if (fs.existsSync(cfgPath)) {
    try {
      cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    } catch {}
  }
  let changed = false;
  if (!cfg.clientId) {
    cfg.clientId = crypto.randomUUID().replace(/-/g, '');
    changed = true;
  }
  if (!cfg.secretHex || cfg.secretHex.length !== 64) {
    cfg.secretHex = crypto.randomBytes(32).toString('hex');
    changed = true;
  }
  if (!Array.isArray(cfg.computers)) {
    cfg.computers = [];
    changed = true;
  }
  if (!cfg.qualityMode) {
    cfg.qualityMode = 'crisp';
    changed = true;
  }
  if (typeof cfg.mapCommandToCtrl !== 'boolean') {
    cfg.mapCommandToCtrl = true;
    changed = true;
  }
  cfg.streamShortcuts = Object.fromEntries(Object.entries(DEFAULT_STREAM_SHORTCUTS).map(([action, fallback]) =>
    [action, isValidAccelerator(cfg.streamShortcuts?.[action]) ? cfg.streamShortcuts[action] : fallback]));
  cfg.tokenHashHex = crypto
    .createHash('sha256')
    .update(Buffer.from(cfg.secretHex, 'hex'))
    .digest('hex')
    .toLowerCase();

  if (changed) saveClientConfig(cfg);
  return cfg;
}

function saveClientConfig(cfg) {
  const copy = {
    clientId: cfg.clientId,
    secretHex: cfg.secretHex,
    qualityMode: cfg.qualityMode,
    mapCommandToCtrl: cfg.mapCommandToCtrl,
    streamShortcuts: cfg.streamShortcuts,
    computers: cfg.computers
  };
  fs.writeFileSync(getClientConfigPath(), JSON.stringify(copy, null, 2), 'utf8');
}

// ============================================================================
// Network & Crypto Helpers
// ============================================================================
let cachedNetInfo = null;
let cachedNetInfoAt = 0;

function getNetworkAddresses() {
  const now = Date.now();
  if (cachedNetInfo && now - cachedNetInfoAt < 15000) {
    return cachedNetInfo;
  }
  const interfaces = os.networkInterfaces();
  let tailscaleIp = null;
  const lanIps = [];

  for (const [name, addrs] of Object.entries(interfaces)) {
    if (!addrs) continue;
    for (const addr of addrs) {
      if (addr.family !== 'IPv4' || addr.internal) continue;
      const parts = addr.address.split('.').map(Number);
      if (parts[0] === 169 && parts[1] === 254) continue;
      const isTailscale =
        name.toLowerCase().includes('tailscale') ||
        (parts[0] === 100 && (parts[1] & 0xc0) === 0x40);
      if (isTailscale && !tailscaleIp) {
        tailscaleIp = addr.address;
      } else {
        lanIps.push(addr.address);
      }
    }
  }
  cachedNetInfo = {
    hostname: os.hostname(),
    tailscaleIp,
    lanIp: lanIps[0] || null,
    primaryAddress: tailscaleIp || lanIps[0] || '127.0.0.1'
  };
  cachedNetInfoAt = now;
  return cachedNetInfo;
}

function computePairingCommitment(pin, certSha256Hex, clientId, tokenHashHex) {
  const key = crypto
    .createHash('sha256')
    .update(`${pin.trim()}:${certSha256Hex.toLowerCase()}`, 'utf8')
    .digest();
  return crypto
    .createHmac('sha256', key)
    .update(`${clientId}:${tokenHashHex.toLowerCase()}`, 'utf8')
    .digest('hex')
    .toLowerCase();
}

function peerFingerprint(socket) {
  return String(socket.getPeerCertificate()?.fingerprint256 || '').replace(/:/g, '').toLowerCase();
}

function computeAuthProof(tokenHashHex, serverNonce, certSha256Hex) {
  const key = Buffer.from(tokenHashHex, 'hex');
  return crypto
    .createHmac('sha256', key)
    .update(`${serverNonce}:${certSha256Hex.toLowerCase()}`, 'utf8')
    .digest('hex')
    .toLowerCase();
}

const { writeProtocolFrame, FrameAccumulator } = require('./protocol');

// ============================================================================
// Windows Host Engine & Admin Loopback API Client
// ============================================================================
let hostAdminCredentials = null; // { username, password }
let cachedFirewallAllowed = false;
let firewallCheckedOnce = false;
const loopbackHttpsAgent = new https.Agent({
  keepAlive: true,
  maxSockets: 6,
  rejectUnauthorized: false
});

function getExpectedHostCertSha256(certFile) {
  if (!certFile || !fs.existsSync(certFile)) return null;
  try {
    const pem = fs.readFileSync(certFile, 'utf8');
    const cert = new crypto.X509Certificate(pem);
    return cert.fingerprint256.replace(/:/g, '').toLowerCase();
  } catch {
    return null;
  }
}

function adminApiRequest(method, apiPath, bodyObj = null, customCreds = null) {
  return new Promise((resolve, reject) => {
    const paths = ensureWindowsHostPrepared();
    if (!paths) {
      return reject(new Error('Host engine is starting up. Please wait a moment.'));
    }
    const creds = customCreds || hostAdminCredentials;
    const headers = { 'Content-Type': 'application/json' };
    if (creds && creds.username) {
      headers['Authorization'] =
        'Basic ' + Buffer.from(`${creds.username}:${creds.password}`).toString('base64');
    }
    const payload = bodyObj ? Buffer.from(JSON.stringify(bodyObj), 'utf8') : null;
    if (payload) headers['Content-Length'] = payload.length;

    const req = https.request(
      {
        hostname: '127.0.0.1',
        port: ENGINE_ADMIN_PORT,
        path: '/' + apiPath.replace(/^\/+/, ''),
        method,
        headers,
        agent: loopbackHttpsAgent,
        rejectUnauthorized: false,
        timeout: 2500
      },
      (res) => {
        const chunks = [];
        res.on('data', (d) => chunks.push(d));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          if (res.statusCode === 401) {
            return reject(new Error('Unauthorized'));
          }
          try {
            const json = JSON.parse(text || '{}');
            resolve({ statusCode: res.statusCode, data: json });
          } catch {
            reject(new Error('Invalid response from local host engine.'));
          }
        });
      }
    );

    req.on('error', (err) => reject(err));
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Local host engine request timed out.'));
    });

    if (payload) req.write(payload);
    req.end();
  });
}

function isEngineProcessRunning() {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: '127.0.0.1', port: ENGINE_ADMIN_PORT, timeout: 600 });
    socket.on('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.on('error', () => resolve(false));
    socket.on('timeout', () => {
      socket.destroy();
      resolve(false);
    });
  });
}

async function startLocalWindowsEngineIfNeeded() {
  if (!isWindows) return false;
  const paths = ensureWindowsHostPrepared(); // also replaces an engine copy left over from an older version
  const running = await isEngineProcessRunning();
  if (running) return true;

  if (!paths || !fs.existsSync(paths.agentExe)) return false;

  try {
    const child = spawn(paths.agentExe, [paths.configFile], {
      cwd: paths.runtimeDir,
      detached: true,
      stdio: 'ignore',
      windowsHide: true
    });
    child.unref();
    await new Promise((r) => setTimeout(r, 1000));
    return await isEngineProcessRunning();
  } catch {
    return false;
  }
}

function runPowerShellCheck(scriptPath) {
  return new Promise((resolve) => {
    if (!isWindows || !fs.existsSync(scriptPath)) return resolve(false);
    execFile(
      'powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', scriptPath],
      { windowsHide: true, timeout: 8000 },
      (err) => {
        resolve(!err);
      }
    );
  });
}

function runElevatedPowerShellScript(scriptPath) {
  return new Promise((resolve, reject) => {
    if (!isWindows || !fs.existsSync(scriptPath)) {
      return reject(new Error('Helper script not found.'));
    }
    const escaped = scriptPath.replace(/'/g, "''");
    const innerCmd = `& '${escaped}'`;
    const encoded = Buffer.from(innerCmd, 'utf16le').toString('base64');
    const outerCmd = `$p = Start-Process -FilePath 'powershell.exe' -Verb RunAs -WindowStyle Hidden -Wait -PassThru -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-EncodedCommand','${encoded}'; exit $p.ExitCode`;

    execFile(
      'powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', outerCmd],
      { windowsHide: true },
      (err) => {
        if (err) return reject(new Error('Windows administrator approval was cancelled or failed.'));
        resolve(true);
      }
    );
  });
}

// ============================================================================
// Active Client Takeover Session State
// ============================================================================
let pairSocket = null;
let sessionSocket = null;
let videoSession = null;
let sessionAddress = null;
let connectControlSession;
let controlConnecting;
let videoOperation = Promise.resolve();
function queueVideoOperation(fn) {
  const next = videoOperation.catch(() => {}).then(fn);
  videoOperation = next;
  return next;
}

// In the stream, Moonlight takes the keyboard and keeps the pointer inside the picture, so these are the way out.
// Orbit registers them with macOS only while a stream is open; the keys stay free for other apps otherwise.
let streamShortcutsOn = [];
function releaseStream() {
  if (!mainWindow || mainWindow.isDestroyed()) createWindow();
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  app.focus({ steal: true }); // Moonlight lets go of the keyboard and pointer once it is no longer the front app.
}
function closeStream() {
  const session = videoSession;
  if (!session?.external) return;
  releaseStream();
  queueVideoOperation(async () => {
    await session.stop(); // Asks Moonlight to quit, and force-quits it if it hasn't after 2.5 seconds.
    if (videoSession === session && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('video:status', { type: 'closed', message: 'Stream window closed.' });
    }
  }).catch((error) => console.log('ORBIT_STREAM_CLOSE', error.message));
}
function setStreamShortcuts(on) {
  for (const accelerator of streamShortcutsOn) globalShortcut.unregister(accelerator);
  streamShortcutsOn = [];
  if (!on) return;
  const { release, close } = loadClientConfig().streamShortcuts;
  for (const [accelerator, run] of [[release, releaseStream], [close, closeStream]]) {
    if (globalShortcut.register(accelerator, run)) streamShortcutsOn.push(accelerator);
    else console.log('ORBIT_SHORTCUT_REFUSED', accelerator);
  }
}
// True if macOS will register the shortcut. It can refuse one, for example a key it reserves.
function macAcceptsShortcut(accelerator) {
  if (globalShortcut.isRegistered(accelerator)) return true;
  const accepted = globalShortcut.register(accelerator, () => {});
  if (accepted) globalShortcut.unregister(accelerator);
  return accepted;
}

async function ensureControlSession() {
  if(!sessionAddress)throw new Error('No active PC session.');
  if(sessionSocket && !sessionSocket.destroyed)return;
  if(!controlConnecting)controlConnecting=connectControlSession({address:sessionAddress,quality:'low',monitor:0,stream:false}).finally(()=>{controlConnecting=null;});
  await controlConnecting;
}

async function closeRemoteSession() {
  if (videoSession) { const old = videoSession; videoSession = null; await old.stop(); }
  sessionAddress = null;
  return closeControlSession();
}

function closeControlSession() {
  const sock = sessionSocket;
  sessionSocket = null;
  if (!sock || sock.destroyed) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(() => { sock.destroy(); resolve(); }, 800);
    sock.once('close', () => { clearTimeout(timer); resolve(); });
    writeProtocolFrame(sock, { type: 'privacy_curtain', enabled: false });
    sock.end();
  });
}

function parseHostPort(addressInput) {
  const trimmed = String(addressInput || '').trim();
  const idx = trimmed.lastIndexOf(':');
  if (idx > 0 && !trimmed.includes(']')) {
    const port = parseInt(trimmed.slice(idx + 1), 10);
    if (port > 0 && port < 65536) {
      return { host: trimmed.slice(0, idx), port };
    }
  }
  return { host: trimmed, port: ENGINE_TAKEOVER_PORT };
}

function probeSingleComputer(entry, cfg) {
  return new Promise((resolve) => {
    const { host, port } = parseHostPort(entry.address);
    let settled = false;
    const finish = (update) => {
      if (settled) return;
      settled = true;
      try {
        sock.destroy();
      } catch {}
      resolve({ ...entry, ...update, statusUnknown: false });
    };

    const sock = tls.connect(
      { host, port, rejectUnauthorized: false, timeout: 3000 },
      () => {
        sock.setNoDelay(true);
        writeProtocolFrame(sock, {
          type: 'probe',
          clientId: cfg.clientId,
          clientName: os.hostname()
        });
      }
    );

    const acc = new FrameAccumulator((json) => {
      if (json.type === 'probe_result') {
        finish({
          online: true,
          name: json.hostname || entry.name,
          paired: Boolean(json.paired),
          privilege: json.privilege || 'Standard',
          desktop: json.desktop || 'Default',
          certSha256: json.paired && !entry.certSha256 ? peerFingerprint(sock) : entry.certSha256
        });
      }
    });

    sock.on('data', (chunk) => acc.push(chunk));
    sock.on('error', () => finish({ online: false }));
    sock.on('timeout', () => finish({ online: false }));
    setTimeout(() => finish({ online: false }), 3200);
  });
}

// ============================================================================
// IPC Handlers
// ============================================================================
function registerIpcHandlers() {
  ipcMain.handle('app:info', async () => {
    if (isWindows) {
      const paths = ensureWindowsHostPrepared();
      startLocalWindowsEngineIfNeeded();
      if (paths && !firewallCheckedOnce) {
        firewallCheckedOnce = true;
        runPowerShellCheck(path.join(paths.scriptsDir, 'check-firewall.ps1')).then((allowed) => {
          cachedFirewallAllowed = allowed;
        });
      }
    }
    const { qualityMode, streamShortcuts } = loadClientConfig();
    return {
      platform: process.platform,
      isWindows,
      network: getNetworkAddresses(),
      clientConfig: { qualityMode, streamShortcuts }
    };
  });

  ipcMain.handle('settings:set-stream-shortcut', (_event, { action, accelerator } = {}) => {
    if (!Object.hasOwn(DEFAULT_STREAM_SHORTCUTS, action)) throw new Error('Unknown shortcut.');
    if (!isValidAccelerator(accelerator)) throw new Error('Use Control or Command, plus a letter, number or function key.');
    const cfg = loadClientConfig();
    if (Object.entries(cfg.streamShortcuts).some(([other, used]) => other !== action && used === accelerator)) {
      throw new Error('The other stream shortcut already uses those keys.');
    }
    if (!macAcceptsShortcut(accelerator)) throw new Error('macOS did not accept that shortcut. Try different keys.');
    cfg.streamShortcuts[action] = accelerator;
    saveClientConfig(cfg);
    if (streamShortcutsOn.length) setStreamShortcuts(true); // a stream is open: switch to the new keys now
    return { streamShortcuts: cfg.streamShortcuts };
  });

  // --- Windows Host Mode Handlers ---
  ipcMain.handle('host:get-status', async () => {
    if (!isWindows) return { supported: false };
    const paths = ensureWindowsHostPrepared();

    let configured = true;
    let savedUsername = hostAdminCredentials?.username || 'orbit';
    let running = false;
    let unlocked = false;
    let privilege = 'Standard';
    let desktop = 'Default';
    let activeSessions = 0;
    let pendingPairs = [];
    let pairedClients = [];

    if (hostAdminCredentials) {
      try {
        const [cfgRes, pinRes, cliRes] = await Promise.all([
          adminApiRequest('GET', 'api/config'),
          adminApiRequest('GET', 'api/pin'),
          adminApiRequest('GET', 'api/clients/list')
        ]);
        running = true;
        if (cfgRes.data && cfgRes.data.status) {
          unlocked = true;
          privilege = cfgRes.data.privilege || 'Standard';
          desktop = cfgRes.data.desktop || 'Default';
          activeSessions = cfgRes.data.activeSessions || 0;
        }
        if (pinRes.data && Array.isArray(pinRes.data.pairings)) {
          pendingPairs = pinRes.data.pairings;
        }
        if (cliRes.data && Array.isArray(cliRes.data.named_certs)) {
          pairedClients = cliRes.data.named_certs;
        }
      } catch (err) {
        if (String(err.message).includes('Unauthorized')) {
          ensureWindowsHostPrepared(true);
        } else {
          running = await startLocalWindowsEngineIfNeeded();
        }
      }
    } else {
      running = await startLocalWindowsEngineIfNeeded();
    }

    if (!firewallCheckedOnce && paths) {
      firewallCheckedOnce = true;
      runPowerShellCheck(path.join(paths.scriptsDir, 'check-firewall.ps1')).then((allowed) => {
        cachedFirewallAllowed = allowed;
      });
    }

    return {
      supported: true,
      running,
      configured,
      savedUsername,
      unlocked,
      firewallAllowed: cachedFirewallAllowed,
      privilege,
      desktop,
      activeSessions,
      pendingPairs,
      pairedClients,
      network: getNetworkAddresses()
    };
  });

  ipcMain.handle('host:unlock', async (_event, { username, password }) => {
    const cleanUser = String(username || '').trim();
    const cleanPass = String(password || '');
    if (!cleanUser || cleanUser.includes(':') || !cleanPass) {
      throw new Error('Enter a valid username and password.');
    }

    await startLocalWindowsEngineIfNeeded();
    const paths = ensureWindowsHostPrepared();
    let configured = false;
    if (paths && fs.existsSync(paths.stateFile)) {
      try {
        const st = JSON.parse(fs.readFileSync(paths.stateFile, 'utf8'));
        configured = Boolean(st.username);
      } catch {}
    }

    if (!configured) {
      if (cleanPass.length < 12) {
        throw new Error('Choose a password of at least 12 characters.');
      }
      const res = await adminApiRequest(
        'POST',
        'api/password',
        {
          currentUsername: '',
          currentPassword: '',
          newUsername: cleanUser,
          newPassword: cleanPass,
          confirmNewPassword: cleanPass
        },
        { username: cleanUser, password: cleanPass }
      );
      if (!res.data || !res.data.status) {
        throw new Error('Could not save initial Orbit Host password.');
      }
    }

    const verifyRes = await adminApiRequest('GET', 'api/config', null, {
      username: cleanUser,
      password: cleanPass
    });
    if (!verifyRes.data || !verifyRes.data.status) {
      throw new Error('That password did not work. Try your Orbit Host login again.');
    }

    hostAdminCredentials = { username: cleanUser, password: cleanPass };
    return { ok: true };
  });

  ipcMain.handle('host:enable-firewall', async () => {
    const paths = ensureWindowsHostPrepared();
    await runElevatedPowerShellScript(path.join(paths.scriptsDir, 'enable-firewall.ps1'));
    cachedFirewallAllowed = await runPowerShellCheck(path.join(paths.scriptsDir, 'check-firewall.ps1'));
    return { allowed: cachedFirewallAllowed };
  });

  ipcMain.handle('host:check-firewall', async () => {
    const paths = ensureWindowsHostPrepared();
    cachedFirewallAllowed = await runPowerShellCheck(path.join(paths.scriptsDir, 'check-firewall.ps1'));
    return { allowed: cachedFirewallAllowed };
  });

  ipcMain.handle('host:enable-admin', async () => {
    const paths = ensureWindowsHostPrepared();
    await runElevatedPowerShellScript(path.join(paths.scriptsDir, 'start-host-admin.ps1'));
    await new Promise((r) => setTimeout(r, 1200));
    return { ok: true };
  });

  ipcMain.handle('host:enable-system-access', async () => {
    const paths = ensureWindowsHostPrepared(true);
    const fwScript = path.join(paths.scriptsDir, 'enable-firewall.ps1').replace(/'/g, "''");
    const adminScript = path.join(paths.scriptsDir, 'start-host-admin.ps1').replace(/'/g, "''");
    const innerCmd = `& '${fwScript}'; & '${adminScript}'`;
    const encoded = Buffer.from(innerCmd, 'utf16le').toString('base64');
    const outerCmd = `$p = Start-Process -FilePath 'powershell.exe' -Verb RunAs -WindowStyle Hidden -Wait -PassThru -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-EncodedCommand','${encoded}'; exit $p.ExitCode`;

    await new Promise((resolve, reject) => {
      execFile(
        'powershell.exe',
        ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', outerCmd],
        { windowsHide: true },
        (err) => {
          if (err) return reject(new Error('Administrator approval was cancelled or failed.'));
          resolve(true);
        }
      );
    });

    let verifiedPrivilege = 'Standard';
    for (let attempt = 0; attempt < 8; attempt++) {
      await new Promise((r) => setTimeout(r, 500));
      try {
        const cfgRes = await adminApiRequest('GET', 'api/config');
        const priv = cfgRes?.data?.privilege || 'Standard';
        if (priv === 'SYSTEM' || priv === 'Administrator') {
          verifiedPrivilege = priv;
          break;
        }
      } catch {}
    }

    cachedFirewallAllowed = await runPowerShellCheck(path.join(paths.scriptsDir, 'check-firewall.ps1'));
    if (verifiedPrivilege !== 'SYSTEM' && verifiedPrivilege !== 'Administrator') {
      throw new Error('Administrator service did not start in SYSTEM mode. Try clicking Enable again.');
    }
    return { ok: true, privilege: verifiedPrivilege, firewallAllowed: cachedFirewallAllowed };
  });

  ipcMain.handle('host:pair-mac', async (_event, { pairingId, pin, name }) => {
    const res = await adminApiRequest('POST', 'api/pin', {
      pairing_id: pairingId,
      pin: String(pin || '').trim(),
      name: name || 'Mac'
    });
    if (!res.data || !res.data.status) {
      throw new Error('Pairing code did not match. Check the 4-digit code on your Mac and try again.');
    }
    return { ok: true };
  });

  ipcMain.handle('host:revoke-client', async (_event, { uuid }) => {
    const res = await adminApiRequest('POST', 'api/clients/unpair', { uuid });
    return { ok: Boolean(res.data && res.data.status) };
  });

  ipcMain.handle('host:keep-awake', (_event, { enabled }) => {
    if (enabled) {
      if (powerBlockerId === null || !powerSaveBlocker.isStarted(powerBlockerId)) {
        powerBlockerId = powerSaveBlocker.start('prevent-display-sleep');
      }
    } else if (powerBlockerId !== null && powerSaveBlocker.isStarted(powerBlockerId)) {
      powerSaveBlocker.stop(powerBlockerId);
      powerBlockerId = null;
    }
    return { enabled: Boolean(enabled) };
  });

  // --- Client / Remote OS Takeover Mode Handlers ---
  ipcMain.handle('client:list-pcs', async () => {
    const cfg = loadClientConfig();
    const updated = await Promise.all(cfg.computers.map((pc) => probeSingleComputer(pc, cfg)));
    cfg.computers = updated;
    saveClientConfig(cfg);
    return updated;
  });

  ipcMain.handle('client:add-pc', async (_event, { address }) => {
    const { host, port } = parseHostPort(address);
    if (!host) throw new Error('Enter a PC IP or Tailscale address.');
    const canonical = port === ENGINE_TAKEOVER_PORT ? host : `${host}:${port}`;
    const cfg = loadClientConfig();
    let existing = cfg.computers.find((c) => c.address.toLowerCase() === canonical.toLowerCase());
    if (!existing) {
      existing = {
        address: canonical,
        name: host,
        certSha256: '',
        paired: false,
        online: false,
        privilege: 'Standard',
        desktop: 'Default'
      };
      cfg.computers.push(existing);
    }
    const probed = await probeSingleComputer(existing, cfg);
    Object.assign(existing, probed);
    saveClientConfig(cfg);
    return cfg.computers;
  });

  ipcMain.handle('client:remove-pc', (_event, { address }) => {
    const cfg = loadClientConfig();
    cfg.computers = cfg.computers.filter((c) => c.address.toLowerCase() !== String(address).toLowerCase());
    saveClientConfig(cfg);
    return cfg.computers;
  });

  ipcMain.handle('client:start-pair', (_event, { address }) => {
    if (pairSocket) {
      try {
        pairSocket.destroy();
      } catch {}
      pairSocket = null;
    }
    const cfg = loadClientConfig();
    const { host, port } = parseHostPort(address);
    const pin = String(crypto.randomInt(1000, 10000));
    // A fresh secret for each PC: a wrong or hostile machine only learns a secret that opens nothing else.
    const tokenHashHex = crypto.randomBytes(32).toString('hex');
    let certSha256 = '';
    let done = false;

    const sock = tls.connect({ host, port, rejectUnauthorized: false }, () => {
      sock.setNoDelay(true);
    });
    pairSocket = sock;
    const finish = (result) => {
      if (done) return;
      done = true;
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('client:pair-Complete', { address, hostname: host, ...result });
      }
      sock.destroy();
      if (pairSocket === sock) pairSocket = null;
    };

    const acc = new FrameAccumulator((json) => {
      if (json.type === 'hello') {
        certSha256 = String(json.certSha256 || '').toLowerCase();
        // Only send the secret to the machine that really holds the certificate it reports.
        if (!certSha256 || peerFingerprint(sock) !== certSha256) {
          finish({ paired: false, error: 'This PC did not prove its identity. Pairing stopped.' });
          return;
        }
        const commitment = computePairingCommitment(pin, certSha256, cfg.clientId, tokenHashHex);
        writeProtocolFrame(sock, {
          type: 'pair_request',
          clientId: cfg.clientId,
          clientName: os.hostname(),
          tokenHash: tokenHashHex,
          commitment
        });
      } else if (json.type === 'pair_status') {
        if (json.paired && certSha256) {
          const freshCfg = loadClientConfig();
          const pc = freshCfg.computers.find((c) => c.address.toLowerCase() === String(address).toLowerCase());
          if (pc) {
            pc.paired = true;
            pc.online = true;
            pc.name = json.hostname || pc.name;
            pc.certSha256 = certSha256;
            pc.tokenHashHex = tokenHashHex;
            saveClientConfig(freshCfg);
          }
        }
        finish({ paired: Boolean(json.paired), hostname: json.hostname || host, error: json.error || '' });
      }
    });

    sock.on('data', (chunk) => acc.push(chunk));
    sock.on('error', (err) => finish({ paired: false, error: err.message }));

    return { pin, host };
  });

  ipcMain.handle('client:cancel-pair', () => {
    if (pairSocket) {
      try {
        pairSocket.destroy();
      } catch {}
      pairSocket = null;
    }
    return { ok: true };
  });

  connectControlSession = async ({ address, quality, monitor, stream = true }) => {
    await closeControlSession();

    const cfg = loadClientConfig();
    const pc = cfg.computers.find((c) => c.address.toLowerCase() === String(address).toLowerCase());
    const expectedCertSha = pc ? String(pc.certSha256 || '').toLowerCase() : '';
    const { host, port } = parseHostPort(address);

    return new Promise((resolve, reject) => {
      let authResolved = false;

      const sock = tls.connect({ host, port, rejectUnauthorized: false }, () => {
        sock.setNoDelay(true);
        sock.setKeepAlive(true, 5000);
      });
      sessionSocket = sock;
      sessionAddress = address;

      const acc = new FrameAccumulator((json, binBuffer) => {
        if (json.type === 'hello') {
          const peerCert = sock.getPeerCertificate();
          const actualFp =
            peerCert && peerCert.fingerprint256
              ? peerCert.fingerprint256.replace(/:/g, '').toLowerCase()
              : String(json.certSha256 || '').toLowerCase();

          if (expectedCertSha && actualFp && expectedCertSha !== actualFp) {
            sock.destroy();
            if (!authResolved) {
              authResolved = true;
              reject(new Error('Host TLS certificate changed. Remove and re-pair this PC.'));
            }
            return;
          }

          // PCs paired before per-PC secrets keep the old shared one until they are paired again.
          const proof = computeAuthProof(pc?.tokenHashHex || cfg.tokenHashHex, json.nonce, actualFp);
          writeProtocolFrame(sock, {
            type: 'auth',
            clientId: cfg.clientId,
            clientName: os.hostname(),
            proof,
            quality: quality || cfg.qualityMode || 'crisp',
            monitor: monitor || 0,
            stream
          });
          return;
        }

        if (json.type === 'auth_error') {
          sock.destroy();
          if (!authResolved) {
            authResolved = true;
            reject(new Error(json.error || 'Authentication failed.'));
          }
          return;
        }

        if (json.type === 'auth_ok') {
          // Keep the physical PC usable until the Windows curtain lifecycle is repaired.
          writeProtocolFrame(sock, { type: 'privacy_curtain', enabled: false });
          if (pc) { pc.monitors = json.monitors || []; saveClientConfig(cfg); }
          if (!authResolved) {
            authResolved = true;
            resolve({
              videoExternal: process.platform === 'darwin' && Boolean(pc?.video),
              hostname: json.hostname || host,
              privilege: json.privilege || 'Standard',
              desktop: json.desktop || 'Default',
              secureDesktop: Boolean(json.secureDesktop),
              monitors: json.monitors || [],
              videoAvailable: Boolean(pc && pc.video),
              privacyCurtain: Boolean(json.privacyCurtain)
            });
          }
          // Request initial file drives and process list
          writeProtocolFrame(sock, { type: 'fs_list', path: 'drives' });
          writeProtocolFrame(sock, { type: 'proc_list' });
          // Let this paired PC accept this computer's SSH key. Orbit's administrator service adds it.
          const sshKey = readSshPublicKey();
          if (sshKey) writeProtocolFrame(sock, { type: 'ssh_key', key: sshKey });
          return;
        }

        if (!mainWindow || mainWindow.isDestroyed()) return;

        if (json.type === 'frame') {
          if (videoSession) return;
          mainWindow.webContents.send('client:frame', json, binBuffer);
          return;
        }

        if (json.type === 'clipboard_data') {
          if (json.text) clipboard.writeText(json.text);
          mainWindow.webContents.send('client:event', json);
          return;
        }

        if (json.type === 'fs_download_result' && json.ok) {
          const downloadsDir = app.getPath('downloads');
          const outPath = path.join(downloadsDir, path.basename(json.name || 'downloaded-file'));
          fs.writeFileSync(outPath, binBuffer);
          mainWindow.webContents.send('client:event', {
            type: 'download_saved',
            path: outPath
          });
          return;
        }

        mainWindow.webContents.send('client:event', json);
      });

      sock.on('data', (chunk) => acc.push(chunk));
      sock.on('error', (err) => {
        if (!authResolved) {
          authResolved = true;
          reject(err);
        } else if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('client:disconnected', { reason: err.message });
        }
      });
      sock.on('close', () => {
        const currentSession = sessionSocket === sock;
        if (currentSession) sessionSocket = null;
        if(!authResolved){authResolved=true;reject(new Error('PC connection closed before authentication.'));}
        if(videoSession)return;
        if (currentSession && mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('client:disconnected', { reason: 'Connection closed' });
        }
      });
    });
  };

  ipcMain.handle('client:connect', (_event, options) => queueVideoOperation(async () => {
    await closeRemoteSession();
    const pc = loadClientConfig().computers.find(pc => pc.address === options.address);
    // A paired GPU PC can launch without authenticating the legacy capture engine.
    if (process.platform === 'darwin' && pc?.video && pc.monitors?.length) {
      sessionAddress = options.address;
      return { hostname:pc.name, monitors:pc.monitors, videoAvailable:true, videoExternal:true };
    }
    const result = await connectControlSession(options);
    if (result.videoExternal) await closeControlSession();
    return result;
  }));

  ipcMain.handle('client:disconnect', () => queueVideoOperation(async () => {
    await closeRemoteSession();
    void installPendingUpdate();
    return { ok: true };
  }));

  ipcMain.handle('video:start', (_event, options = {}) => queueVideoOperation(async () => {
    if (!sessionAddress) throw new Error('Connect to the PC first.');
    if (videoSession) { const old = videoSession; videoSession = null; await old.stop(); }
    const cfg = loadClientConfig();
    const pc = cfg.computers.find(pc => pc.address === sessionAddress);
    if (!pc?.video) throw new Error('GPU streaming is not paired for this PC.');
    if(['crisp','balanced','low'].includes(options.quality)){cfg.qualityMode=options.quality;saveClientConfig(cfg);}
    const bitrate = { crisp: 25000, balanced: 12000, low: 6000 }[options.quality] || pc.video.bitrate;
    if (process.platform === 'darwin') {
      await closeControlSession();
      const current = videoSession = new NativeVideoSession({
        executable:'/Applications/Moonlight.app/Contents/MacOS/Moonlight',
        profile:{...pc.video, bitrate, width:options.width, height:options.height}
      });
      current.on('status', status => {
        if (videoSession === current && mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('video:status', status);
      });
      try {
        const info = await current.start();
        setStreamShortcuts(true);
        current.child?.once('close', () => setStreamShortcuts(false));
        return info;
      }
      catch (error) { await current.stop(); if(videoSession === current) videoSession = null; throw error; }
    }
    const helper = app.isPackaged ? path.join(process.resourcesPath, 'video-engine', 'orbit-video-bridge') : path.join(getRepoOrResourceRoot(), 'work/video-bridge-build/orbit-video-bridge');
    const current = videoSession = new VideoSession({helper, identityPath:path.join(app.getPath('userData'),'video-identity.json'),profile:{...pc.video,bitrate,width:Math.max(640,Math.min(3840,Math.round((Number(options.width)||1920)/2)*2)),height:Math.max(480,Math.min(2160,Math.round((Number(options.height)||1080)/2)*2)),codec:options.codec==='hevc'?'hevc':'h264'}});
    const send = (name, ...args) => { if(videoSession===current && mainWindow && !mainWindow.isDestroyed())mainWindow.webContents.send(name,...args); };
    current.on('packet',(meta, data)=>send('video:packet',meta,data));
    current.on('status',status=>{send('video:status',status);if(status.type==='connected' && Number.isInteger(options.monitor))current.selectMonitor(options.monitor);});
    current.on('failure',error=>send('video:status',{type:'error',message:error}));
    try { const info = await current.start();await closeControlSession();return info; } catch(error) { current.stop(); if(videoSession===current)videoSession=null; throw error; }
  }));
  ipcMain.handle('client:tab', async (_event, tab) => {
    if(!videoSession || !sessionAddress)return;
    if(tab==='desktop'){if(controlConnecting)await controlConnecting;await closeControlSession();return;}
    if(!sessionSocket || sessionSocket.destroyed){
      if(!controlConnecting)controlConnecting=connectControlSession({address:sessionAddress,quality:'low',monitor:0,stream:false}).finally(()=>{controlConnecting=null;});
      await controlConnecting;
    }
  });
  ipcMain.handle('video:focus', async () => {
    if (!videoSession?.external || !videoSession.child) return { running:false };
    const pid = videoSession.child.pid;
    const helper = path.join(app.isPackaged ? process.resourcesPath : path.join(getRepoOrResourceRoot(),'dist'), 'video-engine', 'orbit-focus-player');
    // A failed focus must not restart a working stream; the check above already catches a closed player.
    return new Promise(resolve => execFile(helper, [String(pid)], () => resolve({ running: true })));
  });
  ipcMain.handle('video:monitor', (_event, index) => { if(!videoSession || videoSession.external)throw new Error('Switch monitors in the stream window using Ctrl+Option+Shift+F1 or F2.');videoSession.selectMonitor(index);return {ok:true}; });
  ipcMain.on('video:ack', (_event, id) => videoSession?.ack?.(id));
  ipcMain.on('video:keyframe', () => videoSession?.command?.('I'));
  ipcMain.on('video:metrics', (_event, metrics) => { console.log('ORBIT_VIDEO', JSON.stringify(metrics)); });

  ipcMain.on('client:send', async (_event, payload) => {
    if (videoSession && ['mouse','key'].includes(payload.type)) { videoSession.input(payload); return; }

    if(videoSession && (!sessionSocket || sessionSocket.destroyed) && payload.type==='sas') {
      try { await ensureControlSession(); }
      catch(error) {mainWindow?.webContents.send('client:event',{type:'error',error:error.message});return;}
    }
    if (sessionSocket && !sessionSocket.destroyed) {
      writeProtocolFrame(sessionSocket, payload);
    }
  });

  ipcMain.handle('client:sync-clipboard-to-pc', async () => {
    await ensureControlSession();
    const text = clipboard.readText();
    if (text && sessionSocket && !sessionSocket.destroyed) {
      writeProtocolFrame(sessionSocket, { type: 'clipboard_set', text });
    }
    return { ok: true };
  });

  ipcMain.handle('client:upload-file-dialog', async (_event, { remoteDir }) => {
    if (!sessionSocket || sessionSocket.destroyed || !remoteDir) return { ok: false };
    const result = await dialog.showOpenDialog(mainWindow, {
      title: 'Select File to Upload to Windows PC',
      properties: ['openFile']
    });
    if (result.canceled || !result.filePaths.length) return { ok: false };

    const localFile = result.filePaths[0];
    const bytes = fs.readFileSync(localFile);
    const sep = remoteDir.endsWith('\\') ? '' : '\\';
    const destPath = `${remoteDir}${sep}${path.basename(localFile)}`;
    writeProtocolFrame(sessionSocket, { type: 'fs_upload', path: destPath }, bytes);
    return { ok: true, name: path.basename(localFile) };
  });

  ipcMain.handle('app:open-external', (_event, { url }) => {
    shell.openExternal(url);
  });

  ipcMain.handle('app:copy-text', (_event, { text }) => {
    clipboard.writeText(String(text || ''));
    return { ok: true };
  });

  ipcMain.handle('app:check-updates', async () => {
    return await checkForUpdates(true);
  });

  ipcMain.handle('window:minimize', () => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.minimize();
  });

  ipcMain.handle('window:maximize', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      if (mainWindow.isMaximized()) mainWindow.unmaximize();
      else mainWindow.maximize();
    }
  });

  ipcMain.handle('window:close', () => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.close();
  });
}

// ============================================================================
// Updates: full builds that CI publishes as GitHub releases
// ============================================================================
const updater = require('./updater');
// Written by CI. A packaged build without it predates this updater, so it counts as build 0 and updates.
const BUILD = (() => { try { return require('./build-info.json'); } catch { return { run: 0, commit: 'unknown' }; } })();
let updateChecking = false;
let updateInstalling = false;
let pendingUpdate = null;

function sendUpdateEvent(evt) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('app:update-event', evt);
}

function inRemoteSession() {
  return Boolean(sessionAddress || videoSession || (sessionSocket && !sessionSocket.destroyed));
}

async function checkForUpdates(manual) {
  if (!app.isPackaged) return { message: manual ? 'Updates are off when Orbit runs from source.' : '' };
  if (pendingUpdate) {
    void installPendingUpdate();
    return { commit: BUILD.commit, message: `Build ${pendingUpdate.run} is ready and installs when you disconnect.` };
  }
  if (updateChecking) return { commit: BUILD.commit, message: manual ? 'Already checking for updates.' : '' };
  updateChecking = true;
  try {
    const token = await updater.githubToken();
    if (!token) return { commit: BUILD.commit, message: manual ? 'Sign in to GitHub on this computer (gh auth login) to get updates.' : '' };
    const found = await updater.downloadNewerBuild({ build: BUILD, platform: process.platform, token, dir: path.join(app.getPath('userData'), 'updates') });
    if (!found) return { commit: BUILD.commit, message: manual ? `Orbit is up to date (build ${BUILD.run}).` : '' };
    pendingUpdate = found;
    void installPendingUpdate();
    return { commit: BUILD.commit, message: inRemoteSession() ? `Build ${found.run} is ready and installs when you disconnect.` : `Installing build ${found.run}â€¦` };
  } catch (error) {
    return { commit: BUILD.commit, message: manual ? `Couldn't check for updates: ${error.message}` : '' };
  } finally {
    updateChecking = false;
  }
}

// Install only when no remote session is running, so an update never cuts off a stream or a transfer.
async function installPendingUpdate() {
  if (!pendingUpdate || updateInstalling || inRemoteSession()) return;
  updateInstalling = true;
  sendUpdateEvent({ status: 'installing', message: `Installing Orbit build ${pendingUpdate.run}â€¦` });
  try {
    if (process.platform === 'darwin') {
      await updater.installMac(pendingUpdate.file, path.resolve(process.execPath, '../../..'));
      app.relaunch();
    } else if (process.platform === 'win32') {
      updater.installWindows(pendingUpdate.file);
    } else {
      throw new Error('updates are only built for Mac and Windows');
    }
    app.exit(0);
  } catch (error) {
    updateInstalling = false;
    pendingUpdate = null;
    sendUpdateEvent({ status: 'error', message: `Update failed: ${error.message}` });
  }
}

function startUpdateChecks() {
  if (isSmokeTest || !app.isPackaged) return;
  if (process.platform === 'darwin') updater.removeOldBundle(path.resolve(process.execPath, '../../..'));
  setTimeout(() => void checkForUpdates(false), 10000);
  setInterval(() => void checkForUpdates(false), 6 * 60 * 60 * 1000);
}

// ============================================================================
// Window Lifecycle
// ============================================================================
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 680,
    height: 640,
    minWidth: 500,
    minHeight: 480,
    frame: false,
    titleBarStyle: 'hidden',
    // Centre the Mac's window buttons in Orbit's 44 px top bar.
    trafficLightPosition: { x: 14, y: 16 },
    backgroundColor: '#111111',
    title: 'Orbit',
    icon: path.join(__dirname, 'assets', isWindows ? 'icon.ico' : 'icon.png'),
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  mainWindow.loadFile(path.join(__dirname, 'index.html'));

  if (isSmokeTest) {
    mainWindow.webContents.once('did-finish-load', () => {
      setTimeout(async () => {
        if (process.argv.includes('--open-settings')) {
          await mainWindow.webContents.executeJavaScript('document.getElementById("checkUpdatesCircleBtn")?.click()');
          await new Promise((r) => setTimeout(r, 320));
        }
        const snapArg = process.argv.find((a) => a.startsWith('--capture-ui='));
        if (snapArg) {
          const outPath = snapArg.slice('--capture-ui='.length);
          const img = await mainWindow.webContents.capturePage();
          fs.writeFileSync(outPath, img.toPNG());
        }
        console.log('PASS: Orbit Electron app loaded and verified.');
        app.exit(0);
      }, 1000);
    });
  }
}

app.whenReady().then(async () => {
  registerIpcHandlers();
  createWindow();
  if (isWindows && !isSmokeTest) {
    startLocalWindowsEngineIfNeeded();
  }
  startUpdateChecks();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (!videoSession?.external) void closeRemoteSession();
  if (powerBlockerId !== null && powerSaveBlocker.isStarted(powerBlockerId)) {
    powerSaveBlocker.stop(powerBlockerId);
  }
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', (event) => {
  if ((!sessionSocket || sessionSocket.destroyed) && !videoSession) return;
  event.preventDefault();
  queueVideoOperation(closeRemoteSession).finally(() => app.quit());
});
