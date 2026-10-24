/**
 * Signals view.
 *
 * Explains where the flow-pattern ratio comes from: the balance of acoustic energy
 * between the low and high bands, the optical perfusion the sensor is actually
 * seeing, the contact and flag state of the device, and where the dominant
 * frequency has been sitting.
 */

import { createSparkline } from './charts/sparkline.js';
import { el, formatFixed, qualityBand, perfusionBand } from './format.js';
import { OPTICAL } from './engine.js';
import { QUALITY_MINIMUM } from './ble.js';

const SPARK_SAMPLES = 24;
// 135° sweep through vertical: the classic instrument-gauge arc, symmetric about
// the top so the needle does not appear to hang off centre.
const GAUGE = { width: 200, height: 120, start: Math.PI * 0.75, sweep: Math.PI * 1.5, radius: 72, valueMax: 25 };

function token(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(`--${name}`).trim();
}

function block(eyebrow, title) {
  const section = el('section', 'signal-block');
  const head = el('header', 'signal-block-head');
  head.append(el('p', 'eyebrow', eyebrow), el('h3', 'signal-block-title', title));
  const body = el('div', 'signal-block-body');
  section.append(head, body);
  return { section, body };
}

export function createSignals({ root }) {
  // ── Spectral balance ─────────────────────────────────────────────────────
  const acoustic = block('Acoustic', 'Band energy balance');

  const spectral = el('div', 'spectral');
  const lowRow = el('div', 'spectral-row');
  const lowLabel = el('span', 'spectral-label', 'Low band');
  const lowTrack = el('div', 'spectral-track');
  const lowFill = el('span', 'spectral-fill');
  lowFill.dataset.side = 'low';
  lowTrack.append(lowFill);
  const lowValue = el('span', 'spectral-value', '—');
  lowRow.append(lowLabel, lowTrack, lowValue);

  const ratioBridge = el('div', 'spectral-bridge');
  ratioBridge.append(el('span', 'spectral-bridge-label', 'ratio'));
  const ratioValue = el('strong', 'spectral-ratio', '—');
  ratioBridge.append(ratioValue);

  const highRow = el('div', 'spectral-row');
  const highLabel = el('span', 'spectral-label', 'High band');
  const highTrack = el('div', 'spectral-track');
  const highFill = el('span', 'spectral-fill');
  highFill.dataset.side = 'high';
  highTrack.append(highFill);
  const highValue = el('span', 'spectral-value', '—');
  highRow.append(highLabel, highTrack, highValue);

  spectral.append(lowRow, ratioBridge, highRow);

  const spectralNote = el('p', 'note', 'Bars are scaled against the strongest band seen since calibration. The ratio is what VFM compares to your baseline.');

  acoustic.body.append(spectral, spectralNote);

  // ── Perfusion gauge ──────────────────────────────────────────────────────
  const optical = block('Optical', 'Perfusion reaching the sensor');
  const gauge = el('canvas', 'gauge');
  gauge.setAttribute('role', 'img');
  gauge.width = GAUGE.width;
  gauge.height = GAUGE.height;
  const gaugeWrap = el('div', 'gauge-wrap');
  gaugeWrap.append(gauge);
  const gaugeCaption = el('p', 'gauge-caption', 'Perfusion index · no reading');
  const gaugeScale = el('p', 'gauge-scale');
  gaugeScale.append(
    el('span', null, 'weak'),
    el('span', null, 'fair'),
    el('span', null, 'strong')
  );
  optical.body.append(gaugeWrap, gaugeScale, gaugeCaption);

  // ── Flag chips ───────────────────────────────────────────────────────────
  const device = block('Device', 'Reported state');
  const flagGrid = el('div', 'flag-grid');
  const flags = [
    { key: 'contact', label: 'Sensor contact' },
    { key: 'ppg', label: 'PPG valid' },
    { key: 'fault', label: 'No device fault' },
    { key: 'haptic', label: 'Haptics available' }
  ];
  const flagNodes = new Map();
  for (const flag of flags) {
    const chip = el('span', 'chip', flag.label);
    chip.dataset.tone = 'neutral';
    flagNodes.set(flag.key, chip);
    flagGrid.append(chip);
  }
  const flagNote = el('p', 'note', 'Optical values are only reported when the band asserts PPG validity.');
  device.body.append(flagGrid, flagNote);

  // ── Dominant frequency ───────────────────────────────────────────────────
  const frequency = block('Acoustic', 'Dominant frequency');
  frequency.section.classList.add('signal-wide');
  const freqValue = el('strong', 'freq-value', '—');
  const freqUnit = el('span', 'freq-unit', 'Hz');
  const freqHead = el('div', 'freq-head');
  freqHead.append(freqValue, freqUnit);
  const freqSpark = el('div', 'freq-spark');
  const freqRange = el('p', 'freq-range', 'collecting…');
  const freqNote = el('p', 'note', 'A sustained upward shift in dominant frequency accompanies a rising flow ratio.');
  frequency.body.append(freqHead, freqSpark, freqRange, freqNote);

  root.replaceChildren(acoustic.section, optical.section, device.section, frequency.section);

  const gaugeContext = gauge.getContext('2d');
  let smoothScale = 1;

  function drawGauge(value) {
    const { width, height, radius, start, sweep, valueMax } = GAUGE;
    const scale = Math.min(window.devicePixelRatio || 1, 2.5);
    gauge.width = Math.floor(width * scale);
    gauge.height = Math.floor(height * scale);
    gaugeContext.setTransform(scale, 0, 0, scale, 0, 0);
    gaugeContext.clearRect(0, 0, width, height);

    const cx = width / 2;
    const cy = height - 16;

    // Quality bands across the arc.
    const bands = [
      { from: 0, to: OPTICAL.perfusionIndex.poorBelow, tone: 'alert' },
      { from: OPTICAL.perfusionIndex.poorBelow, to: OPTICAL.perfusionIndex.fairBelow, tone: 'watch' },
      { from: OPTICAL.perfusionIndex.fairBelow, to: valueMax, tone: 'nominal' }
    ];
    gaugeContext.lineWidth = 13;
    gaugeContext.lineCap = 'butt';
    for (const band of bands) {
      const from = start + (Math.min(band.from, valueMax) / valueMax) * sweep;
      const to = start + (Math.min(band.to, valueMax) / valueMax) * sweep;
      gaugeContext.strokeStyle = token(band.tone);
      gaugeContext.globalAlpha = 0.2;
      gaugeContext.beginPath();
      gaugeContext.arc(cx, cy, radius, from, to);
      gaugeContext.stroke();
    }

    // End caps marking where each band stops.
    gaugeContext.globalAlpha = 0.55;
    gaugeContext.strokeStyle = token('line-strong');
    gaugeContext.lineWidth = 1.5;
    for (const boundary of [OPTICAL.perfusionIndex.poorBelow, OPTICAL.perfusionIndex.fairBelow]) {
      const angle = start + (boundary / valueMax) * sweep;
      gaugeContext.beginPath();
      gaugeContext.moveTo(cx + Math.cos(angle) * (radius - 8), cy + Math.sin(angle) * (radius - 8));
      gaugeContext.lineTo(cx + Math.cos(angle) * (radius + 8), cy + Math.sin(angle) * (radius + 8));
      gaugeContext.stroke();
    }

    gaugeContext.globalAlpha = 1;
    if (Number.isFinite(value)) {
      const angle = start + (Math.min(value, valueMax) / valueMax) * sweep;
      gaugeContext.strokeStyle = token(perfusionBand(value).tone);
      gaugeContext.lineWidth = 6;
      gaugeContext.lineCap = 'round';
      gaugeContext.beginPath();
      gaugeContext.arc(cx, cy, radius, start, angle);
      gaugeContext.stroke();

      gaugeContext.fillStyle = token('ink');
      gaugeContext.beginPath();
      gaugeContext.arc(cx + Math.cos(angle) * radius, cy + Math.sin(angle) * radius, 3.6, 0, Math.PI * 2);
      gaugeContext.fill();

      gauge.setAttribute('aria-label', `Perfusion index ${value} percent, ${perfusionBand(value).label.toLowerCase()}`);
    } else {
      gauge.setAttribute('aria-label', 'Perfusion index unavailable');
    }
  }

  return {
    update({ latest, readings = [], baseline = null }) {
      // Spectral balance, with an eased ceiling so the bars do not jump.
      const low = latest?.lowBandPower ?? null;
      const high = latest?.highBandPower ?? null;
      const ceiling = Math.max(
        1e-6,
        ...readings.map((r) => Math.max(r.lowBandPower ?? 0, r.highBandPower ?? 0)),
        low ?? 0,
        high ?? 0
      );
      smoothScale = smoothScale ? smoothScale * 0.6 + ceiling * 0.4 : ceiling || 1;

      if (Number.isFinite(low)) {
        lowFill.style.setProperty('--level', `${Math.min(100, (low / smoothScale) * 100)}%`);
        lowValue.textContent = low.toFixed(3);
      } else {
        lowFill.style.setProperty('--level', '0%');
        lowValue.textContent = '—';
      }
      if (Number.isFinite(high)) {
        highFill.style.setProperty('--level', `${Math.min(100, (high / smoothScale) * 100)}%`);
        highValue.textContent = high.toFixed(3);
      } else {
        highFill.style.setProperty('--level', '0%');
        highValue.textContent = '—';
      }
      if (Number.isFinite(latest?.ratio)) {
        ratioValue.textContent = latest.ratio.toFixed(3);
        ratioBridge.dataset.tone = latest.anomalous ? 'alert' : baseline ? 'nominal' : 'neutral';
      } else {
        ratioValue.textContent = '—';
        ratioBridge.dataset.tone = 'neutral';
      }

      // Perfusion.
      drawGauge(latest?.perfusionIndex ?? null);
      gaugeCaption.textContent = Number.isFinite(latest?.perfusionIndex)
        ? `${latest.perfusionIndex}% · ${perfusionBand(latest.perfusionIndex).label}`
        : 'No reading';
      gaugeCaption.dataset.tone = Number.isFinite(latest?.perfusionIndex) ? perfusionBand(latest.perfusionIndex).tone : 'neutral';

      // Flags. Fault and missing contact invert the sense of their chips.
      flagNodes.get('contact').dataset.tone = !latest ? 'neutral' : latest.contact ? 'nominal' : 'alert';
      flagNodes.get('ppg').dataset.tone = !latest ? 'neutral' : latest.ppgValid ? 'nominal' : 'watch';
      flagNodes.get('fault').dataset.tone = !latest ? 'neutral' : latest.faulty ? 'alert' : 'nominal';
      flagNodes.get('haptic').dataset.tone = latest?.hapticAvailable ? 'info' : 'neutral';

      // Dominant frequency.
      freqValue.textContent = Number.isFinite(latest?.dominantFrequencyHz) ? String(latest.dominantFrequencyHz) : '—';
      const freqValues = readings.slice(-SPARK_SAMPLES).map((r) => r.dominantFrequencyHz).filter(Number.isFinite);
      const threshold = baseline?.dominantFrequencyHz ?? null;
      freqSpark.replaceChildren(
        createSparkline({
          values: freqValues,
          tone: latest?.anomalous ? 'alert' : 'accent',
          threshold,
          width: 220,
          height: 34
        })
      );

      /* A dominant frequency that is holding steady draws a perfectly flat
         line, which reads as a broken chart rather than as the good news it is.
         State the spread explicitly instead of leaving the shape to speak. */
      if (freqValues.length >= 2) {
        const min = Math.min(...freqValues);
        const max = Math.max(...freqValues);
        const spread = max - min;
        freqRange.textContent =
          spread === 0 ? `holding steady at ${max} Hz` : `${min}–${max} Hz · spread ${spread} Hz`;
      } else {
        freqRange.textContent = 'collecting…';
      }
      // Quality note doubles as the placement guidance when the signal is poor.
      if (latest && Number.isFinite(latest.quality) && latest.quality < QUALITY_MINIMUM) {
        spectralNote.textContent = `Signal quality is ${latest.quality} of 100, below the ${QUALITY_MINIMUM}-point admission floor. Reposition the band over the access site and hold still; these readings are not used as evidence.`;
        spectralNote.dataset.tone = 'watch';
      } else {
        spectralNote.textContent = 'Bars are scaled against the strongest band seen since calibration. The ratio is what VFM compares to your baseline.';
        delete spectralNote.dataset.tone;
      }

      void formatFixed;
      void qualityBand;
    },
    refresh() {
      drawGauge(null);
    }
  };
}
