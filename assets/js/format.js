/** Shared formatting. Every measured value renders through here. */

import { OPTICAL } from './engine.js';

const clockFormat = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' });
const clockSecondsFormat = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
const dateTimeFormat = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

export function formatClock(timestamp) {
  return clockFormat.format(new Date(timestamp));
}

export function formatClockSeconds(timestamp) {
  return clockSecondsFormat.format(new Date(timestamp));
}

export function formatDateTime(timestamp) {
  return dateTimeFormat.format(new Date(timestamp));
}

export function formatPercent(value, digits = 1) {
  if (!Number.isFinite(value)) return '—';
  const sign = value > 0 ? '+' : value < 0 ? '−' : '';
  return `${sign}${Math.abs(value).toFixed(digits)}%`;
}

export function formatSigned(value, digits = 1) {
  if (!Number.isFinite(value)) return '—';
  const sign = value > 0 ? '+' : value < 0 ? '−' : '';
  return `${sign}${Math.abs(value).toFixed(digits)}`;
}

export function formatFixed(value, digits = 2) {
  return Number.isFinite(value) ? value.toFixed(digits) : '—';
}

export function formatCountdown(milliseconds) {
  const total = Math.max(0, Math.ceil(milliseconds / 1000));
  return `${Math.floor(total / 60).toString().padStart(2, '0')}:${(total % 60).toString().padStart(2, '0')}`;
}

export function formatDuration(milliseconds) {
  if (!Number.isFinite(milliseconds)) return '—';
  const seconds = Math.round(Math.abs(milliseconds) / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

/** Severity class shared by every surface that renders an event or a reading. */
export function toneClass(tone) {
  return tone === 'good' || tone === 'nominal'
    ? 'is-nominal'
    : tone === 'watch'
      ? 'is-watch'
      : tone === 'alert'
        ? 'is-alert'
        : 'is-neutral';
}

/**
 * Saturation bands. These mirror the convention used on clinical pulse oximetry,
 * and are a display convention only, not a diagnosis.
 */
export function spo2Band(spo2) {
  if (!Number.isFinite(spo2)) return { label: 'No signal', tone: 'neutral' };
  if (spo2 >= 97) return { label: 'Normal', tone: 'nominal' };
  if (spo2 >= 94) return { label: 'Low-normal', tone: 'watch' };
  if (spo2 >= 90) return { label: 'Low', tone: 'alert' };
  return { label: 'Critical', tone: 'alert' };
}

export function perfusionBand(pi) {
  if (!Number.isFinite(pi)) return { label: 'No signal', tone: 'neutral' };
  if (pi >= OPTICAL.perfusionIndex.fairBelow) return { label: 'Strong', tone: 'nominal' };
  if (pi >= OPTICAL.perfusionIndex.poorBelow) return { label: 'Fair', tone: 'watch' };
  return { label: 'Weak', tone: 'alert' };
}

export function qualityBand(quality) {
  if (!Number.isFinite(quality)) return { label: 'Unknown', tone: 'neutral' };
  if (quality >= 85) return { label: 'Excellent', tone: 'nominal' };
  if (quality >= 70) return { label: 'Acceptable', tone: 'nominal' };
  if (quality >= 45) return { label: 'Marginal', tone: 'watch' };
  return { label: 'Poor', tone: 'alert' };
}

export function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}
