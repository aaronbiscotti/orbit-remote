const { app, BrowserWindow, ipcMain, clipboard, dialog, powerSaveBlocker, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const net = require('net');
const tls = require('tls');
const https = require('https');
const crypto = require('crypto');
const { spawn, execFile } = require('child_process');
const { VideoSession } = require('./video-session');
const { NativeVideoSession } = require('./native-video-session');


const isSmokeTest = process.argv.includes('--smoke-test');
const isWindows = process.platform === 'win32';

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

function ensureWindowsHostPrepared() {
  if (!isWindows) return null;
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

  const agentExe = path.join(runtimeDir, 'sunshine.exe');
  const srcCoreDll = path.join(srcEngine, 'Orbit.Core.dll');
  const dstCoreDll = path.join(runtimeDir, 'Orbit.Core.dll');
  let engineNeedsSync = !fs.existsSync(agentExe);
  if (!engineNeedsSync && fs.existsSync(srcCoreDll) && fs.existsSync(dstCoreDll)) {
    try {
      const sHash = crypto.createHash('sha256').update(fs.readFileSync(srcCoreDll)).digest('hex');
      const dHash = crypto.createHash('sha256').update(fs.readFileSync(dstCoreDll)).digest('hex');
      engineNeedsSync = sHash !== dHash;
    } catch {}
  }

  if (fs.existsSync(path.join(srcEngine, 'Orbit.Host.exe')) && engineNeedsSync) {
    for (const file of fs.readdirSync(srcEngine)) {
      const fullSrc = path.join(srcEngine, file);
      if (fs.statSync(fullSrc).isFile()) {
        try {
          fs.copyFileSync(fullSrc, path.join(runtimeDir, file));
        } catch {}
      }
    }
    try {
      fs.copyFileSync(path.join(srcEngine, 'Orbit.Host.exe'), agentExe);
    } catch {}
    if (fs.existsSync(path.join(srcEngine, 'Orbit.Host.runtimeconfig.json'))) {
      try {
        fs.copyFileSync(
          path.join(srcEngine, 'Orbit.Host.runtimeconfig.json'),
          path.join(runtimeDir, 'sunshine.runtimeconfig.json')
        );
      } catch {}
    }
    if (fs.existsSync(path.join(srcEngine, 'Orbit.Host.deps.json'))) {
      try {
        fs.copyFileSync(
          path.join(srcEngine, 'Orbit.Host.deps.json'),
          path.join(runtimeDir, 'sunshine.deps.json')
        );
      } catch {}
    }
  }

  const configFile = path.join(configDir, 'sunshine.conf');
  if (!fs.existsSync(configFile)) {
    fs.writeFileSync(
      configFile,
      [
        `sunshine_name = ${os.hostname()}`,
        'engine = orbit-takeover',
        'takeover_port = 47995',
        'admin_port = 47990'
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

  return {
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
    computers: cfg.computers
  };
  fs.writeFileSync(getClientConfigPath(), JSON.stringify(copy, null, 2), 'utf8');
}

// ============================================================================
// Network & Crypto Helpers
// ============================================================================
function getNetworkAddresses() {
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
  return {
    hostname: os.hostname(),
    tailscaleIp,
    lanIp: lanIps[0] || null,
    primaryAddress: tailscaleIp || lanIps[0] || '127.0.0.1'
  };
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
        port: 47990,
        path: '/' + apiPath.replace(/^\/+/, ''),
        method,
        headers,
        rejectUnauthorized: false,
        timeout: 5000
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
    const socket = net.createConnection({ host: '127.0.0.1', port: 47990, timeout: 600 });
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
  const running = await isEngineProcessRunning();
  if (running) return true;

  const paths = ensureWindowsHostPrepared();
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
  return { host: trimmed, port: 47995 };
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
      await startLocalWindowsEngineIfNeeded();
      const paths = ensureWindowsHostPrepared();
      if (paths) {
        cachedFirewallAllowed = await runPowerShellCheck(path.join(paths.scriptsDir, 'check-firewall.ps1'));
      }
    }
    return {
      platform: process.platform,
      isWindows,
      network: getNetworkAddresses(),
      clientConfig: {qualityMode:loadClientConfig().qualityMode}
    };
  });

  // --- Windows Host Mode Handlers ---
  ipcMain.handle('host:get-status', async () => {
    if (!isWindows) return { supported: false };
    const paths = ensureWindowsHostPrepared();
    const running = await startLocalWindowsEngineIfNeeded();

    let configured = false;
    let savedUsername = 'orbit';
    if (paths && fs.existsSync(paths.stateFile)) {
      try {
        const st = JSON.parse(fs.readFileSync(paths.stateFile, 'utf8'));
        if (st.username) {
          configured = true;
          savedUsername = st.username;
        }
      } catch {}
    }

    let unlocked = false;
    let privilege = 'Standard';
    let desktop = 'Default';
    let activeSessions = 0;
    let pendingPairs = [];
    let pairedClients = [];

    if (running && hostAdminCredentials) {
      try {
        const cfgRes = await adminApiRequest('GET', 'api/config');
        if (cfgRes.data && cfgRes.data.status) {
          unlocked = true;
          privilege = cfgRes.data.privilege || 'Standard';
          desktop = cfgRes.data.desktop || 'Default';
          activeSessions = cfgRes.data.activeSessions || 0;
        }
        const pinRes = await adminApiRequest('GET', 'api/pin');
        if (pinRes.data && Array.isArray(pinRes.data.pairings)) {
          pendingPairs = pinRes.data.pairings;
        }
        const cliRes = await adminApiRequest('GET', 'api/clients/list');
        if (cliRes.data && Array.isArray(cliRes.data.named_certs)) {
          pairedClients = cliRes.data.named_certs;
        }
      } catch (err) {
        if (String(err.message).includes('Unauthorized')) {
          hostAdminCredentials = null;
        }
      }
    }

    if (!cachedFirewallAllowed && paths) {
      cachedFirewallAllowed = await runPowerShellCheck(path.join(paths.scriptsDir, 'check-firewall.ps1'));
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
    const paths = ensureWindowsHostPrepared();
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
    await new Promise((r) => setTimeout(r, 1200));
    cachedFirewallAllowed = await runPowerShellCheck(path.join(paths.scriptsDir, 'check-firewall.ps1'));
    return { ok: true, firewallAllowed: cachedFirewallAllowed };
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
    const canonical = port === 47995 ? host : `${host}:${port}`;
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
      try { return await current.start(); }
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
    return await checkAndApplyCodeUpdates({ manual: true, pullRemote: true });
  });
}

// ============================================================================
// Auto-Update & Live Code Sync Engine (GitHub + Local Workspace Watch)
// ============================================================================
const REPO_URL = 'https://github.com/aaronbiscotti/orbit-remote.git';

let updateInProgress = false;
let fileWatcherStarted = false;
let runtimeFileHashes = new Map();

function sha256File(filePath) {
  try {
    if (!fs.existsSync(filePath)) return '';
    return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
  } catch {
    return '';
  }
}

function listTrackedElectronFiles(electronDir) {
  const results = [];
  if (!fs.existsSync(electronDir)) return results;
  for (const entry of fs.readdirSync(electronDir, { withFileTypes: true })) {
    if (entry.isFile()) {
      results.push(entry.name);
    } else if (entry.isDirectory() && entry.name === 'assets') {
      const assetsDir = path.join(electronDir, 'assets');
      for (const asset of fs.readdirSync(assetsDir, { withFileTypes: true })) {
        if (asset.isFile()) {
          results.push(`assets/${asset.name}`);
        }
      }
    }
  }
  return results;
}

function snapshotRunningHashes() {
  for (const rel of listTrackedElectronFiles(__dirname)) {
    runtimeFileHashes.set(rel, sha256File(path.join(__dirname, rel)));
  }
}

function execCmd(bin, args, cwd, timeoutMs = 15000) {
  return new Promise((resolve) => {
    execFile(bin, args, { cwd, windowsHide: true, timeout: timeoutMs }, (err, stdout, stderr) => {
      resolve({
        ok: !err,
        stdout: String(stdout || '').trim(),
        stderr: String(stderr || '').trim()
      });
    });
  });
}

async function resolveAndSyncCodeSource(pullRemote = false) {
  const scratchRepo = path.join(os.homedir(), '.gemini', 'antigravity', 'scratch', 'orbit-remote');
  const syncRepo = path.join(app.getPath('userData'), 'repo-sync');

  let repoDir = null;
  let isScratchWorkspace = false;

  if (fs.existsSync(path.join(scratchRepo, 'electron', 'index.html'))) {
    repoDir = scratchRepo;
    isScratchWorkspace = true;
  } else if (fs.existsSync(path.join(syncRepo, 'electron', 'index.html'))) {
    repoDir = syncRepo;
  }

  if (pullRemote) {
    if (!repoDir) {
      fs.mkdirSync(path.dirname(syncRepo), { recursive: true });
      const cloneRes = await execCmd('git', ['clone', '--depth', '1', REPO_URL, syncRepo], os.homedir(), 25000);
      if (!cloneRes.ok) {
        await execCmd('gh', ['repo', 'clone', 'aaronbiscotti/orbit-remote', syncRepo, '--', '--depth', '1'], os.homedir(), 25000);
      }
      if (fs.existsSync(path.join(syncRepo, 'electron', 'index.html'))) {
        repoDir = syncRepo;
      }
    } else if (fs.existsSync(path.join(repoDir, '.git'))) {
      await execCmd('git', ['fetch', 'origin', 'main'], repoDir, 15000);
      if (isScratchWorkspace) {
        const st = await execCmd('git', ['status', '--porcelain'], repoDir, 5000);
        if (st.ok && !st.stdout) {
          await execCmd('git', ['merge', '--ff-only', 'origin/main'], repoDir, 10000);
        }
      } else {
        await execCmd('git', ['reset', '--hard', 'origin/main'], repoDir, 10000);
      }
    }
  }

  return repoDir;
}

async function getRepoShortCommit(repoDir) {
  if (!repoDir || !fs.existsSync(path.join(repoDir, '.git'))) return 'local';
  const res = await execCmd('git', ['rev-parse', '--short', 'HEAD'], repoDir, 4000);
  return res.ok && res.stdout ? res.stdout : 'local';
}

async function checkAndApplyCodeUpdates({ manual = false, pullRemote = false } = {}) {
  if (updateInProgress || isSmokeTest) {
    return { updated: false, message: 'Update check already running.' };
  }
  updateInProgress = true;
  try {
    const sourceRepo = await resolveAndSyncCodeSource(pullRemote);
    if (!sourceRepo) {
      return { updated: false, commit: 'v1.0.0', message: 'Up to date.' };
    }

    const commit = await getRepoShortCommit(sourceRepo);
    const srcElectronDir = path.join(sourceRepo, 'electron');
    const sameDir = path.resolve(srcElectronDir) === path.resolve(__dirname);

    let mainChanged = false;
    let uiChanged = false;

    for (const rel of listTrackedElectronFiles(srcElectronDir)) {
      const srcFile = path.join(srcElectronDir, rel);
      const dstFile = path.join(__dirname, rel);
      if (!fs.existsSync(srcFile)) continue;

      const srcHash = sha256File(srcFile);
      const dstHash = sameDir ? runtimeFileHashes.get(rel) || '' : sha256File(dstFile);

      if (srcHash && srcHash !== dstHash) {
        if (!sameDir) {
          fs.mkdirSync(path.dirname(dstFile), { recursive: true });
          fs.copyFileSync(srcFile, dstFile);
        }
        runtimeFileHashes.set(rel, srcHash);
        if (rel === 'main.js' || rel === 'preload.js' || rel.endsWith('session.js') || rel === 'protocol.js') {
          mainChanged = true;
        } else {
          uiChanged = true;
        }
      }
    }

    // Sync PowerShell helper scripts on Windows
    if (isWindows && !sameDir) {
      const srcScripts = path.join(sourceRepo, 'scripts');
      if (fs.existsSync(srcScripts)) {
        const paths = ensureWindowsHostPrepared();
        for (const f of fs.readdirSync(srcScripts)) {
          if (!f.endsWith('.ps1')) continue;
          const sFile = path.join(srcScripts, f);
          const sHash = sha256File(sFile);
          if (paths && paths.scriptsDir) {
            const wFile = path.join(paths.scriptsDir, f);
            if (sha256File(wFile) !== sHash) {
              try {
                fs.copyFileSync(sFile, wFile);
              } catch {}
            }
          }
        }
      }
    }

    if (mainChanged) {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('app:update-event', {
          status: 'restarting',
          commit,
          message: `Updated to ${commit} · Restarting Orbit...`
        });
      }
      setTimeout(() => {
        app.relaunch();
        app.exit(0);
      }, 650);
      return { updated: true, restarting: true, commit, message: `Updated to ${commit} · Restarting...` };
    }

    if (uiChanged) {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.reloadIgnoringCache();
        setTimeout(() => {
          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('app:update-event', {
              status: 'updated',
              commit,
              message: `Auto-updated UI to latest code (${commit})`
            });
          }
        }, 450);
      }
      return { updated: true, commit, message: `Updated to latest code (${commit}).` };
    }

    return {
      updated: false,
      commit,
      message: manual ? `Orbit is up to date (${commit}).` : ''
    };
  } catch {
    return { updated: false, message: manual ? 'Update check completed.' : '' };
  } finally {
    updateInProgress = false;
  }
}

async function startAutoUpdateEngine() {
  if (isSmokeTest) return;
  snapshotRunningHashes();

  const sourceRepo = await resolveAndSyncCodeSource(false);
  if (sourceRepo && !fileWatcherStarted) {
    const watchDir = path.join(sourceRepo, 'electron');
    if (fs.existsSync(watchDir)) {
      fileWatcherStarted = true;
      let debounceTimer = null;
      try {
        fs.watch(watchDir, { recursive: true }, () => {
          if (debounceTimer) clearTimeout(debounceTimer);
          debounceTimer = setTimeout(() => {
            checkAndApplyCodeUpdates({ manual: false, pullRemote: false });
          }, 350);
        });
      } catch {}
    }
  }

  setTimeout(() => {
    checkAndApplyCodeUpdates({ manual: false, pullRemote: true });
  }, 2000);

  setInterval(() => {
    checkAndApplyCodeUpdates({ manual: false, pullRemote: true });
  }, 45000);
}

// ============================================================================
// Window Lifecycle
// ============================================================================
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 720,
    height: 580,
    minWidth: 540,
    minHeight: 480,
    backgroundColor: '#000000',
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
        const snapArg = process.argv.find((a) => a.startsWith('--capture-ui='));
        if (snapArg) {
          const outPath = snapArg.slice('--capture-ui='.length);
          const img = await mainWindow.webContents.capturePage();
          fs.writeFileSync(outPath, img.toPNG());
        }
        console.log('PASS: Orbit Electron app loaded and verified.');
        app.exit(0);
      }, 1400);
    });
  }
}

app.whenReady().then(async () => {
  registerIpcHandlers();
  if (isWindows && !isSmokeTest) {
    await startLocalWindowsEngineIfNeeded();
  }
  createWindow();
  startAutoUpdateEngine();

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
