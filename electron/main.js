const { app, BrowserWindow, ipcMain, clipboard, dialog, powerSaveBlocker, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const net = require('net');
const tls = require('tls');
const https = require('https');
const crypto = require('crypto');
const { spawn, execFile } = require('child_process');

// Enable GPU rasterization and zero-copy canvas acceleration for ultra-low-latency tile rendering
app.commandLine.appendSwitch('enable-gpu-rasterization');
app.commandLine.appendSwitch('enable-zero-copy');
app.commandLine.appendSwitch('ignore-gpu-blocklist');

const isSmokeTest = process.argv.includes('--smoke-test');
const isWindows = process.platform === 'win32';

let mainWindow = null;
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
  if (fs.existsSync(path.join(srcEngine, 'Orbit.Host.exe')) && !fs.existsSync(agentExe)) {
    for (const file of fs.readdirSync(srcEngine)) {
      const fullSrc = path.join(srcEngine, file);
      if (fs.statSync(fullSrc).isFile()) {
        fs.copyFileSync(fullSrc, path.join(runtimeDir, file));
      }
    }
    fs.copyFileSync(path.join(srcEngine, 'Orbit.Host.exe'), agentExe);
    if (fs.existsSync(path.join(srcEngine, 'Orbit.Host.runtimeconfig.json'))) {
      fs.copyFileSync(
        path.join(srcEngine, 'Orbit.Host.runtimeconfig.json'),
        path.join(runtimeDir, 'sunshine.runtimeconfig.json')
      );
    }
    if (fs.existsSync(path.join(srcEngine, 'Orbit.Host.deps.json'))) {
      fs.copyFileSync(
        path.join(srcEngine, 'Orbit.Host.deps.json'),
        path.join(runtimeDir, 'sunshine.deps.json')
      );
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

function computeAuthProof(tokenHashHex, serverNonce, certSha256Hex) {
  const key = Buffer.from(tokenHashHex, 'hex');
  return crypto
    .createHmac('sha256', key)
    .update(`${serverNonce}:${certSha256Hex.toLowerCase()}`, 'utf8')
    .digest('hex')
    .toLowerCase();
}

function writeProtocolFrame(socket, jsonObj, binaryBuffer = null) {
  if (!socket || socket.destroyed) return;
  const jsonBytes = Buffer.from(JSON.stringify(jsonObj), 'utf8');
  const binBytes = binaryBuffer ? Buffer.from(binaryBuffer) : Buffer.alloc(0);
  const header = Buffer.allocUnsafe(8);
  header.writeInt32BE(jsonBytes.length, 0);
  header.writeInt32BE(binBytes.length, 4);
  socket.write(header);
  socket.write(jsonBytes);
  if (binBytes.length > 0) socket.write(binBytes);
}

class FrameAccumulator {
  constructor(onFrame) {
    this.chunks = [];
    this.totalLength = 0;
    this.onFrame = onFrame;
  }

  push(chunk) {
    this.chunks.push(chunk);
    this.totalLength += chunk.length;
    this.drain();
  }

  drain() {
    while (this.totalLength >= 8) {
      const combined = this.chunks.length === 1 ? this.chunks[0] : Buffer.concat(this.chunks, this.totalLength);
      this.chunks = [combined];

      const jsonLen = combined.readInt32BE(0);
      const binLen = combined.readInt32BE(4);
      if (jsonLen <= 0 || jsonLen > 4 * 1024 * 1024 || binLen < 0 || binLen > 32 * 1024 * 1024) {
        this.chunks = [];
        this.totalLength = 0;
        return;
      }

      const frameTotal = 8 + jsonLen + binLen;
      if (this.totalLength < frameTotal) return;

      const jsonSlice = combined.subarray(8, 8 + jsonLen);
      const binSlice = binLen > 0 ? Buffer.from(combined.subarray(8 + jsonLen, frameTotal)) : Buffer.alloc(0);

      const remainder = combined.subarray(frameTotal);
      this.chunks = remainder.length > 0 ? [remainder] : [];
      this.totalLength = remainder.length;

      try {
        const parsed = JSON.parse(jsonSlice.toString('utf8'));
        this.onFrame(parsed, binSlice);
      } catch {}
    }
  }
}

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
          certSha256: json.paired && !entry.certSha256 ? (json.certSha256 || '') : entry.certSha256
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
      clientConfig: loadClientConfig()
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

    pairSocket = tls.connect({ host, port, rejectUnauthorized: false }, () => {
      pairSocket.setNoDelay(true);
    });

    const acc = new FrameAccumulator((json) => {
      if (json.type === 'hello') {
        const certSha256 = String(json.certSha256 || '').toLowerCase();
        const commitment = computePairingCommitment(pin, certSha256, cfg.clientId, cfg.tokenHashHex);
        writeProtocolFrame(pairSocket, {
          type: 'pair_request',
          clientId: cfg.clientId,
          clientName: os.hostname(),
          tokenHash: cfg.tokenHashHex,
          commitment
        });
      } else if (json.type === 'pair_status') {
        if (json.paired) {
          const freshCfg = loadClientConfig();
          const pc = freshCfg.computers.find((c) => c.address.toLowerCase() === String(address).toLowerCase());
          if (pc) {
            pc.paired = true;
            pc.online = true;
            pc.name = json.hostname || pc.name;
            pc.certSha256 = String(json.certSha256 || '').toLowerCase();
            saveClientConfig(freshCfg);
          }
        }
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('client:pair-Complete', {
            paired: Boolean(json.paired),
            address,
            hostname: json.hostname || host,
            error: json.error || ''
          });
        }
        try {
          pairSocket.destroy();
        } catch {}
        pairSocket = null;
      }
    });

    pairSocket.on('data', (chunk) => acc.push(chunk));
    pairSocket.on('error', (err) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('client:pair-Complete', {
          paired: false,
          address,
          error: err.message
        });
      }
    });

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

  ipcMain.handle('client:connect', (_event, { address, quality, monitor }) => {
    if (sessionSocket) {
      try {
        sessionSocket.destroy();
      } catch {}
      sessionSocket = null;
    }

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

          const proof = computeAuthProof(cfg.tokenHashHex, json.nonce, actualFp);
          writeProtocolFrame(sock, {
            type: 'auth',
            clientId: cfg.clientId,
            clientName: os.hostname(),
            proof,
            quality: quality || cfg.qualityMode || 'crisp',
            monitor: monitor || 0
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
          if (!authResolved) {
            authResolved = true;
            resolve({
              hostname: json.hostname || host,
              privilege: json.privilege || 'Standard',
              desktop: json.desktop || 'Default',
              secureDesktop: Boolean(json.secureDesktop),
              monitors: json.monitors || [],
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
        if (sessionSocket === sock) sessionSocket = null;
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('client:disconnected', { reason: 'Connection closed' });
        }
      });
    });
  });

  ipcMain.handle('client:disconnect', () => {
    if (sessionSocket) {
      try {
        sessionSocket.destroy();
      } catch {}
      sessionSocket = null;
    }
    return { ok: true };
  });

  ipcMain.on('client:send', (_event, payload) => {
    if (sessionSocket && !sessionSocket.destroyed) {
      writeProtocolFrame(sessionSocket, payload);
    }
  });

  ipcMain.handle('client:sync-clipboard-to-pc', () => {
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
    backgroundColor: '#09090b',
    title: 'Orbit',
    icon: path.join(__dirname, 'assets', isWindows ? 'icon.ico' : 'icon.png'),
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false
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

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (powerBlockerId !== null && powerSaveBlocker.isStarted(powerBlockerId)) {
    powerSaveBlocker.stop(powerBlockerId);
  }
  if (process.platform !== 'darwin') app.quit();
});
