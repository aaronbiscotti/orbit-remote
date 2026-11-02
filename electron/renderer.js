/* global orbit */
const state = {
  isWindows: false,
  mode: 'client', // 'host' | 'client' | 'session'
  activeTab: 'desktop',
  computers: [],
  quality: 'crisp',
  privacyCurtain: false,
  currentFsPath: '',
  parentFsPath: 'drives',
  bytesThisSecond: 0,
  tilesThisSecond: 0,
  remoteWidth: 1920,
  remoteHeight: 1080
};

const el = (id) => document.getElementById(id);

// High-speed GPU-accelerated Desktop Canvas
const canvas = el('desktopCanvas');
const ctx = canvas.getContext('2d', { alpha: false, desynchronized: true });

function setNotice(text) {
  el('footerNotice').textContent = text || '';
  const hostNotice = el('hostStatusNotice');
  if (text) {
    hostNotice.textContent = text;
    hostNotice.classList.remove('hidden');
  } else {
    hostNotice.classList.add('hidden');
  }
}

function switchView(newMode) {
  state.mode = newMode;
  el('hostView').classList.toggle('hidden', newMode !== 'host');
  el('clientHomeView').classList.toggle('hidden', newMode !== 'client');
  el('sessionView').classList.toggle('hidden', newMode !== 'session');

  el('homeHeaderControls').classList.toggle('hidden', newMode === 'session');
  el('sessionHeaderControls').classList.toggle('hidden', newMode !== 'session');
  el('disconnectBtn').classList.toggle('hidden', newMode !== 'session');
  el('clientHomeButtons').classList.toggle('hidden', newMode !== 'client');

  el('modeHostBtn').classList.toggle('active', newMode === 'host');
  el('modeClientBtn').classList.toggle('active', newMode === 'client');

  if (newMode !== 'session') {
    el('headerTitle').textContent = 'Orbit';
    el('privilegeBadge').classList.add('hidden');
    el('uacAlertBadge').classList.add('hidden');
  }
}

// ============================================================================
// Windows Host Dashboard Polling & Controls
// ============================================================================
async function refreshHostDashboard() {
  if (!state.isWindows || state.mode !== 'host') return;
  try {
    const status = await window.orbit.getHostStatus();
    if (!status.supported) return;

    el('hostComputerName').textContent = status.network.hostname;
    el('hostAddressInput').value = status.network.primaryAddress;
    el('hostNetworkHint').textContent = status.network.tailscaleIp
      ? `● Tailscale connected · ${status.network.tailscaleIp}`
      : `Local network · ${status.network.primaryAddress}`;

    el('hostStatusPill').textContent = !status.running
      ? '○ OS Takeover starting…'
      : status.activeSessions > 0
      ? `● Mac connected (${status.activeSessions})`
      : '● OS Takeover ready';

    if (status.configured && !el('hostUsername').dataset.touched) {
      el('hostUsername').value = status.savedUsername || 'orbit';
    }

    el('hostLoginTitle').textContent = status.configured ? 'Unlock pairing' : 'Protect your PC';
    el('hostLoginHint').textContent = status.configured
      ? 'Enter your Orbit Host password to approve a Mac.'
      : 'Choose a password of at least 12 characters to approve your Mac.';
    el('hostUnlockBtn').textContent = status.configured ? 'Unlock & continue →' : 'Save & continue →';

    const step = !status.unlocked ? 0 : !status.firewallAllowed ? 1 : 2;
    el('hostStep1').classList.toggle('hidden', step !== 0);
    el('hostStep2').classList.toggle('hidden', step !== 1);
    el('hostStep3').classList.toggle('hidden', step !== 2);

    [el('stepBadge1'), el('stepBadge2'), el('stepBadge3')].forEach((badge, idx) => {
      badge.classList.toggle('active', idx === step);
      badge.classList.toggle('done', idx < step);
    });

    // Pending pairings
    const pending = status.pendingPairs || [];
    el('hostPairBox').classList.toggle('hidden', pending.length === 0);
    if (pending.length > 0) {
      el('hostPendingLabel').textContent = `Enter the 4-digit code shown on ${pending[0].name}:`;
      el('hostApprovePairBtn').dataset.pairingId = pending[0].id;
      el('hostApprovePairBtn').dataset.pairingName = pending[0].name;
    }

    // Paired Macs list
    const clients = status.pairedClients || [];
    el('hostPairedCount').textContent = `${clients.length} paired`;
    const listEl = el('hostPairedList');
    listEl.innerHTML = '';
    for (const cli of clients) {
      const row = document.createElement('div');
      row.className = 'paired-item';
      row.innerHTML = `<span><strong>${cli.name}</strong></span>`;
      const btn = document.createElement('button');
      btn.className = 'btn btn-subtle btn-sm';
      btn.textContent = 'Remove access';
      btn.onclick = async () => {
        await window.orbit.revokeClient(cli.uuid);
        refreshHostDashboard();
      };
      row.appendChild(btn);
      listEl.appendChild(row);
    }

    // Privilege status
    const isAdminOrSys = status.privilege === 'SYSTEM' || status.privilege === 'Administrator';
    el('hostAdminTitle').textContent =
      status.privilege === 'SYSTEM'
        ? '✓ Full OS Takeover (SYSTEM & UAC Ready)'
        : isAdminOrSys
        ? '✓ Administrator control enabled'
        : 'OS Takeover & UAC Prompts';
    el('hostEnableAdminBtn').classList.toggle('hidden', isAdminOrSys);
  } catch (err) {
    setNotice(err.message);
  }
}

// ============================================================================
// Client PC Grid & Pairing
// ============================================================================
function renderComputersGrid(computers) {
  state.computers = computers || [];
  const empty = state.computers.length === 0;
  el('emptyPcState').classList.toggle('hidden', !empty);
  el('pcCardsGrid').classList.toggle('hidden', empty);

  const grid = el('pcCardsGrid');
  grid.innerHTML = '';
  for (const pc of state.computers) {
    const card = document.createElement('div');
    card.className = `pc-card ${pc.online ? 'online' : ''}`;
    const statusLabel = !pc.online
      ? 'Offline'
      : pc.privilege === 'SYSTEM'
      ? '● Online · SYSTEM & UAC Ready'
      : `● Online · ${pc.privilege || 'Standard'}`;

    card.innerHTML = `
      <div class="row-between">
        <div>
          <div class="card-title-lg">${pc.name}</div>
          <div class="muted-text mono">${pc.address}</div>
        </div>
        <button class="btn btn-subtle btn-sm remove-pc-btn" title="Remove PC">✕</button>
      </div>
      <div class="muted-text" style="color: ${pc.online ? '#a6d7bd' : '#8e98b0'}">${statusLabel}</div>
      <button class="btn ${pc.online ? 'btn-accent' : 'btn-subtle'} connect-pc-btn" style="width:100%">
        ${!pc.online ? 'Offline (Click to Retry)' : pc.paired ? 'Take Over PC →' : 'Pair This Mac →'}
      </button>
    `;

    card.querySelector('.remove-pc-btn').onclick = async (e) => {
      e.stopPropagation();
      const updated = await window.orbit.removePc(pc.address);
      renderComputersGrid(updated);
    };

    card.querySelector('.connect-pc-btn').onclick = async () => {
      if (!pc.online) {
        refreshClientPcs();
        return;
      }
      if (pc.paired) {
        startTakeoverSession(pc.address);
      } else {
        const res = await window.orbit.startPairing(pc.address);
        el('pairModalTitle').textContent = `Pair with ${pc.name}`;
        el('pairPinDisplay').textContent = res.pin;
        el('pairModal').classList.remove('hidden');
      }
    };

    grid.appendChild(card);
  }
}

async function refreshClientPcs() {
  const pcs = await window.orbit.listPcs();
  renderComputersGrid(pcs);
}

// ============================================================================
// High-Performance Dirty-Tile Desktop Rendering & Input
// ============================================================================
async function startTakeoverSession(address) {
  try {
    setNotice(`Connecting to ${address}…`);
    const info = await window.orbit.connectToPc(address, state.quality, 0);
    setNotice('');
    switchView('session');
    el('headerTitle').textContent = info.hostname;
    updateSessionBadges(info.privilege, info.desktop, info.secureDesktop, info.privacyCurtain);
    canvas.focus();
  } catch (err) {
    setNotice(err.message);
  }
}

function updateSessionBadges(privilege, desktop, secureDesktop, privacyCurtain) {
  const privBadge = el('privilegeBadge');
  privBadge.classList.remove('hidden');
  privBadge.textContent = privilege === 'SYSTEM' ? '✓ SYSTEM · UAC Ready' : privilege;

  const uacBadge = el('uacAlertBadge');
  uacBadge.classList.toggle('hidden', !secureDesktop);
  if (secureDesktop) {
    uacBadge.textContent = `⚡ UAC / Lock Screen Active (${desktop})`;
  }

  if (typeof privacyCurtain === 'boolean') {
    state.privacyCurtain = privacyCurtain;
    el('curtainBtn').textContent = privacyCurtain ? '● PC Screen Blanked' : 'Blank PC Screen';
  }
}

// Subscribe to binary dirty-tile frames from main process
window.orbit.onFrame(async (meta, binBuffer) => {
  if (meta.screenW > 0 && meta.screenH > 0) {
    if (canvas.width !== meta.screenW || canvas.height !== meta.screenH) {
      canvas.width = meta.screenW;
      canvas.height = meta.screenH;
      state.remoteWidth = meta.screenW;
      state.remoteHeight = meta.screenH;
    }
  }

  updateSessionBadges(meta.privilege, meta.desktop, meta.secureDesktop, undefined);

  const tiles = meta.tiles || [];
  const u8 = binBuffer instanceof Uint8Array ? binBuffer : new Uint8Array(binBuffer);
  state.bytesThisSecond += u8.byteLength;
  state.tilesThisSecond += tiles.length;

  // Decode all dirty sub-tiles in parallel on the GPU via createImageBitmap
  const decodeJobs = tiles.map(async (t) => {
    const slice = u8.subarray(t.offset, t.offset + t.length);
    const mime = t.format === 'jpeg' ? 'image/jpeg' : 'image/png';
    const bmp = await createImageBitmap(new Blob([slice], { type: mime }));
    return { x: t.x, y: t.y, bmp };
  });

  const decoded = await Promise.all(decodeJobs);
  for (const item of decoded) {
    ctx.drawImage(item.bmp, item.x, item.y);
    item.bmp.close();
  }

  // Immediately send frame_ack backpressure acknowledgement
  window.orbit.send({ type: 'frame_ack', seq: meta.seq });
});

function mapCanvasNormCoords(clientX, clientY) {
  const rect = canvas.getBoundingClientRect();
  if (rect.width <= 1 || rect.height <= 1) return { x: 0.5, y: 0.5 };
  const x = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
  const y = Math.min(1, Math.max(0, (clientY - rect.top) / rect.height));
  return { x, y };
}

function mouseButtonName(btn) {
  if (btn === 2) return 'right';
  if (btn === 1) return 'middle';
  return 'left';
}

canvas.addEventListener('mousemove', (e) => {
  if (state.mode !== 'session') return;
  const pt = mapCanvasNormCoords(e.clientX, e.clientY);
  window.orbit.send({ type: 'mouse', action: 'move', x: pt.x, y: pt.y, button: 'left' });
});

canvas.addEventListener('mousedown', (e) => {
  canvas.focus();
  const pt = mapCanvasNormCoords(e.clientX, e.clientY);
  window.orbit.send({ type: 'mouse', action: 'down', x: pt.x, y: pt.y, button: mouseButtonName(e.button) });
});

canvas.addEventListener('mouseup', (e) => {
  const pt = mapCanvasNormCoords(e.clientX, e.clientY);
  window.orbit.send({ type: 'mouse', action: 'up', x: pt.x, y: pt.y, button: mouseButtonName(e.button) });
});

canvas.addEventListener('dblclick', (e) => {
  const pt = mapCanvasNormCoords(e.clientX, e.clientY);
  window.orbit.send({ type: 'mouse', action: 'dblclick', x: pt.x, y: pt.y, button: mouseButtonName(e.button) });
});

canvas.addEventListener('contextmenu', (e) => e.preventDefault());

canvas.addEventListener(
  'wheel',
  (e) => {
    e.preventDefault();
    const pt = mapCanvasNormCoords(e.clientX, e.clientY);
    window.orbit.send({
      type: 'mouse',
      action: 'wheel',
      x: pt.x,
      y: pt.y,
      button: 'left',
      deltaX: Math.round(-e.deltaX),
      deltaY: Math.round(-e.deltaY)
    });
  },
  { passive: false }
);

canvas.addEventListener('keydown', (e) => {
  if (state.mode !== 'session' || state.activeTab !== 'desktop') return;
  e.preventDefault();
  const vk = e.keyCode || e.which || 0;
  if (!vk) return;
  const ctrl = e.ctrlKey || ( !state.isWindows && e.metaKey );
  window.orbit.send({
    type: 'key',
    action: 'press',
    vk,
    ctrl,
    alt: e.altKey,
    shift: e.shiftKey,
    win: state.isWindows ? e.metaKey : false
  });
});

// ============================================================================
// Events from Remote OS Takeover Server (Terminal, Files, Processes)
// ============================================================================
window.orbit.onEvent((msg) => {
  if (msg.type === 'privacy_curtain_result') {
    updateSessionBadges(el('privilegeBadge').textContent, '', !el('uacAlertBadge').classList.contains('hidden'), msg.enabled);
  } else if (msg.type === 'exec_result') {
    const out = el('terminalOutput');
    if (msg.stdout) out.textContent += `\n${msg.stdout}`;
    if (msg.stderr) out.textContent += `\n[stderr] ${msg.stderr}`;
    out.scrollTop = out.scrollHeight;
    el('terminalHeaderLabel').textContent = `Remote Windows PowerShell (${msg.cwd || 'C:\\'})`;
  } else if (msg.type === 'fs_list_result') {
    state.currentFsPath = msg.path || '';
    state.parentFsPath = msg.parent || 'drives';
    el('fsPathInput').value = state.currentFsPath;
    renderFileEntries(msg.entries || []);
  } else if (msg.type === 'fs_upload_result' || msg.type === 'fs_delete_result') {
    window.orbit.send({ type: 'fs_list', path: state.currentFsPath || 'drives' });
  } else if (msg.type === 'download_saved') {
    setNotice(`Downloaded file to ${msg.path}`);
  } else if (msg.type === 'proc_list_result') {
    renderProcessEntries(msg.processes || []);
  } else if (msg.type === 'proc_kill_result') {
    window.orbit.send({ type: 'proc_list' });
  }
});

window.orbit.onPairComplete((data) => {
  el('pairModal').classList.add('hidden');
  if (data.paired) {
    setNotice(`Paired with ${data.hostname}! Click Take Over PC to connect.`);
    refreshClientPcs();
  } else if (data.error) {
    setNotice(data.error);
  }
});

window.orbit.onDisconnected(() => {
  if (state.mode === 'session') {
    switchView('client');
    setNotice('Disconnected from PC.');
    refreshClientPcs();
  }
});

function renderFileEntries(entries) {
  const container = el('fsListContainer');
  container.innerHTML = '';
  for (const item of entries) {
    const row = document.createElement('div');
    row.className = 'list-row';
    const meta = item.isDir ? item.modified : `${Math.round((item.size || 0) / 1024)} KB · ${item.modified}`;
    row.innerHTML = `
      <span>${item.isDir ? '📁' : '📄'} &nbsp;<strong>${item.name}</strong></span>
      <div class="row-gap">
        <span class="muted-text">${meta}</span>
        <button class="btn btn-subtle btn-sm action-btn">${item.isDir ? 'Open' : 'Download to Mac'}</button>
      </div>
    `;
    row.querySelector('.action-btn').onclick = () => {
      if (item.isDir) {
        window.orbit.send({ type: 'fs_list', path: item.path });
      } else {
        window.orbit.send({ type: 'fs_download', path: item.path });
      }
    };
    container.appendChild(row);
  }
}

function renderProcessEntries(procs) {
  el('procCountLabel').textContent = `Windows Task Manager (${procs.length} processes)`;
  const container = el('procListContainer');
  container.innerHTML = '';
  for (const p of procs) {
    const row = document.createElement('div');
    row.className = 'list-row';
    row.innerHTML = `
      <div>
        <strong>${p.name}</strong> <span class="muted-text">(PID ${p.pid})</span>
        ${p.elevated ? '<span class="badge badge-green" style="margin-left:8px">Elevated</span>' : ''}
        <span class="muted-text" style="margin-left:10px">${p.title || ''}</span>
      </div>
      <div class="row-gap">
        <span style="color:#a6d7bd">${p.memoryMb} MB</span>
        <button class="btn btn-danger btn-sm kill-btn">End Task</button>
      </div>
    `;
    row.querySelector('.kill-btn').onclick = () => {
      window.orbit.send({ type: 'proc_kill', pid: p.pid });
    };
    container.appendChild(row);
  }
}

// ============================================================================
// UI Button Bindings & Initialization
// ============================================================================
el('modeHostBtn').onclick = () => {
  switchView('host');
  refreshHostDashboard();
};
el('modeClientBtn').onclick = () => {
  switchView('client');
  refreshClientPcs();
};

el('hostUsername').oninput = () => {
  el('hostUsername').dataset.touched = '1';
};

el('hostUnlockBtn').onclick = async () => {
  try {
    setNotice('');
    await window.orbit.unlockHost(el('hostUsername').value, el('hostPassword').value);
    el('hostPassword').value = '';
    await refreshHostDashboard();
  } catch (err) {
    setNotice(err.message);
  }
};

el('hostAllowFwBtn').onclick = async () => {
  try {
    setNotice('Approve the Windows administrator prompt…');
    await window.orbit.enableFirewall();
    setNotice('');
    await refreshHostDashboard();
  } catch (err) {
    setNotice(err.message);
  }
};

el('hostCheckFwBtn').onclick = async () => {
  await window.orbit.checkFirewall();
  await refreshHostDashboard();
};

el('hostCopyAddrBtn').onclick = async () => {
  await window.orbit.copyText(el('hostAddressInput').value);
  el('hostCopyAddrBtn').textContent = 'Copied ✓';
  setTimeout(() => {
    el('hostCopyAddrBtn').textContent = 'Copy address';
  }, 1500);
};

el('hostApprovePairBtn').onclick = async () => {
  try {
    const btn = el('hostApprovePairBtn');
    await window.orbit.pairMac(btn.dataset.pairingId, el('hostPinInput').value, btn.dataset.pairingName);
    el('hostPinInput').value = '';
    setNotice('Mac paired!');
    await refreshHostDashboard();
  } catch (err) {
    setNotice(err.message);
  }
};

el('hostEnableAdminBtn').onclick = async () => {
  try {
    setNotice('Approve the Windows administrator prompt to enable SYSTEM & UAC takeover…');
    await window.orbit.enableAdminTakeover();
    setNotice('Administrator & UAC Secure Desktop takeover enabled.');
    await refreshHostDashboard();
  } catch (err) {
    setNotice(err.message);
  }
};

el('hostKeepAwakeCheck').onchange = (e) => {
  window.orbit.setKeepAwake(e.target.checked);
};

el('openAddPcBtn').onclick = () => el('addPcModal').classList.remove('hidden');
el('emptyAddPcBtn').onclick = () => el('addPcModal').classList.remove('hidden');
el('cancelAddPcBtn').onclick = () => el('addPcModal').classList.add('hidden');
el('confirmAddPcBtn').onclick = async () => {
  const addr = el('addPcAddressInput').value.trim();
  if (!addr) return;
  el('addPcModal').classList.add('hidden');
  el('addPcAddressInput').value = '';
  const pcs = await window.orbit.addPc(addr);
  renderComputersGrid(pcs);
};

el('cancelPairModalBtn').onclick = async () => {
  await window.orbit.cancelPairing();
  el('pairModal').classList.add('hidden');
};

el('refreshPcsBtn').onclick = () => refreshClientPcs();
el('homeQualitySelect').onchange = (e) => {
  state.quality = e.target.value;
};

el('disconnectBtn').onclick = async () => {
  await window.orbit.disconnectSession();
  switchView('client');
  refreshClientPcs();
};

document.querySelectorAll('.session-tab').forEach((btn) => {
  btn.onclick = () => {
    document.querySelectorAll('.session-tab').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    state.activeTab = btn.dataset.tab;
    el('tabDesktop').classList.toggle('hidden', state.activeTab !== 'desktop');
    el('tabTerminal').classList.toggle('hidden', state.activeTab !== 'terminal');
    el('tabFiles').classList.toggle('hidden', state.activeTab !== 'files');
    el('tabProcesses').classList.toggle('hidden', state.activeTab !== 'processes');
    if (state.activeTab === 'desktop') canvas.focus();
  };
});

el('sasBtn').onclick = () => {
  window.orbit.send({ type: 'sas' });
  setNotice('Sent Ctrl+Alt+Del (SAS) to PC.');
};

el('curtainBtn').onclick = () => {
  window.orbit.send({ type: 'privacy_curtain', enabled: !state.privacyCurtain });
};

el('fitWindowBtn').onclick = () => {
  const rect = canvas.getBoundingClientRect();
  window.orbit.send({
    type: 'display_config',
    monitor: 0,
    quality: state.quality,
    width: Math.round(rect.width * window.devicePixelRatio),
    height: Math.round(rect.height * window.devicePixelRatio)
  });
  setNotice('Resized PC display to fit window.');
};

el('syncClipBtn').onclick = async () => {
  await window.orbit.syncClipboardToPc();
  setNotice('Synced clipboard to PC.');
};

el('runTermBtn').onclick = () => {
  const cmd = el('terminalInput').value.trim();
  if (!cmd) return;
  el('terminalOutput').textContent += `\n> ${cmd}`;
  el('terminalInput').value = '';
  window.orbit.send({ type: 'exec_cmd', id: String(Date.now()), shell: 'powershell', command: cmd });
};

el('terminalInput').onkeydown = (e) => {
  if (e.key === 'Enter') el('runTermBtn').click();
};

el('clearTermBtn').onclick = () => {
  el('terminalOutput').textContent = '';
};

el('fsUpBtn').onclick = () => window.orbit.send({ type: 'fs_list', path: state.parentFsPath || 'drives' });
el('fsDrivesBtn').onclick = () => window.orbit.send({ type: 'fs_list', path: 'drives' });
el('fsGoBtn').onclick = () => window.orbit.send({ type: 'fs_list', path: el('fsPathInput').value.trim() });
el('fsUploadBtn').onclick = async () => {
  if (!state.currentFsPath) return;
  const res = await window.orbit.uploadFileDialog(state.currentFsPath);
  if (res.ok) setNotice(`Uploaded ${res.name}`);
};

el('refreshProcsBtn').onclick = () => window.orbit.send({ type: 'proc_list' });
el('lockPcBtn').onclick = () => window.orbit.send({ type: 'sys_power', action: 'lock' });
el('restartPcBtn').onclick = () => window.orbit.send({ type: 'sys_power', action: 'restart' });

// Telemetry Ticker
setInterval(() => {
  if (state.mode === 'session') {
    if (state.bytesThisSecond === 0) {
      el('footerStats').textContent = `Dirty-Tile OS Takeover · 0.0 KB/s · Static (0 dirty tiles) · ${state.remoteWidth} × ${state.remoteHeight}`;
    } else {
      const kbps = (state.bytesThisSecond / 1024).toFixed(1);
      el('footerStats').textContent = `Dirty-Tile OS Takeover · ${kbps} KB/s · ${state.tilesThisSecond} sub-tile patches · ${state.remoteWidth} × ${state.remoteHeight}`;
    }
    state.bytesThisSecond = 0;
    state.tilesThisSecond = 0;
  } else {
    el('footerStats').textContent = 'AVX2 SIMD Dirty-Tile Engine · 0.0 KB/s when screen is static';
  }
}, 1000);

setInterval(() => {
  if (state.mode === 'host') refreshHostDashboard();
}, 3000);

// Initial Boot
(async () => {
  const info = await window.orbit.getAppInfo();
  state.isWindows = info.isWindows;
  if (info.isWindows) {
    el('roleSwitchGroup').classList.remove('hidden');
    window.orbit.setKeepAwake(true);
    switchView('host');
    await refreshHostDashboard();
  } else {
    switchView('client');
    await refreshClientPcs();
  }
})();
