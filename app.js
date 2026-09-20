// Built-in ICE servers are STUN only (direct/NAT-traversal). There is no free public TURN relay that
// is reliable, so for networks that block direct connections add your own TURN in Network Settings
// (Metered / Twilio / Cloudflare / coturn). Ports 443 (TCP/TLS) get through most corporate firewalls.
const COMMON_ICE_SERVERS = [
    { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302', 'stun:global.stun.twilio.com:3478'] }
];

// Signaling servers tried in order. First entry is the public PeerJS cloud (wss on 443).
// A custom server (Network Settings) is tried first when configured.
const DEFAULT_SIGNALING = [{ host: '0.peerjs.com', port: 443, path: '/', secure: true }];
let signalingIndex = 0;
let signalingRetries = 0;
const MAX_SIGNALING_RETRIES = 6;

// Parse one "turn:user:pass@host:port[?transport=tcp]" (or plain stun:/turn: URL) into an RTCIceServer.
function parseIceUrl(raw) {
    raw = (raw || '').trim();
    const m = raw.match(/^(stuns?|turns?):(?:([^:@\/]+):([^@\/]+)@)?(.+)$/i);
    if (!m) return null;
    const server = { urls: `${m[1].toLowerCase()}:${m[4]}` };
    if (m[2]) { server.username = decodeURIComponent(m[2]); server.credential = decodeURIComponent(m[3]); }
    return server;
}

// Accepts: a JSON iceServers array (as given by Metered/Twilio/Cloudflare), or one turn:/stun: URL per line/comma.
function parseIceServers(raw) {
    raw = (raw || '').trim();
    if (!raw) return [];
    if (raw[0] === '[' || raw[0] === '{') {
        try {
            let j = JSON.parse(raw);
            if (j && !Array.isArray(j)) j = j.iceServers || [j];
            return j.filter(x => x && x.urls);
        } catch (e) { return []; }
    }
    return raw.split(/[\s,]+/).map(parseIceUrl).filter(Boolean);
}

// Parse "host[:port][/path]" (prefix wss:// or ws:// optional) into PeerJS server options.
function parseSignalingServer(raw) {
    raw = (raw || '').trim();
    if (!raw) return null;
    const m = raw.match(/^(?:(wss?|https?):\/\/)?([^:\/]+)(?::(\d+))?(\/.*)?$/i);
    if (!m) return null;
    const secure = !m[1] || /^(wss|https)$/i.test(m[1]);
    return { host: m[2], port: m[3] ? parseInt(m[3], 10) : (secure ? 443 : 80), path: m[4] || '/', secure };
}

function getSignalingList() {
    const list = [];
    const custom = parseSignalingServer(localStorage.getItem('aerosync_signaling'));
    if (custom) list.push(custom);
    return list.concat(DEFAULT_SIGNALING);
}

let signalingStatus = 'checking'; // 'ok' | 'blocked' | 'checking'

const roleSelectionOverlay = document.getElementById('role-selection-overlay');
const clientConnectionOverlay = document.getElementById('client-connection-overlay');
const webHostOverlay = document.getElementById('web-host-overlay');
const btnRoleClient = document.getElementById('btn-role-client');
const btnRoleHost = document.getElementById('btn-role-host');
const clientBackBtn = document.getElementById('client-back-btn');
const hostBackBtn = document.getElementById('host-back-btn');
const networkBackBtn = document.getElementById('network-back-btn');

const networkSettingsOverlay = document.getElementById('network-settings-overlay');
const openNetworkSettingsBtns = document.querySelectorAll('.open-network-settings-btn');
const saveNetworkSettingsBtn = document.getElementById('save-network-settings');
const customIceServerInput = document.getElementById('custom-ice-server');
const forceRelayCheckbox = document.getElementById('force-relay-mode');
const customSignalingInput = document.getElementById('custom-signaling-server');

const sessionContainer = document.getElementById('session-container');
const recordBtn = document.getElementById('record-btn');
const connectBtn = document.getElementById('connect-btn');
const disconnectBtn = document.getElementById('disconnect-btn');
const hostIdInput = document.getElementById('host-id-input');
const clientStatusMsg = document.getElementById('client-status-msg');
const remoteVideo = document.getElementById('remote-video');
const connectedIdDisplay = document.getElementById('connected-id-display');
const hostKeyInput = document.getElementById('host-key-input');
const saveDeviceCheck = document.getElementById('save-device-check');
const deviceNameInput = document.getElementById('device-name-input');
const autoConnectCheck = document.getElementById('autoconnect-check');
const savedDevicesWrap = document.getElementById('saved-devices-wrap');
const savedDevicesEl = document.getElementById('saved-devices');
const hostUnregisteredBox = document.getElementById('host-unregistered');
const hostRegisteredBox = document.getElementById('host-registered');
const hostKeyDisplay = document.getElementById('host-key-display');
const hostRegName = document.getElementById('host-reg-name');
const hostDeviceNameInput = document.getElementById('host-device-name');
const registerDeviceBtn = document.getElementById('register-device-btn');
const unregisterDeviceBtn = document.getElementById('unregister-device-btn');
const copyHostInfoBtn = document.getElementById('copy-host-info-btn');

const webHostIdDisplay = document.getElementById('web-host-id-display');
const startShareBtn = document.getElementById('start-share-btn');
const hostStatusMsg = document.getElementById('host-status-msg');
const toggleControlBtn = document.getElementById('toggle-control-btn');

const signalDot = document.getElementById('signal-dot');
const clientStatusText = document.getElementById('client-status-text');
const hostSignalDot = document.getElementById('host-signal-dot');
const hostStatusText = document.getElementById('host-status-text');

let peer = null;
let dataConnection = null;
let isControlEnabled = true;
let currentMode = 'none'; // 'client' | 'host'
let localStream = null;
let remoteStream = null;
let mediaRecorder = null;
let recordedChunks = [];
let isRecording = false;
let mediaCall = null;
let isConnected = false;

function generateShortId() {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    let id = '';
    for (let i = 0; i < 6; i++) {
        id += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return id.substring(0, 3) + '-' + id.substring(3, 6);
}

// ---- Diagnostics: on-screen connection log (signaling, ICE candidates, ICE state) to debug firewall/VPN issues ----
const diagLines = [];
function diag(msg) {
    diagLines.push(`${new Date().toLocaleTimeString()} ${msg}`);
    if (diagLines.length > 200) diagLines.shift();
    document.querySelectorAll('.diag-log').forEach(el => { el.textContent = diagLines.join('\n'); el.scrollTop = el.scrollHeight; });
}
function watchPeerConnection(conn, label, tries = 0) {
    const pc = conn && conn.peerConnection;
    if (!pc) { if (tries < 25) setTimeout(() => watchPeerConnection(conn, label, tries + 1), 200); return; }
    const counts = { host: 0, srflx: 0, prflx: 0, relay: 0 };
    diag(`[${label}] connection started (policy: ${(pc.getConfiguration().iceTransportPolicy) || 'all'})`);
    pc.addEventListener('icecandidate', (e) => {
        if (e.candidate) { const t = e.candidate.type || 'unknown'; counts[t] = (counts[t] || 0) + 1; }
        else diag(`[${label}] candidates gathered: host=${counts.host} srflx(STUN)=${counts.srflx} relay(TURN)=${counts.relay}` + (counts.srflx + counts.relay === 0 ? '  -> NO public/relay candidates: STUN/TURN unreachable (firewall/VPN)' : ''));
    });
    pc.addEventListener('iceconnectionstatechange', () => diag(`[${label}] ICE state: ${pc.iceConnectionState}` + (pc.iceConnectionState === 'failed' ? '  -> no working network path (need TURN on port 443)' : '')));
    pc.addEventListener('icecandidateerror', (e) => diag(`[${label}] ICE server error ${e.errorCode || ''} ${e.url || ''} ${e.errorText || ''}`));
}
document.addEventListener('click', async (e) => {
    const btn = e.target.closest && e.target.closest('.copy-diag');
    if (!btn) return;
    try { await navigator.clipboard.writeText(diagLines.join('\n')); btn.textContent = 'Copied'; } catch (err) { btn.textContent = 'Select the text and copy'; }
    setTimeout(() => { btn.textContent = 'Copy log'; }, 2000);
});

// ---- Device registration: no server/accounts, credentials live in this browser's localStorage ----
const LS_HOST_REG = 'aerosync_host_reg', LS_DEVICES = 'aerosync_devices', LS_AUTO = 'aerosync_autoconnect', LS_LAST = 'aerosync_last_device';
const lsGet = (k, d) => { try { const v = JSON.parse(localStorage.getItem(k)); return v === null || v === undefined ? d : v; } catch (e) { return d; } };
const lsSet = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} };
function randomToken(len, alphabet) {
    const a = new Uint32Array(len); crypto.getRandomValues(a);
    return Array.from(a, n => alphabet[n % alphabet.length]).join('');
}
function getHostReg() { const r = lsGet(LS_HOST_REG, null); return r && r.id && r.key ? r : null; }
function safeEqual(a, b) {
    a = String(a || ''); b = String(b || '');
    if (a.length !== b.length) return false;
    let d = 0; for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
    return d === 0;
}
let idRetries = 0, authFails = 0, authLockedUntil = 0, pendingClientId = null, pendingConn = null;
let keepClientStatus = false;
let autoRetry = null, autoRetryTimer = null, pendingAutoDevice = null;

function showOverlay(overlay) {
    roleSelectionOverlay.classList.add('hidden');
    clientConnectionOverlay.classList.add('hidden');
    webHostOverlay.classList.add('hidden');
    networkSettingsOverlay.classList.add('hidden');
    sessionContainer.classList.add('hidden');
    if (overlay) overlay.classList.remove('hidden');
}

btnRoleClient.addEventListener('click', () => {
    currentMode = 'client';
    showOverlay(clientConnectionOverlay);
    initPeer();
});

btnRoleHost.addEventListener('click', () => {
    currentMode = 'host';
    showOverlay(webHostOverlay);
    const reg = getHostReg();
    renderHostRegistration();
    initPeer(reg ? reg.id : generateShortId());
});

clientBackBtn.addEventListener('click', () => {
    cancelAutoRetry();
    resetApp();
});

hostBackBtn.addEventListener('click', () => {
    resetApp();
});

networkBackBtn.addEventListener('click', () => {
    if (currentMode === 'host') {
        showOverlay(webHostOverlay);
    } else {
        showOverlay(clientConnectionOverlay);
    }
});

openNetworkSettingsBtns.forEach(btn => {
    btn.addEventListener('click', () => {
        const savedIce = localStorage.getItem('aerosync_custom_ice');
        customIceServerInput.value = savedIce || '';
        customSignalingInput.value = localStorage.getItem('aerosync_signaling') || '';
        
        const isForced = localStorage.getItem('aerosync_force_relay') === 'true';
        forceRelayCheckbox.checked = isForced;
        
        showOverlay(networkSettingsOverlay);
    });
});

saveNetworkSettingsBtn.addEventListener('click', () => {
    const server = customIceServerInput.value.trim();
    if (server && parseIceServers(server).length) {
        localStorage.setItem('aerosync_custom_ice', server);
    } else {
        localStorage.removeItem('aerosync_custom_ice');
    }
    
    const sig = customSignalingInput.value.trim();
    if (sig && parseSignalingServer(sig)) localStorage.setItem('aerosync_signaling', sig);
    else localStorage.removeItem('aerosync_signaling');

    localStorage.setItem('aerosync_force_relay', forceRelayCheckbox.checked ? 'true' : 'false');
    
    alert('Settings saved. Restarting application...');
    location.reload();
});

function initPeer(customId = null, isRetry = false) {
    if (peer) { peer.destroy(); }
    if (!isRetry) { signalingIndex = 0; signalingRetries = 0; idRetries = 0; }

    const iceServers = [...COMMON_ICE_SERVERS];
    iceServers.unshift(...parseIceServers(localStorage.getItem('aerosync_custom_ice')));

    const isForced = localStorage.getItem('aerosync_force_relay') === 'true';

    const signalingList = getSignalingList();
    const signaling = signalingList[signalingIndex % signalingList.length];

    const peerOptions = {
        debug: 1,
        host: signaling.host,
        port: signaling.port,
        path: signaling.path,
        secure: signaling.secure,
        pingInterval: 5000,
        config: {
            'iceServers': iceServers,
            'sdpSemantics': 'unified-plan',
            'iceTransportPolicy': isForced ? 'relay' : 'all',
            'iceCandidatePoolSize': 4
        }
    };

    const activePeer = customId ? new Peer(customId, peerOptions) : new Peer(peerOptions);
    peer = activePeer;
    const stillCurrent = () => peer === activePeer;

    // Signaling failed: rotate to the next server / retry with backoff instead of giving up.
    const retrySignaling = (reason) => {
        if (!stillCurrent()) return;
        if (signalingRetries >= MAX_SIGNALING_RETRIES) return false;
        signalingRetries++;
        signalingIndex++;
        const delay = Math.min(1000 * signalingRetries, 5000);
        const msg = `Signaling unreachable (${reason}). Retrying ${signalingRetries}/${MAX_SIGNALING_RETRIES}...`;
        if (currentMode === 'client') { clientStatusText.textContent = msg; clientStatusMsg.style.color = '#e3b341'; }
        else if (currentMode === 'host') { hostStatusText.textContent = msg; hostStatusMsg.style.color = '#e3b341'; }
        setTimeout(() => { if (stillCurrent() && currentMode !== 'none') initPeer(customId, true); }, delay);
        return true;
    };

    peer.on('open', (id) => {
        diag(`signaling connected via ${signaling.host}:${signaling.port} as ${id}`);
        signalingStatus = 'ok';
        signalingRetries = 0;
        if (signalDot) signalDot.style.background = '#2ea043';
        if (hostSignalDot) hostSignalDot.style.background = '#2ea043';
        
        if (currentMode === 'client') {
            clientStatusText.textContent = 'AeroSync Ready.';
            connectBtn.disabled = false;
            if (pendingAutoDevice) {
                const d = pendingAutoDevice; pendingAutoDevice = null;
                connectToHost(d.id, d.key, true);
            }
        } else if (currentMode === 'host') {
            webHostIdDisplay.textContent = id;
            hostStatusText.textContent = 'AeroSync Ready.';
            hostStatusMsg.style.color = '#2ea043';
            startShareBtn.classList.remove('hidden');
        }
    });

    peer.on('error', (err) => {
        console.error('PeerJS error:', err);
        diag(`peer error: ${err.type} ${err.message || ''}`);

        // Host ID in use. A registered ID may still be held by our previous session for ~a minute: keep retrying it.
        if (err.type === 'unavailable-id' && currentMode === 'host') {
            const reg = getHostReg();
            if (reg && customId === reg.id) {
                if (idRetries < 12) {
                    idRetries++;
                    hostStatusText.textContent = `Reclaiming your registered ID (${idRetries}/12)...`;
                    hostStatusMsg.style.color = '#e3b341';
                    setTimeout(() => { if (stillCurrent() && currentMode === 'host') initPeer(customId, true); }, 4000);
                } else {
                    hostStatusText.textContent = 'Registered ID is in use by another session. Close other host windows and retry.';
                    hostStatusMsg.style.color = '#f85149';
                }
                return;
            }
            initPeer(generateShortId(), true);
            return;
        }

        // Client tried to reach a host that is not online / wrong ID.
        if (err.type === 'peer-unavailable') {
            clientStatusText.textContent = 'Host ID not found. Check the ID and that the host is online.';
            clientStatusMsg.style.color = '#f85149';
            connectBtn.disabled = false;
            scheduleAutoRetry();
            return;
        }

        // Critical signaling errors: rotate servers and retry automatically.
        if (err.type === 'network' || err.type === 'socket-error' || err.type === 'socket-closed' || err.type === 'server-error') {
            signalingStatus = 'blocked';
            if (signalDot) signalDot.style.background = '#f85149';
            if (hostSignalDot) hostSignalDot.style.background = '#f85149';
            if (retrySignaling(err.type)) return;
        }

        const blockedMsg = 'Signaling server unreachable. Firewall/VPN may block it - set a custom signaling server in Network Settings.';
        if (currentMode === 'client') {
            clientStatusText.textContent = signalingStatus === 'blocked' ? blockedMsg : `Error: ${err.type}`;
            clientStatusMsg.style.color = '#f85149';
        } else if (currentMode === 'host') {
            hostStatusText.textContent = signalingStatus === 'blocked' ? blockedMsg : `Error: ${err.type}`;
            hostStatusMsg.style.color = '#f85149';
        }
    });

    peer.on('disconnected', () => {
        // Keep the same ID; retry until the signaling socket is back.
        const p = peer;
        const tryReconnect = (n) => {
            if (!p || p !== peer || p.destroyed || !p.disconnected) return;
            try { p.reconnect(); } catch (e) {}
            if (n < 10) setTimeout(() => tryReconnect(n + 1), Math.min(1000 * (n + 1), 8000));
        };
        setTimeout(() => tryReconnect(0), 500);
    });

    // Handle incoming connections (Host Mode)
    peer.on('connection', (conn) => {
        if (currentMode !== 'host') return;
        diag('incoming connection from a client');
        watchPeerConnection(conn, 'host-data');

        conn.on('data', (data) => {
            if (!data || data.type !== 'system' || data.action !== 'request-stream') return;

            // Registered hosts require the Access Key; lock out guessing.
            const reg = getHostReg();
            if (reg) {
                const locked = Date.now() < authLockedUntil;
                if (locked || !safeEqual(data.key, reg.key)) {
                    if (!locked && ++authFails >= 5) { authLockedUntil = Date.now() + 60000; authFails = 0; }
                    hostStatusText.textContent = 'Rejected a connection with a wrong Access Key.';
                    hostStatusMsg.style.color = '#e3b341';
                    try { conn.send({ type: 'system', action: 'auth-failed', locked }); } catch (e) {}
                    setTimeout(() => conn.close(), 400);
                    return;
                }
                authFails = 0;
            }

            if (localStream) {
                hostStatusText.textContent = 'Client connected, sending stream...';
                hostStatusMsg.style.color = '#2ea043';
                const call = peer.call(data.clientId, localStream);
                handleActiveCall(call);
            } else {
                // Not sharing yet: remember the client and call it as soon as sharing starts.
                pendingClientId = data.clientId; pendingConn = conn;
                hostStatusText.textContent = 'Client is waiting - click Start Sharing.';
                hostStatusMsg.style.color = '#58a6ff';
                try { conn.send({ type: 'system', action: 'waiting' }); } catch (e) {}
            }
        });

        conn.on('close', () => { if (pendingConn === conn) { pendingConn = null; pendingClientId = null; } });
    });

    // Handle incoming calls (Client Mode)
    peer.on('call', (call) => {
        if (currentMode !== 'client') return;
        mediaCall = call;
        call.answer();
        watchPeerConnection(call, 'client-media');

        call.on('stream', (stream) => {
            remoteStream = stream;
            remoteVideo.srcObject = remoteStream;
            showOverlay(sessionContainer);
            connectedIdDisplay.textContent = hostIdInput.value.trim();
            isConnected = true;
            clientStatusText.textContent = 'Connected successfully.';
            
            if ('ontouchstart' in window || navigator.maxTouchPoints > 0) {
                document.getElementById('mobile-controls').classList.remove('hidden');
                toggleTrackpadVisibility(true);
                isTouchDevice = true;
            }
            setupControlListeners();
        });

        call.on('close', () => resetUI());
    });
}

// Host Mode: Start Sharing
startShareBtn.addEventListener('click', async () => {
    try {
        localStream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
        hostStatusText.textContent = 'Sharing active. Waiting for client to connect...';
        hostStatusMsg.style.color = '#58a6ff';
        startShareBtn.classList.add('hidden');
        if (pendingClientId && peer && peer.open) {
            hostStatusText.textContent = 'Client connected, sending stream...';
            handleActiveCall(peer.call(pendingClientId, localStream));
            pendingClientId = null; pendingConn = null;
        }
        
        // If user manually stops sharing via browser UI
        localStream.getVideoTracks()[0].onended = () => {
            hostStatusText.textContent = 'Screen sharing stopped.';
            hostStatusMsg.style.color = '#8b949e';
            startShareBtn.classList.remove('hidden');
            if (mediaCall) mediaCall.close();
            localStream = null;
        };
    } catch (err) {
        console.error('Display capture error:', err);
        hostStatusText.textContent = 'Permission denied for screen share.';
        hostStatusMsg.style.color = '#f85149';
    }
});

function handleActiveCall(call) {
    mediaCall = call;
    watchPeerConnection(call, 'host-media');
    call.on('close', () => {
        if (localStream) {
            hostStatusText.textContent = 'Client disconnected. Still sharing, waiting for new client...';
            hostStatusMsg.style.color = '#58a6ff';
        }
    });
}

// Client Mode: Connect
function cancelAutoRetry() { autoRetry = null; clearTimeout(autoRetryTimer); }
function scheduleAutoRetry() {
    clearTimeout(autoRetryTimer);
    if (!autoRetry) return;
    autoRetryTimer = setTimeout(() => {
        if (currentMode === 'client' && autoRetry && !isConnected) connectToHost(autoRetry.id, autoRetry.key, true);
    }, 8000);
}

function connectToHost(hostId, key, isAuto = false) {
    clearTimeout(autoRetryTimer);
    autoRetry = isAuto ? { id: hostId, key } : null;
    hostIdInput.value = hostId;
    hostKeyInput.value = key || '';

    if (!peer || peer.disconnected || !peer.open) {
        clientStatusText.textContent = 'Not connected to signaling yet. Retrying...';
        clientStatusMsg.style.color = '#e3b341';
        if (peer && peer.disconnected) { try { peer.reconnect(); } catch (e) {} }
        if (isAuto) scheduleAutoRetry();
        return;
    }

    clientStatusText.textContent = 'Connecting...';
    clientStatusMsg.style.color = '#58a6ff';
    connectBtn.disabled = true;

    if (dataConnection) { try { dataConnection.close(); } catch (e) {} }
    const conn = peer.connect(hostId, { reliable: true });
    dataConnection = conn;
    diag(`connecting to ${hostId}...`);
    watchPeerConnection(conn, 'client-data');

    // Connection watchdog
    const connectionTimeout = setTimeout(() => {
        if (dataConnection === conn && !conn.open) {
            clientStatusText.textContent = 'Could not reach host. Network blocks direct connections: add a TURN server in Network Settings on BOTH devices (see help there), or check the ID.';
            clientStatusMsg.style.color = '#e3b341';
            connectBtn.disabled = false;
            scheduleAutoRetry();
        }
    }, 20000);

    conn.on('open', () => {
        clearTimeout(connectionTimeout);
        clientStatusText.textContent = 'Requesting stream...';
        setTimeout(() => {
            if (conn.open) {
                conn.send({ type: 'system', action: 'request-stream', clientId: peer.id, key: key || '' });
            }
        }, 500);
    });

    conn.on('data', (data) => {
        if (!data || data.type !== 'system') return;
        if (data.action === 'auth-failed') {
            cancelAutoRetry();
            keepClientStatus = true;
            clientStatusText.textContent = data.locked ? 'Too many wrong keys. Wait a minute and retry.' : 'Wrong Access Key for this host.';
            clientStatusMsg.style.color = '#f85149';
            connectBtn.disabled = false;
        } else if (data.action === 'waiting') {
            clientStatusText.textContent = 'Host is online - waiting for the host to click Start Sharing...';
            clientStatusMsg.style.color = '#58a6ff';
        }
    });

    conn.on('close', () => { if (dataConnection === conn) resetUI(); });
}

connectBtn.addEventListener('click', () => {
    const hostId = hostIdInput.value.trim();
    const key = hostKeyInput.value.trim();
    if (!hostId) {
        clientStatusText.textContent = 'Please enter a valid Host ID';
        clientStatusMsg.style.color = '#f85149';
        return;
    }
    if (saveDeviceCheck.checked) saveDevice(hostId, key, deviceNameInput.value.trim());
    connectToHost(hostId, key, false);
});

// Saved devices list
function saveDevice(id, key, name) {
    const list = lsGet(LS_DEVICES, []);
    const dev = { id, key, name: (name || id).slice(0, 40) };
    const i = list.findIndex(d => d.id === id);
    if (i >= 0) list[i] = dev; else list.push(dev);
    lsSet(LS_DEVICES, list);
    lsSet(LS_LAST, id);
    renderSavedDevices();
}

function renderSavedDevices() {
    const list = lsGet(LS_DEVICES, []);
    savedDevicesEl.textContent = '';
    savedDevicesWrap.classList.toggle('hidden', list.length === 0);
    list.forEach(dev => {
        const row = document.createElement('div');
        row.style.cssText = 'display:flex; align-items:center; gap:8px; padding:6px 0; border-bottom:1px solid rgba(255,255,255,0.08);';
        const label = document.createElement('span');
        label.style.cssText = 'flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; color:#c9d1d9;';
        label.textContent = dev.name;
        label.title = dev.id;
        const go = document.createElement('button');
        go.textContent = 'Connect';
        go.className = 'menu-btn';
        go.style.cssText = 'width:auto; padding:4px 10px;';
        go.addEventListener('click', () => { lsSet(LS_LAST, dev.id); connectToHost(dev.id, dev.key, false); });
        const del = document.createElement('button');
        del.textContent = '\u2715';
        del.title = 'Remove';
        del.className = 'menu-btn';
        del.style.cssText = 'width:auto; padding:4px 8px;';
        del.addEventListener('click', () => {
            lsSet(LS_DEVICES, lsGet(LS_DEVICES, []).filter(d => d.id !== dev.id));
            if (lsGet(LS_LAST, null) === dev.id) localStorage.removeItem(LS_LAST);
            renderSavedDevices();
        });
        row.append(label, go, del);
        savedDevicesEl.appendChild(row);
    });
}

autoConnectCheck.addEventListener('change', () => lsSet(LS_AUTO, autoConnectCheck.checked));

// Host Mode: register / unregister this device
function renderHostRegistration() {
    const reg = getHostReg();
    hostUnregisteredBox.classList.toggle('hidden', !!reg);
    hostRegisteredBox.classList.toggle('hidden', !reg);
    if (reg) { hostKeyDisplay.textContent = reg.key; hostRegName.textContent = `${reg.name} (${reg.id})`; }
}

registerDeviceBtn.addEventListener('click', () => {
    if (localStream) { alert('Stop sharing first, then register.'); return; }
    const reg = {
        id: 'as-' + randomToken(10, 'abcdefghjkmnpqrstuvwxyz23456789'),
        key: randomToken(10, 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'),
        name: (hostDeviceNameInput.value.trim() || 'My device').slice(0, 40)
    };
    lsSet(LS_HOST_REG, reg);
    renderHostRegistration();
    initPeer(reg.id);
});

unregisterDeviceBtn.addEventListener('click', () => {
    if (localStream) { alert('Stop sharing first, then unregister.'); return; }
    if (!confirm('Unregister this device? Saved copies on other devices will stop working.')) return;
    localStorage.removeItem(LS_HOST_REG);
    renderHostRegistration();
    initPeer(generateShortId());
});

copyHostInfoBtn.addEventListener('click', async () => {
    const reg = getHostReg(); if (!reg) return;
    try { await navigator.clipboard.writeText(`ID: ${reg.id}\nAccess Key: ${reg.key}`); copyHostInfoBtn.textContent = 'Copied'; }
    catch (e) { copyHostInfoBtn.textContent = 'Copy failed - select the key manually'; }
    setTimeout(() => { copyHostInfoBtn.textContent = 'Copy ID + Key'; }, 2000);
});

disconnectBtn.addEventListener('click', () => { cancelAutoRetry(); resetUI(); });

function resetUI() {
    if (dataConnection) { dataConnection.close(); dataConnection = null; }
    if (mediaCall) { mediaCall.close(); mediaCall = null; }
    if (isRecording) stopRecording();
    
    remoteVideo.srcObject = null;
    remoteStream = null;
    isConnected = false;
    
    if (currentMode === 'client') {
        showOverlay(clientConnectionOverlay);
        connectBtn.disabled = false;
        if (keepClientStatus) { keepClientStatus = false; }
        else { clientStatusText.textContent = 'Disconnected.'; clientStatusMsg.style.color = '#8b949e'; }
        removeControlListeners();
        setControlMode(true);
    }
}

function resetApp() {
    resetUI();
    if (peer) { peer.destroy(); peer = null; }
    if (localStream) {
        localStream.getTracks().forEach(t => t.stop());
        localStream = null;
    }
    currentMode = 'none';
    showOverlay(roleSelectionOverlay);
    
    // reset Host UI specifically
    webHostIdDisplay.textContent = 'Generating...';
    startShareBtn.classList.add('hidden');
    hostStatusText.textContent = 'Initializing...';
    hostStatusMsg.style.color = '#8b949e';
}

function setControlMode(enabled) {
    isControlEnabled = enabled;
    if (enabled) {
        document.body.classList.remove('controls-disabled');
        if (toggleControlBtn) {
            toggleControlBtn.textContent = 'Controls: ON';
            toggleControlBtn.classList.add('active');
        }
    } else {
        document.body.classList.add('controls-disabled');
        if (toggleControlBtn) {
            toggleControlBtn.textContent = 'Controls: OFF';
            toggleControlBtn.classList.remove('active');
        }
    }
}

// OS Control Logic
function sendControl(type, actionData) {
    if (isConnected && isControlEnabled && dataConnection && dataConnection.open) {
        dataConnection.send({
            type: type,
            action: actionData
        });
    }
}

// --- MOUSE CONTROLS ---
const videoRect = () => remoteVideo.getBoundingClientRect();

function getRelativeCoordinates(e) {
    const rect = videoRect();
    // Calculate aspect ratio letterboxing/pillarboxing
    const videoRatio = remoteVideo.videoWidth / remoteVideo.videoHeight;
    const containerRatio = rect.width / rect.height;
    
    let drawWidth = rect.width;
    let drawHeight = rect.height;
    let offsetX = 0;
    let offsetY = 0;

    if (videoRatio > containerRatio) {
        // Letterboxed (bars top and bottom)
        drawHeight = rect.width / videoRatio;
        offsetY = (rect.height - drawHeight) / 2;
    } else {
        // Pillarboxed (bars sides)
        drawWidth = rect.height * videoRatio;
        offsetX = (rect.width - drawWidth) / 2;
    }

    const rawX = e.clientX - rect.left - offsetX;
    const rawY = e.clientY - rect.top - offsetY;

    // Relative percentage
    const x = Math.max(0, Math.min(1, rawX / drawWidth));
    const y = Math.max(0, Math.min(1, rawY / drawHeight));

    return { x, y };
}

function handleMouseMove(e) {
    if (!isConnected || !isControlEnabled) return;
    const { x, y } = getRelativeCoordinates(e);
    sendControl('mouse', { type: 'move', x, y });
}

function handleMouseDown(e) {
    if (!isConnected) return;
    const { x, y } = getRelativeCoordinates(e);
    const button = e.button === 0 ? 'left' : e.button === 2 ? 'right' : 'middle';
    sendControl('mouse', { type: 'down', button, x, y });
}

function handleMouseUp(e) {
    if (!isConnected) return;
    const { x, y } = getRelativeCoordinates(e);
    const button = e.button === 0 ? 'left' : e.button === 2 ? 'right' : 'middle';
    sendControl('mouse', { type: 'up', button, x, y });
}

function handleContextMenu(e) {
    e.preventDefault(); // Prevent browser context menu on video
}

// --- KEYBOARD CONTROLS ---
function handleKeyDown(e) {
    if (!isConnected) return;
    
    // ESC shortcut to release control
    if (e.key === 'Escape') {
        setControlMode(false);
        return;
    }

    if (!isControlEnabled) return;
    e.preventDefault();
    sendControl('keyboard', { type: 'down', key: e.key });
}

function handleKeyUp(e) {
    if (!isConnected) return;
    e.preventDefault();
    sendControl('keyboard', { type: 'up', key: e.key });
}

// --- MOBILE TOUCH CONTROLS ---
const mobileControls = document.getElementById('mobile-controls');
const hiddenKeyboardInput = document.getElementById('hidden-keyboard-input');
const keyboardBtn = document.getElementById('mobile-keyboard-btn');
const leftClickBtn = document.getElementById('mobile-left-click');
const rightClickBtn = document.getElementById('mobile-right-click');
const virtualTrackpad = document.getElementById('virtual-trackpad');
const trackpadPanel = document.getElementById('trackpad-panel');
const dragHandle = document.getElementById('drag-handle');
const resizeHandle = document.getElementById('resize-handle');
const hideTrackpadBtn = document.getElementById('hide-trackpad-btn');
const showTrackpadBtn = document.getElementById('show-trackpad-btn');

let isTouchDevice = false;
let lastTouch = null;

function toggleTrackpadVisibility(show) {
    if (show) {
        trackpadPanel.classList.remove('hidden');
        showTrackpadBtn.classList.add('hidden');
    } else {
        trackpadPanel.classList.add('hidden');
        showTrackpadBtn.classList.remove('hidden');
    }
}


// Drag and Resize State
let isDraggingPanel = false;
let panelDragStart = { x: 0, y: 0 };
let panelStartPos = { left: 0, top: 0 };

let isResizingPanel = false;
let panelResizeStart = { x: 0, y: 0 };
let panelStartSize = { w: 0, h: 0 };

function handleTrackpadTouchStart(e) {
    if (!isConnected) return;
    e.preventDefault();
    isTouchDevice = true;
    lastTouch = { x: e.touches[0].clientX, y: e.touches[0].clientY };
    virtualTrackpad.style.background = 'rgba(255,255,255,0.1)';
}

function handleTrackpadTouchMove(e) {
    if (!isConnected || !lastTouch) return;
    e.preventDefault(); // Prevent scrolling
    
    const touch = e.touches[0];
    const dx = touch.clientX - lastTouch.x;
    const dy = touch.clientY - lastTouch.y;
    
    lastTouch = { x: touch.clientX, y: touch.clientY };
    
    // Send relative movement
    sendControl('mouse', { type: 'move-relative', dx, dy });
}

function handleTrackpadTouchEnd(e) {
    lastTouch = null;
    virtualTrackpad.style.background = 'rgba(255,255,255,0.05)';
}

// Panel Dragging Logic
function startPanelDrag(e) {
    if (e.target.id === 'hide-trackpad-btn') return; 
    
    isDraggingPanel = true;
    const touch = e.touches[0];
    panelDragStart = { x: touch.clientX, y: touch.clientY };
    const rect = trackpadPanel.getBoundingClientRect();
    panelStartPos = { left: rect.left, top: rect.top };
    
    // Switch from right/bottom to absolute left/top for free dragging
    trackpadPanel.style.right = 'auto';
    trackpadPanel.style.bottom = 'auto';
    trackpadPanel.style.left = `${panelStartPos.left}px`;
    trackpadPanel.style.top = `${panelStartPos.top}px`;
    e.preventDefault();
}

// Panel Resizing Logic
function startPanelResize(e) {
    isResizingPanel = true;
    const touch = e.touches[0];
    panelResizeStart = { x: touch.clientX, y: touch.clientY };
    const rect = trackpadPanel.getBoundingClientRect();
    panelStartSize = { w: rect.width, h: rect.height };
    e.preventDefault();
}

// Global Touch Move for Dragging/Resizing
function handlePanelInteractionsMove(e) {
    if (isDraggingPanel) {
        const touch = e.touches[0];
        const dx = touch.clientX - panelDragStart.x;
        const dy = touch.clientY - panelDragStart.y;
        trackpadPanel.style.left = `${panelStartPos.left + dx}px`;
        trackpadPanel.style.top = `${panelStartPos.top + dy}px`;
        e.preventDefault();
    } else if (isResizingPanel) {
        const touch = e.touches[0];
        const dx = touch.clientX - panelResizeStart.x;
        const dy = touch.clientY - panelResizeStart.y;
        
        // Minimum size of 120x120
        const newW = Math.max(120, panelStartSize.w + dx); 
        const newH = Math.max(120, panelStartSize.h + dy); 
        
        trackpadPanel.style.width = `${newW}px`;
        trackpadPanel.style.height = `${newH}px`;
        e.preventDefault();
    }
}

function handlePanelInteractionsEnd(e) {
    isDraggingPanel = false;
    isResizingPanel = false;
}

// Global touch start just to show controls if they were hidden
function handleGlobalTouch(e) {
    if (!isTouchDevice) {
        isTouchDevice = true;
        mobileControls.classList.remove('hidden');
    }
}

// Mobile Overlay Button Logic
function triggerMobileLeftClick() {
    sendControl('mouse', { type: 'click', button: 'left' });
}

function triggerMobileRightClick() {
    sendControl('mouse', { type: 'click', button: 'right' });
}

function toggleMobileKeyboard() {
    hiddenKeyboardInput.focus();
    hiddenKeyboardInput.click();
}

// Capture typing from the hidden mobile input box
hiddenKeyboardInput.addEventListener('input', (e) => {
    if (!isConnected) return;
    
    // Check if the input value decreased in length (meaning backspace was pressed)
    // Mobile keyboards often don't send reliable keydown events for Backspace, 
    // but the 'input' event fires and the value gets shorter.
    // To keep it simple, we just send standard characters typed.
    
    const val = hiddenKeyboardInput.value;
    if (val.length > 0) {
        const char = val.charAt(val.length - 1);
        sendControl('keyboard', { type: 'down', key: char });
        setTimeout(() => sendControl('keyboard', { type: 'up', key: char }), 20);
    }
});

hiddenKeyboardInput.addEventListener('keydown', (e) => {
    if (e.key === 'Backspace' || e.key === 'Enter') {
        sendControl('keyboard', { type: 'down', key: e.key });
        setTimeout(() => sendControl('keyboard', { type: 'up', key: e.key }), 20);
    }
});


// --- SESSION RECORDING ---
function startRecording() {
    if (!remoteStream) return;
    recordedChunks = [];
    isRecording = true;
    recordBtn.textContent = '⏹️ Stop';
    recordBtn.classList.add('recording-active');

    const options = { mimeType: 'video/webm; codecs=vp8' };
    mediaRecorder = new MediaRecorder(remoteStream, options);

    mediaRecorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
            recordedChunks.push(event.data);
        }
    };

    mediaRecorder.onstop = () => {
        const blob = new Blob(recordedChunks, { type: 'video/webm' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        document.body.appendChild(a);
        a.style = 'display: none';
        a.href = url;
        const date = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
        a.download = `AeroSync-Session-${date}.webm`;
        a.click();
        window.URL.revokeObjectURL(url);
    };

    mediaRecorder.start();
}

function stopRecording() {
    isRecording = false;
    recordBtn.textContent = '🔴 Record';
    recordBtn.classList.remove('recording-active');
    if (mediaRecorder && mediaRecorder.state !== 'inactive') {
        mediaRecorder.stop();
    }
}

recordBtn.addEventListener('click', () => {
    if (isRecording) {
        stopRecording();
    } else {
        startRecording();
    }
});

function setupControlListeners() {
    remoteVideo.addEventListener('mousemove', handleMouseMove);
    remoteVideo.addEventListener('mousedown', handleMouseDown);
    remoteVideo.addEventListener('mouseup', handleMouseUp);
    remoteVideo.addEventListener('contextmenu', handleContextMenu);
    
    // Global touch fallback to show UI
    window.addEventListener('touchstart', handleGlobalTouch, { passive: true });
    
    // Specific Virtual Trackpad events
    virtualTrackpad.addEventListener('touchstart', handleTrackpadTouchStart, { passive: false });
    virtualTrackpad.addEventListener('touchmove', handleTrackpadTouchMove, { passive: false });
    virtualTrackpad.addEventListener('touchend', handleTrackpadTouchEnd);
    virtualTrackpad.addEventListener('touchcancel', handleTrackpadTouchEnd);
    
    // Panel Drag and Resize events
    dragHandle.addEventListener('touchstart', startPanelDrag, { passive: false });
    resizeHandle.addEventListener('touchstart', startPanelResize, { passive: false });
    window.addEventListener('touchmove', handlePanelInteractionsMove, { passive: false });
    window.addEventListener('touchend', handlePanelInteractionsEnd);
    window.addEventListener('touchcancel', handlePanelInteractionsEnd);
    
    // Mobile Buttons
    leftClickBtn.addEventListener('click', triggerMobileLeftClick);
    rightClickBtn.addEventListener('click', triggerMobileRightClick);
    keyboardBtn.addEventListener('click', toggleMobileKeyboard);
    
    hideTrackpadBtn.addEventListener('touchstart', (e) => {
        e.stopPropagation();
        toggleTrackpadVisibility(false);
    }, { passive: true });
    
    showTrackpadBtn.addEventListener('touchstart', (e) => {
        e.stopPropagation();
        toggleTrackpadVisibility(true);
    }, { passive: true });

    if (toggleControlBtn) {
        toggleControlBtn.addEventListener('click', () => {
            setControlMode(!isControlEnabled);
        });
        // Set initial state
        setControlMode(true);
    }
    
    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('keyup', handleKeyUp);
}

function removeControlListeners() {
    remoteVideo.removeEventListener('mousemove', handleMouseMove);
    remoteVideo.removeEventListener('mousedown', handleMouseDown);
    remoteVideo.removeEventListener('mouseup', handleMouseUp);
    remoteVideo.removeEventListener('contextmenu', handleContextMenu);
    
    window.removeEventListener('touchstart', handleGlobalTouch);
    
    virtualTrackpad.removeEventListener('touchstart', handleTrackpadTouchStart);
    virtualTrackpad.removeEventListener('touchmove', handleTrackpadTouchMove);
    virtualTrackpad.removeEventListener('touchend', handleTrackpadTouchEnd);
    virtualTrackpad.removeEventListener('touchcancel', handleTrackpadTouchEnd);
    
    dragHandle.removeEventListener('touchstart', startPanelDrag);
    resizeHandle.removeEventListener('touchstart', startPanelResize);
    window.removeEventListener('touchmove', handlePanelInteractionsMove);
    window.removeEventListener('touchend', handlePanelInteractionsEnd);
    window.removeEventListener('touchcancel', handlePanelInteractionsEnd);
    
    leftClickBtn.removeEventListener('click', triggerMobileLeftClick);
    rightClickBtn.removeEventListener('click', triggerMobileRightClick);
    keyboardBtn.removeEventListener('click', toggleMobileKeyboard);
    hideTrackpadBtn.removeEventListener('touchstart', () => toggleTrackpadVisibility(false));
    showTrackpadBtn.removeEventListener('touchstart', () => toggleTrackpadVisibility(true));
    
    window.removeEventListener('keydown', handleKeyDown);
    window.removeEventListener('keyup', handleKeyUp);
}

// Startup: restore saved devices; optionally jump straight into client mode and auto-connect.
renderSavedDevices();
autoConnectCheck.checked = lsGet(LS_AUTO, false) === true;
(function autoStart() {
    if (!autoConnectCheck.checked) return;
    const list = lsGet(LS_DEVICES, []);
    const dev = list.find(d => d.id === lsGet(LS_LAST, null)) || list[list.length - 1];
    if (!dev) return;
    pendingAutoDevice = dev;
    btnRoleClient.click();
})();
