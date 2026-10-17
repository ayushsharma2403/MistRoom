/**
 * Safe Walk Timer module for MistRoom.
 * Tracks GPS in a local ring buffer (max 120 points).
 * Warns at T-60s with vibration and sound.
 * On unacknowledged expiry, sends signed Women Safety beacon with last 10 GPS points.
 */
import { state, $ } from './state.js';
import { sendPublicBeacon, appendSystemMessage } from './ui.js';
import { queueOfflineMessage } from './outbox.js';
import { router } from './transport.js';

let activeTimerId = null;
let countdownInterval = null;
let gpsInterval = null;
let wakeLock = null;
let targetExpiryTime = 0;
let destinationNote = '';
let chosenRecipients = 'everyone'; // 'everyone' or array of peer IDs

const GPS_RING_BUFFER_KEY = 'mistroom_safewalk_gps';
const MAX_RING_BUFFER = 120;

export function getSafeWalkState() {
  return {
    isActive: !!activeTimerId,
    targetExpiryTime,
    destinationNote,
    chosenRecipients
  };
}

// Request screen wake lock
async function acquireWakeLock() {
  if ('wakeLock' in navigator) {
    try {
      wakeLock = await navigator.wakeLock.request('screen');
    } catch (e) {
      console.debug('Wake lock request denied:', e);
    }
  }
}

function releaseWakeLock() {
  if (wakeLock) {
    try { wakeLock.release(); } catch (e) {}
    wakeLock = null;
  }
}

// Local GPS recording in ring buffer
export function recordGpsPoint(point) {
  try {
    const raw = localStorage.getItem(GPS_RING_BUFFER_KEY);
    const buf = raw ? JSON.parse(raw) : [];
    buf.push(point);
    if (buf.length > MAX_RING_BUFFER) {
      buf.shift();
    }
    localStorage.setItem(GPS_RING_BUFFER_KEY, JSON.stringify(buf));
  } catch (e) {}
}

export function getLastGpsPoints(n = 10) {
  try {
    const raw = localStorage.getItem(GPS_RING_BUFFER_KEY);
    const buf = raw ? JSON.parse(raw) : [];
    return buf.slice(-n);
  } catch (e) {
    return [];
  }
}

function sampleGps() {
  if (!navigator.geolocation || document.visibilityState !== 'visible') return;
  navigator.geolocation.getCurrentPosition(
    pos => {
      recordGpsPoint({
        lat: pos.coords.latitude,
        lon: pos.coords.longitude,
        accuracy: pos.coords.accuracy,
        ts: Date.now()
      });
    },
    err => console.debug('SafeWalk GPS error:', err),
    { enableHighAccuracy: true, timeout: 5000, maximumAge: 10000 }
  );
}

// Play loud prompt tone at T-60s
function playAlertTone() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(880, ctx.currentTime);
    osc.frequency.exponentialRampToValueAtTime(440, ctx.currentTime + 0.5);
    gain.gain.setValueAtTime(0.5, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.5);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + 0.5);
  } catch (e) {}
}

export function startSafeWalk(durationMinutes, note = '', recipients = 'everyone') {
  stopSafeWalk();

  destinationNote = note;
  chosenRecipients = recipients;
  targetExpiryTime = Date.now() + durationMinutes * 60 * 1000;

  acquireWakeLock();
  sampleGps();
  gpsInterval = setInterval(sampleGps, 20000);

  const chip = $('safewalk-chip');
  if (chip) chip.style.display = 'inline-flex';

  let warned = false;
  countdownInterval = setInterval(() => {
    const remainingMs = targetExpiryTime - Date.now();
    if (remainingMs <= 0) {
      triggerSafeWalkAlert();
      return;
    }

    // T-60s warning
    if (remainingMs <= 60000 && !warned) {
      warned = true;
      if (navigator.vibrate) navigator.vibrate([400, 200, 400]);
      playAlertTone();
      showExtensionPrompt();
    }

    updateChipDisplay(remainingMs);
  }, 1000);

  appendSystemMessage(`🛡️ Safe walk timer started (${durationMinutes} min). Keep page visible.`);
}

function updateChipDisplay(remainingMs) {
  const chip = $('safewalk-chip');
  if (!chip) return;
  const mins = Math.floor(remainingMs / 60000);
  const secs = Math.floor((remainingMs % 60000) / 1000);
  chip.textContent = `🚶 Safe Walk: ${mins}:${secs.toString().padStart(2, '0')}`;
}

function showExtensionPrompt() {
  const banner = $('safewalk-warn-banner');
  if (banner) {
    banner.style.display = 'flex';
  }
}

export function extendSafeWalk(extraMinutes = 5) {
  targetExpiryTime += extraMinutes * 60 * 1000;
  const banner = $('safewalk-warn-banner');
  if (banner) banner.style.display = 'none';
  appendSystemMessage(`⏳ Safe walk timer extended by ${extraMinutes} min.`);
}

export function stopSafeWalk() {
  if (countdownInterval) clearInterval(countdownInterval);
  if (gpsInterval) clearInterval(gpsInterval);
  countdownInterval = null;
  gpsInterval = null;
  releaseWakeLock();

  const chip = $('safewalk-chip');
  if (chip) chip.style.display = 'none';

  const banner = $('safewalk-warn-banner');
  if (banner) banner.style.display = 'none';
}

export function triggerSafeWalkAlert() {
  stopSafeWalk();
  const lastPoints = getLastGpsPoints(10);
  const latest = lastPoints[lastPoints.length - 1] || null;

  const alertPayload = {
    t: 'safewalk_sos',
    id: 'sw_' + Date.now().toString(36),
    note: destinationNote || 'Safe Walk timer expired without check-in',
    breadcrumbs: lastPoints,
    handle: state.isStealthMode ? 'Ghost' : state.currentNickname,
    ts: Date.now()
  };

  // Broadcast Women Safety beacon
  sendPublicBeacon('women_safety', 1, `Safe walk expired: ${alertPayload.note}`, latest);

  // Send payload via Router
  router.broadcast(alertPayload);

  appendSystemMessage('🚨 Safe Walk timer expired! Women safety alert dispatched.');
}
