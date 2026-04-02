const COMMON_ICE_SERVERS = [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun2.l.google.com:19302' },
    { urls: 'stun:stun3.l.google.com:19302' },
    { urls: 'stun:stun4.l.google.com:19302' },
    { urls: 'stun:stun.voipstunt.com' },
    { urls: 'stun:stun.voxgratia.org' },
    { urls: 'stun:stun.ekiga.net' },
    { urls: 'stun:stun.ideasip.com' },
    { urls: 'stun:stun.schlund.de' },
    { urls: 'stun:stun.voiparound.com' },
    { urls: 'stun:stun.voipbuster.com' },
    { urls: 'stun:stun.voipstunt.com' }
];

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

const sessionContainer = document.getElementById('session-container');
const recordBtn = document.getElementById('record-btn');
const connectBtn = document.getElementById('connect-btn');
const disconnectBtn = document.getElementById('disconnect-btn');
const hostIdInput = document.getElementById('host-id-input');
const clientStatusMsg = document.getElementById('client-status-msg');
const remoteVideo = document.getElementById('remote-video');
const connectedIdDisplay = document.getElementById('connected-id-display');

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

function generateShortId() {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    let id = '';
    for (let i = 0; i < 6; i++) {
        id += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return id.substring(0, 3) + '-' + id.substring(3, 6);
}

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
    initPeer(generateShortId());
});

clientBackBtn.addEventListener('click', () => {
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
        if (savedIce) customIceServerInput.value = savedIce;
        
        const isForced = localStorage.getItem('aerosync_force_relay') === 'true';
        forceRelayCheckbox.checked = isForced;
        
        showOverlay(networkSettingsOverlay);
    });
});

saveNetworkSettingsBtn.addEventListener('click', () => {
    const server = customIceServerInput.value.trim();
    if (server) {
        localStorage.setItem('aerosync_custom_ice', server);
    } else {
        localStorage.removeItem('aerosync_custom_ice');
    }
    
    localStorage.setItem('aerosync_force_relay', forceRelayCheckbox.checked ? 'true' : 'false');
    
    alert('Settings saved. Restarting application...');
    location.reload();
});

function initPeer(customId = null) {
    if (peer) { peer.destroy(); }
    
    let iceServers = [...COMMON_ICE_SERVERS];
    const customIce = localStorage.getItem('aerosync_custom_ice');
    if (customIce && customIce.includes(':')) {
        iceServers.unshift({ urls: customIce });
    }

    const isForced = localStorage.getItem('aerosync_force_relay') === 'true';

    const peerOptions = {
        debug: 1,
        config: {
            'iceServers': iceServers,
            'sdpSemantics': 'unified-plan',
            'iceTransportPolicy': isForced ? 'relay' : 'all'
        }
    };

    peer = customId ? new Peer(customId, peerOptions) : new Peer(peerOptions);

    peer.on('open', (id) => {
        signalingStatus = 'ok';
        if (signalDot) signalDot.style.background = '#2ea043';
        if (hostSignalDot) hostSignalDot.style.background = '#2ea043';
        
        if (currentMode === 'client') {
            clientStatusText.textContent = 'AeroSync Ready.';
            connectBtn.disabled = false;
        } else if (currentMode === 'host') {
            webHostIdDisplay.textContent = id;
            hostStatusText.textContent = 'AeroSync Ready.';
            hostStatusMsg.style.color = '#2ea043';
            startShareBtn.classList.remove('hidden');
        }
    });

    peer.on('error', (err) => {
        console.error('PeerJS error:', err);
        
        // Critical Signaling Errors
        if (err.type === 'network' || err.type === 'socket-error' || err.type === 'server-error') {
            signalingStatus = 'blocked';
            if (signalDot) signalDot.style.background = '#f85149';
            if (hostSignalDot) hostSignalDot.style.background = '#f85149';
        }

        if (currentMode === 'client') {
            if (signalingStatus === 'blocked') {
                clientStatusText.textContent = '🚨 Handshake Blocked by VPN.';
            } else {
                clientStatusText.textContent = `Error: ${err.type}`;
            }
            clientStatusMsg.style.color = '#f85149';
        } else if (currentMode === 'host') {
            const msg = signalingStatus === 'blocked' ? '🚨 Handshake Blocked' : `Error: ${err.type}`;
            hostStatusText.textContent = msg;
            hostStatusMsg.style.color = '#f85149';
        }
    });

    peer.on('disconnected', () => {
        peer.reconnect();
    });

    // Handle incoming connections (Host Mode)
    peer.on('connection', (conn) => {
        if (currentMode !== 'host') return;
        
        conn.on('data', (data) => {
            if (data.type === 'system' && data.action === 'request-stream') {
                if (localStream) {
                    hostStatusMsg.textContent = 'Client connected, sending stream...';
                    hostStatusMsg.style.color = '#2ea043';
                    const call = peer.call(data.clientId, localStream);
                    handleActiveCall(call);
                }
            }
        });
    });

    // Handle incoming calls (Client Mode)
    peer.on('call', (call) => {
        if (currentMode !== 'client') return;
        mediaCall = call;
        call.answer();

        call.on('stream', (stream) => {
            remoteStream = stream;
            remoteVideo.srcObject = remoteStream;
            showOverlay(sessionContainer);
            connectedIdDisplay.textContent = hostIdInput.value.trim();
            isConnected = true;
            clientStatusMsg.textContent = 'Connected successfully.';
            
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
        hostStatusMsg.textContent = 'Sharing active. Waiting for client to connect...';
        hostStatusMsg.style.color = '#58a6ff';
        startShareBtn.classList.add('hidden');
        
        // If user manually stops sharing via browser UI
        localStream.getVideoTracks()[0].onended = () => {
            hostStatusMsg.textContent = 'Screen sharing stopped.';
            hostStatusMsg.style.color = '#8b949e';
            startShareBtn.classList.remove('hidden');
            if (mediaCall) mediaCall.close();
            localStream = null;
        };
    } catch (err) {
        console.error('Display capture error:', err);
        hostStatusMsg.textContent = 'Permission denied for screen share.';
        hostStatusMsg.style.color = '#f85149';
    }
});

function handleActiveCall(call) {
    mediaCall = call;
    call.on('close', () => {
        if (localStream) {
            hostStatusMsg.textContent = 'Client disconnected. Still sharing, waiting for new client...';
            hostStatusMsg.style.color = '#58a6ff';
        }
    });
}

// Client Mode: Connect Button
connectBtn.addEventListener('click', () => {
    const hostId = hostIdInput.value.trim();
    if (!hostId) {
        clientStatusText.textContent = 'Please enter a valid Host ID';
        clientStatusMsg.style.color = '#f85149';
        return;
    }

    if (signalingStatus === 'blocked') {
        clientStatusText.textContent = 'Handshake blocked. Check VPN/Relay.';
        clientStatusMsg.style.color = '#f85149';
        return;
    }

    clientStatusText.textContent = 'Connecting...';
    clientStatusMsg.style.color = '#58a6ff';
    connectBtn.disabled = true;

    dataConnection = peer.connect(hostId, { reliable: true });
    
    // Connection watchdog
    const connectionTimeout = setTimeout(() => {
        if (!dataConnection || !dataConnection.open) {
            clientStatusText.textContent = 'Immediate block suspected. Check VPN/Relay.';
            clientStatusMsg.style.color = '#e3b341';
            connectBtn.disabled = false;
        }
    }, 10000);
    
    dataConnection.on('open', () => {
        clearTimeout(connectionTimeout);
        clientStatusText.textContent = 'Requesting stream...';
        setTimeout(() => {
            if (dataConnection && dataConnection.open) {
                dataConnection.send({
                    type: 'system',
                    action: 'request-stream',
                    clientId: peer.id
                });
            }
        }, 500);
    });

    dataConnection.on('close', () => resetUI());
});

disconnectBtn.addEventListener('click', () => resetUI());

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
        clientStatusMsg.textContent = 'Disconnected.';
        clientStatusMsg.style.color = '#8b949e';
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
    hostStatusMsg.textContent = 'Initializing...';
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
