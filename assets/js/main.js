/**
 * VFM application controller.
 *
 * Owns app state and wires the telemetry path together:
 *
 *   band / replay -> decode -> quality gate -> baseline -> classify -> recheck -> alert
 *
 * Every view is a pure function of that state, so there is exactly one place where a
 * reading becomes evidence and exactly one place where evidence becomes an alert.
 */

import {
  connectBand as openBand,
  parseTelemetry,
  makeFrame,
  isAdmissible,
  VERSION,
  CONTROL,
  QUALITY_MINIMUM
} from './ble.js';
import { store, persistQuietly, READING_LIMIT, EVENT_LIMIT } from './store.js';
import { TIMING, buildBaseline, classify, toReading, normaliseStoredReading, OPTICAL } from './engine.js';
import { createTheme, motion, syncMotionAttribute } from './theme.js';
import { createRouter, VIEWS } from './views.js';
import { createVitals, createPulseRing } from './vitals.js';
import { createReadingsTable } from './readings-table.js';
import { createSignals } from './signals.js';
import { createEventsView } from './events.js';
import { createDemoConsole, nextPacket } from './demo.js';
import { createAlertCenter } from './alert.js';
import { createScope } from './charts/scope.js';
import { autoAnimate } from '../vendor/auto-animate.mjs';
import { scrambleTo, scrambleNow } from './ui/scramble.js';
import { toast } from './ui/toast.js';
import { el, formatClock, formatCountdown, formatFixed, formatPercent, spo2Band } from './format.js';

const $ = (id) => document.getElementById(id);
const elements = {
  nav: $('primary-nav'),
  viewHost: $('view-host'),
  viewHostInner: $('view-host-inner'),
  themeToggle: $('theme-toggle'),
  themeLabel: $('theme-label'),
  connectBtn: $('connectBtn'),
  connectionPill: $('connection-pill'),
  profileBtn: $('profileBtn'),
  profilePanel: $('profile-panel'),
  profileForm: $('profile-form'),
  patientAlias: $('patientAlias'),
  accessSide: $('accessSide'),
  profileClose: $('profile-close'),

  stateLabel: $('state-label'),
  stateDetail: $('state-detail'),
  stateDot: $('state-dot'),
  pulseRing: $('pulse-ring'),
  stateLive: $('state-live'),
  sourceBadge: $('source-badge'),
  sessionBadge: $('session-badge'),

  calibrateBtn: $('calibrate-btn'),
  calibrateHint: $('calibrate-hint'),
  calibrationTrack: $('calibration-track'),
  calibrationStatus: $('calibration-status'),
  calibrationProgress: $('calibration-progress'),
  baselineBadge: $('baseline-badge'),
  baselineSummary: $('baseline-summary'),
  calibrationCollapsed: $('calibration-collapsed'),
  calibrationCard: $('calibration-card'),

  prototypeNotice: $('prototype-notice'),

  vitalsRoot: $('vitals-root'),  scopeCanvas: $('scope-canvas'),
  scopeTooltip: $('scope-tooltip'),
  scopeCaption: $('scope-caption'),
  recheckCard: $('recheck-card'),
  recheckTitle: $('recheck-title'),
  recheckDetail: $('recheck-detail'),
  recheckFill: $('recheck-fill'),
  recheckTally: $('recheck-tally'),
  recheckClock: $('recheck-clock'),

  tableRoot: $('readings-table'),
  signalsRoot: $('signals-root'),
  eventsRoot: $('events-root'),
  demoRoot: $('demo-root'),

  alertDialog: $('alert-dialog'),
  exportBtn: $('export-btn'),
  resetBtn: $('reset-btn'),
  apiStatus: $('api-status'),
  storageNote: $('storage-note')
};

// If the markup and the controller ever drift apart, say which ids are missing
// rather than failing later inside an unrelated render.
const MISSING_ELEMENTS = Object.entries(elements)
  .filter(([, node]) => node == null)
  .map(([name]) => name);
if (MISSING_ELEMENTS.length) {
  console.error(`[VFM] Markup/controller drift — missing elements: ${MISSING_ELEMENTS.join(', ')}`);
}

const state = {
  source: 'live',  connection: 'disconnected',
  operational: 'READY',
  profile: { id: 'current', patientAlias: 'VFM Demo Patient', accessSide: 'Left' },
  baseline: null,
  calibration: null,
  readings: [],
  events: [],
  activeAlert: null,
  recheck: null,
  /**
   * True once an alert has been acknowledged or escalated and the underlying
   * change has not yet resolved. While set, VFM keeps monitoring and keeps
   * reporting the drift, but does not open a fresh recheck for the same
   * unresolved change — otherwise acknowledging would loop a new alert every
   * verification window.
   */
  suppressed: false,
  band: null,
  simulator: null,
  demo: null,
  alertTimer: null,
  recheckTimer: null,
  clockTimer: null,
  signalTimer: null,
  lastPacketAt: 0,
  lastGoodPacketAt: 0,
  lastStaleNoticeAt: 0,
  /**
   * The newest projected reading, whether or not it passed the quality floor.
   * The Monitor shows what the band is actually sending; admissibility decides
   * whether it is used as evidence, not whether it may be displayed at all.
   */
  lastSeenReading: null
};

/**
 * How long a reading stays on screen as "current". A band that is connected but
 * producing unusable frames must not leave a healthy-looking readout frozen on
 * the Monitor view, so anything older than this is presented as stale instead.
 */
const SIGNAL_STALE_MS = 4000;
/** A repeated outage must not append a duplicate audit event every second. */
const STALE_EVENT_COOLDOWN_MS = 30_000;
/** A calibration that stops producing admissible readings is abandoned. */
const CALIBRATION_TIMEOUT_MS = 12_000;

/** True while a source is attached and therefore expected to produce readings. */
function expectingReadings() {
  return Boolean(state.simulator) || state.connection === 'connected';
}

function signalIsStale(now = Date.now()) {
  if (!expectingReadings()) return false;
  // Staleness means "no telemetry at all", not "the last frames failed the
  // quality floor". Gating on admissible frames only made a marginal band
  // blank the readouts every few seconds — the flashing "no signal" cycle.
  const lastSeen = Math.max(state.lastPacketAt, state.lastGoodPacketAt);
  return lastSeen > 0 && now - lastSeen > SIGNAL_STALE_MS;
}

// ─────────────────────────────────────────────────────────────────────────────
// Presentation modules
// ─────────────────────────────────────────────────────────────────────────────

const theme = createTheme({
  onChange(next) {
    elements.themeToggle.dataset.theme = next;
    elements.themeLabel.textContent = next === 'dark' ? 'Dark' : 'Light';
    elements.themeToggle.setAttribute('aria-label', `Switch to ${next === 'dark' ? 'light' : 'dark'} theme`);
  }
});
syncMotionAttribute();

const pulseRing = createPulseRing(elements.pulseRing);

const scope = createScope({
  canvas: elements.scopeCanvas,
  tooltip: elements.scopeTooltip,
  onHover(reading) {
    highlightLinkedRow(reading ? `${reading.timestamp}-${reading.sequence ?? 0}` : null);
  }
});

const vitals = createVitals({
  root: elements.vitalsRoot,
  onInspect() {
    /* Reserved: the scope highlights the hovered reading, not the reverse. */
  }
});

const readingsTable = createReadingsTable({
  root: elements.tableRoot,
  onInspect(reading) {
    scope.focus(reading);
    highlightLinkedRow(`${reading.timestamp}-${reading.sequence ?? 0}`);
  },
  onInspectEnd() {
    scope.blur();
    highlightLinkedRow(null);
  }
});

// FLIP animation is valuable when the user is reading or re-sorting the table and
// distracting when rows stream in every second, so it is gated on follow mode.
const tableAnimator = autoAnimate(elements.tableRoot.querySelector('tbody'), { duration: motion.reduced ? 0 : 200 });

const signals = createSignals({ root: elements.signalsRoot });
const eventsView = createEventsView({ root: elements.eventsRoot });
const eventsAnimator = autoAnimate(elements.eventsRoot.querySelector('.event-list'), { duration: motion.reduced ? 0 : 260 });

const demoConsole = createDemoConsole({
  root: elements.demoRoot,
  onStart: (scenario) => startDemo(scenario),
  onStop: () => stopDemo()
});

const alertCenter = createAlertCenter({
  dialog: elements.alertDialog,
  onAcknowledge: () => acknowledgeAlert(),
  onReposition: () => {
    toast('Reposition the band over the access site and hold still. The timer keeps running until you acknowledge.');
    elements.alertDialog.querySelector('[data-alert-summary]').textContent =
      'Reposition the band, then acknowledge once you have completed your own safety check.';
  }
});

const router = createRouter({
  root: elements.viewHost,
  nav: elements.nav,
  onChange(key) {
    if (key === 'readings') tableAnimator.enable();
    else tableAnimator.disable();
    elements.viewHostInner.classList.toggle('is-wide', key === 'readings');
    elements.sessionBadge.textContent = `${state.readings.length} reading${state.readings.length === 1 ? '' : 's'} held`;
  }
});

function highlightLinkedRow(key) {
  const body = elements.tableRoot.querySelector('tbody');
  if (!body) return;
  for (const row of body.children) {
    row.classList.toggle('is-linked', Boolean(key) && row.dataset.key === key);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Status and events
// ─────────────────────────────────────────────────────────────────────────────

const OPERATIONAL_TONE = {
  READY: 'neutral',
  DISCONNECTED: 'watch',
  CALIBRATING: 'watch',
  MONITORING: 'good',
  RECHECK: 'watch',
  SENSOR_ISSUE: 'watch',
  ALERT_PENDING_ACK: 'alert',
  ACKNOWLEDGED: 'good',
  ESCALATED: 'alert'
};

let lastAnnouncedPhase = '';

function setOperational(phase, label, detail, tone = null) {
  state.operational = phase;
  elements.stateDot.dataset.tone = tone ?? OPERATIONAL_TONE[phase] ?? 'neutral';
  scrambleTo(elements.stateLabel, label);
  elements.stateDetail.textContent = detail;
  document.body.dataset.phase = phase.toLowerCase();

  // Announce phase changes once, never on every tick of a running clock.
  if (phase !== lastAnnouncedPhase) {
    lastAnnouncedPhase = phase;
    elements.stateLive.textContent = `${label}. ${detail}`;
  }
}

async function addEvent(message, tone = 'system', detail = null) {
  // Collapse an immediate repeat of the same message. A flapping band can
  // otherwise append the identical audit row several times a second.
  const newest = state.events[0];
  if (newest && newest.message === message && newest.tone === tone && Date.now() - newest.timestamp < 5000) {
    return;
  }
  const event = { id: uid(), message, tone, detail, timestamp: Date.now() };
  state.events.unshift(event);
  state.events = state.events.slice(0, EVENT_LIMIT);
  renderEvents();
  persistQuietly(store.put('events', event));
}

function uid() {
  return crypto.randomUUID ? crypto.randomUUID() : `vfm-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Calibration
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build an ECG-style trace for the calibration progress track, sized in real
 * pixels so one SVG unit equals one CSS pixel.
 *
 * An earlier revision used a fixed 1000x26 viewBox with preserveAspectRatio="none".
 * That stretches the trace by whatever ratio the container happens to be —
 * measured at 4.98:1 on a 390px phone — which squashed the R-spikes into
 * unreadable slivers and made the whole thing read as a jagged scribble.
 * Generating at the container's own size keeps the waveform proportional
 * everywhere and lets the beat count follow the width, so a beat stays roughly
 * the same physical size on a phone as on a desktop.
 */
function buildScribbleGeometry(width, height) {
  const targetBeat = 86;
  const beats = Math.max(2, Math.round(width / targetBeat));
  const beat = width / beats;
  const mid = height / 2;
  const amp = height * 0.36;
  const step = 2;

  const wave = (t) => {
    const ramp = (a, b) => Math.max(0, Math.min(1, (t - a) / (b - a)));
    const bump = (a, b, scale) => Math.sin(Math.PI * ramp(a, b)) * scale;
    return (
      bump(0.3, 0.42, 0.16) + // P
      bump(0.55, 0.6, -0.2) + // Q
      bump(0.6, 0.7, 1) + // R
      bump(0.7, 0.78, -0.32) + // S
      bump(0.83, 0.95, 0.24) // T
    );
  };

  const points = [];
  for (let x = 0; x <= width; x += step) {
    const phase = ((((x % beat) + beat) % beat) / beat);
    points.push(`${x.toFixed(1)} ${(mid - wave(phase) * amp).toFixed(2)}`);
  }
  return `M${points.join(' L')}`;
}

/**
 * Regenerate the trace at the container's current pixel size. Runs on boot and
 * on every box change, because the geometry is expressed in pixels and would
 * otherwise drift from the element it is drawn in.
 */
function layoutScribble() {
  const stack = elements.calibrationTrack?.querySelector('.scribble-stack');
  if (!stack) return;
  const box = stack.getBoundingClientRect();
  if (box.width < 2 || box.height < 2) return;

  const viewBox = `0 0 ${Math.round(box.width)} ${Math.round(box.height)}`;
  const d = buildScribbleGeometry(box.width, box.height);
  for (const layer of stack.querySelectorAll('.scribble-layer')) {
    layer.setAttribute('viewBox', viewBox);
    layer.firstElementChild?.setAttribute('d', d);
  }
}

function renderCalibration() {
  const config = TIMING[state.source];
  const calibration = state.calibration;
  const baseline = state.baseline;

  const collected = calibration?.samples.length ?? 0;
  const goal = calibration?.goal ?? config.calibrationSamples;
  const ratio = goal > 0 ? Math.min(1, collected / goal) : 0;

  elements.calibrationTrack.setAttribute('aria-valuemax', String(goal));
  elements.calibrationTrack.setAttribute('aria-valuenow', String(collected));

  if (baseline && !calibration) {
    // Report the baseline that was actually learned, not a stale counter that
    // still reads "0 of 10" from the run that produced it.
    const progress = 1;
    elements.calibrationCard.dataset.phase = 'done';
    elements.baselineBadge.textContent = 'Baseline ready';
    elements.baselineBadge.dataset.tone = 'good';
    elements.calibrationStatus.textContent = `Learned from ${baseline.sampleCount} quality-checked readings`;
    elements.calibrateHint.textContent = 'Recalibrate only when your usual flow pattern has been stable.';
    elements.calibrateBtn.textContent = 'Recalibrate';
    elements.calibrateBtn.disabled = false;
    elements.calibrationTrack.setAttribute('aria-valuetext', `Baseline learned from ${baseline.sampleCount} readings`);
    elements.calibrationTrack.style.setProperty('--progress', '100%');
    elements.calibrationProgress.textContent = `${baseline.sampleCount} samples`;
    renderBaselineSummary();
    return;
  }

  if (calibration) {
    elements.calibrationCard.dataset.phase = 'active';
    elements.baselineBadge.textContent = 'Calibrating';
    elements.baselineBadge.dataset.tone = 'watch';
    elements.calibrationStatus.textContent = `${collected} of ${goal} eligible readings collected`;
    elements.calibrateHint.textContent = `Hold still with good band contact. ${Math.max(0, goal - collected)} readings remain.`;
    elements.calibrateBtn.textContent = 'Calibrating…';
    elements.calibrateBtn.disabled = true;
    elements.calibrationTrack.setAttribute('aria-valuetext', `${collected} of ${goal} readings collected`);
    elements.calibrationTrack.style.setProperty('--progress', `${(ratio * 100).toFixed(1)}%`);
    elements.calibrationProgress.textContent = `${Math.round(ratio * 100)}%`;
    return;
  }

  elements.calibrationCard.dataset.phase = 'idle';
  elements.baselineBadge.textContent = 'Not calibrated';
  elements.baselineBadge.dataset.tone = 'neutral';
  elements.calibrationStatus.textContent = 'No baseline yet';
  elements.calibrateHint.textContent =
    state.source === 'demo'
      ? `The accelerated demo calibration needs ${goal} readings.`
      : `A personal calibration needs ${goal} quality-checked readings.`;
  elements.calibrateBtn.textContent = 'Start calibration';
  elements.calibrateBtn.disabled = state.connection !== 'connected' && !state.simulator;
  elements.calibrationTrack.setAttribute('aria-valuetext', 'Not started');
  elements.calibrationTrack.style.setProperty('--progress', '0%');
  elements.calibrationProgress.textContent = '0%';
  elements.baselineSummary.textContent = '';
}

function renderBaselineSummary() {
  if (!state.baseline) {
    elements.baselineSummary.textContent = '';
    elements.calibrationCollapsed.textContent = '';
    return;
  }
  const b = state.baseline;
  const parts = [
    `ratio ${formatFixed(b.ratio, 3)}`,
    `threshold ${formatFixed(b.thresholdRatio, 3)}`,
    `spread ±${formatFixed(b.thresholdRatio - b.ratio, 3)}`
  ];
  if (b.spo2 != null) parts.push(`SpO₂ ${formatFixed(b.spo2, 1)}%`);
  if (b.bpm != null) parts.push(`HR ${Math.round(b.bpm)} bpm`);
  if (b.perfusionIndex != null) parts.push(`PI ${formatFixed(b.perfusionIndex, 1)}%`);
  elements.baselineSummary.textContent = parts.join(' · ');

  // One-line replacement for the collapsed card on narrow screens. Built as
  // text nodes rather than innerHTML; the only markup is the <b> that carries
  // the sample count.
  elements.calibrationCollapsed.replaceChildren(
    document.createTextNode('Learned from '),
    Object.assign(document.createElement('b'), { textContent: `${b.sampleCount} readings` }),
    document.createTextNode(`. Threshold ${formatFixed(b.thresholdRatio, 3)}.`)
  );
}

async function beginCalibration() {
  if (state.connection !== 'connected' && !state.simulator) {
    toast('Connect a VFM band, or start a guided scenario from the Demo tab.');
    return;
  }
  clearRecheck();
  state.calibration = {
    samples: [],
    goal: TIMING[state.source].calibrationSamples,
    source: state.source,
    startedAt: Date.now(),
    lastSampleAt: Date.now()
  };
  setOperational(
    'CALIBRATING',
    'Building your baseline',
    `Collecting ${state.calibration.goal} quality-checked readings. Stay still and keep the band seated.`,
    'watch'
  );
  renderCalibration();
  await addEvent(`Started ${state.source === 'demo' ? 'accelerated demo' : 'personal'} calibration for ${state.calibration.goal} readings.`, 'system');
}

async function finishCalibration() {
  const built = buildBaseline(state.calibration.samples);
  state.baseline = built;
  state.calibration = null;
  // A new baseline is a new reference, so any suppression from the old one lapses.
  state.suppressed = false;
  persistQuietly(store.put('baseline', built));
  renderCalibration();
  setOperational(
    'MONITORING',
    'Monitoring your flow pattern',
    'Personal baseline ready. VFM verifies a change before it raises anything.',
    'good'
  );
  await addEvent(
    `Personal baseline learned from ${built.sampleCount} readings: ratio ${formatFixed(built.ratio, 3)}, threshold ${formatFixed(built.thresholdRatio, 3)}${
      built.spo2 != null ? `, SpO₂ ${formatFixed(built.spo2, 1)}%, ${Math.round(built.bpm)} bpm` : ''
    }.`,
    'good',
    [
      { label: 'Algorithm', value: built.algorithm },
      { label: 'Sample count', value: String(built.sampleCount) },
      { label: 'Median absolute deviation', value: formatFixed(built.mad, 4) },
      { label: 'Optical samples', value: `${built.opticalSampleCount} of ${built.sampleCount}` }
    ]
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Recheck
// ─────────────────────────────────────────────────────────────────────────────

function beginRecheck(evidence) {
  const timing = TIMING[state.source];
  const now = Date.now();
  state.recheck = {
    startedAt: now,
    endsAt: now + timing.recheckMs,
    valid: 1,
    anomalous: 1,
    lastAnomalous: true,
    lastGoodAt: now,
    timing
  };
  elements.recheckCard.hidden = false;
  setOperational(
    'RECHECK',
    'Rechecking this change',
    `VFM is verifying for ${Math.round(timing.recheckMs / 1000)} seconds before drawing a conclusion.`,
    'watch'
  );
  renderRecheck();
  addEvent(`Change detected: ${evidence.reason.toLowerCase()}. Opening a second check.`, 'watch', evidenceDetail(evidence));
  clearInterval(state.recheckTimer);
  state.recheckTimer = setInterval(tickRecheck, 250);
}

function tickRecheck() {
  const recheck = state.recheck;
  if (!recheck) return;
  const now = Date.now();

  // Losing signal during verification must not be silently converted into an alert.
  if (now - recheck.lastGoodAt > 10_000) {
    clearRecheck();
    setOperational('SENSOR_ISSUE', 'Signal dropped during verification', 'VFM did not turn missing data into an alert. Reposition the band and try again.', 'watch');
    addEvent('Signal quality dropped for more than 10 s during verification. The recheck was abandoned rather than escalated.', 'watch');
    return;
  }

  const remaining = Math.max(0, recheck.endsAt - now);
  renderRecheck(remaining);
  if (remaining > 0) return;

  const confirmed =
    recheck.valid >= recheck.timing.recheckValidSamples &&
    recheck.anomalous >= recheck.timing.recheckAnomalies &&
    recheck.lastAnomalous;

  clearInterval(state.recheckTimer);
  state.recheckTimer = null;
  state.recheck = null;
  elements.recheckCard.hidden = true;

  if (confirmed) {
    confirmAlert();
  } else {
    setOperational('MONITORING', 'The change did not persist', 'The second check cleared it, so no alert was raised.', 'good');
    addEvent('The change did not survive the second check. Cleared as transient, no alert raised.', 'good', [
      { label: 'Readings seen', value: String(recheck.valid) },
      { label: 'Changed readings', value: String(recheck.anomalous) },
      { label: 'Required to confirm', value: String(recheck.timing.recheckAnomalies) }
    ]);
  }
}

function renderRecheck(remaining) {
  const recheck = state.recheck;
  if (!recheck) return;
  const total = recheck.timing.recheckMs;
  const left = remaining ?? Math.max(0, recheck.endsAt - Date.now());
  const elapsedRatio = Math.min(1, (total - left) / total);
  const confirmRatio = recheck.timing.recheckAnomalies / Math.max(1, recheck.timing.recheckValidSamples);

  elements.recheckFill.style.setProperty('--recheck-elapsed', `${(elapsedRatio * 100).toFixed(1)}%`);
  elements.recheckFill.style.setProperty('--recheck-confirm', `${(confirmRatio * 100).toFixed(1)}%`);
  elements.recheckTally.textContent = `${recheck.anomalous} of ${recheck.valid} readings changed`;
  elements.recheckClock.textContent = formatCountdown(left);
  elements.recheckClock.setAttribute('aria-hidden', 'true');
}

function clearRecheck() {
  clearInterval(state.recheckTimer);
  state.recheckTimer = null;
  state.recheck = null;
  elements.recheckCard.hidden = true;
  if (state.baseline && !state.activeAlert && state.operational === 'RECHECK') {
    setOperational('MONITORING', 'Monitoring your flow pattern', 'Current readings are within your personal range.', 'good');
  }
}

function evidenceDetail(evidence) {
  return [
    { label: 'Flow ratio', value: formatFixed(evidence.ratio, 3) },
    { label: 'Personal baseline', value: formatFixed(evidence.baseline, 3) },
    { label: 'Change', value: formatPercent(evidence.ratioDelta) },
    { label: 'SpO₂', value: Number.isFinite(evidence.spo2) ? `${evidence.spo2}%` : 'not reported' },
    { label: 'Heart rate', value: Number.isFinite(evidence.bpm) ? `${evidence.bpm} bpm` : 'not reported' },
    { label: 'Primary reason', value: evidence.reason }
  ];
}

// ─────────────────────────────────────────────────────────────────────────────
// Alert lifecycle
// ─────────────────────────────────────────────────────────────────────────────

async function confirmAlert() {
  const latest = state.readings.at(-1);
  const timing = TIMING[state.source];
  const evidence = latest?.reasons?.length
    ? {
        ...latest,
        ratio: latest.ratio,
        baseline: latest.baselineRatio,
        ratioDelta: latest.deltaPercent,
        amplitudeDelta: percentOf(latest.amplitude),
        isAnomalous: true,
        reasons: latest.reasons
      }
    : null;

  state.activeAlert = {
    id: uid(),
    state: 'PENDING_ACK',
    createdAt: Date.now(),
    dueAt: Date.now() + timing.alertMs,
    total: timing.alertMs,
    mode: state.source,
    evidence
  };
  persistQuietly(store.put('alerts', state.activeAlert));

  setOperational('ALERT_PENDING_ACK', 'A flow-pattern change persisted', 'Please acknowledge. The acknowledgement timer is running.', 'alert');
  alertCenter.open(state.activeAlert);

  if (navigator.vibrate) navigator.vibrate([180, 100, 180, 100, 260]);
  if (latest?.hapticAvailable) state.band?.sendControl(CONTROL.HAPTIC_PULSE);

  await addEvent('Persistent change confirmed across the second check. Acknowledgement timer started.', 'alert', evidenceDetail(evidence ?? {}));
  startAlertTimer();

  function percentOf(amplitude) {
    if (!state.baseline?.amplitude || !Number.isFinite(amplitude)) return null;
    return ((amplitude - state.baseline.amplitude) / state.baseline.amplitude) * 100;
  }
}

function startAlertTimer() {
  clearInterval(state.alertTimer);
  const update = () => {
    const alert = state.activeAlert;
    if (!alert || alert.state !== 'PENDING_ACK') return;
    const remaining = alert.dueAt - Date.now();
    alertCenter.tick(remaining, alert.total);
    if (remaining <= 0) escalateAlert();
  };
  update();
  state.alertTimer = setInterval(update, 250);
}

async function acknowledgeAlert() {
  const alert = state.activeAlert;
  if (!alert || alert.state !== 'PENDING_ACK') return;
  clearInterval(state.alertTimer);
  alert.state = 'ACKNOWLEDGED';
  alert.acknowledgedAt = Date.now();
  alert.suppressed = true;
  state.suppressed = true;
  persistQuietly(store.put('alerts', alert));
  alertCenter.close();
  state.band?.sendControl(CONTROL.HAPTIC_STOP);

  setOperational('ACKNOWLEDGED', 'Alert acknowledged', 'Saved on this device. Follow your agreed care plan if you feel unwell.', 'good');
  pulseRing.clear();
  await addEvent('Alert acknowledged. Nothing was transmitted to a clinic.', 'good');
  fetch(`/api/alerts/${encodeURIComponent(alert.id)}/acknowledge`, { method: 'POST' }).catch(() => undefined);
  toast('Acknowledgement recorded on this device. Nothing was transmitted.');
  renderAll();
}

async function escalateAlert() {
  const alert = state.activeAlert;
  if (!alert || alert.state !== 'PENDING_ACK') return;
  clearInterval(state.alertTimer);

  const payload = {
    id: alert.id,
    patientAlias: state.profile.patientAlias,
    accessSide: state.profile.accessSide,
    occurredAt: new Date(alert.createdAt).toISOString(),
    mode: alert.mode ?? state.source,
    evidence: alert.evidence
  };

  let delivery = 'LOCAL_SIMULATED_DELIVERY';
  try {
    const response = await fetch('/api/alerts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    if (!response.ok) throw new Error('unavailable');
    const data = await response.json();
    delivery = data.delivery ?? delivery;
  } catch {
    await addEvent('The local receipt service was unreachable, so the event was recorded on this device only.', 'watch');
  }

  alert.state = 'ESCALATED';
  alert.escalatedAt = Date.now();
  alert.delivery = delivery;
  alert.suppressed = true;
  state.suppressed = true;
  persistQuietly(store.put('alerts', alert));

  alertCenter.setState('ESCALATED', 'VFM recorded a simulated clinic-delivery receipt for this event.');
  state.band?.sendControl(CONTROL.HAPTIC_STOP);

  setOperational('ESCALATED', 'Simulated delivery recorded', 'This prototype does not contact emergency services or a real clinic.', 'alert');
  await addEvent(`Acknowledgement window closed. Delivery state: ${delivery}.`, 'alert', [
    { label: 'Delivery state', value: delivery },
    { label: 'Created', value: new Date(alert.createdAt).toISOString() },
    { label: 'Escalated', value: new Date(alert.escalatedAt).toISOString() }
  ]);
  setTimeout(() => alertCenter.close(), 2600);
  toast('Simulated clinic-delivery receipt recorded locally.');
  renderAll();
}

// ─────────────────────────────────────────────────────────────────────────────
// Telemetry ingest
// ─────────────────────────────────────────────────────────────────────────────

function ingestPacket(packet, source) {
  if (state.simulator && source === 'live') return;
  state.source = source;
  state.lastPacketAt = Date.now();

  const admissible = isAdmissible(packet);
  const evidence = admissible && state.baseline ? classify(packet, packet.highBandPower / Math.max(packet.lowBandPower, 1e-6), state.baseline) : null;

  // Project every frame, admissible or not, so the Monitor can show what the
  // band is sending instead of blanking the readouts on a marginal frame.
  const reading = toReading(packet, source, evidence, state.baseline);
  reading.hapticAvailable = packet.hapticAvailable;
  state.lastSeenReading = reading;

  if (admissible) {
    state.lastGoodPacketAt = Date.now();
    state.lastStaleNoticeAt = 0;
    state.readings.push(reading);
    if (state.readings.length > READING_LIMIT) state.readings = state.readings.slice(-READING_LIMIT);
    persistQuietly(store.add('readings', reading).then(() => store.pruneReadings()));
  }

  if (state.calibration) {
    if (admissible) {
      state.calibration.samples.push({
        ratio: packet.highBandPower / Math.max(packet.lowBandPower, 1e-6),
        amplitude: packet.amplitude,
        spo2: packet.spo2,
        bpm: packet.bpm,
        perfusionIndex: packet.perfusionIndex
      });
      state.calibration.lastSampleAt = Date.now();
      renderCalibration();
      if (state.calibration.samples.length >= state.calibration.goal) finishCalibration();
    } else {
      elements.calibrationStatus.textContent = `${state.calibration.samples.length} of ${state.calibration.goal} eligible readings — waiting for a better signal`;
    }
    renderAll();
    return;
  }

  if (!state.baseline) {
    // Only a genuinely admissible frame counts as recovery. Announcing
    // "Signal restored" for a rejected frame made the watchdog fire again the
    // next second, which is what produced one stale event per second.
    if (admissible && state.operational === 'SENSOR_ISSUE') {
      setOperational('READY', 'Signal restored', 'Readings are arriving again. Calibrate to set a personal baseline.', 'good');
    }
    renderAll();
    return;
  }

  if (state.activeAlert?.state === 'PENDING_ACK') {
    renderAll();
    return;
  }

  if (state.recheck) {
    state.recheck.valid += 1;
    state.recheck.lastGoodAt = Date.now();
    if (admissible && evidence) {
      state.recheck.lastAnomalous = evidence.isAnomalous;
      if (evidence.isAnomalous) state.recheck.anomalous += 1;
    }
    renderRecheck();
    renderAll();
    return;
  }

  if (admissible && evidence) {
    // The change has resolved, so a future deviation is genuinely new again.
    if (!evidence.isAnomalous) state.suppressed = false;
  }

  if (evidence?.isAnomalous && !state.suppressed) {
    beginRecheck(evidence);
  } else if (evidence?.isAnomalous && state.suppressed) {
    setOperational(
      'MONITORING',
      'Change still present after acknowledgement',
      'VFM is watching it, not re-alerting. It re-arms once readings return to your personal range.',
      'watch'
    );
  } else if (admissible) {
    // Includes recovery from ACKNOWLEDGED/ESCALATED: once readings are back in
    // range the strip must stop claiming an alert is still outstanding.
    setOperational('MONITORING', 'Monitoring your flow pattern', 'Current readings are within your personal range.', 'good');
  }

  renderAll();
}

function renderAll() {
  const stale = signalIsStale();
  // While stale the readouts are hidden rather than left frozen on the last
  // good value: a stale number looks exactly like a live one. While frames are
  // arriving, show the newest frame even if it is below the quality floor — the
  // quality card carries the "below floor" verdict instead of blanking
  // everything (which read as a flashing signal).
  const latest = stale ? null : (state.lastSeenReading ?? state.readings.at(-1) ?? null);
  const admissible = latest ? latest.quality >= QUALITY_MINIMUM && latest.contact && !latest.faulty : false;

  vitals.update({
    readings: state.readings,
    latest,
    baseline: state.baseline,
    admissible,
    stale
  });

  scope.setData(state.readings, state.baseline);
  readingsTable.setData(state.readings, state.baseline);
  signals.update({ latest, readings: state.readings, baseline: state.baseline });

  const bpm = latest?.bpm ?? null;
  const spo2 = latest?.spo2 ?? null;
  pulseRing.set(bpm, bpmTone(spo2));

  if (!bpm) pulseRing.clear();

  elements.scopeCaption.textContent = stale
    ? 'No telemetry for 4 s — the trace is history, not live data.'
    : scopeDescription(latest);
  elements.sourceBadge.textContent = state.source === 'demo' ? 'Demo replay' : state.connection === 'connected' ? 'Live band' : 'No band';
  elements.sourceBadge.dataset.tone = state.source === 'demo' ? 'info' : state.connection === 'connected' ? 'good' : 'neutral';
  elements.sessionBadge.textContent = `${state.readings.length} reading${state.readings.length === 1 ? '' : 's'} held`;
}

function bpmTone(spo2) {
  if (Number.isFinite(spo2) && spo2 < OPTICAL.spo2.warn) return 'alert';
  return 'nominal';
}

function scopeDescription(latest) {
  if (!latest) return 'No readings yet.';
  const parts = [`Flow ratio ${formatFixed(latest.ratio, 3)}`];
  if (state.baseline) parts.push(`baseline ${formatFixed(state.baseline.ratio, 3)}`);
  if (latest.deltaPercent != null) parts.push(`${formatPercent(latest.deltaPercent)} from baseline`);
  if (latest.spo2 != null) parts.push(`SpO₂ ${latest.spo2}%`);
  if (latest.bpm != null) parts.push(`${latest.bpm} bpm`);
  return `${parts.join(', ')}.`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Band connection
// ─────────────────────────────────────────────────────────────────────────────

async function toggleConnection() {
  if (state.connection === 'connected' && state.band) {
    state.band.stop();
    return;
  }
  try {
    elements.connectBtn.disabled = true;
    elements.connectBtn.dataset.phase = 'pairing';
    elements.connectBtn.querySelector('span').textContent = 'Pairing…';

    const band = await openBand({
      onPacket(dataView) {
        try {
          ingestPacket(parseTelemetry(dataView), 'live');
        } catch (error) {
          addEvent(`Discarded an unreadable frame: ${error.message}`, 'watch');
        }
      },
      onDisconnect() {
        handleDisconnect();
      }
    });

    state.band = band;
    state.connection = 'connected';
    // Start the staleness clock now: a band that connects but never notifies
    // must go stale instead of leaving restored readings looking live.
    state.lastGoodPacketAt = Date.now();
    if (state.calibration?.source === 'demo') {
      state.calibration = null;
      renderCalibration();
    }
    state.source = 'live';
    elements.connectBtn.dataset.phase = 'connected';
    elements.connectBtn.querySelector('span').textContent = 'Disconnect';
    elements.connectionPill.textContent = band.name;
    elements.connectionPill.dataset.tone = 'good';
    setOperational('READY', 'Band connected', 'Check the signal, then calibrate when placement is stable.', 'good');
    await addEvent(`Connected to ${band.name} over Web Bluetooth.`, 'good', [
      { label: 'Telemetry frame', value: `v${VERSION.EXTENDED} (${22} bytes) accepted, v1 (20 bytes) also accepted` },
      { label: 'Optical support', value: 'SpO₂, heart rate and perfusion index' }
    ]);
  } catch (error) {
    const message =
      error?.name === 'NotFoundError' ? 'No band was selected.' : `Could not connect: ${error.message}`;
    elements.connectBtn.dataset.phase = '';
    elements.connectBtn.querySelector('span').textContent = 'Connect band';
    toast(message);
    addEvent(message, 'watch');
  } finally {
    elements.connectBtn.disabled = false;
    renderCalibration();
  }
}

function handleDisconnect() {
  state.connection = 'disconnected';
  state.band = null;
  // The newest live frame is no longer live once the band is gone.
  state.lastSeenReading = null;
  elements.connectBtn.dataset.phase = '';
  elements.connectBtn.querySelector('span').textContent = 'Connect band';
  elements.connectionPill.textContent = 'Band disconnected';
  elements.connectionPill.dataset.tone = 'watch';
  // A calibration cannot continue without frames, and leaving it "active" used
  // to wedge the card on "Calibrating…" with the start button disabled.
  if (state.calibration) {
    state.calibration = null;
    addEvent('Calibration cancelled because the band disconnected.', 'watch');
  }
  clearRecheck();
  if (!state.simulator) {
    setOperational('DISCONNECTED', 'Band disconnected', 'Reconnect to resume monitoring. Stored readings are kept.', 'watch');
  }
  addEvent('Band disconnected.', 'watch');
  renderCalibration();
  renderAll();
}

// ─────────────────────────────────────────────────────────────────────────────
// Signal watchdog
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Runs once a second while a source is attached. Two jobs, both about honesty:
 * never show a frozen reading as if it were live, and never build a baseline out
 * of a stream that stopped producing admissible readings.
 */
function tickSignalState() {
  // The recheck has its own drop-out handling, and an open acknowledgement
  // dialog must keep its own status until the user resolves it.
  if (state.recheck) return;
  if (state.activeAlert?.state === 'PENDING_ACK') return;

  if (state.calibration && Date.now() - state.calibration.lastSampleAt > CALIBRATION_TIMEOUT_MS) {
    state.calibration = null;
    setOperational(
      'SENSOR_ISSUE',
      'Calibration stopped',
      'No usable reading arrived for 12 s, so no baseline was built from bad data. Reposition the band and start again.',
      'watch'
    );
    addEvent('Calibration abandoned after 12 s without an admissible reading.', 'watch');
    renderCalibration();
    renderAll();
    return;
  }

  if (state.calibration) return;

  if (signalIsStale() && state.operational !== 'SENSOR_ISSUE') {
    setOperational(
      'SENSOR_ISSUE',
      'No live signal',
      'The band has not sent telemetry for 4 s. Last values are hidden rather than shown as current.',
      'watch'
    );
    renderAll();
  }

  // Log an outage once, then at most once per cooldown, so a marginal band
  // cannot fill the audit log with one identical row per second.
  if (signalIsStale() && Date.now() - state.lastStaleNoticeAt > STALE_EVENT_COOLDOWN_MS) {
    state.lastStaleNoticeAt = Date.now();
    addEvent('No telemetry for 4 s. The last values were marked stale instead of being shown as current.', 'watch');
  }
}

function startSignalWatchdog() {
  clearInterval(state.signalTimer);
  state.signalTimer = setInterval(tickSignalState, 1000);
}

// ─────────────────────────────────────────────────────────────────────────────
// Guided replay
// ─────────────────────────────────────────────────────────────────────────────

async function startDemo(scenario) {
  stopDemo();
  state.calibration = null;
  state.source = 'demo';
  state.lastGoodPacketAt = Date.now();
  // `tick` counts replay seconds; `establishedTick` counts only the seconds since
  // calibration completed. Scenario windows are expressed against the latter.
  state.demo = { scenario, tick: 0, establishedTick: 0 };

  state.simulator = setInterval(() => {
    state.demo.tick += 1;
    const warmingUp = !state.baseline || Boolean(state.calibration);
    if (warmingUp) state.demo.establishedTick = 0;
    else state.demo.establishedTick += 1;

    const packet = nextPacket(state.demo.scenario, state.demo.establishedTick, { warmingUp });
    try {
      // Replay goes through the real encoder and decoder, not around them.
      ingestPacket(parseTelemetry(makeFrame(packet)), 'demo');
    } catch (error) {
      // Keep the bad frame out of the pipeline, but make the failure loud. A
      // render error swallowed into the event log leaves stale readouts on
      // screen with no visible cause.
      console.error('[VFM] Replay frame error', error);
      addEvent(`Replay frame error: ${error.message}`, 'alert');
    }
  }, 1000);

  demoConsole.setActive(scenario);
  if (!state.baseline && !state.calibration) await beginCalibration();
  if (state.baseline) {
    const labels = {
      normal: ['MONITORING', 'Replay: stable flow', 'Synthetic stable packets are streaming through the live pipeline.', 'good'],
      transient: ['MONITORING', 'Replay: transient change', 'VFM will recheck this and safely clear it.', 'good'],
      persistent: ['MONITORING', 'Replay: persistent change', 'VFM will verify persistence before alerting.', 'watch']
    }[scenario];
    setOperational(labels[0], labels[1], labels[2], labels[3]);
  }
  renderCalibration();
  await addEvent(`Started guided replay: ${scenario}.`, 'system', [{ label: 'Mode', value: 'Synthetic packets encoded as v2 telemetry frames' }]);
}

function stopDemo() {
  if (!state.simulator) return;
  clearInterval(state.simulator);
  state.simulator = null;
  state.demo = null;
  if (state.calibration?.source === 'demo') {
    state.calibration = null;
  }
  demoConsole.setActive(null);
  if (state.connection !== 'connected') {
    setOperational('READY', 'Replay stopped', 'Pair a band, or choose another scenario.', 'neutral');
  }
  addEvent('Guided replay stopped.', 'system');
  renderCalibration();
  renderAll();
}

// ─────────────────────────────────────────────────────────────────────────────
// Profile, export, reset
// ─────────────────────────────────────────────────────────────────────────────

async function saveProfile(event) {
  event.preventDefault();
  const alias = elements.patientAlias.value.trim();
  if (!alias) {
    elements.patientAlias.focus();
    return;
  }
  state.profile = { id: 'current', patientAlias: alias, accessSide: elements.accessSide.value, updatedAt: Date.now() };
  await store.put('profile', state.profile);
  toast('Profile saved on this device.');
  addEvent('Monitoring profile updated.', 'system');
  closeProfile();
}

function openProfile() {
  elements.profilePanel.hidden = false;
  elements.profilePanel.querySelector('input, select, button')?.focus();
}

function closeProfile() {
  elements.profilePanel.hidden = true;
  elements.profileBtn.setAttribute('aria-expanded', 'false');
}

async function exportSummary() {
  const [alerts, events, readings] = await Promise.all([store.getAll('alerts'), store.getAll('events'), store.getAll('readings')]);
  const summary = {
    exportedAt: new Date().toISOString(),
    generator: 'VFM prototype',
    disclaimer: 'Decision-support demonstration. Not a medical device and not clinical data.',
    protocol: { version: VERSION.EXTENDED, frameBytes: 22, legacyFrameBytes: 20 },
    profile: state.profile,
    baseline: state.baseline,
    alerts,
    events: events.sort((a, b) => b.timestamp - a.timestamp),
    readings: readings.sort((a, b) => a.timestamp - b.timestamp)
  };
  const blob = new Blob([JSON.stringify(summary, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = el('a');
  link.href = url;
  link.download = `vfm-summary-${new Date().toISOString().slice(0, 10)}.json`;
  document.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
  toast(`Exported ${readings.length} readings, ${events.length} events and ${alerts.length} alerts.`);
}

async function resetData() {
  if (!window.confirm('Reset the profile, baseline, readings, events and alerts stored on this device? This cannot be undone.')) return;
  stopDemo();
  clearRecheck();
  clearInterval(state.alertTimer);
  await store.clear();
  location.reload();
}

async function checkApi() {
  try {
    const response = await fetch('/api/health', { cache: 'no-store' });
    const data = await response.json();
    elements.apiStatus.textContent =
      data.notificationMode === 'demo' ? 'Local receipt service ready (simulated)' : 'Receipt service ready';
    elements.apiStatus.dataset.tone = 'good';
  } catch {
    elements.apiStatus.textContent = 'Receipt service unreachable — alerts will be recorded on this device only';
    elements.apiStatus.dataset.tone = 'watch';
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Render helpers and boot
// ─────────────────────────────────────────────────────────────────────────────

function renderEvents() {
  eventsView.update(state.events);
}

async function restore() {
  try {
    await store.open();
    const [profile, baseline, readings, events, alerts] = await Promise.all([
      store.get('profile', 'current'),
      store.get('baseline', 'current'),
      store.getAll('readings'),
      store.getAll('events'),
      store.getAll('alerts')
    ]);

    if (profile) state.profile = profile;
    elements.patientAlias.value = state.profile.patientAlias ?? '';
    elements.accessSide.value = state.profile.accessSide ?? 'Left';

    state.baseline = baseline ?? null;
    state.readings = readings.map(normaliseStoredReading).filter(Boolean).sort((a, b) => a.timestamp - b.timestamp).slice(-READING_LIMIT);
    state.events = events.sort((a, b) => b.timestamp - a.timestamp).slice(0, EVENT_LIMIT);
    state.activeAlert = alerts.sort((a, b) => b.createdAt - a.createdAt)[0] ?? null;
    // Acknowledging must not start an alert loop across a page reload: restore
    // the suppression flag that lives with the alert record.
    state.suppressed = state.activeAlert?.suppressed === true;
  } catch (error) {
    elements.storageNote.textContent = `Local storage unavailable: ${error.message}`;
    elements.storageNote.dataset.tone = 'watch';
  }

  renderEvents();
  layoutScribble();
  renderCalibration();
  renderAll();
  scrambleNow(elements.stateLabel, 'Ready to connect');

  // A pending acknowledgement survives a reload: it must not silently disappear.
  if (state.activeAlert?.state === 'PENDING_ACK') {
    if (state.activeAlert.dueAt <= Date.now()) {
      escalateAlert();
    } else {
      state.activeAlert.total = state.activeAlert.total ?? TIMING.live.alertMs;
      setOperational('ALERT_PENDING_ACK', 'A flow-pattern change persisted', 'A pending acknowledgement was restored.', 'alert');
      alertCenter.open(state.activeAlert);
      startAlertTimer();
    }
  } else {
    setOperational('READY', 'Ready to connect', 'Pair a VFM band, or open the Demo tab for guided scenarios.', 'neutral');
  }

  checkApi();
}

function startClock() {
  clearInterval(state.clockTimer);
  state.clockTimer = setInterval(() => {
    if (state.demo) demoConsole.tickElapsed();
  }, 1000);
}

// Wiring
elements.connectBtn.addEventListener('click', toggleConnection);
elements.calibrateBtn.addEventListener('click', beginCalibration);

// The prototype boundary is always available but should not permanently occupy
// the top of a phone screen above the readouts.
elements.prototypeNotice.querySelector('.notice-more')?.addEventListener('click', (event) => {
  const notice = elements.prototypeNotice;
  const expanded = notice.dataset.collapsed === 'false';
  notice.dataset.collapsed = String(expanded);
  const button = event.currentTarget;
  button.setAttribute('aria-expanded', String(!expanded));
  button.querySelector('.visually-hidden').textContent = expanded
    ? 'Show the full prototype boundary'
    : 'Hide the full prototype boundary';
});

// The prototype boundary now sits at the foot of the Monitor view as a collapsed
// footnote, so it starts collapsed regardless of calibration state.
elements.prototypeNotice.dataset.collapsed = 'true';
elements.themeToggle.addEventListener('click', () => {
  const next = theme.toggle();
  toast(`${next === 'dark' ? 'Dark' : 'Light'} theme.`);
});
elements.profileBtn.addEventListener('click', () => {
  const open = elements.profilePanel.hidden;
  elements.profilePanel.hidden = !open;
  elements.profileBtn.setAttribute('aria-expanded', String(open));
  if (open) elements.patientAlias.focus();
});
elements.profileClose.addEventListener('click', closeProfile);
elements.profileForm.addEventListener('submit', saveProfile);
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && !elements.profilePanel.hidden) closeProfile();
});
elements.exportBtn.addEventListener('click', exportSummary);
elements.resetBtn.addEventListener('click', resetData);

motion.onChange(() => {
  scope.refresh();
  signals.refresh();
  renderCalibration();
});

theme.onChange(() => {
  scope.refresh();
  signals.refresh();
});

// The calibration trace is generated in pixels, so it has to be rebuilt whenever
// its box changes — a rotation, a resize, or the mobile/tablet layout switch.
const scribbleStack = elements.calibrationTrack?.querySelector('.scribble-stack');
if (scribbleStack && 'ResizeObserver' in window) {
  let scribbleWidth = 0;
  new ResizeObserver((entries) => {
    const width = entries[0]?.contentRect.width ?? 0;
    if (Math.abs(width - scribbleWidth) < 1) return;
    scribbleWidth = width;
    layoutScribble();
  }).observe(scribbleStack);
}

startClock();
startSignalWatchdog();
restore();

// Exposed for the console during a live demo; carries no behaviour of its own.
window.VFM = { state, router, VIEWS, spo2Band, startDemo, stopDemo };
