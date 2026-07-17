
const startOverlay = document.getElementById('start-overlay');
// Determine Socket URL
// 1. Try LocalStorage (if set by main app)
// 2. Default to current window origin (if production/same-origin)
// 3. Fallback to localhost:3000 (if dev on port 5173)

let serverUrl = localStorage.getItem('walkieTalkieServer');
if (!serverUrl) {
    const hostname = window.location.hostname;
    const port = window.location.port;
    if (port === '5173' || port === '3001') {
        serverUrl = `http://${hostname}:3000`;
    } else {
        serverUrl = window.location.origin; // Production usually same origin for socket.io if proxy set up, or render URL
        // If on Render but accessing via render domain, origin is correct.
        // If on dev but port 3000, origin is correct.
    }
}
// Hardcoded fallback for reliability in this specific workspace context if desired:
// serverUrl = 'http://localhost:3000'; 

console.log('Connecting to GPS Server at:', serverUrl);
const socket = io(serverUrl);

// Map and Grid Logic
let leafletMap = null;
let mapInitialized = false;
let units = {}; // Store unit data: { socketId: { id, callSign, lat, lng, status, el } }

startOverlay.addEventListener('click', () => {
    // Determine Op ID and Pass
    const opId = localStorage.getItem('admin_op_id');
    const password = localStorage.getItem('admin_op_pass');

    if (!opId || !password) {
        alert("ACCESS DENIED: No active Operation session found. Please login to Admin Dashboard first.");
        return;
    }

    startOverlay.style.opacity = '0';
    setTimeout(() => startOverlay.remove(), 500);

    // Login as Admin to get scoped updates
    console.log(`Initializing GPS for Operation: ${opId}`);
    socket.emit('login-admin', { opId, password });

    initMap();
    startGridUpdater();

    // Update Header
    const headerTitle = document.querySelector('.gps-header h2');
    if (headerTitle) headerTitle.innerText = `OVERWATCH: ${opId.toUpperCase()}`;
});

// Switch Views
document.getElementById('view-grid-btn').addEventListener('click', () => {
    document.getElementById('gps-grid-view').classList.add('active');
    document.getElementById('gps-map-view').classList.remove('active');
    document.getElementById('view-grid-btn').classList.add('active');
    document.getElementById('view-map-btn').classList.remove('active');
});

document.getElementById('view-map-btn').addEventListener('click', () => {
    document.getElementById('gps-grid-view').classList.remove('active');
    document.getElementById('gps-map-view').classList.add('active');
    document.getElementById('view-grid-btn').classList.remove('active');
    document.getElementById('view-map-btn').classList.add('active');
    setTimeout(() => {
        if (leafletMap) leafletMap.invalidateSize();
    }, 100);
});


// Initialization
function initMap() {
    leafletMap = L.map('gps-map-view').setView([0, 0], 2); // Default world view

    L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>',
        subdomains: 'abcd',
        maxZoom: 20
    }).addTo(leafletMap);

    // --- Tactical Drag (Shift + Click Drag) ---
    let isSelecting = false;
    let selectionBox = null;
    let startPoint = null;

    leafletMap.on('mousedown', (e) => {
        if (!e.originalEvent.shiftKey) return;
        isSelecting = true;
        leafletMap.dragging.disable(); // Prevent map panning while drawing
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
        }).addTo(leafletMap);
    });

    leafletMap.on('mousemove', (e) => {
        if (!isSelecting || !selectionBox) return;
        selectionBox.setBounds([startPoint, e.latlng]);
    });

    leafletMap.on('mouseup', (e) => {
        if (!isSelecting) return;
        isSelecting = false;
        leafletMap.dragging.enable();

        if (selectionBox) {
            const bounds = selectionBox.getBounds();
            const selectedUnits = [];

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

                    const tacChannel = `TAC-ZONE-${Date.now().toString().slice(-4)}`;
                    console.log(`Tactical Drag selected ${selectedUnits.length} units for ${tacChannel}`);

                    socket.emit('create-tactical-zone', {
                        channelName: tacChannel,
                        unitSocketIds: selectedUnits
                    });
                }
            }

            setTimeout(() => {
                if (selectionBox) selectionBox.remove();
                selectionBox = null;
            }, 1000);
        }
    });
}


// Socket Event Listeners for Updates
socket.on('active-units-list', (list) => {
    console.log("Received Full List:", list);
    units = {}; // Reset local
    document.getElementById('unit-list-container').innerHTML = ''; // Clear UI
    document.getElementById('gps-grid-view').innerHTML = '<div class="grid-background"></div>'; // Clear grid
    if (leafletMap) {
        // Clear markers (naive)
        leafletMap.eachLayer((layer) => {
            if (layer instanceof L.Marker) leafletMap.removeLayer(layer);
        });
    }

    Object.values(list).forEach(data => {
        updateUnit(data);
    });
});

socket.on('update-location', (data) => {
    // data = { id: 'U-1234', callSign: 'ALPHA-1', lat, lng, socketId }
    updateUnit(data);
});

socket.on('register-unit', (data) => {
    console.log("Unit Registered:", data);
    updateUnit({ ...data, status: "WAITING FOR GPS..." });
});

socket.on('user-disconnected', (socketId) => {
    if (units[socketId]) {
        removeUnit(socketId);
    }
});

socket.on('chaos-index-updated', ({ index, state }) => {
    const chaosEl = document.getElementById('chaos-index-val');
    if (chaosEl) {
        chaosEl.innerText = `CHAOS: ${index}% (${state})`;
        if (state === 'CRÍTICO') chaosEl.style.color = '#ff3b30';
        else if (state === 'ALTO') chaosEl.style.color = '#ff9f0a';
        else if (state === 'MEDIO') chaosEl.style.color = '#ffd60a';
        else chaosEl.style.color = '#50E3C2';
    }
});


function updateUnit(data) {
    const unitId = data.socketId || data.id; // Use socket as unique key for now

    // Create new unit if not exists
    if (!units[unitId]) {
        units[unitId] = {
            ...data,
            lat: data.lat || 0,
            lng: data.lng || 0,
            marker: null,
            gridDot: null,
            card: null
        };
        createUnitUI(unitId);
    }

    // Update Data
    const unit = units[unitId];
    if (data.lat !== undefined) unit.lat = data.lat;
    if (data.lng !== undefined) unit.lng = data.lng;
    if (data.callSign) unit.callSign = data.callSign;
    if (data.status) unit.status = data.status;

    // Update Map Marker (only if we have valid coords)
    if (leafletMap && unit.lat !== 0 && unit.lng !== 0) {
        if (!unit.marker) {
            const color = getColorForUnit(unit.callSign);
            const markerIcon = L.divIcon({
                className: 'custom-div-icon',
                html: `<div style="background-color:${color}; width: 12px; height: 12px; border-radius: 50%; box-shadow: 0 0 10px ${color}; border: 2px solid #fff;"></div>`,
                iconSize: [12, 12],
                iconAnchor: [6, 6]
            });
            unit.marker = L.marker([unit.lat, unit.lng], { icon: markerIcon }).addTo(leafletMap);
            unit.marker.bindPopup(`<b>${unit.callSign}</b><br>ID: ${unit.id}`);

            // Center map on first valid fix if not initialized
            if (!mapInitialized || leafletMap.getZoom() < 5) {
                leafletMap.setView([unit.lat, unit.lng], 15);
                mapInitialized = true;
            }
        } else {
            unit.marker.setLatLng([unit.lat, unit.lng]);
        }
    }

    // Update List Card
    if (unit.card) {
        if (unit.status) {
            unit.card.querySelector('.u-status').innerText = unit.status;
        } else if (unit.lat !== 0) {
            unit.card.querySelector('.u-status').innerText = `LAT: ${unit.lat.toFixed(4)}, LNG: ${unit.lng.toFixed(4)}`;
        }
    }
}

function createUnitUI(unitId) {
    const unit = units[unitId];
    const color = getColorForUnit(unit.callSign);

    // 1. Grid Dot
    const dot = document.createElement('div');
    dot.className = 'unit-dot pulse';
    dot.style.backgroundColor = color;
    dot.style.boxShadow = `0 0 10px ${color}`;
    // Random initial position for grid aesthetic
    const randomTop = Math.floor(Math.random() * 80) + 10;
    const randomLeft = Math.floor(Math.random() * 80) + 10;
    dot.style.top = `${randomTop}%`;
    dot.style.left = `${randomLeft}%`;

    document.getElementById('gps-grid-view').appendChild(dot);
    unit.gridDot = dot;

    // 2. Sidebar Card
    const card = document.createElement('div');
    card.className = 'unit-card status-ok';
    card.innerHTML = `
        <div class="dot" style="background:${color}; box-shadow:0 0 8px ${color}"></div>
        <div class="info">
            <span class="u-name">${unit.callSign}</span>
            <span class="u-status">${unit.status || "LOCATING..."}</span>
        </div>
    `;
    document.getElementById('unit-list-container').appendChild(card);
    unit.card = card;

    updateCount();
}

function removeUnit(unitId) {
    const unit = units[unitId];
    if (!unit) return;

    if (unit.marker) unit.marker.remove();
    if (unit.gridDot) unit.gridDot.remove();
    if (unit.card) unit.card.remove();

    delete units[unitId];
    updateCount();
}

function updateCount() {
    const count = Object.keys(units).length;
    document.getElementById('active-units-count').innerText = `UNITS: ${count}`;
}

function getColorForUnit(name) {
    // Simple hash to color
    const colors = ['#50E3C2', '#5097E3', '#FF9F0A', '#FF5E57', '#D1E350'];
    let hash = 0;
    for (let i = 0; i < name.length; i++) {
        hash = name.charCodeAt(i) + ((hash << 5) - hash);
    }
    return colors[Math.abs(hash) % colors.length];
}

// Function to simulate grid movement slightly
function startGridUpdater() {
    setInterval(() => {
        Object.values(units).forEach(unit => {
            if (unit.gridDot) {
                // Subtle drift
                // In real app, you'd map lat/lng to x/y on grid 
            }
        });
    }, 2000);
}
