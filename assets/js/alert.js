/**
 * Escalation alert.
 *
 * This is the highest-stakes surface in the app, so it is built to be explicit
 * rather than dramatic: the evidence table shows the measured ratio, the personal
 * baseline, the percentage change, and every optical reading that contributed, and
 * the panel states plainly what the acknowledgement timer does and does not do.
 *
 * Accessibility note: the countdown digits are hidden from assistive technology and
 * a separate polite live region announces only at phase boundaries. Announcing a
 * ticking clock would drown out everything else the user needs to hear.
 */

import { el, formatCountdown, formatPercent, formatFixed } from './format.js';
import { motion } from './theme.js';

// `primary` fields span the full row on narrow screens, so the three numbers
// that matter most stay on one readable line instead of pairing up arbitrarily.
const EVIDENCE_FIELDS = [
  { key: 'ratio', label: 'Flow ratio', format: (e) => formatFixed(e.ratio, 3) },
  { key: 'baseline', label: 'Personal baseline', format: (e) => formatFixed(e.baseline, 3) },
  { key: 'ratioDelta', label: 'Change from baseline', format: (e) => formatPercent(e.ratioDelta) },
  { key: 'spo2', label: 'SpO₂', format: (e) => (Number.isFinite(e.spo2) ? `${e.spo2}%` : 'not reported'), primary: true },
  { key: 'bpm', label: 'Heart rate', format: (e) => (Number.isFinite(e.bpm) ? `${e.bpm} bpm` : 'not reported'), primary: true },
  { key: 'perfusionIndex', label: 'Perfusion index', format: (e) => (Number.isFinite(e.perfusionIndex) ? `${e.perfusionIndex}%` : 'not reported'), primary: true },
  { key: 'amplitudeDelta', label: 'Amplitude change', format: (e) => formatPercent(e.amplitudeDelta) },
  { key: 'dominantFrequencyHz', label: 'Dominant frequency', format: (e) => (Number.isFinite(e.dominantFrequencyHz) ? `${e.dominantFrequencyHz} Hz` : 'not reported') }
];

export function createAlertCenter({ dialog, onAcknowledge, onReposition }) {
  const body = dialog.querySelector('.alert-scroll');
  const evidence = dialog.querySelector('[data-alert-evidence]');
  const evidenceTable = dialog.querySelector('[data-alert-table]');
  const headline = dialog.querySelector('[data-alert-headline]');
  const summary = dialog.querySelector('[data-alert-summary]');
  const countdown = dialog.querySelector('[data-alert-countdown]');
  const ring = dialog.querySelector('[data-alert-ring]');
  const live = dialog.querySelector('[data-alert-live]');
  const reasons = dialog.querySelector('[data-alert-reasons]');
  const acknowledgeButton = dialog.querySelector('[data-alert-ack]');
  const repositionButton = dialog.querySelector('[data-alert-reposition]');

  let current = null;
  let onClose = null;

  const circumference = 2 * Math.PI * 52;
  ring.style.setProperty('--ring-circumference', String(circumference));

  acknowledgeButton.addEventListener('click', () => onAcknowledge?.());
  repositionButton.addEventListener('click', () => onReposition?.());

  // Rotating the phone changes whether the evidence list overflows.
  if ('ResizeObserver' in window) {
    new ResizeObserver(syncScrollAffordance).observe(dialog);
  } else {
    window.addEventListener('resize', syncScrollAffordance);
  }

  dialog.addEventListener('cancel', (event) => {
    // A pending acknowledgement must be resolved deliberately, not by Escape.
    if (current) event.preventDefault();
  });

  dialog.addEventListener('close', () => {
    current = null;
    dialog.dataset.state = 'idle';
    onClose?.();
    onClose = null;
  });

  function renderEvidence(payload) {
    const rows = [];
    for (const field of EVIDENCE_FIELDS) {
      const value = field.format(payload || {});
      if (value === 'not reported' || value === '—') continue;
      const row = el('div', 'evidence-row');
      if (field.primary) row.classList.add('is-primary');
      row.append(el('span', 'evidence-key', field.label));
      const strong = el('strong', 'evidence-value', value);
      if (field.key === 'ratioDelta' && payload?.isAnomalous) strong.dataset.tone = 'alert';
      if (field.key === 'spo2' && Number.isFinite(payload?.spo2) && payload.spo2 < 94) strong.dataset.tone = 'alert';
      row.append(strong);
      rows.push(row);
    }
    evidenceTable.replaceChildren(...rows);
  }

  /**
   * Fade the foot of the scroll area only while its content actually overflows.
   * Measured rather than assumed: the dialog's height depends on viewport height,
   * so the same alert overflows in landscape and fits in portrait.
   */
  function syncScrollAffordance() {
    const overflowing = body.scrollHeight - body.clientHeight > 4;
    body.classList.toggle('is-scrollable', overflowing);
  }

  function renderReasons(list) {
    if (!list || !list.length) {
      reasons.replaceChildren();
      reasons.hidden = true;
      return;
    }
    const items = list.map((text) => el('li', null, text));
    reasons.replaceChildren(...items);
    reasons.hidden = false;
  }

  return {
    open(alert, { onClosed } = {}) {
      current = alert;
      onClose = onClosed;
      const payload = alert.evidence || {};

      headline.textContent = alert.state === 'ESCALATED' ? 'The acknowledgement window has closed' : 'A flow-pattern change persisted';
      summary.textContent =
        alert.state === 'ESCALATED'
          ? 'VFM recorded a simulated clinic-delivery receipt for this event.'
          : 'VFM verified this change across a second check. Nothing has been sent anywhere.';

      renderReasons(payload.reasons);
      renderEvidence(payload);
      evidence.textContent =
        alert.mode === 'demo'
          ? 'Replay is active, so this change was synthetic.'
          : 'These values came from a connected band.';

      dialog.dataset.state = alert.state === 'ESCALATED' ? 'escalated' : 'pending';
      live.textContent = alert.state === 'ESCALATED' ? 'Alert escalated.' : 'Alert raised. Acknowledgement timer started.';

      if (!dialog.open && dialog.showModal) dialog.showModal();
      syncScrollAffordance();
      // Restart the sonar rings on every open.
      if (!motion.reduced) {
        dialog.classList.remove('is-pinged');
        void dialog.offsetWidth;
        dialog.classList.add('is-pinged');
      }
      this.tick(alert.remaining ?? 0, alert.total ?? 1);
    },

    tick(remaining, total) {
      if (!current) return;
      countdown.textContent = formatCountdown(remaining);
      const ratio = total > 0 ? Math.max(0, Math.min(1, remaining / total)) : 0;
      ring.style.setProperty('--ring-offset', String(circumference * (1 - ratio)));
    },

    setState(state, detail) {
      if (!current) return;
      current.state = state;
      dialog.dataset.state = state;
      if (detail) summary.textContent = detail;
      live.textContent = detail ?? `Alert ${state.toLowerCase()}.`;
    },

    close() {
      if (dialog.open) dialog.close();
      current = null;
    },

    get isOpen() {
      return Boolean(current);
    }
  };
}
