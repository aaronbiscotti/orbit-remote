// Updates Orbit from full builds that CI publishes as GitHub releases (see .github/workflows/build.yml).
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { Readable, Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { execFile, spawn } = require('node:child_process');

const REPO = 'aaronbiscotti/orbit-remote';

function run(cmd, args, input = '') {
  // Apps opened from Finder get a short PATH; add Homebrew's so the GitHub CLI is found.
  const extra = process.platform === 'darwin' ? ['/opt/homebrew/bin', '/usr/local/bin'] : [];
  const env = { ...process.env, PATH: [process.env.PATH, ...extra].join(path.delimiter), GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' };
  return new Promise((resolve) => {
    const child = execFile(cmd, args, { timeout: 15000, windowsHide: true, env }, (error, stdout) => resolve(error ? '' : String(stdout).trim()));
    child.stdin?.end(input);
  });
}

// The repo is private, so use the GitHub login already on this computer: GitHub CLI first, then git's saved login.
async function githubToken() {
  const fromCli = await run('gh', ['auth', 'token']);
  if (fromCli) return fromCli;
  return /^password=(.+)$/m.exec(await run('git', ['credential', 'fill'], 'protocol=https\nhost=github.com\n\n'))?.[1] ?? '';
}

async function github(url, token, accept, timeoutMs, redirect = 'follow') {
  const res = await fetch(url.startsWith('https://') ? url : `https://api.github.com${url}`, {
    headers: { Accept: accept, Authorization: `Bearer ${token}`, 'User-Agent': 'Orbit-updater', 'X-GitHub-Api-Version': '2022-11-28' },
    redirect,
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (res.ok || (redirect === 'manual' && res.status >= 300 && res.status < 400)) return res;
  throw Object.assign(new Error(`GitHub answered ${res.status}`), { status: res.status });
}

async function assetResponse(asset, token, timeoutMs) {
  const res = await github(asset.url, token, 'application/octet-stream', timeoutMs, 'manual');
  if (res.status < 300 || res.status >= 400) return res;
  // The bytes live on a signed storage URL; the GitHub token must not be sent there.
  const stored = await fetch(res.headers.get('location'), { signal: AbortSignal.timeout(timeoutMs) });
  if (!stored.ok) throw new Error(`the download failed (${stored.status})`);
  return stored;
}

// The file for this computer, if the release is newer than the running build.
function pickTarget(manifest, build, platform) {
  if (!(Number(manifest.run) > Number(build.run))) return null;
  const target = platform === 'darwin' ? manifest.mac : platform === 'win32' ? manifest.win : null;
  return target && /^[\w.-]+$/.test(target.name) && /^[0-9a-f]{64}$/i.test(target.sha256) ? target : null;
}

async function saveWithFingerprint(res, file) {
  const hash = crypto.createHash('sha256');
  const tap = new Transform({ transform(chunk, _enc, done) { hash.update(chunk); done(null, chunk); } });
  await pipeline(Readable.fromWeb(res.body), tap, fs.createWriteStream(file));
  return hash.digest('hex');
}

// Returns { run, file } for a downloaded, verified newer build, or null when this build is current.
async function downloadNewerBuild({ build, platform, token, dir }) {
  const latest = await github(`/repos/${REPO}/releases/latest`, token, 'application/vnd.github+json', 30000)
    .catch((error) => { if (error.status === 404) return null; throw error; }); // no release published yet
  if (!latest) return null;
  const release = await latest.json();
  const manifestAsset = release.assets?.find((a) => a.name === 'update.json');
  if (!manifestAsset) return null;
  const manifest = await (await assetResponse(manifestAsset, token, 30000)).json();
  const target = pickTarget(manifest, build, platform);
  const asset = target && release.assets.find((a) => a.name === target.name);
  if (!asset) return null;
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, target.name);
  const sha = await saveWithFingerprint(await assetResponse(asset, token, 600000), file);
  if (sha !== target.sha256.toLowerCase()) {
    fs.rmSync(file, { force: true });
    throw new Error('the download did not match its fingerprint');
  }
  return { run: Number(manifest.run), file };
}

// Swap the whole app: unpack beside the current one, then two renames on the same disk.
async function installMac(zipFile, bundle) {
  if (!bundle.endsWith('.app')) throw new Error('Orbit is not running from an app bundle');
  const staging = `${bundle}.update`;
  fs.rmSync(staging, { recursive: true, force: true });
  await new Promise((resolve, reject) => execFile('ditto', ['-x', '-k', zipFile, staging], (error) => (error ? reject(error) : resolve())));
  const name = fs.readdirSync(staging).find((n) => n.endsWith('.app'));
  if (!name || !fs.existsSync(path.join(staging, name, 'Contents', 'MacOS'))) throw new Error('the update does not contain the app');
  const old = `${bundle}.old`;
  fs.rmSync(old, { recursive: true, force: true });
  fs.renameSync(bundle, old);
  try {
    fs.renameSync(path.join(staging, name), bundle);
  } catch (error) {
    fs.renameSync(old, bundle);
    throw error;
  }
  fs.rmSync(staging, { recursive: true, force: true });
}

// The replaced app is deleted by the new one, since the old process reads its own files until it exits.
function removeOldBundle(bundle) {
  fs.rm(`${bundle}.old`, { recursive: true, force: true }, () => {});
}

// electron-builder's installer: /S installs silently, --updated --force-run reopens Orbit afterwards.
function installWindows(installer) {
  spawn(installer, ['/S', '--updated', '--force-run'], { detached: true, stdio: 'ignore' }).unref();
}

module.exports = { githubToken, downloadNewerBuild, pickTarget, installMac, installWindows, removeOldBundle };
