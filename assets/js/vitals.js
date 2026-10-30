/**
 * The vital quartet.
 *
 * Four primary readouts, each with an odometer value, a state chip, personal context,
 * and a sparkline. The pulse ring under the status strip beats at the measured heart
 * rate rather than at a fixed animation speed, so the interface is visually paced by
 * the person being monitored.
 */

import { createOdometer } from './ui/odometer.js';
import { createSparkline } from './charts/sparkline.js';
import { el, formatFixed, formatPercent, spo2Band, perfusionBand, qualityBand } from './format.js';
import { OPTICAL } from './engine.js';

const SPARK_SAMPLES = 16;

function vitalCard(key, label, unit, digits, decimals, description) {
  const article = el('article', 'vital');
  article.dataset.vital = key;

  const head = el('header', 'vital-head');
  const heading = el('h3', 'vital-label', label);
  heading.id = `vital-${key}-label`;
  article.setAttribute('aria-labelledby', heading.id);
  const chip = el('span', 'chip');
  head.append(heading, chip);

  const readout = el('div', 'vital-readout');
  const odo = el('span', 'odo');
  odo.setAttribute('role', 'img');
  readout.append(odo, el('span', 'vital-unit', unit));

  const context = el('p', 'vital-context');

  const foot = el('div', 'vital-foot');
  const sparkSlot = el('div', 'vital-spark');
  const delta = el('span', 'vital-delta');
  foot.append(sparkSlot, delta);

  article.append(head, readout, context, foot);
  sparkSlot.setAttribute('role', 'presentation');

  return { article, chip, odo, context, sparkSlot, delta, unit, digits, decimals, description };
}

export function createVitals({ root, onInspect }) {
  const cards = {
    // Five cells with three decimals covers 0.000-99.999, which is the whole
    // realistic range of the acoustic ratio.
    ratio: vitalCard('ratio', 'Flow pattern ratio', 'ratio', 5, 3),
    spo2: vitalCard('spo2', 'Oxygen saturation', 'SpO₂', 3, 0),
    hr: vitalCard('hr', 'Heart rate', 'bpm', 3, 0),
    quality: vitalCard('quality', 'Signal quality', 'score', 3, 0)
  };

  const odometers = {
    ratio: createOdometer(cards.ratio.odo, { digits: 5, decimals: 3 }),
    spo2: createOdometer(cards.spo2.odo, { digits: 3, decimals: 0 }),
    hr: createOdometer(cards.hr.odo, { digits: 3, decimals: 0 }),
    quality: createOdometer(cards.quality.odo, { digits: 3, decimals: 0 })
  };

  root.replaceChildren(...Object.values(cards).map((card) => card.article));

  // Hovering a vital highlights the same feature on the scope trace.
  for (const [key, card] of Object.entries(cards)) {
    card.article.addEventListener('pointerenter', () => onInspect?.(key));
  }

  function history(values, getter) {
    return values.slice(-SPARK_SAMPLES).map(getter).filter(Number.isFinite);
  }

  function renderSpark(slot, values, tone, threshold) {
    const next = createSparkline({ values, tone, threshold, width: 78, height: 22 });
    if (slot.firstElementChild && slot.firstElementChild.dataset.empty === next.dataset.empty) {
      const existing = slot.firstElementChild;
      if (existing.dataset.empty === 'true') return;
      existing.replaceWith(next);
    } else {
      slot.replaceChildren(next);
    }
  }

  function setChip(card, label, tone) {
    card.chip.textContent = label;
    card.chip.dataset.tone = tone;
  }

  return {
    /**
     * @param {object} snapshot
     * @param {Array}  snapshot.readings chronological readings
     * @param {object} snapshot.latest    newest admissible reading
     * @param {object} snapshot.baseline  learned personal baseline
     * @param {boolean} snapshot.admissible whether the newest reading passed quality
     */
    update({ readings = [], latest = null, baseline = null, admissible = false, stale = false }) {
      const chronological = readings;

      // ── Flow pattern ratio ────────────────────────────────────────────────
      const ratioCard = cards.ratio;
      if (!latest || !Number.isFinite(latest.ratio)) {
        odometers.ratio.apply(null);
        setChip(ratioCard, 'No data', 'neutral');
        ratioCard.context.textContent = baseline ? 'Awaiting a reading' : 'Calibrate to establish a baseline';
        ratioCard.delta.textContent = '—';
        ratioCard.delta.dataset.tone = 'neutral';
      } else {
        odometers.ratio.apply(latest.ratio);
        const delta = latest.deltaPercent;
        const tone = latest.anomalous ? 'alert' : Math.abs(delta ?? 0) < 3 ? 'nominal' : 'watch';
        setChip(ratioCard, latest.anomalous ? 'Flagged' : Math.abs(delta ?? 0) < 3 ? 'Within range' : 'Drifting', tone);
        ratioCard.context.textContent = baseline
          ? `Baseline ${formatFixed(baseline.ratio, 3)} · threshold ${formatFixed(baseline.thresholdRatio, 3)}`
          : 'No personal baseline yet';
        ratioCard.delta.textContent = formatPercent(delta);
        ratioCard.delta.dataset.tone = tone;
        renderSpark(
          ratioCard.sparkSlot,
          history(chronological, (r) => r.ratio),
          tone === 'nominal' ? 'accent' : tone,
          baseline?.thresholdRatio ?? null
        );
      }

      // ── Oxygen saturation ─────────────────────────────────────────────────
      const spo2Card = cards.spo2;
      if (!latest || latest.spo2 == null) {
        odometers.spo2.apply(null);
        const reason = !latest
          ? 'No reading'
          : !latest.ppgValid
            ? 'PPG not asserted'
            : latest.protocol === 1
              ? 'Firmware v1 frame'
              : 'Out of range';
        setChip(spo2Card, reason, 'neutral');
        spo2Card.context.textContent = 'Requires a v2 frame with the PPG-valid flag';
        spo2Card.delta.textContent = '—';
        spo2Card.delta.dataset.tone = 'neutral';
      } else {
        odometers.spo2.apply(latest.spo2);
        const band = spo2Band(latest.spo2);
        setChip(spo2Card, band.label, band.tone);
        const delta = baseline?.spo2 != null ? ((latest.spo2 - baseline.spo2) / baseline.spo2) * 100 : null;
        spo2Card.context.textContent =
          baseline?.spo2 != null ? `Your baseline ${formatFixed(baseline.spo2, 1)}%` : `Watch threshold ${OPTICAL.spo2.warn}%`;
        spo2Card.delta.textContent = formatPercent(delta);
        spo2Card.delta.dataset.tone = band.tone;
        renderSpark(
          spo2Card.sparkSlot,
          history(chronological, (r) => r.spo2),
          band.tone === 'nominal' ? 'nominal' : band.tone,
          OPTICAL.spo2.warn
        );
      }

      // ── Heart rate ────────────────────────────────────────────────────────
      const hrCard = cards.hr;
      if (!latest || latest.bpm == null) {
        odometers.hr.apply(null);
        setChip(hrCard, !latest ? 'No reading' : !latest.ppgValid ? 'PPG not asserted' : 'Out of range', 'neutral');
        hrCard.context.textContent = 'Requires a v2 frame with the PPG-valid flag';
        hrCard.delta.textContent = '—';
        hrCard.delta.dataset.tone = 'neutral';
      } else {
        odometers.hr.apply(latest.bpm);
        const delta = baseline?.bpm != null ? ((latest.bpm - baseline.bpm) / baseline.bpm) * 100 : null;
        const tachycardic = baseline?.bpm != null && latest.bpm > baseline.bpm * 1.25;
        const tone = tachycardic ? 'alert' : Math.abs(delta ?? 0) < 8 ? 'nominal' : 'watch';
        setChip(hrCard, tachycardic ? 'Elevated vs baseline' : Math.abs(delta ?? 0) < 8 ? 'Steady' : 'Rising', tone);
        hrCard.context.textContent = baseline?.bpm != null ? `Your baseline ${Math.round(baseline.bpm)} bpm` : 'No pulse baseline yet';
        hrCard.delta.textContent = formatPercent(delta, 0);
        hrCard.delta.dataset.tone = tone;
        renderSpark(hrCard.sparkSlot, history(chronological, (r) => r.bpm), tone === 'nominal' ? 'nominal' : tone, null);
      }

      // ── Signal quality ────────────────────────────────────────────────────
      const qualityCard = cards.quality;
      if (!latest || !Number.isFinite(latest.quality)) {
        odometers.quality.apply(null);
        setChip(qualityCard, stale ? 'Stale' : 'No signal', stale ? 'watch' : 'neutral');
        qualityCard.context.textContent = stale
          ? 'No admissible reading for 4 s — values hidden rather than frozen'
          : 'Band not connected';
        qualityCard.delta.textContent = '—';
        qualityCard.delta.dataset.tone = 'neutral';
      } else {
        odometers.quality.apply(latest.quality);
        const band = qualityBand(latest.quality);
        const usable = admissible;
        setChip(qualityCard, usable ? band.label : 'Below floor', usable ? band.tone : 'watch');
        qualityCard.context.textContent = usable
          ? 'Reading accepted as evidence'
          : 'Below the 70-point floor — not used as evidence';
        qualityCard.delta.textContent = `${latest.contact ? 'Contact' : 'No contact'}`;
        qualityCard.delta.dataset.tone = latest.contact ? 'nominal' : 'alert';
        renderSpark(qualityCard.sparkSlot, history(chronological, (r) => r.quality), usable ? 'nominal' : 'watch', 70);
      }

      // Keep assistive tech in step, but only for the values that changed.
      cards.ratio.odo.setAttribute('aria-label', describe('Flow pattern ratio', latest?.ratio, latest?.deltaPercent));
      cards.spo2.odo.setAttribute('aria-label', describe('Oxygen saturation', latest?.spo2, null, '%'));
      cards.hr.odo.setAttribute('aria-label', describe('Heart rate', latest?.bpm, null, 'bpm'));
      cards.quality.odo.setAttribute('aria-label', describe('Signal quality', latest?.quality, null, 'of 100'));
    },

    /** Brief bloom on the two optical readouts when they take a meaningful change. */
    flagOptical(spo2Tone, hrTone) {
      if (spo2Tone === 'alert' || spo2Tone === 'watch') cards.spo2.odo.querySelector('.odo')?.classList.add('is-flag');
      if (hrTone === 'alert') cards.hr.odo.querySelector('.odo')?.classList.add('is-flag');
      setTimeout(() => {
        cards.spo2.odo.querySelector('.odo')?.classList.remove('is-flag');
        cards.hr.odo.querySelector('.odo')?.classList.remove('is-flag');
      }, 900);
    }
  };

  function describe(label, value, delta, unit = '') {
    if (value == null || !Number.isFinite(value)) return `${label}: no reading`;
    const suffix = unit ? ` ${unit}` : '';
    const change = Number.isFinite(delta) && unit === '' ? `, ${formatPercent(delta)} from baseline` : '';
    return `${label} ${value}${suffix}${change}`;
  }
}

/**
 * Pulse ring. The ring's animation period is derived from the measured heart rate,
 * so the whole status cluster breathes at the subject's actual pulse.
 */
export function createPulseRing(node) {
  let current = null;

  return {
    set(bpm, tone = 'nominal') {
      const valid = Number.isFinite(bpm) && bpm >= 30 && bpm <= 220;
      if (!valid) {
        node.dataset.active = 'false';
        node.dataset.tone = tone;
        node.style.setProperty('--pulse-period', '2.4s');
        current = null;
        return;
      }
      if (current === bpm) return;
      current = bpm;
      node.dataset.active = 'true';
      node.dataset.tone = tone;
      // Period = one cardiac cycle. Clamped so an implausible rate cannot stall the animation.
      node.style.setProperty('--pulse-period', `${Math.min(2.2, Math.max(0.42, 60 / bpm)).toFixed(3)}s`);
    },
    clear() {
      current = null;
      node.dataset.active = 'false';
    }
  };
}

export { perfusionBand };
