/**
 * Guided demo console.
 *
 * The demo is not a separate code path. Every synthetic packet is encoded into a
 * real v2 telemetry frame and pushed through the same decoder, quality gate,
 * baseline and recheck logic as hardware, so what a judge sees is the product.
 *
 * The scenarios are tuned so the new optical readouts carry the story rather than
 * merely decorating it: a sustained flow problem shows as falling saturation,
 * falling perfusion and a compensatory rise in pulse rate.
 */

import { el } from './format.js';
import { VERSION, FLAG } from './ble.js';

export const SCENARIOS = {
  normal: {
    key: 'normal',
    title: 'Stable flow',
    thesis: 'Establishes the personal baseline and shows a quiet, nominal system.',
    cue: 'VFM is learning this person’s normal, not comparing them to a population threshold.',
    expect: 'No recheck. No alert. All four readouts nominal.',
    duration: 'Runs indefinitely'
  },
  transient: {
    key: 'transient',
    title: 'Transient change',
    thesis: 'A short disturbance from movement should be absorbed, not escalated.',
    cue: 'One reading is not evidence. VFM rechecks before it says anything.',
    expect: 'Recheck opens, the band loses its PPG assertion so optical values drop out, then the change clears itself.',
    duration: 'Disturbance lasts 3 s of the 10 s recheck'
  },
  persistent: {
    key: 'persistent',
    title: 'Persistent change',
    thesis: 'A change that survives the second check produces an explainable alert.',
    cue: 'Watch saturation fall and pulse rate rise — the optical channel corroborates the acoustic one.',
    expect: 'Recheck confirms, alert dialog opens, acknowledgement timer starts.',
    duration: 'Alert dialog after 10 s recheck'
  }
};

/** Small deterministic wobble so the trace never looks like a flat line. */
function jitter(scale) {
  return (Math.random() - 0.5) * scale;
}

/**
 * Build the next synthetic packet.
 *
 * @param {string} scenario one of SCENARIOS
 * @param {number} tick seconds of *established* monitoring — i.e. counted from the
 *   moment calibration finished, not from replay start. Counting from replay start
 *   would push every perturbation window inside the calibration phase, where it is
 *   suppressed, and the scenario would silently never fire.
 * @param {object} context
 * @param {boolean} context.warmingUp true while calibrating, when perturbations are suppressed
 */
export function nextPacket(scenario, tick, { warmingUp = false } = {}) {
  const noise = jitter(0.024);
  let lowBandPower = 0.82 + noise;
  let ratio = 1.24 + noise;
  let amplitude = 0.84 + noise;
  let dominantFrequencyHz = 150;
  let quality = 94;
  let bpm = 74 + Math.round(jitter(4));
  let spo2 = 97 + jitter(0.9);
  let perfusionIndex = 3.6 + jitter(0.4);
  let flags = FLAG.CONTACT | FLAG.PPG_VALID | FLAG.HAPTIC;

  if (!warmingUp) {
    if (scenario === 'transient' && tick >= 2 && tick <= 4) {
      // Movement artefact: energy shifts up and the band stops asserting the PPG
      // validity flag, so optical readouts drop out entirely. Quality stays just
      // above the admission floor, so the reading is still usable as acoustic
      // evidence — which is what puts it through the recheck rather than tripping
      // the placement-guidance path.
      ratio = 1.5 + noise;
      dominantFrequencyHz = 465;
      quality = 76 + Math.round(jitter(4));
      flags = FLAG.CONTACT | FLAG.HAPTIC;
    }

    if (scenario === 'persistent' && tick >= 2) {
      // A sustained flow problem: ratio up, amplitude down, energy shifted up,
      // perfusion poor, saturation drifting down, pulse rate compensating upward.
      const ramp = Math.min(1, (tick - 1) / 6);
      ratio = 1.24 + 0.26 * ramp + noise;
      amplitude = 0.84 - 0.12 * ramp + noise;
      dominantFrequencyHz = 150 + Math.round(335 * ramp);
      quality = 92 + Math.round(jitter(3));
      perfusionIndex = Math.max(0.5, 3.6 - 3.0 * ramp + jitter(0.3));
      spo2 = Math.max(90, 97 - 4 * ramp + jitter(0.7));
      bpm = Math.round(74 + 16 * ramp + jitter(4));
    }
  }

  return {
    version: VERSION.EXTENDED,
    sequence: tick % 65536,
    lowBandPower,
    highBandPower: lowBandPower * ratio,
    amplitude,
    dominantFrequencyHz,
    quality: Math.max(0, Math.min(100, Math.round(quality))),
    bpm: Math.max(0, Math.min(255, Math.round(bpm))),
    spo2: Math.max(0, Math.min(100, Math.round(spo2))),
    perfusionIndex: Math.max(0, Math.min(100, Math.round(perfusionIndex))),
    flags
  };
}

export function createDemoConsole({ root, onStart, onStop }) {
  let activeKey = null;

  const intro = el('p', 'demo-intro');
  intro.textContent =
    'Replay encodes synthetic packets into real v2 telemetry frames and pushes them through the same decoder, quality gate and recheck logic as hardware. No shortcuts.';

  const grid = el('div', 'scenario-grid');
  const nodes = new Map();

  for (const scenario of Object.values(SCENARIOS)) {
    const card = el('article', 'scenario');
    card.dataset.scenario = scenario.key;
    if (scenario.key === 'persistent') card.dataset.emphasis = 'alert';

    const head = el('header', 'scenario-head');
    head.append(el('span', 'scenario-index', String(Object.keys(SCENARIOS).indexOf(scenario.key) + 1).padStart(2, '0')));
    head.append(el('h3', 'scenario-title', scenario.title));
    card.append(head);

    card.append(el('p', 'scenario-thesis', scenario.thesis));

    const expect = el('dl', 'scenario-meta');
    for (const [label, value] of [
      ['Expected result', scenario.expect],
      ['What to say', scenario.cue],
      ['Timing', scenario.duration]
    ]) {
      const dt = el('dt', null, label);
      const dd = el('dd', null, value);
      expect.append(dt, dd);
    }
    card.append(expect);

    const button = el('button', 'btn btn-run');
    button.type = 'button';
    button.append(el('span', null, 'Run scenario'));
    button.addEventListener('click', () => onStart(scenario.key));
    card.append(button);

    nodes.set(scenario.key, { card, button });
    grid.append(card);
  }

  const active = el('div', 'demo-active');
  active.hidden = true;
  const activeName = el('strong', null, '');
  const activeSince = el('span', 'demo-active-since', '');
  const stopButton = el('button', 'btn btn-danger btn-sm', 'Stop replay');
  stopButton.type = 'button';
  stopButton.addEventListener('click', () => onStop());
  const activeRow = el('div', 'demo-active-row');
  activeRow.append(activeName, activeSince, stopButton);
  active.append(activeRow);

  root.replaceChildren(intro, grid, active);

  let startedAt = 0;

  /** Live elapsed counter for the active replay. */
  function updateElapsed() {
    if (!activeKey) return;
    const seconds = Math.round((Date.now() - startedAt) / 1000);
    activeSince.textContent = seconds < 60 ? `${seconds}s elapsed` : `${Math.floor(seconds / 60)}m ${seconds % 60}s elapsed`;
  }

  return {
    setActive(key) {
      activeKey = key;
      for (const [scenarioKey, node] of nodes) {
        const on = scenarioKey === key;
        node.card.classList.toggle('is-active', on);
        node.button.disabled = on;
        node.button.querySelector('span').textContent = on ? 'Running…' : 'Run scenario';
      }
      active.hidden = !key;
      if (key) {
        activeName.textContent = `${SCENARIOS[key].title} replay running`;
        startedAt = Date.now();
        updateElapsed();
      }
    },

    tickElapsed: updateElapsed,

    get activeScenario() {
      return activeKey;
    }
  };
}
