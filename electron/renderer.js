/* global orbit */
(() => {
  let isWindows = false;
  let currentMode = 'client'; // 'client' | 'host'
  let inSession = false;
  let privacyCurtainEnabled = false;
  let remoteDesktopWidth = 1920;
  let remoteDesktopHeight = 1080;
  let currentFileParentPath = '';
  let currentFilePath = '';
  let pendingPairingsList = [];
  let hostPollTimer = null;
  let toastTimeout = null;

  const $ = (id) => document.getElementById(id);

  const canvas = $('desktopCanvas');
  const ctx = canvas.getContext('2d', {
    alpha: false,
    desynchronized: true
  });

  function showBanner(msg) {
    if (!msg) return;
    $('bannerText').textContent = msg;
    $('bannerBar').classList.remove('hidden');
    if (toastTimeout) clearTimeout(toastTimeout);
    toastTimeout = setTimeout(() => {
      $('bannerBar').classList.add('hidden');
    }, 4500);
  }

  $('bannerCloseBtn').addEventListener('click', () => {
    $('bannerBar').classList.add('hidden');
  });

  // ============================================================================
  // Mode Switching (Remote Control vs Share This PC)
  // ============================================================================
  function setMode(mode) {
    currentMode = mode;
    $('modeClientBtn').classList.toggle('active', mode === 'client');
    $('modeHostBtn').classList.toggle('active', mode === 'host');

    if (!inSession) {
      $('clientHomeView').classList.toggle('hidden', mode !== 'client');
      $('hostView').classList.toggle('hidden', mode !== 'host');
    }

    if (mode === 'host' && isWindows) {
      refreshHostStatus();
    } else if (mode === 'client') {
      refreshPcCards();
    }
  }

  $('modeClientBtn').addEventListener('click', () => setMode('client'));
  $('modeHostBtn').addEventListener('click', () => setMode('host'));

  // ============================================================================
  // Share This PC (Windows Host View — Zero-Password Auto-Unlocked)
  // ============================================================================
  async function refreshHostStatus() {
    if (!isWindows) return;
    try {
      const st = await orbit.getHostStatus();
      if (!st.supported) return;

      const ip = (st.network && st.network.primaryAddress) || '127.0.0.1';
      $('hostPrimaryIp').textContent = ip;

      const badge = $('hostEngineBadge');
      if (st.running) {
        badge.textContent = st.activeSessions > 0 ? `${st.activeSessions} Connected` : 'Online · Port 47995';
        badge.className = 'sh-badge sh-badge-green';
      } else {
        badge.textContent = 'Starting...';
        badge.className = 'sh-badge sh-badge-secondary';
      }

      const isSystem = st.privilege === 'SYSTEM' || st.privilege === 'Administrator';
      const sysReady = isSystem && st.firewallAllowed;

      const sysBadge = $('systemAccessBadge');
      const sysBtn = $('enableSystemAccessBtn');
      if (sysReady) {
        sysBadge.textContent = `${st.privilege} · UAC Ready`;
        sysBadge.className = 'sh-badge sh-badge-green';
        sysBtn.textContent = 'Re-apply';
      } else if (isSystem) {
        sysBadge.textContent = `${st.privilege} (Firewall needed)`;
        sysBadge.className = 'sh-badge sh-badge-amber';
        sysBtn.textContent = 'Enable';
      } else {
        sysBadge.textContent = 'Standard';
        sysBadge.className = 'sh-badge sh-badge-outline';
        sysBtn.textContent = 'Enable';
      }

      const topBadge = $('privilegeBadge');
      if (isSystem) {
        topBadge.textContent = `${st.privilege} · UAC Ready`;
        topBadge.className = 'sh-badge sh-badge-green';
      } else {
        topBadge.textContent = st.running ? 'Engine Ready' : 'Starting...';
        topBadge.className = 'sh-badge sh-badge-outline';
      }

      // Pending pairing requests
      pendingPairingsList = st.pendingPairs || [];
      const waitBadge = $('pendingPairBadge');
      const hint = $('pendingPairHint');
      if (pendingPairingsList.length > 0) {
        const latest = pendingPairingsList[0];
        waitBadge.classList.remove('hidden');
        hint.textContent = `${latest.name || 'Device'} (${latest.address || 'remote'}) is waiting — enter its 4-digit PIN.`;
      } else {
        waitBadge.classList.add('hidden');
        hint.textContent = 'Click Pair on your Mac, then enter the 4-digit PIN here.';
      }

      // Paired devices list
      const paired = st.pairedClients || [];
      const pairedCard = $('pairedDevicesCard');
      const listEl = $('pairedClientsList');
      listEl.innerHTML = '';
      if (paired.length === 0) {
        pairedCard.classList.add('hidden');
      } else {
        pairedCard.classList.remove('hidden');
        for (const item of paired) {
          const row = document.createElement('div');
          row.className = 'paired-item';
          const nameSpan = document.createElement('span');
          nameSpan.className = 'sh-label';
          nameSpan.textContent = item.name || 'Mac';
          const btn = document.createElement('button');
          btn.className = 'sh-btn sh-btn-ghost sh-btn-sm';
          btn.textContent = 'Remove';
          btn.addEventListener('click', async () => {
            await orbit.revokeClient(item.uuid);
            refreshHostStatus();
          });
          row.appendChild(nameSpan);
          row.appendChild(btn);
          listEl.appendChild(row);
        }
      }
    } catch {}
  }

  $('copyPrimaryIpBtn').addEventListener('click', async () => {
    const ip = $('hostPrimaryIp').textContent;
    await orbit.copyText(ip);
    showBanner(`Copied ${ip} to clipboard.`);
  });

  $('enableSystemAccessBtn').addEventListener('click', async () => {
    try {
      $('enableSystemAccessBtn').disabled = true;
      $('enableSystemAccessBtn').textContent = 'Enabling...';
      await orbit.enableSystemAccess();
      showBanner('Administrator, UAC Secure Desktop, and Firewall enabled.');
      await refreshHostStatus();
    } catch (err) {
      showBanner(err.message || 'Could not enable system access.');
    } finally {
      $('enableSystemAccessBtn').disabled = false;
    }
  });

  $('hostPairBtn').addEventListener('click', async () => {
    const pin = $('hostPinInput').value.replace(/\D/g, '');
    if (pin.length !== 4) {
      showBanner('Enter the 4-digit PIN shown on your Mac.');
      return;
    }
    try {
      $('hostPairBtn').disabled = true;
      const target = pendingPairingsList[0] || { id: '', name: 'Mac' };
      await orbit.pairMac(target.id || '', pin, target.name || 'Mac');
      $('hostPinInput').value = '';
      showBanner('Device paired! You can now click Connect on your Mac.');
      await refreshHostStatus();
    } catch (err) {
      showBanner(err.message || 'Pairing failed. Check the 4-digit PIN.');
    } finally {
      $('hostPairBtn').disabled = false;
    }
  });

  $('hostPinInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') $('hostPairBtn').click();
  });

  $('keepAwakeToggle').addEventListener('change', (e) => {
    orbit.setKeepAwake(e.target.checked);
  });

  // ============================================================================
  // Remote Control View (Connect to PC)
  // ============================================================================
  async function refreshPcCards() {
    const res = await orbit.listPcs();
    const grid = $('pcCardsGrid');
    const empty = $('emptyPcState');
    grid.innerHTML = '';

    const list = res.computers || [];
    if (list.length === 0) {
      empty.classList.remove('hidden');
      return;
    }
    empty.classList.add('hidden');

    for (const pc of list) {
      const card = document.createElement('div');
      card.className = 'sh-card pc-item';

      const left = document.createElement('div');
      left.className = 'pc-meta';

      const dot = document.createElement('span');
      dot.className = 'status-dot' + (pc.online ? ' online' : '');

      const textGroup = document.createElement('div');
      const titleRow = document.createElement('div');
      titleRow.className = 'row-gap-sm';

      const nameEl = document.createElement('span');
      nameEl.className = 'pc-title';
      nameEl.textContent = pc.name || pc.address;
      titleRow.appendChild(nameEl);

      if (pc.paired) {
        const b = document.createElement('span');
        b.className = 'sh-badge sh-badge-secondary';
        b.textContent = 'Paired';
        titleRow.appendChild(b);
      }

      const subEl = document.createElement('div');
      subEl.className = 'pc-sub';
      subEl.textContent = pc.online ? `${pc.address} · Online` : `${pc.address} · Offline`;

      textGroup.appendChild(titleRow);
      textGroup.appendChild(subEl);

      left.appendChild(dot);
      left.appendChild(textGroup);

      const actions = document.createElement('div');
      actions.className = 'row-gap-sm';

      const mainBtn = document.createElement('button');
      mainBtn.className = pc.paired ? 'sh-btn sh-btn-primary sh-btn-sm' : 'sh-btn sh-btn-outline sh-btn-sm';
      mainBtn.textContent = pc.paired ? 'Connect' : 'Pair';
      mainBtn.disabled = !pc.online;
      mainBtn.addEventListener('click', () => {
        if (pc.paired) {
          startTakeoverSession(pc.address, pc.name || pc.address);
        } else {
          beginClientPairing(pc.address, pc.name || pc.address);
        }
      });

      const delBtn = document.createElement('button');
      delBtn.className = 'sh-btn sh-btn-ghost sh-btn-icon-sm';
      delBtn.title = 'Remove PC';
      delBtn.textContent = '✕';
      delBtn.addEventListener('click', async () => {
        await orbit.removePc(pc.address);
        refreshPcCards();
      });

      actions.appendChild(mainBtn);
      actions.appendChild(delBtn);

      card.appendChild(left);
      card.appendChild(actions);
      grid.appendChild(card);
    }
  }

  $('refreshPcsBtn').addEventListener('click', refreshPcCards);

  $('confirmAddPcBtn').addEventListener('click', async () => {
    const addr = $('addPcAddressInput').value.trim();
    if (!addr) {
      $('addPcAddressInput').focus();
      return;
    }
    try {
      $('confirmAddPcBtn').disabled = true;
      await orbit.addPc(addr);
      $('addPcAddressInput').value = '';
      await refreshPcCards();
    } catch (err) {
      showBanner(err.message || 'Could not add PC.');
    } finally {
      $('confirmAddPcBtn').disabled = false;
    }
  });

  $('addPcAddressInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') $('confirmAddPcBtn').click();
  });

  async function beginClientPairing(address, label) {
    try {
      const res = await orbit.startPairing(address);
      $('pairModalHostLabel').textContent = label || address;
      $('pairModalPinDisplay').textContent = res.pin;
      $('pairPinModal').classList.remove('hidden');
    } catch (err) {
      showBanner(err.message || 'Could not start pairing.');
    }
  }

  $('cancelPairModalBtn').addEventListener('click', async () => {
    await orbit.cancelPairing();
    $('pairPinModal').classList.add('hidden');
  });

  orbit.onPairComplete((data) => {
    $('pairPinModal').classList.add('hidden');
    if (data.ok) {
      showBanner('Paired! Click Connect to take over your PC.');
      refreshPcCards();
    } else {
      showBanner(data.error || 'Pairing did not complete.');
    }
  });

  // ============================================================================
  // Active Takeover Session
  // ============================================================================
  async function startTakeoverSession(address, label) {
    try {
      const quality = $('sessionQualitySelect').value || 'crisp';
      $('desktopLoadingOverlay').classList.remove('hidden');

      inSession = true;
      $('clientHomeView').classList.add('hidden');
      $('hostView').classList.add('hidden');
      $('sessionView').classList.remove('hidden');

      $('homeTabs').classList.add('hidden');
      $('homeStatusGroup').classList.add('hidden');
      $('sessionTabs').classList.remove('hidden');
      $('sessionToolbar').classList.remove('hidden');
      $('disconnectBtn').classList.remove('hidden');

      $('headerTitle').textContent = label;
      switchSessionTab('desktop');

      const res = await orbit.connectToPc(address, quality, 0);
      updateRemotePrivilegeBadges(res.privilege || 'Standard', res.desktop || 'Default');
      $('desktopViewport').focus();
    } catch (err) {
      exitSessionUi();
      showBanner(err.message || 'Connection failed.');
    }
  }

  function updateRemotePrivilegeBadges(privilege, desktop) {
    const isUac =
      String(desktop).toLowerCase().includes('winlogon') ||
      String(desktop).toLowerCase().includes('secure');
    $('uacAlertBadge').classList.toggle('hidden', !isUac);
  }

  function exitSessionUi() {
    inSession = false;
    privacyCurtainEnabled = false;
    $('curtainBtn').textContent = 'Blank PC';

    $('sessionView').classList.add('hidden');
    $('sessionTabs').classList.add('hidden');
    $('sessionToolbar').classList.add('hidden');
    $('disconnectBtn').classList.add('hidden');
    $('uacAlertBadge').classList.add('hidden');

    $('homeTabs').classList.remove('hidden');
    $('homeStatusGroup').classList.remove('hidden');
    $('headerTitle').textContent = 'Orbit';

    setMode(currentMode);
  }

  $('disconnectBtn').addEventListener('click', async () => {
    await orbit.disconnectSession();
    exitSessionUi();
  });

  orbit.onDisconnected((info) => {
    if (inSession) {
      exitSessionUi();
      showBanner((info && info.reason) || 'Session ended.');
    }
  });

  function switchSessionTab(tabName) {
    document.querySelectorAll('.session-tab').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.tab === tabName);
    });
    $('tabDesktop').classList.toggle('hidden', tabName !== 'desktop');
    $('tabTerminal').classList.toggle('hidden', tabName !== 'terminal');
    $('tabFiles').classList.toggle('hidden', tabName !== 'files');
    $('tabProcesses').classList.toggle('hidden', tabName !== 'processes');

    if (tabName === 'desktop') {
      $('desktopViewport').focus();
    } else if (tabName === 'terminal') {
      $('termInput').focus();
    } else if (tabName === 'files' && !currentFilePath) {
      orbit.send({ type: 'file_list', path: '' });
    } else if (tabName === 'processes') {
      orbit.send({ type: 'process_list' });
    }
  }

  document.querySelectorAll('.session-tab').forEach((btn) => {
    btn.addEventListener('click', () => switchSessionTab(btn.dataset.tab));
  });

  // ============================================================================
  // High-Performance Dirty-Tile Canvas Rendering
  // ============================================================================
  orbit.onFrame(async (meta, binBuffer) => {
    $('desktopLoadingOverlay').classList.add('hidden');

    if (meta.width && meta.height) {
      if (canvas.width !== meta.width || canvas.height !== meta.height) {
        canvas.width = meta.width;
        canvas.height = meta.height;
        remoteDesktopWidth = meta.width;
        remoteDesktopHeight = meta.height;
      }
    }

    if (meta.privilege || meta.desktop) {
      updateRemotePrivilegeBadges(meta.privilege || 'Standard', meta.desktop || 'Default');
    }

    const tiles = meta.tiles || [];
    if (tiles.length === 0 || !binBuffer) return;

    const u8 = binBuffer instanceof Uint8Array ? binBuffer : new Uint8Array(binBuffer);
    const decodeJobs = [];

    for (let i = 0; i < tiles.length; i++) {
      const t = tiles[i];
      const slice = u8.subarray(t.offset, t.offset + t.length);
      const mime = t.format === 'png' ? 'image/png' : 'image/jpeg';
      const blob = new Blob([slice], { type: mime });
      decodeJobs.push(
        createImageBitmap(blob).then((bmp) => ({
          bmp,
          x: t.x,
          y: t.y,
          w: t.w,
          h: t.h
        }))
      );
    }

    try {
      const decoded = await Promise.all(decodeJobs);
      for (let i = 0; i < decoded.length; i++) {
        const d = decoded[i];
        ctx.drawImage(d.bmp, d.x, d.y, d.w, d.h);
        d.bmp.close();
      }
    } catch {}
  });

  // ============================================================================
  // Mouse & Keyboard Input Forwarding
  // ============================================================================
  function mapCanvasCoords(clientX, clientY) {
    const rect = canvas.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return { x: 0, y: 0 };
    const relX = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    const relY = Math.max(0, Math.min(1, (clientY - rect.top) / rect.height));
    return {
      x: Math.round(relX * remoteDesktopWidth),
      y: Math.round(relY * remoteDesktopHeight)
    };
  }

  function mapMouseButton(btn) {
    if (btn === 2) return 'right';
    if (btn === 1) return 'middle';
    return 'left';
  }

  let lastMoveSent = 0;
  canvas.addEventListener('mousemove', (e) => {
    if (!inSession) return;
    const now = performance.now();
    if (now - lastMoveSent < 8) return;
    lastMoveSent = now;
    const pt = mapCanvasCoords(e.clientX, e.clientY);
    orbit.send({
      type: 'input_mouse',
      action: 'move',
      x: pt.x,
      y: pt.y,
      w: remoteDesktopWidth,
      h: remoteDesktopHeight
    });
  });

  canvas.addEventListener('mousedown', (e) => {
    if (!inSession) return;
    $('desktopViewport').focus();
    const pt = mapCanvasCoords(e.clientX, e.clientY);
    orbit.send({
      type: 'input_mouse',
      action: 'down',
      button: mapMouseButton(e.button),
      x: pt.x,
      y: pt.y,
      w: remoteDesktopWidth,
      h: remoteDesktopHeight
    });
  });

  canvas.addEventListener('mouseup', (e) => {
    if (!inSession) return;
    const pt = mapCanvasCoords(e.clientX, e.clientY);
    orbit.send({
      type: 'input_mouse',
      action: 'up',
      button: mapMouseButton(e.button),
      x: pt.x,
      y: pt.y,
      w: remoteDesktopWidth,
      h: remoteDesktopHeight
    });
  });

  canvas.addEventListener('dblclick', (e) => {
    if (!inSession) return;
    const pt = mapCanvasCoords(e.clientX, e.clientY);
    orbit.send({
      type: 'input_mouse',
      action: 'dblclick',
      button: 'left',
      x: pt.x,
      y: pt.y,
      w: remoteDesktopWidth,
      h: remoteDesktopHeight
    });
  });

  canvas.addEventListener('contextmenu', (e) => e.preventDefault());

  canvas.addEventListener(
    'wheel',
    (e) => {
      if (!inSession) return;
      e.preventDefault();
      const pt = mapCanvasCoords(e.clientX, e.clientY);
      const delta = e.deltaY < 0 ? 120 : -120;
      orbit.send({
        type: 'input_mouse',
        action: 'wheel',
        delta,
        x: pt.x,
        y: pt.y,
        w: remoteDesktopWidth,
        h: remoteDesktopHeight
      });
    },
    { passive: false }
  );

  const CODE_TO_VK = {
    Backspace: 0x08,
    Tab: 0x09,
    Enter: 0x0d,
    NumpadEnter: 0x0d,
    ShiftLeft: 0x10,
    ShiftRight: 0x10,
    ControlLeft: 0x11,
    ControlRight: 0x11,
    AltLeft: 0x12,
    AltRight: 0x12,
    Pause: 0x13,
    CapsLock: 0x14,
    Escape: 0x1b,
    Space: 0x20,
    PageUp: 0x21,
    PageDown: 0x22,
    End: 0x23,
    Home: 0x24,
    ArrowLeft: 0x25,
    ArrowUp: 0x26,
    ArrowRight: 0x27,
    ArrowDown: 0x28,
    Insert: 0x2d,
    Delete: 0x2e,
    MetaLeft: 0x11,
    MetaRight: 0x11,
    F1: 0x70,
    F2: 0x71,
    F3: 0x72,
    F4: 0x73,
    F5: 0x74,
    F6: 0x75,
    F7: 0x76,
    F8: 0x77,
    F9: 0x78,
    F10: 0x79,
    F11: 0x7a,
    F12: 0x7b,
    Semicolon: 0xba,
    Equal: 0xbb,
    Comma: 0xbc,
    Minus: 0xbd,
    Period: 0xbe,
    Slash: 0xbf,
    Backquote: 0xc0,
    BracketLeft: 0xdb,
    Backslash: 0xdc,
    BracketRight: 0xdd,
    Quote: 0xde
  };

  function getWindowsVk(e) {
    if (CODE_TO_VK[e.code]) return CODE_TO_VK[e.code];
    if (e.code && e.code.startsWith('Key') && e.code.length === 4) {
      return e.code.charCodeAt(3);
    }
    if (e.code && e.code.startsWith('Digit') && e.code.length === 6) {
      return e.code.charCodeAt(5);
    }
    return e.keyCode || 0;
  }

  $('desktopViewport').addEventListener('keydown', (e) => {
    if (!inSession || $('tabDesktop').classList.contains('hidden')) return;
    e.preventDefault();
    const vk = getWindowsVk(e);
    if (vk > 0) {
      orbit.send({ type: 'input_key', vk, down: true });
    }
  });

  $('desktopViewport').addEventListener('keyup', (e) => {
    if (!inSession || $('tabDesktop').classList.contains('hidden')) return;
    e.preventDefault();
    const vk = getWindowsVk(e);
    if (vk > 0) {
      orbit.send({ type: 'input_key', vk, down: false });
    }
  });

  // ============================================================================
  // Session Toolbar Actions
  // ============================================================================
  $('sasBtn').addEventListener('click', () => {
    orbit.send({ type: 'power_action', action: 'sas' });
    showBanner('Sent Ctrl+Alt+Del (Secure Attention Sequence) to PC.');
  });

  $('curtainBtn').addEventListener('click', () => {
    privacyCurtainEnabled = !privacyCurtainEnabled;
    orbit.send({ type: 'privacy_curtain', enabled: privacyCurtainEnabled });
    $('curtainBtn').textContent = privacyCurtainEnabled ? 'Unblank PC' : 'Blank PC';
  });

  $('fitWindowBtn').addEventListener('click', () => {
    const vp = $('desktopViewport').getBoundingClientRect();
    const w = Math.max(1024, Math.round(vp.width));
    const h = Math.max(720, Math.round(vp.height));
    orbit.send({ type: 'set_resolution', width: w, height: h });
    showBanner(`Requested PC display resolution ${w}×${h}.`);
  });

  $('sessionQualitySelect').addEventListener('change', (e) => {
    orbit.send({ type: 'set_quality', quality: e.target.value, monitor: 0 });
  });

  $('syncClipBtn').addEventListener('click', async () => {
    await orbit.syncClipboardToPc();
    showBanner('Clipboard synced to remote PC.');
  });

  // ============================================================================
  // Terminal, Files & Processes Events
  // ============================================================================
  function appendTerm(text) {
    const out = $('termOutput');
    out.textContent += text;
    out.scrollTop = out.scrollHeight;
  }

  $('sendTermBtn').addEventListener('click', () => {
    const cmd = $('termInput').value.trim();
    if (!cmd) return;
    const shell = $('termShellSelect').value;
    appendTerm(`\nPS> ${cmd}\n`);
    $('termInput').value = '';
    orbit.send({ type: 'terminal_exec', command: cmd, shell });
  });

  $('termInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') $('sendTermBtn').click();
  });

  $('clearTermBtn').addEventListener('click', () => {
    $('termOutput').textContent = '';
  });

  $('fileDrivesBtn').addEventListener('click', () => {
    orbit.send({ type: 'file_list', path: '' });
  });

  $('fileUpBtn').addEventListener('click', () => {
    orbit.send({ type: 'file_list', path: currentFileParentPath || '' });
  });

  $('fileRefreshBtn').addEventListener('click', () => {
    orbit.send({ type: 'file_list', path: currentFilePath || '' });
  });

  $('fileUploadBtn').addEventListener('click', async () => {
    if (!currentFilePath) {
      showBanner('Open a drive or folder first before uploading.');
      return;
    }
    const res = await orbit.uploadFileDialog(currentFilePath);
    if (res && res.ok) {
      showBanner(`Uploading ${res.name}...`);
    }
  });

  $('procRefreshBtn').addEventListener('click', () => {
    orbit.send({ type: 'process_list' });
  });

  $('powerLockBtn').addEventListener('click', () => {
    orbit.send({ type: 'power_action', action: 'lock' });
    showBanner('Locked Windows PC.');
  });

  $('powerRestartBtn').addEventListener('click', () => {
    orbit.send({ type: 'power_action', action: 'restart' });
    showBanner('Restarting Windows PC in 5 seconds...');
  });

  orbit.onEvent((msg) => {
    if (msg.type === 'terminal_result') {
      if (msg.stdout) appendTerm(msg.stdout);
      if (msg.stderr) appendTerm(msg.stderr);
    } else if (msg.type === 'file_list_result') {
      currentFilePath = msg.path || '';
      currentFileParentPath = msg.parent || '';
      $('fileCurrentPath').textContent = currentFilePath || 'Computer (Drives)';

      const container = $('fileListContainer');
      container.innerHTML = '';
      const entries = msg.entries || [];
      for (const item of entries) {
        const row = document.createElement('div');
        row.className = 'table-row';

        const left = document.createElement('div');
        left.className = 'row-gap-sm';
        const name = document.createElement('span');
        name.className = 'sh-label';
        name.textContent = item.isDir ? `📁 ${item.name}` : `📄 ${item.name}`;
        left.appendChild(name);

        const right = document.createElement('div');
        right.className = 'row-gap-sm';
        if (item.isDir) {
          const openBtn = document.createElement('button');
          openBtn.className = 'sh-btn sh-btn-outline sh-btn-sm';
          openBtn.textContent = 'Open';
          openBtn.addEventListener('click', () => {
            orbit.send({ type: 'file_list', path: item.path });
          });
          right.appendChild(openBtn);
        } else {
          const kb = Math.max(1, Math.round((item.size || 0) / 1024));
          const sz = document.createElement('span');
          sz.className = 'sh-muted';
          sz.textContent = `${kb.toLocaleString()} KB`;
          right.appendChild(sz);

          const dlBtn = document.createElement('button');
          dlBtn.className = 'sh-btn sh-btn-outline sh-btn-sm';
          dlBtn.textContent = 'Download';
          dlBtn.addEventListener('click', () => {
            orbit.send({ type: 'file_download', path: item.path });
            showBanner(`Downloading ${item.name} to Downloads...`);
          });
          right.appendChild(dlBtn);
        }

        row.appendChild(left);
        row.appendChild(right);
        container.appendChild(row);
      }
    } else if (msg.type === 'file_saved_local') {
      showBanner(`Downloaded to ${msg.savedTo}`);
    } else if (msg.type === 'file_upload_result') {
      if (msg.ok) {
        showBanner('Upload complete.');
        orbit.send({ type: 'file_list', path: currentFilePath });
      } else {
        showBanner(msg.error || 'Upload failed.');
      }
    } else if (msg.type === 'process_list_result') {
      const container = $('procListContainer');
      container.innerHTML = '';
      const procs = msg.processes || [];
      for (const p of procs) {
        const row = document.createElement('div');
        row.className = 'table-row';

        const left = document.createElement('div');
        const title = document.createElement('div');
        title.className = 'sh-label';
        title.textContent = p.title ? `${p.name} — ${p.title}` : p.name;
        const sub = document.createElement('div');
        sub.className = 'sh-muted mono';
        sub.textContent = `PID ${p.pid} · ${p.memoryMb} MB`;
        left.appendChild(title);
        left.appendChild(sub);

        const killBtn = document.createElement('button');
        killBtn.className = 'sh-btn sh-btn-outline sh-btn-sm';
        killBtn.textContent = 'End Task';
        killBtn.addEventListener('click', () => {
          orbit.send({ type: 'process_kill', pid: p.pid });
          setTimeout(() => orbit.send({ type: 'process_list' }), 400);
        });

        row.appendChild(left);
        row.appendChild(killBtn);
        container.appendChild(row);
      }
    }
  });

  // ============================================================================
  // Bootstrap
  // ============================================================================
  async function init() {
    const info = await orbit.getAppInfo();
    isWindows = Boolean(info.isWindows);

    if (!isWindows) {
      $('modeHostBtn').classList.add('hidden');
      setMode('client');
    } else {
      // On Windows, default to "Share This PC" so the user immediately sees their IP & Pair box
      setMode('host');
      orbit.setKeepAwake(true);
      hostPollTimer = setInterval(() => {
        if (!inSession && currentMode === 'host') {
          refreshHostStatus();
        }
      }, 2500);
    }
  }

  init();
})();
