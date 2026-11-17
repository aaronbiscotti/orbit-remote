/* global orbit */
(() => {
  let isWindows = false;
  let currentMode = 'host';
  let inSession = false;
  let video = null;
  let gpuSession = false;
  let externalVideo = false;
  let sessionMonitors = [];
  const heldKeys = new Set();
  const heldButtons = new Set();
  let remoteDesktopWidth = 1920;
  let remoteDesktopHeight = 1080;
  let selectedMonitor = 0;
  let sessionGeneration = 0;
  let currentFileParentPath = '';
  let currentFilePath = '';
  let pendingPairingsList = [];
  let lastPairedSignature = null;
  let toastTimeout = null;
  let audioCtx = null;
  let tactileSoundsEnabled = localStorage.getItem('orbit_tactile_sounds') !== 'false';

  const $ = (id) => document.getElementById(id);
  document.documentElement.classList.toggle('mac', navigator.platform.startsWith('Mac'));

  // ============================================================================
  // Nintendo Switch Audio-Visual Synesthesia (Synthesized Micro-Acoustics)
  // ============================================================================
  function playTactileSound(kind = 'tick') {
    if (!tactileSoundsEnabled) return;
    try {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return;
      if (!audioCtx) audioCtx = new Ctx();
      if (audioCtx.state === 'suspended') audioCtx.resume();

      const now = audioCtx.currentTime;
      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      osc.connect(gain);
      gain.connect(audioCtx.destination);

      if (kind === 'tab') {
        osc.type = 'sine';
        osc.frequency.setValueAtTime(580, now);
        osc.frequency.exponentialRampToValueAtTime(840, now + 0.018);
        gain.gain.setValueAtTime(0.032, now);
        gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.022);
        osc.start(now);
        osc.stop(now + 0.024);
      } else if (kind === 'switch-on') {
        osc.type = 'triangle';
        osc.frequency.setValueAtTime(520, now);
        osc.frequency.exponentialRampToValueAtTime(880, now + 0.024);
        gain.gain.setValueAtTime(0.035, now);
        gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.028);
        osc.start(now);
        osc.stop(now + 0.03);
      } else if (kind === 'switch-off') {
        osc.type = 'triangle';
        osc.frequency.setValueAtTime(720, now);
        osc.frequency.exponentialRampToValueAtTime(420, now + 0.022);
        gain.gain.setValueAtTime(0.03, now);
        gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.026);
        osc.start(now);
        osc.stop(now + 0.028);
      } else if (kind === 'pop') {
        osc.type = 'sine';
        osc.frequency.setValueAtTime(640, now);
        osc.frequency.exponentialRampToValueAtTime(980, now + 0.032);
        gain.gain.setValueAtTime(0.04, now);
        gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.038);
        osc.start(now);
        osc.stop(now + 0.04);
      } else {
        osc.type = 'sine';
        osc.frequency.setValueAtTime(500, now);
        osc.frequency.exponentialRampToValueAtTime(190, now + 0.012);
        gain.gain.setValueAtTime(0.028, now);
        gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.014);
        osc.start(now);
        osc.stop(now + 0.016);
      }
    } catch {}
  }

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
    }, 4000);
  }

  $('bannerCloseBtn').addEventListener('click', () => {
    $('bannerBar').classList.add('hidden');
  });

  // ============================================================================
  // Mode Switching (This PC vs Remote PCs) + Sliding Spring Glider
  // ============================================================================
  function syncTabGlider() {
    const tabsEl = $('homeTabs');
    const glider = $('homeTabGlider');
    if (!tabsEl || !glider) return;
    const activeBtn = modeHostVisibleAndActive();
    if (!activeBtn || activeBtn.offsetWidth === 0) return;
    tabsEl.classList.add('has-glider');
    glider.style.width = `${activeBtn.offsetWidth}px`;
    glider.style.transform = `translateX(${activeBtn.offsetLeft}px)`;
  }

  function modeHostVisibleAndActive() {
    return currentMode === 'host' && !$('modeHostBtn').classList.contains('hidden')
      ? $('modeHostBtn')
      : $('modeClientBtn');
  }

  function setMode(mode, userInitiated = false) {
    if (userInitiated && mode !== currentMode) {
      playTactileSound('tab');
    }
    currentMode = mode;
    $('modeHostBtn').classList.toggle('active', mode === 'host');
    $('modeClientBtn').classList.toggle('active', mode === 'client');
    requestAnimationFrame(syncTabGlider);

    $('hostView').classList.toggle('hidden', mode !== 'host');
    $('clientHomeView').classList.toggle('hidden', mode !== 'client');

    if (mode === 'host' && isWindows) {
      refreshHostStatus();
    } else if (mode === 'client') {
      refreshPcCards();
    }
  }

  $('modeHostBtn').addEventListener('click', () => setMode('host', true));
  $('modeClientBtn').addEventListener('click', () => setMode('client', true));
  window.addEventListener('resize', syncTabGlider);

  // ============================================================================
  // This PC (Windows Host)
  // ============================================================================
  async function refreshHostStatus() {
    if (!isWindows) return;
    try {
      const st = await orbit.getHostStatus();
      if (!st.supported) return;

      const ip = (st.network && st.network.primaryAddress) || '127.0.0.1';
      $('hostPrimaryIp').textContent = ip;

      const dot = $('hostStatusDot');
      const statusLabel = $('hostStatusLabel');
      if (st.running) {
        dot.className = 'dot online';
        statusLabel.textContent = st.activeSessions > 0 ? `${st.activeSessions} connected` : 'Online';
      } else {
        dot.className = 'dot';
        statusLabel.textContent = 'Starting...';
      }

      const isSystem = st.privilege === 'SYSTEM' || st.privilege === 'Administrator';
      const checkIcon = $('adminStatusIcon');
      const statusText = $('adminStatusText');
      const enableBtn = $('enableSystemAccessBtn');
      const repairBtn = $('settingsRepairAdminBtn');

      if (isSystem) {
        checkIcon.classList.remove('hidden');
        statusText.textContent = 'Active';
        enableBtn.classList.add('hidden');
        if (repairBtn && !repairBtn.disabled) repairBtn.textContent = 'Active · Re-apply';
      } else {
        checkIcon.classList.add('hidden');
        statusText.textContent = 'Standard';
        enableBtn.classList.remove('hidden');
        if (!enableBtn.disabled) enableBtn.textContent = 'Enable';
        if (repairBtn && !repairBtn.disabled) repairBtn.textContent = 'Enable';
      }

      // Pending pairing requests
      pendingPairingsList = st.pendingPairs || [];
      const hint = $('pendingPairHint');
      if (pendingPairingsList.length > 0) {
        const latest = pendingPairingsList[0];
        hint.textContent = `● ${latest.name || 'Mac'} waiting`;
        hint.className = 'field-hint active-wait';
      } else {
        hint.textContent = '4-digit PIN';
        hint.className = 'field-hint';
      }

      // Paired devices list (only rebuild DOM when signature changes)
      const paired = st.pairedClients || [];
      const nextSig = JSON.stringify(paired.map((p) => `${p.uuid}:${p.name}`));
      if (nextSig !== lastPairedSignature) {
        lastPairedSignature = nextSig;
        const section = $('pairedDevicesSection');
        const listEl = $('pairedClientsList');
        listEl.innerHTML = '';
        if (paired.length === 0) {
          section.classList.add('hidden');
        } else {
          section.classList.remove('hidden');
          for (const item of paired) {
            const row = document.createElement('div');
            row.className = 'paired-item';

            const left = document.createElement('div');
            left.className = 'item-left';

            const d = document.createElement('span');
            d.className = 'dot online';

            const nameSpan = document.createElement('span');
            nameSpan.className = 'item-title';
            nameSpan.textContent = item.name || 'Mac';

            left.appendChild(d);
            left.appendChild(nameSpan);

            const btn = document.createElement('button');
            btn.className = 'sh-btn sh-btn-ghost sh-btn-sm';
            btn.textContent = 'Remove';
            btn.addEventListener('click', async () => {
              playTactileSound('tick');
              await orbit.revokeClient(item.uuid);
              lastPairedSignature = null;
              refreshHostStatus();
            });

            row.appendChild(left);
            row.appendChild(btn);
            listEl.appendChild(row);
          }
        }
      }
    } catch {}
  }

  $('copyPrimaryIpBtn').addEventListener('click', async () => {
    playTactileSound('pop');
    const ip = $('hostPrimaryIp').textContent;
    await orbit.copyText(ip);
    const btn = $('copyPrimaryIpBtn');
    const label = $('copyPrimaryIpText');
    btn.classList.add('pop-success');
    if (label) label.textContent = 'Copied';
    else btn.textContent = 'Copied';
    setTimeout(() => {
      btn.classList.remove('pop-success');
      if (label) label.textContent = 'Copy';
      else btn.textContent = 'Copy';
    }, 1400);
  });

  async function applyAdminService() {
    const enableBtn = $('enableSystemAccessBtn');
    const repairBtn = $('settingsRepairAdminBtn');
    const statusText = $('adminStatusText');
    try {
      if (enableBtn) {
        enableBtn.disabled = true;
        enableBtn.textContent = 'Enabling...';
      }
      if (repairBtn) {
        repairBtn.disabled = true;
        repairBtn.textContent = 'Applying...';
      }
      if (statusText) statusText.textContent = 'Applying...';

      await orbit.enableSystemAccess();
      if (statusText) statusText.textContent = 'Active';
      if (enableBtn) enableBtn.classList.add('hidden');
      showBanner('Administrator & UAC service active (SYSTEM).');
    } catch (err) {
      showBanner(err.message || 'Could not enable administrator access.');
    } finally {
      if (enableBtn) {
        enableBtn.disabled = false;
        enableBtn.textContent = 'Enable';
      }
      if (repairBtn) {
        repairBtn.disabled = false;
      }
      await refreshHostStatus();
    }
  }

  $('enableSystemAccessBtn').addEventListener('click', (e) => {
    e.stopPropagation();
    playTactileSound('tick');
    applyAdminService();
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
      showBanner('Device paired! You can now connect from your Mac.');
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
    const checked = e.target.checked;
    playTactileSound(checked ? 'switch-on' : 'switch-off');
    if ($('settingsKeepAwakeToggle')) $('settingsKeepAwakeToggle').checked = checked;
    orbit.setKeepAwake(checked);
  });

  $('adminRowItem')?.addEventListener('click', (e) => {
    if (e.target.closest('#enableSystemAccessBtn')) return;
    playTactileSound('tick');
    if (!$('enableSystemAccessBtn').classList.contains('hidden')) {
      $('enableSystemAccessBtn').click();
    } else {
      showBanner('Administrator & UAC service is active (SYSTEM).');
    }
  });

  $('updatesRowItem')?.addEventListener('click', () => {
    playTactileSound('tick');
    $('checkUpdatesBtn').click();
  });

  // ============================================================================
  // Remote PCs (Client View)
  // ============================================================================
  async function refreshPcCards() {
    const res = await orbit.listPcs();
    const grid = $('pcCardsGrid');
    const empty = $('emptyPcState');
    grid.innerHTML = '';

    const list = res;
    if (list.length === 0) {
      empty.classList.remove('hidden');
      return;
    }
    empty.classList.add('hidden');

    for (const pc of list) {
      const card = document.createElement('div');
      card.className = 'pc-item';

      const left = document.createElement('div');
      left.className = 'item-left';

      const dot = document.createElement('span');
      dot.className = 'dot' + (pc.online ? ' online' : '');

      const textGroup = document.createElement('div');
      const nameEl = document.createElement('div');
      nameEl.className = 'item-title';
      const shownName = pc.name || pc.address;
      nameEl.textContent = shownName;

      const subEl = document.createElement('div');
      subEl.className = 'item-sub';
      const status = pc.online ? (pc.paired ? 'Paired' : 'Ready to pair') : 'Offline';
      // Show the address under the name only when the name isn't already the address.
      subEl.textContent = shownName === pc.address ? status : `${pc.address} · ${status}`;

      textGroup.appendChild(nameEl);
      textGroup.appendChild(subEl);

      left.appendChild(dot);
      left.appendChild(textGroup);

      const actions = document.createElement('div');
      actions.className = 'row-gap-sm';

      const mainBtn = document.createElement('button');
      mainBtn.className = pc.paired ? 'sh-btn sh-btn-primary sh-btn-sm' : 'sh-btn sh-btn-secondary sh-btn-sm';
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
      delBtn.className = 'sh-btn-icon';
      delBtn.title = 'Remove PC';
      delBtn.textContent = '✕';
      delBtn.addEventListener('click', async () => {
        // Removing forgets the pairing and stream settings, so ask first.
        if (!confirm(`Remove ${pc.name || pc.address}? You will need to pair it again.`)) return;
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
    if (data.paired) {
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
      sessionGeneration++;
      selectedMonitor = 0;
      $('sessionMonitorSelect').innerHTML = '';
      const quality = $('sessionQualitySelect').value || 'crisp';
      $('desktopLoadingOverlay').classList.remove('hidden');

      inSession = true;
      $('homeShell').classList.add('hidden');
      $('sessionView').classList.remove('hidden');

      $('headerTitle').textContent = label;
      switchSessionTab('desktop');

      const res = await orbit.connectToPc(address, quality, 0);
      const monitors = res.monitors || [];
      sessionMonitors = monitors;
      for (const monitor of monitors) {
        const option = document.createElement('option');
        option.value = String(monitor.Index);
        option.textContent = `${monitor.Name} · ${monitor.Width}×${monitor.Height}${monitor.Primary ? ' (Main)' : ''}`;
        $('sessionMonitorSelect').appendChild(option);
      }
      externalVideo = Boolean(res.videoExternal);
      if (res.videoAvailable) {
        gpuSession = true;
        selectedMonitor = monitors.find(m => m.Primary)?.Index || 0;
        await startGpuVideo();
      }
      $('sessionMonitorSelect').value = String(selectedMonitor);
      $('sessionMonitorSelect').disabled = externalVideo || monitors.length < 2;
      $('sessionMonitorSelect').classList.toggle('hidden', externalVideo);
      $('fitWindowBtn').classList.toggle('hidden', externalVideo);
      updateRemotePrivilegeBadges(res.privilege || 'Standard', res.desktop || 'Default');
      $('desktopViewport').focus();
    } catch (err) {
      exitSessionUi();
      showBanner(err.message || 'Connection failed.');
    }
  }

  async function startGpuVideo() {
    if(video)video.close();
    if (externalVideo) {
      $('desktopLoadingOverlay').classList.add('hidden');
      canvas.classList.add('hidden');
      $('externalStreamPanel').classList.remove('hidden');
      $('externalStreamStatus').textContent = 'Opening stream window…';
      $('videoStats').classList.add('hidden');
      await orbit.startVideo({quality:$('sessionQualitySelect').value, width:1920, height:1080});
      $('externalStreamStatus').textContent = 'Your desktop opens in a separate Moonlight window.';
      return;
    }
    const hevc = await VideoDecoder.isConfigSupported({codec:'hev1.1.6.L153.B0',hardwareAcceleration:'prefer-hardware',optimizeForLatency:true}).catch(()=>({supported:false}));
    const codec=hevc.supported?'hevc':'h264';
    video = new OrbitVideo(canvas, {
      frame(width,height) {
        remoteDesktopWidth=width;remoteDesktopHeight=height;
        canvas.style.cursor='none';
        $('desktopLoadingOverlay').classList.add('hidden');
      },
      error(message) { showBanner(message); },
      stats(stats) {
        $('videoStats').classList.remove('hidden');
        $('videoStats').textContent=`${stats.renderedFps} fps · ${stats.networkMs} ms`;
        $('videoStats').title=`Target 120 fps · network jitter ${stats.jitterMs} ms · decode ${stats.decodeMs} ms · host ${stats.hostMs} ms`;
      }
    }, codec);
    const monitor=sessionMonitors.find(m=>m.Index===selectedMonitor);
    const native=$('sessionQualitySelect').value==='crisp';
    try { await orbit.startVideo({quality:$('sessionQualitySelect').value,codec,monitor:selectedMonitor,width:native?monitor?.Width:1920,height:native?monitor?.Height:1080}); }
    catch(error) { video.close();video=null;throw error; }
  }

  $('openStreamWindowBtn').addEventListener('click', async () => {
    try { const result = await orbit.focusVideo(); if(!result.running) await startGpuVideo(); }
    catch(error) { $('externalStreamStatus').textContent = error.message; }
  });
  orbit.onVideoStatus(status => {
    if(externalVideo && status.type === 'closed') $('externalStreamStatus').textContent = status.message;
  });

  function updateRemotePrivilegeBadges(privilege, desktop) {
    const isUac =
      String(desktop).toLowerCase().includes('winlogon') ||
      String(desktop).toLowerCase().includes('secure');
    $('uacAlertBadge').classList.toggle('hidden', !isUac);
  }

  function exitSessionUi() {
    if(video){video.close();video=null;}
    externalVideo=false;canvas.classList.remove('hidden');$('externalStreamPanel').classList.add('hidden');
    $('sessionMonitorSelect').classList.remove('hidden');$('fitWindowBtn').classList.remove('hidden');
    gpuSession=false;canvas.style.cursor='';$('videoStats').classList.add('hidden');
    if(moveTimer)clearTimeout(moveTimer);moveTimer=null;pendingMove=null;
    sessionGeneration++;
    inSession = false;
    skippedSeq = 0;
    $('curtainBtn').textContent = 'Blank PC';

    $('sessionView').classList.add('hidden');
    $('uacAlertBadge').classList.add('hidden');
    $('homeShell').classList.remove('hidden');

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

  async function switchSessionTab(tabName) {
    document.querySelectorAll('.session-tab').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.tab === tabName);
    });
    $('tabDesktop').classList.toggle('hidden', tabName !== 'desktop');
    $('tabTerminal').classList.toggle('hidden', tabName !== 'terminal');
    $('tabFiles').classList.toggle('hidden', tabName !== 'files');
    $('tabProcesses').classList.toggle('hidden', tabName !== 'processes');

    if(video)video.setVisible(tabName==='desktop'&&!document.hidden);
    if(gpuSession){try{await orbit.sessionTab(tabName);}catch(error){showBanner(error.message);return;}}
    if (tabName === 'desktop') {
      $('desktopViewport').focus();
      resumeTiles();
    } else if (tabName === 'terminal') {
      $('termInput').focus();
    } else if (tabName === 'files' && !currentFilePath) {
      orbit.send({ type: 'fs_list', path: '' });
    } else if (tabName === 'processes') {
      orbit.send({ type: 'proc_list' });
    }
  }

  document.querySelectorAll('.session-tab').forEach((btn) => {
    btn.addEventListener('click', () => switchSessionTab(btn.dataset.tab));
  });

  // ============================================================================
  // High-Performance Dirty-Tile Canvas Rendering
  // ============================================================================
  let skippedSeq = 0;
  // Acknowledge what was skipped and ask for a full frame, since the canvas missed those changes.
  function resumeTiles() {
    if (!skippedSeq || !inSession || gpuSession) return;
    orbit.send({ type: 'frame_ack', seq: skippedSeq });
    skippedSeq = 0;
    orbit.send({ type: 'display_config', monitor: selectedMonitor });
  }
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && !$('tabDesktop').classList.contains('hidden')) resumeTiles();
  });

  // The PC may have two frames in flight. Draw them strictly in arrival order, since each holds only what changed.
  let drawQueue = Promise.resolve();
  orbit.onFrame((meta, binBuffer) => { drawQueue = drawQueue.then(() => drawFrame(meta, binBuffer)); });
  async function drawFrame(meta, binBuffer) {
    if(gpuSession)return;
    // Nobody is looking: skip decoding and hold the ack, so the PC stops sending until the desktop is shown again.
    if (document.hidden || $('tabDesktop').classList.contains('hidden')) { skippedSeq = Math.max(skippedSeq, meta.seq); return; }
    const generation = sessionGeneration;
    const decoded = [];
    try {
      const { screenW, screenH } = meta;
      if (!Number.isInteger(screenW) || screenW <= 0 || !Number.isInteger(screenH) || screenH <= 0) {
        throw new Error('The host sent invalid display dimensions.');
      }
      const u8 = binBuffer instanceof Uint8Array ? binBuffer : new Uint8Array(binBuffer);
      const results = await Promise.allSettled((meta.tiles || []).map(async (tile) => {
        if (!Number.isInteger(tile.offset) || !Number.isInteger(tile.length) || tile.offset < 0 ||
            tile.length <= 0 || tile.offset + tile.length > u8.length) {
          throw new Error('The host sent an incomplete desktop tile.');
        }
        const bytes = u8.subarray(tile.offset, tile.offset + tile.length);
        const mime = tile.format === 'png' ? 'image/png' : 'image/jpeg';
        const bmp = await createImageBitmap(new Blob([bytes], { type: mime }));
        decoded.push({ bmp, tile });
      }));
      if (generation !== sessionGeneration) return;
      const failure = results.find(result => result.status === 'rejected');
      if (failure) throw failure.reason;
      if (canvas.width !== screenW || canvas.height !== screenH) {
        canvas.width = screenW;
        canvas.height = screenH;
      }
      remoteDesktopWidth = screenW;
      remoteDesktopHeight = screenH;
      if (meta.full) {
        ctx.fillStyle = '#000';
        ctx.fillRect(0, 0, screenW, screenH);
      }
      for (const { bmp, tile } of decoded) {
        ctx.drawImage(bmp, tile.x, tile.y, tile.w, tile.h);
      }
      if (meta.privilege || meta.desktop) {
        updateRemotePrivilegeBadges(meta.privilege || 'Standard', meta.desktop || 'Default');
      }
      $('desktopLoadingOverlay').classList.add('hidden');
      orbit.send({ type: 'frame_ack', seq: meta.seq });
    } catch (error) {
      if (generation === sessionGeneration) {
        showBanner(error.message || 'Could not draw the remote desktop. Reconnect to try again.');
        orbit.send({ type: 'display_config', monitor: selectedMonitor });
      }
    } finally {
      for (const { bmp } of decoded) bmp.close();
    }
  }

  // ============================================================================
  // Mouse & Keyboard Input Forwarding
  // ============================================================================
  function mapCanvasCoords(clientX, clientY) {
    const rect = canvas.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return { x: 0, y: 0 };
    const scale = Math.min(rect.width / remoteDesktopWidth, rect.height / remoteDesktopHeight);
    const width = remoteDesktopWidth * scale;
    const height = remoteDesktopHeight * scale;
    const left = rect.left + (rect.width - width) / 2;
    const top = rect.top + (rect.height - height) / 2;
    const relX = (clientX - left) / width;
    const relY = (clientY - top) / height;
    return {
      x: Math.max(0, Math.min(1, relX)),
      y: Math.max(0, Math.min(1, relY)),
      inside: relX >= 0 && relX <= 1 && relY >= 0 && relY <= 1
    };
  }

  function mapMouseButton(btn) {
    if (btn === 2) return 'right';
    if (btn === 1) return 'middle';
    return 'left';
  }

  let lastMoveSent = 0;
  let moveTimer = null;
  let pendingMove = null;
  function sendPendingMove() {
    moveTimer=null;
    if(!pendingMove||!inSession)return;
    orbit.send(pendingMove);pendingMove=null;lastMoveSent=performance.now();
  }
  // pointerrawupdate arrives as soon as the OS reports a move; mousemove waits for the next screen refresh.
  canvas.addEventListener('onpointerrawupdate' in window ? 'pointerrawupdate' : 'mousemove', (e) => {
    if (!inSession) return;
    const pt = mapCanvasCoords(e.clientX, e.clientY);
    if (!pt.inside) return;
    pendingMove={type:'mouse',action:'move',x:pt.x,y:pt.y};
    const remaining=4-(performance.now()-lastMoveSent);
    if(remaining<=0){if(moveTimer)clearTimeout(moveTimer);sendPendingMove();}
    else if(!moveTimer)moveTimer=setTimeout(sendPendingMove,remaining);
  });

  canvas.addEventListener('mousedown', (e) => {
    if (!inSession) return;
    $('desktopViewport').focus();
    if(moveTimer)clearTimeout(moveTimer);sendPendingMove();
    const pt = mapCanvasCoords(e.clientX, e.clientY);
    if (!pt.inside) return;
    heldButtons.add(mapMouseButton(e.button));
    orbit.send({
      type: 'mouse',
      action: 'down',
      button: mapMouseButton(e.button),
      x: pt.x,
      y: pt.y
    });
  });

  canvas.addEventListener('mouseup', (e) => {
    if (!inSession) return;
    const pt = mapCanvasCoords(e.clientX, e.clientY);
    heldButtons.delete(mapMouseButton(e.button));
    orbit.send({
      type: 'mouse',
      action: 'up',
      button: mapMouseButton(e.button),
      x: pt.x,
      y: pt.y
    });
  });

  window.addEventListener('blur', () => {
    for(const vk of heldKeys)orbit.send({type:'key',vk,action:'up',modifiers:0});
    for(const button of heldButtons)orbit.send({type:'mouse',button,action:'release'});
    heldKeys.clear();heldButtons.clear();
  });
  window.addEventListener('mouseup', (e) => {
    if(e.target===canvas)return;
    const button=mapMouseButton(e.button);
    if(heldButtons.delete(button))orbit.send({type:'mouse',button,action:'release'});
  });
  canvas.addEventListener('contextmenu', (e) => e.preventDefault());

  canvas.addEventListener(
    'wheel',
    (e) => {
      if (!inSession) return;
      e.preventDefault();
      const pt = mapCanvasCoords(e.clientX, e.clientY);
      if (!pt.inside) return;
      // Send the real amount (about 100 px per notch = Windows' 120), both directions, so trackpads don't flood the PC.
      const unit = e.deltaMode === 1 ? 40 : e.deltaMode === 2 ? 120 : 1.2;
      const clamp = (v) => Math.max(-120, Math.min(120, Math.round(v * unit)));
      const deltaY = clamp(-e.deltaY);
      const deltaX = clamp(e.deltaX);
      if (!deltaY && !deltaX) return;
      orbit.send({ type: 'mouse', action: 'wheel', deltaY, deltaX, x: pt.x, y: pt.y });
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

  const isMac = navigator.platform.startsWith('Mac');
  // A Mac reports Caps Lock "down" when it turns on and "up" when it turns off; Windows needs a full press each time.
  function tapCapsLock() {
    orbit.send({ type: 'key', vk: 0x14, action: 'down', modifiers: 0 });
    orbit.send({ type: 'key', vk: 0x14, action: 'up', modifiers: 0 });
  }

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
    if (isMac && vk === 0x14) { tapCapsLock(); return; }
    if (vk > 0) {
      heldKeys.add(vk);
      orbit.send({ type: 'key', vk, action: 'down', modifiers:(e.shiftKey?1:0)|((e.ctrlKey||e.metaKey)?2:0)|(e.altKey?4:0) });
    }
  });

  $('desktopViewport').addEventListener('keyup', (e) => {
    if (!inSession || $('tabDesktop').classList.contains('hidden')) return;
    e.preventDefault();
    const vk = getWindowsVk(e);
    if (isMac && vk === 0x14) { tapCapsLock(); return; }
    if (vk > 0) {
      heldKeys.delete(vk);
      orbit.send({ type: 'key', vk, action: 'up', modifiers:(e.shiftKey?1:0)|((e.ctrlKey||e.metaKey)?2:0)|(e.altKey?4:0) });
    }
    // macOS sends no keyup for keys pressed while Cmd was held, so let go of them when Cmd is released.
    if (isMac && e.key === 'Meta') {
      for (const held of [...heldKeys]) {
        if (held >= 0x10 && held <= 0x12) continue;
        heldKeys.delete(held);
        orbit.send({ type: 'key', vk: held, action: 'up', modifiers: 0 });
      }
    }
  });

  // ============================================================================
  // Session Toolbar Actions
  // ============================================================================
  $('sasBtn').addEventListener('click', () => {
    orbit.send({ type: 'sas' });
    showBanner('Sent Ctrl+Alt+Del (Secure Attention Sequence) to PC.');
  });

  $('sessionMonitorSelect').addEventListener('change', async (event) => {
    selectedMonitor = Number(event.target.value);
    if(gpuSession){try{if($('sessionQualitySelect').value==='crisp')await startGpuVideo();else await orbit.selectVideoMonitor(selectedMonitor);}catch(error){showBanner(error.message);}return;}
    $('desktopLoadingOverlay').classList.remove('hidden');
    orbit.send({ type: 'display_config', monitor: selectedMonitor, quality: $('sessionQualitySelect').value });
  });

  $('fitWindowBtn').addEventListener('click', () => {
    if(gpuSession){canvas.style.width='100%';canvas.style.height='100%';return;}

    const vp = $('desktopViewport').getBoundingClientRect();
    const w = Math.max(1024, Math.round(vp.width));
    const h = Math.max(720, Math.round(vp.height));
    orbit.send({ type: 'display_config', monitor: selectedMonitor, width: w, height: h });
    showBanner(`Requested PC display resolution ${w}×${h}.`);
  });

  $('sessionQualitySelect').addEventListener('change', async (e) => {
    if(gpuSession){try{await startGpuVideo();}catch(error){showBanner(error.message);}return;}

    orbit.send({ type: 'display_config', quality: e.target.value, monitor: selectedMonitor });
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
    orbit.send({ type: 'exec_cmd', command: cmd, shell });
  });

  $('termInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') $('sendTermBtn').click();
  });

  $('clearTermBtn').addEventListener('click', () => {
    $('termOutput').textContent = '';
  });

  $('fileDrivesBtn').addEventListener('click', () => {
    orbit.send({ type: 'fs_list', path: '' });
  });

  $('fileUpBtn').addEventListener('click', () => {
    orbit.send({ type: 'fs_list', path: currentFileParentPath || '' });
  });

  $('fileRefreshBtn').addEventListener('click', () => {
    orbit.send({ type: 'fs_list', path: currentFilePath || '' });
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
    orbit.send({ type: 'proc_list' });
  });

  $('powerLockBtn').addEventListener('click', () => {
    orbit.send({ type: 'sys_power', action: 'lock' });
    showBanner('Locked Windows PC.');
  });

  $('powerRestartBtn').addEventListener('click', () => {
    orbit.send({ type: 'sys_power', action: 'restart' });
    showBanner('Restarting Windows PC in 5 seconds...');
  });

  orbit.onEvent((msg) => {
    if(msg.error){showBanner(msg.error);return;}
    if (msg.type === 'exec_result') {
      if (msg.stdout) appendTerm(msg.stdout);
      if (msg.stderr) appendTerm(msg.stderr);
    } else if (msg.type === 'fs_list_result') {
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
        name.className = 'item-title';
        name.textContent = item.isDir ? `📁 ${item.name}` : `📄 ${item.name}`;
        left.appendChild(name);

        const right = document.createElement('div');
        right.className = 'row-gap-sm';
        if (item.isDir) {
          const openBtn = document.createElement('button');
          openBtn.className = 'sh-btn sh-btn-outline sh-btn-sm';
          openBtn.textContent = 'Open';
          openBtn.addEventListener('click', () => {
            orbit.send({ type: 'fs_list', path: item.path });
          });
          right.appendChild(openBtn);
        } else {
          const kb = Math.max(1, Math.round((item.size || 0) / 1024));
          const sz = document.createElement('span');
          sz.className = 'footer-muted';
          sz.textContent = `${kb.toLocaleString()} KB`;
          right.appendChild(sz);

          const dlBtn = document.createElement('button');
          dlBtn.className = 'sh-btn sh-btn-outline sh-btn-sm';
          dlBtn.textContent = 'Download';
          dlBtn.addEventListener('click', () => {
            orbit.send({ type: 'fs_download', path: item.path });
            showBanner(`Downloading ${item.name} to Downloads...`);
          });
          right.appendChild(dlBtn);
        }

        row.appendChild(left);
        row.appendChild(right);
        container.appendChild(row);
      }
    } else if (msg.type === 'download_saved') {
      showBanner(`Downloaded to ${msg.path}`);
    } else if (msg.type === 'fs_upload_result') {
      if (msg.ok) {
        showBanner('Upload complete.');
        orbit.send({ type: 'fs_list', path: currentFilePath });
      } else {
        showBanner(msg.error || 'Upload failed.');
      }
    } else if (msg.type === 'proc_list_result') {
      const container = $('procListContainer');
      container.innerHTML = '';
      const procs = msg.processes || [];
      for (const p of procs) {
        const row = document.createElement('div');
        row.className = 'table-row';

        const left = document.createElement('div');
        const title = document.createElement('div');
        title.className = 'item-title';
        title.textContent = p.title ? `${p.name} — ${p.title}` : p.name;
        const sub = document.createElement('div');
        sub.className = 'item-sub';
        sub.textContent = `PID ${p.pid} · ${p.memoryMb} MB`;
        left.appendChild(title);
        left.appendChild(sub);

        const killBtn = document.createElement('button');
        killBtn.className = 'sh-btn sh-btn-outline sh-btn-sm';
        killBtn.textContent = 'End Task';
        killBtn.addEventListener('click', () => {
          orbit.send({ type: 'proc_kill', pid: p.pid });
          setTimeout(() => orbit.send({ type: 'proc_list' }), 400);
        });

        row.appendChild(left);
        row.appendChild(killBtn);
        container.appendChild(row);
      }
    }
  });

  // ============================================================================
  // Frameless Window, Settings Popover & Auto-Update Controls
  // ============================================================================
  $('winMinBtn')?.addEventListener('click', () => orbit.minimizeWindow?.());
  $('winMaxBtn')?.addEventListener('click', () => orbit.maximizeWindow?.());
  $('winCloseBtn')?.addEventListener('click', () => orbit.closeWindow?.());

  function setSettingsOpen(open) {
    const popover = $('settingsPopover');
    const backdrop = $('settingsBackdrop');
    const gearBtn = $('checkUpdatesCircleBtn');
    if (!popover || !backdrop || !gearBtn) return;
    popover.classList.toggle('hidden', !open);
    backdrop.classList.toggle('hidden', !open);
    gearBtn.classList.toggle('is-open', open);
    gearBtn.setAttribute('aria-expanded', String(open));
    if (!open) showStreamShortcuts(); // stop waiting for a key press
  }

  // Settings: the two Mac stream shortcuts. Click one, then press the new keys. Esc cancels.
  let streamShortcuts = {};
  let recordingShortcut = null; // the button waiting for a key press
  function showStreamShortcuts(shortcuts = streamShortcuts) {
    streamShortcuts = shortcuts;
    recordingShortcut = null;
    const keys = (action) => OrbitShortcuts.formatAccelerator(streamShortcuts[action]);
    document.querySelectorAll('.shortcut-btn').forEach((btn) => { btn.textContent = keys(btn.dataset.shortcut); });
    $('streamShortcutHint').textContent = `${keys('release')} brings you back to your Mac and ${keys('close')} closes the stream.`;
  }
  document.querySelectorAll('.shortcut-btn').forEach((btn) => btn.addEventListener('click', () => {
    showStreamShortcuts();
    recordingShortcut = btn;
    btn.textContent = 'Press keys…';
  }));
  document.addEventListener('keydown', async (e) => {
    if (!recordingShortcut) return;
    e.preventDefault();
    e.stopPropagation(); // keep Esc from also closing Settings
    const accelerator = OrbitShortcuts.acceleratorFromKeyEvent(e);
    if (!accelerator && e.key !== 'Escape') return; // only modifier keys are down so far
    const action = recordingShortcut.dataset.shortcut;
    showStreamShortcuts();
    if (!accelerator) return;
    try { showStreamShortcuts((await orbit.setStreamShortcut(action, accelerator)).streamShortcuts); }
    catch (error) { showBanner(error.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')); }
  }, true);

  $('checkUpdatesCircleBtn')?.addEventListener('click', () => {
    const isOpen = !$('settingsPopover')?.classList.contains('hidden');
    playTactileSound(isOpen ? 'switch-off' : 'switch-on');
    setSettingsOpen(!isOpen);
  });

  $('settingsBackdrop')?.addEventListener('click', () => {
    playTactileSound('tick');
    setSettingsOpen(false);
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !$('settingsPopover')?.classList.contains('hidden')) {
      setSettingsOpen(false);
    }
  });

  // Settings Popover: Stream Quality Segmented Control
  function syncQualityButtons(mode) {
    document.querySelectorAll('#settingsQualitySegment .seg-btn').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.quality === mode);
    });
    if ($('sessionQualitySelect')) {
      $('sessionQualitySelect').value = mode;
    }
  }

  document.querySelectorAll('#settingsQualitySegment .seg-btn').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const mode = btn.dataset.quality;
      playTactileSound('tab');
      syncQualityButtons(mode);
      await orbit.setQualityMode(mode);
    });
  });

  // Settings Popover: Tactile UI Sounds Toggle
  if ($('soundEffectsToggle')) {
    $('soundEffectsToggle').checked = tactileSoundsEnabled;
    $('soundEffectsToggle').addEventListener('change', (e) => {
      tactileSoundsEnabled = e.target.checked;
      localStorage.setItem('orbit_tactile_sounds', String(tactileSoundsEnabled));
      if (tactileSoundsEnabled) playTactileSound('switch-on');
    });
  }

  // Settings Popover: Keep PC Awake Sync
  $('settingsKeepAwakeToggle')?.addEventListener('change', (e) => {
    const checked = e.target.checked;
    playTactileSound(checked ? 'switch-on' : 'switch-off');
    if ($('keepAwakeToggle')) $('keepAwakeToggle').checked = checked;
    orbit.setKeepAwake(checked);
  });

  // Settings Popover: Re-apply Admin & UAC Service
  $('settingsRepairAdminBtn')?.addEventListener('click', () => {
    playTactileSound('tick');
    applyAdminService();
  });

  // Settings Popover: Check Updates Button
  $('settingsCheckUpdatesBtn')?.addEventListener('click', () => {
    playTactileSound('tick');
    $('checkUpdatesBtn')?.click();
  });

  $('checkUpdatesBtn').addEventListener('click', async () => {
    playTactileSound('tick');
    const btn = $('checkUpdatesBtn');
    const popBtn = $('settingsCheckUpdatesBtn');
    const prev = btn.textContent;
    btn.textContent = 'Checking...';
    btn.disabled = true;
    if (popBtn) {
      popBtn.textContent = 'Checking...';
      popBtn.disabled = true;
    }
    try {
      const res = await orbit.checkForUpdates();
      if (res && res.commit) {
        $('updateVersionLabel').textContent = `Automatic · ${res.commit}`;
        if ($('settingsCommitBadge')) $('settingsCommitBadge').textContent = `v1.0 · ${res.commit}`;
      }
      if (res && res.message) {
        showBanner(res.message);
      }
    } catch {
      showBanner('Update check complete.');
    } finally {
      btn.textContent = prev;
      btn.disabled = false;
      if (popBtn) {
        popBtn.textContent = 'Check now';
        popBtn.disabled = false;
      }
    }
  });

  if (orbit.onUpdateEvent) {
    orbit.onUpdateEvent((evt) => {
      if (evt && evt.commit) {
        $('updateVersionLabel').textContent = `Automatic · ${evt.commit}`;
        if ($('settingsCommitBadge')) $('settingsCommitBadge').textContent = `v1.0 · ${evt.commit}`;
      }
      if (evt && evt.message) {
        showBanner(evt.message);
      }
    });
  }

  document.addEventListener('visibilitychange',()=>video?.setVisible(!document.hidden&&!$('tabDesktop').classList.contains('hidden')));
  async function init() {
    const info = await orbit.getAppInfo();
    isWindows = Boolean(info.isWindows);
    const qMode = info.clientConfig?.qualityMode || 'crisp';
    syncQualityButtons(qMode);
    showStreamShortcuts(info.clientConfig?.streamShortcuts);

    if (!isWindows) {
      $('modeHostBtn').classList.add('hidden');
      setMode('client');
    } else {
      setMode('host');
      orbit.setKeepAwake(true);
      setInterval(() => {
        if (!inSession && currentMode === 'host') {
          refreshHostStatus();
        }
      }, 2500);
    }
  }

  init();
})();
