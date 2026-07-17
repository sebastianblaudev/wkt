
const getServerUrl = () => {
    const hostname = window.location.hostname;
    const port = window.location.port;
    if (port === '3001' || port === '5173') {
        return `http://${hostname}:3000`;
    }
    return window.location.origin;
};
const socket = io(getServerUrl());

// State
let currentOpId = '';
let currentToken = '';
let map = null;
let units = {}; // socketId -> unitData
let incidents = {}; // incidentId -> { id, marker, circle, latlng }
let selectedIncidents = new Set();

// DOM Elements
const loginScreen = document.getElementById('login-screen');
const dashboard = document.getElementById('dashboard-container');
const loginBtn = document.getElementById('login-btn');
const opIdInput = document.getElementById('op-id-input');
const opPassInput = document.getElementById('op-pass-input');
const loginError = document.getElementById('login-error');
const createToggle = document.getElementById('create-toggle');
const displayOpId = document.getElementById('display-op-id');
const channelList = document.getElementById('channel-list');
const addChannelBtn = document.getElementById('add-channel-btn');
const newChannelInput = document.getElementById('new-channel-name');
const inviteBtn = document.getElementById('generate-invite-btn');
const activeUnitCount = document.getElementById('active-unit-count');
const totalUnitCount = document.getElementById('total-unit-count');
const fuseBtn = document.getElementById('fuse-incidents-btn');
// --- Login / Create Logic ---

// --- Login Logic ---

// Removed Create Mode Toggle


loginBtn.addEventListener('click', () => {
    const opId = opIdInput.value.trim();
    const password = opPassInput.value.trim();

    if (!opId || !password) {
        showError("Credentials required.");
        return;
    }

    socket.emit('login-admin', { opId, password });
});

function showError(msg) {
    loginError.innerText = msg;
    loginError.style.display = 'block';
}

// --- Socket Handlers ---

socket.on('operation-created', ({ success, opId }) => {
    if (success) {
        // Auto-login after create
        const password = opPassInput.value.trim();
        socket.emit('login-admin', { opId, password });
    }
});

socket.on('operation-error', (msg) => {
    showError(msg);
});

socket.on('admin-auth-error', (msg) => {
    showError(msg);
});

socket.on('admin-authenticated', ({ success, opId, channels }) => {
    if (success) {
        // Save credentials for GPS view and reload
        localStorage.setItem('admin_op_id', opId);
        // We need to capture password from input or closure if not provided in event
        // But the event doesn't return it. We can grab it from logic above or input
        // Since this listener runs after login request, inputs might still be populated
        const password = document.getElementById('op-pass-input').value.trim();
        if (password) localStorage.setItem('admin_op_pass', password);

        currentOpId = opId;
        loginScreen.style.opacity = '0';
        setTimeout(() => loginScreen.style.display = 'none', 500);

        dashboard.classList.add('active');
        displayOpId.innerText = opId.toUpperCase();

        renderChannels(channels);
        initMap();
    }
});


// --- Dashboard Logic ---

// Channels
function renderChannels(channels) {
    channelList.innerHTML = '';
    channels.forEach(channel => {
        const div = document.createElement('div');
        div.className = 'channel-item';
        div.innerHTML = `
            <span># ${channel}</span>
            <button class="btn-icon material-icons-round" onclick="removeChannel('${channel}')">delete</button>
        `;
        channelList.appendChild(div);
    });
}

// Add Channel
addChannelBtn.addEventListener('click', () => {
    const channelName = newChannelInput.value.trim().toUpperCase();
    if (!channelName) return;

    socket.emit('add-channel', { channelName });
    newChannelInput.value = '';
});

// Remove Channel
window.removeChannel = (channelName) => {
    if (confirm(`Delete channel ${channelName}?`)) {
        socket.emit('remove-channel', { channelName });
    }
};

socket.on('channels-updated', (channels) => {
    renderChannels(channels);
});

// Invite
inviteBtn.addEventListener('click', () => {
    socket.emit('generate-invite', { opId: currentOpId });
});

socket.on('invite-generated', ({ token, opId }) => {
    const url = `${window.location.origin}/?op=${opId}&token=${token}`;
    navigator.clipboard.writeText(url).then(() => {
        const originalText = inviteBtn.innerText;
        inviteBtn.innerText = "COPIED TO CLIPBOARD!";
        setTimeout(() => inviteBtn.innerText = originalText, 2000);
    });
});

// Chaos Index
socket.on('chaos-index-updated', ({ index, state }) => {
    const chaosEl = document.getElementById('chaos-index-val');
    if (chaosEl) {
        chaosEl.innerText = `${index}% (${state})`;
        if (state === 'CRÍTICO') chaosEl.style.color = '#ff3b30';
        else if (state === 'ALTO') chaosEl.style.color = '#ff9f0a';
        else if (state === 'MEDIO') chaosEl.style.color = '#ffd60a';
        else chaosEl.style.color = '#50E3C2';
    }
});

// --- Map & GPS Logic ---

function initMap() {
    map = L.map('admin-map', {
        doubleClickZoom: false
    }).setView([0, 0], 2);
    L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
        attribution: '&copy; OpenStreetMap contributors &copy; CARTO',
        subdomains: 'abcd',
        maxZoom: 20
    }).addTo(map);

    // --- Incident Creation ---
    const createIncidentAtStr = (e) => {
        if (!currentOpId) return;
        const incidentId = `INCIDENT-${Date.now().toString().slice(-6)}`;

        const incidentIcon = L.divIcon({
            className: 'custom-div-icon',
            html: `<div class="incident-marker" id="marker-${incidentId}"></div>`,
            iconSize: [20, 20],
            iconAnchor: [10, 10]
        });

        const marker = L.marker(e.latlng, { icon: incidentIcon }).addTo(map);
        marker.bindPopup(`<b>${incidentId}</b><br>Drop units here to assign<br><br><span style="font-size:10px;color:#888;">Shift+Click to select for fusion</span>`);

        marker.on('click', (ev) => {
            if (ev.originalEvent.shiftKey) {
                toggleIncidentSelection(incidentId);
            }
        });

        const circle = L.circle(e.latlng, {
            color: '#ff3b30',
            fillColor: '#ff3b30',
            fillOpacity: 0.1,
            radius: 300 // 300 meters influence zone
        }).addTo(map);

        incidents[incidentId] = { id: incidentId, marker, circle, latlng: e.latlng };

        socket.emit('add-channel', { channelName: incidentId });
    };

    map.on('contextmenu', createIncidentAtStr);
    map.on('dblclick', createIncidentAtStr);


    // --- Tactical Drag (Shift + Click Drag) ---
    let isSelecting = false;
    let selectionBox = null;
    let startPoint = null;

    map.on('mousedown', (e) => {
        if (!e.originalEvent.shiftKey) return;
        isSelecting = true;
        map.dragging.disable(); // Prevent map panning while drawing
        startPoint = e.latlng;

        if (selectionBox) {
            selectionBox.remove();
        }

        selectionBox = L.rectangle([startPoint, startPoint], {
            color: '#50E3C2',
            weight: 2,
            fillColor: '#50E3C2',
            fillOpacity: 0.1,
            dashArray: '5, 5'
        }).addTo(map);
    });

    map.on('mousemove', (e) => {
        if (!isSelecting || !selectionBox) return;
        selectionBox.setBounds([startPoint, e.latlng]);
    });

    map.on('mouseup', (e) => {
        if (!isSelecting) return;
        isSelecting = false;
        map.dragging.enable();

        if (selectionBox) {
            const bounds = selectionBox.getBounds();
            const selectedUnits = [];

            // Find all units within the rectangle
            for (const socketId in units) {
                const u = units[socketId];
                if (u.lat && u.lng) {
                    const unitLatLng = L.latLng(u.lat, u.lng);
                    if (bounds.contains(unitLatLng)) {
                        selectedUnits.push(socketId);
                    }
                }
            }

            if (selectedUnits.length > 0) {
                const currentSelectionStr = selectedUnits.sort().join(',');
                const now = Date.now();
                if (window.lastTacticalSelection === currentSelectionStr && (now - (window.lastTacticalTime || 0)) < 10000) {
                    console.log("Duplicate selection prevented.");
                } else {
                    window.lastTacticalSelection = currentSelectionStr;
                    window.lastTacticalTime = now;

                    // Associate with incident if active incident is within bounds
                    let targetIncidentId = null;
                    for (const incId in incidents) {
                        const inc = incidents[incId];
                        if (bounds.contains(inc.latlng)) {
                            targetIncidentId = incId;
                            break;
                        }
                    }

                    if (targetIncidentId) {
                        console.log(`Tactical Drag selected ${selectedUnits.length} units for existing incident ${targetIncidentId}`);
                        selectedUnits.forEach(unitSocketId => {
                            socket.emit('assign-to-incident', { incidentId: targetIncidentId, unitSocketId });
                        });
                    } else {
                        const tacChannel = `TAC-ZONE-${Date.now().toString().slice(-4)}`;
                        console.log(`Tactical Drag selected ${selectedUnits.length} units for ${tacChannel}`);

                        // Create the channel and assign units
                        socket.emit('create-tactical-zone', {
                            channelName: tacChannel,
                            unitSocketIds: selectedUnits
                        });
                    }
                }
            }

            // Remove visual box after a short delay
            setTimeout(() => {
                if (selectionBox) selectionBox.remove();
                selectionBox = null;
            }, 1000);
        }
    });

}

window.toggleIncidentSelection = (incidentId) => {
    const inc = incidents[incidentId];
    if (!inc) return;

    if (selectedIncidents.has(incidentId)) {
        selectedIncidents.delete(incidentId);
        const el = document.getElementById(`marker-${incidentId}`);
        if (el) el.style.border = "2px solid #111113";
    } else {
        selectedIncidents.add(incidentId);
        const el = document.getElementById(`marker-${incidentId}`);
        if (el) el.style.border = "2px solid #5097E3"; // Highlight
    }

    if (selectedIncidents.size > 1) {
        fuseBtn.style.display = 'block';
    } else {
        fuseBtn.style.display = 'none';
    }
};

fuseBtn.addEventListener('click', () => {
    if (selectedIncidents.size > 1) {
        const incidentsToFuse = Array.from(selectedIncidents);
        const masterId = `MASTER-INC-${Date.now().toString().slice(-4)}`;
        socket.emit('fuse-incidents', { masterId, subIds: incidentsToFuse });

        selectedIncidents.clear();
        fuseBtn.style.display = 'none';

        // Remove borders from visuals locally before server confirms just in case
        incidentsToFuse.forEach(id => {
            const el = document.getElementById(`marker-${id}`);
            if (el) el.style.border = "2px solid #111113";
        });
    }
});

socket.on('incident-fused', ({ masterId, subIds }) => {
    console.log(`Incidents fused into ${masterId}`, subIds);
    // Draw master incident polygon or center point
    // For simplicity, just leave the original markers but maybe color them to show they belong to master
    subIds.forEach(id => {
        if (incidents[id]) {
            const el = document.getElementById(`marker-${id}`);
            if (el) {
                el.style.backgroundColor = '#5097E3'; // Blue for fused
                el.style.boxShadow = '0 0 20px 8px rgba(80, 151, 227, 0.5)';
            }
            if (incidents[id].circle) {
                incidents[id].circle.setStyle({ color: '#5097E3', fillColor: '#5097E3' });
            }
            // Update popup
            incidents[id].marker.bindPopup(`<b>${id}</b><br>Fused into: ${masterId}`);
        }
    });
});

socket.on('active-units-list', (list) => {
    // Initial bulk load
    units = {};
    if (map) {
        map.eachLayer((layer) => {
            if (layer instanceof L.Marker) map.removeLayer(layer);
        });
    }
    Object.values(list).forEach(data => updateUnitMarker(data));
    updateCount();
});

socket.on('update-location', (data) => {
    updateUnitMarker(data);
    updateCount();
});

socket.on('register-unit', (data) => {
    updateUnitMarker(data);
    updateCount();
});

socket.on('user-disconnected', (socketId) => {
    if (units[socketId]) {
        if (units[socketId].marker) units[socketId].marker.remove();
        delete units[socketId];
        updateCount();
    }
});

function updateUnitMarker(data) {
    // data = { socketId, id, callSign, lat, lng }
    let unit = units[data.socketId];

    if (!unit) {
        units[data.socketId] = { ...data, marker: null };
        unit = units[data.socketId];
    }

    // Update data
    Object.assign(unit, data);

    if (unit.lat && unit.lng && map) {
        if (!unit.marker) {
            const color = getColorForUnit(unit.callSign);
            const markerIcon = L.divIcon({
                className: 'custom-div-icon',
                html: `<div class="glow-marker" style="background-color:${color}; box-shadow: 0 0 20px 6px ${color}66; border-color: #111113;"></div>`,
                iconSize: [16, 16],
                iconAnchor: [8, 8]
            });
            // Make unit markers draggable for reassignment
            unit.marker = L.marker([unit.lat, unit.lng], { icon: markerIcon, draggable: true }).addTo(map);
            unit.marker.bindPopup(`<b>${unit.callSign}</b><br>ID: ${unit.id}`);

            // Handle Drag-and-Drop Assignment
            unit.marker.on('dragend', function (e) {
                const dropLatLng = e.target.getLatLng();
                let assigned = false;

                // Check distance to all active incidents
                for (const incId in incidents) {
                    const inc = incidents[incId];
                    const distance = map.distance(dropLatLng, inc.latlng);

                    // If dropped within the circle radius
                    if (distance <= inc.circle.getRadius()) {
                        // Emit assignment
                        socket.emit('assign-to-incident', { incidentId: incId, unitSocketId: unit.socketId });
                        // Provide visual feedback (could toast here)
                        console.log(`Assigned ${unit.callSign} to ${incId}`);
                        assigned = true;
                        break; // Only assign to the first matched incident
                    }
                }

                // Always snap the marker back to the unit's actual GPS location
                unit.marker.setLatLng([unit.lat, unit.lng]);
            });

            // Auto zoom valid point if map at world view
            if (map.getZoom() < 5) map.setView([unit.lat, unit.lng], 15);
        } else {
            // Only update position if we aren't currently dragging it
            if (!unit.marker.dragging?._draggable?._moving) {
                unit.marker.setLatLng([unit.lat, unit.lng]);
            }
        }
    }
}

socket.on('sos-triggered', ({ userId, channelName, lat, lng }) => {
    console.warn("SOS TRIGGERED:", userId, channelName);
    const unit = Object.values(units).find(u => u.id === userId);
    if (!unit) return;

    if (unit.marker) {
        unit.marker.openPopup();
        const popupContent = `<b>${unit.callSign}</b><br>ID: ${unit.id}<br><b style="color:#ff3b30">EMERGENCY SOS</b>`;
        unit.marker.setPopupContent(popupContent);
    }

    if (map && lat && lng) {
        map.flyTo([lat, lng], 16);
    }

    const mainMap = document.getElementById('admin-map');
    if (mainMap) {
        mainMap.style.border = "2px solid #ff3b30";
        setTimeout(() => mainMap.style.border = "none", 5000);
    }
});

// DOM Elements
const unitsList = document.getElementById('units-list');

function updateCount() {
    const total = Object.keys(units).length;
    let active = 0;
    Object.values(units).forEach(u => { if (u.lat && u.lng) active++; });

    if (totalUnitCount) totalUnitCount.innerText = total.toString().padStart(2, '0');
    if (activeUnitCount) activeUnitCount.innerText = active.toString().padStart(2, '0');
    renderUnitsList();
}

function renderUnitsList() {
    if (!unitsList) return;
    unitsList.innerHTML = '';

    if (Object.keys(units).length === 0) {
        unitsList.innerHTML = '<div style="padding: 20px; text-align: center; color: #444; font-size: 12px; font-family: \'Inter\', sans-serif;">WAITING FOR SIGNALS...</div>';
        return;
    }

    Object.values(units).forEach(unit => {
        const div = document.createElement('div');
        div.className = 'unit-item';

        let statusClass = 'status-offline';
        let statusText = 'OFFLINE';

        if (unit.lat && unit.lng) {
            statusClass = 'status-active';
            statusText = 'EN ROUTE';
        } else if (unit.status === 'WAITING FOR GPS...') {
            statusClass = 'status-waiting';
            statusText = 'STANDING BY';
        } else if (unit.status === 'LOW SIGNAL') {
            statusClass = 'status-waiting';
            statusText = 'LOW SIGNAL';
        }

        div.innerHTML = `
            <div class="u-dot ${statusClass}"></div>
            <div class="u-info">
                <span class="u-name">${unit.callSign}: ${statusText}</span>
            </div>
        `;

        div.addEventListener('click', () => {
            if (unit.lat && unit.lng && map) {
                map.flyTo([unit.lat, unit.lng], 16, {
                    animate: true,
                    duration: 1.5
                });
                if (unit.marker) {
                    unit.marker.openPopup();
                }
            }
        });

        unitsList.appendChild(div);
    });
}

function getColorForUnit(name) {
    const colors = ['#50E3C2', '#5097E3', '#FF9F0A', '#FF5E57', '#D1E350'];
    let hash = 0;
    for (let i = 0; i < name.length; i++) {
        hash = name.charCodeAt(i) + ((hash << 5) - hash);
    }
    return colors[Math.abs(hash) % colors.length];
}
