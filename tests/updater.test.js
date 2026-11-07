const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { downloadNewerBuild, pickTarget, installMac } = require('../electron/updater');

const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');

test('only a newer build with a safe file name and a real fingerprint is picked', () => {
  const m = { run: 5, mac: { name: 'Orbit-mac-arm64.zip', sha256: 'a'.repeat(64) }, win: { name: 'Orbit-Setup-win-x64.exe', sha256: 'b'.repeat(64) } };
  assert.equal(pickTarget(m, { run: 4 }, 'darwin').name, 'Orbit-mac-arm64.zip');
  assert.equal(pickTarget(m, { run: 4 }, 'win32').name, 'Orbit-Setup-win-x64.exe');
  assert.equal(pickTarget(m, { run: 5 }, 'darwin'), null);
  assert.equal(pickTarget({ ...m, mac: { name: '../evil.zip', sha256: 'a'.repeat(64) } }, { run: 0 }, 'darwin'), null);
  assert.equal(pickTarget(m, { run: 0 }, 'linux'), null);
});

test('downloads the newer build, never sends the token to storage, and rejects a wrong fingerprint', async (t) => {
  const zip = Buffer.from('new app bytes');
  const manifest = { run: 9, mac: { name: 'Orbit-mac-arm64.zip', sha256: sha(zip) } };
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, opts = {}) => {
    calls.push({ url, auth: opts.headers?.Authorization });
    if (url.endsWith('/releases/latest')) return Response.json({ assets: [
      { name: 'update.json', url: 'https://api.github.com/assets/1' }, { name: 'Orbit-mac-arm64.zip', url: 'https://api.github.com/assets/2' }] });
    if (url.startsWith('https://api.github.com/assets/')) return new Response(null, { status: 302, headers: { location: `https://storage.example/${url.at(-1)}` } });
    if (url === 'https://storage.example/1') return Response.json(manifest);
    if (url === 'https://storage.example/2') return new Response(zip);
    throw new Error(`unexpected ${url}`);
  });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-update-'));
  const found = await downloadNewerBuild({ build: { run: 3 }, platform: 'darwin', token: 'T', dir });
  assert.equal(found.run, 9);
  assert.equal(fs.readFileSync(found.file, 'utf8'), 'new app bytes');
  assert.ok(calls.filter((c) => c.url.startsWith('https://storage.example')).every((c) => !c.auth));
  assert.equal(await downloadNewerBuild({ build: { run: 9 }, platform: 'darwin', token: 'T', dir }), null);
  manifest.mac.sha256 = '0'.repeat(64);
  await assert.rejects(downloadNewerBuild({ build: { run: 3 }, platform: 'darwin', token: 'T', dir }), /fingerprint/);
  assert.equal(fs.existsSync(found.file), false);
});

test('swaps the Mac app bundle in place and keeps the old one aside', { skip: process.platform !== 'darwin' }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-swap-'));
  const make = (dir, text) => { fs.mkdirSync(path.join(dir, 'Contents', 'MacOS'), { recursive: true }); fs.writeFileSync(path.join(dir, 'Contents', 'MacOS', 'Orbit'), text); };
  const bundle = path.join(root, 'Orbit.app');
  make(bundle, 'old');
  const build = path.join(root, 'build', 'Orbit.app');
  make(build, 'new');
  const zip = path.join(root, 'update.zip');
  execFileSync('ditto', ['-c', '-k', '--keepParent', build, zip]);
  await installMac(zip, bundle);
  assert.equal(fs.readFileSync(path.join(bundle, 'Contents', 'MacOS', 'Orbit'), 'utf8'), 'new');
  assert.equal(fs.readFileSync(path.join(`${bundle}.old`, 'Contents', 'MacOS', 'Orbit'), 'utf8'), 'old');
  assert.equal(fs.existsSync(`${bundle}.update`), false);
});
