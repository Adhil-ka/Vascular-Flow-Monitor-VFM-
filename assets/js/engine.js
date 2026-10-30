/**
 * Baseline learning and change classification.
 *
 * The central idea: VFM has no universal threshold. It learns one person's normal
 * acoustic and optical signature, then asks only whether the current reading differs
 * from *that* baseline by more than the person's own observed variability.
 *
 * Dispersion is estimated with a median absolute deviation (MAD) scaled by 1.4826,
 * which is consistent with a standard deviation for normally distributed data and is
 * far less dragged around by a single bad sample than a mean/variance estimate.
 */

export const ALGORITHM = 'median-mad-v2';

export const TIMING = {
  live: { calibrationSamples: 60, recheckMs: 60_000, recheckValidSamples: 60, recheckAnomalies: 45, alertMs: 300_000 },
  demo: { calibrationSamples: 10, recheckMs: 10_000, recheckValidSamples: 10, recheckAnomalies: 8, alertMs: 15_000 }
};

export const BASELINE_FLOOR = 0.21;
/** Smallest personal tolerance, so an unnaturally quiet window cannot create a zero-width band. */
export const MIN_TOLERANCE = 0.021;

export const OPTICAL = {
  spo2: { warn: 94, alert: 90 },
  // Peak-to-peak perfusion index as reported by real pulse oximeters. At rest a
  // well-seated sensor reads roughly 2-10 %; below 1 % the optical signal is too
  // weak to trust, and 1-3 % is marginal. The demo generator uses the same scale.
  perfusionIndex: { poorBelow: 1, fairBelow: 3 }
};

function median(values) {
  const list = [...values].sort((a, b) => a - b);
  if (!list.length) return 0;
  const mid = Math.floor(list.length / 2);
  return list.length % 2 ? list[mid] : (list[mid - 1] + list[mid]) / 2;
}

export function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

export function percentDelta(value, reference) {
  if (!Number.isFinite(value) || !Number.isFinite(reference) || reference === 0) return null;
  return ((value - reference) / reference) * 100;
}

/**
 * Build a personal baseline from quality-checked calibration samples.
 * Optical baselines are optional: a v1 band still yields a valid acoustic baseline.
 */
export function buildBaseline(samples) {
  const ratios = samples.map((s) => s.ratio);
  const amplitudes = samples.map((s) => s.amplitude);
  const ratio = median(ratios);
  const amplitude = median(amplitudes);
  const mad = median(ratios.map((v) => Math.abs(v - ratio)));
  const sigma = 1.4826 * mad;
  const thresholdRatio = ratio * (1 + Math.max(MIN_TOLERANCE, (3 * sigma) / Math.max(ratio, 1e-6)));

  const spo2Samples = samples.map((s) => s.spo2).filter(Number.isFinite);
  const bpmSamples = samples.map((s) => s.bpm).filter(Number.isFinite);
  const piSamples = samples.map((s) => s.perfusionIndex).filter(Number.isFinite);

  return {
    id: 'current',
    algorithm: ALGORITHM,
    ratio,
    amplitude,
    mad,
    sigma,
    thresholdRatio,
    amplitudeThreshold: amplitude * 0.7,
    spo2: spo2Samples.length >= 3 ? median(spo2Samples) : null,
    bpm: bpmSamples.length >= 3 ? median(bpmSamples) : null,
    perfusionIndex: piSamples.length >= 3 ? median(piSamples) : null,
    opticalSampleCount: spo2Samples.length,
    sampleCount: samples.length,
    createdAt: Date.now()
  };
}

/**
 * Compare one reading against the baseline.
 *
 * Flow evidence (acoustic ratio, amplitude) and optical evidence (saturation,
 * perfusion, pulse rate) are evaluated independently and then combined, so a
 * saturation drop with an unchanged acoustic ratio still produces evidence rather
 * than being silently discarded.
 */
export function classify(packet, ratio, baseline) {
  const ratioDelta = percentDelta(ratio, baseline.ratio);
  const amplitudeDelta = percentDelta(packet.amplitude, baseline.amplitude);

  const highRatio = ratio >= baseline.thresholdRatio;
  const lowAmplitude = packet.amplitude <= baseline.amplitudeThreshold;

  const reasons = [];
  if (highRatio && lowAmplitude) reasons.push('Flow ratio rose while signal amplitude fell');
  else if (highRatio) reasons.push('Flow ratio is above your personal threshold');
  else if (lowAmplitude) reasons.push('Signal amplitude is lower than your baseline');

  let spo2Delta = null;
  let lowSpo2 = false;
  if (Number.isFinite(packet.spo2)) {
    spo2Delta = baseline.spo2 == null ? null : percentDelta(packet.spo2, baseline.spo2);
    lowSpo2 = packet.spo2 < OPTICAL.spo2.warn || (spo2Delta != null && spo2Delta <= -3);
    if (lowSpo2) {
      const absolute = packet.spo2 < OPTICAL.spo2.alert ? 'critical' : 'below normal';
      reasons.push(`SpO2 ${packet.spo2}% is ${absolute}${spo2Delta != null ? ` (${spo2Delta.toFixed(1)}% vs baseline)` : ''}`);
    }
  }

  let lowPerfusion = false;
  if (Number.isFinite(packet.perfusionIndex)) {
    // Perfusion is judged against the person's own optical baseline when one
    // exists, with an absolute floor for a signal too weak to trust at all.
    // A fixed threshold alone would flag anyone whose normal PI is modest.
    const piDelta = baseline.perfusionIndex == null ? null : percentDelta(packet.perfusionIndex, baseline.perfusionIndex);
    lowPerfusion = piDelta == null
      ? packet.perfusionIndex < OPTICAL.perfusionIndex.fairBelow
      : piDelta <= -40 || packet.perfusionIndex < OPTICAL.perfusionIndex.poorBelow;
    if (lowPerfusion) reasons.push(`Perfusion index ${packet.perfusionIndex}% is weak`);
  }

  let bpmDelta = null;
  let tachycardic = false;
  if (Number.isFinite(packet.bpm)) {
    bpmDelta = baseline.bpm == null ? null : percentDelta(packet.bpm, baseline.bpm);
    tachycardic = baseline.bpm != null && packet.bpm > baseline.bpm * 1.25;
  }

  return {
    isAnomalous: highRatio || lowAmplitude || lowSpo2 || lowPerfusion,
    highRatio,
    lowAmplitude,
    lowSpo2,
    lowPerfusion,
    tachycardic,
    ratioDelta,
    amplitudeDelta,
    spo2Delta,
    bpmDelta,
    ratio,
    baseline: baseline.ratio,
    dominantFrequencyHz: packet.dominantFrequencyHz,
    spo2: packet.spo2,
    bpm: packet.bpm,
    perfusionIndex: packet.perfusionIndex,
    reason: reasons[0] || 'Within your personal range',
    reasons
  };
}

/** A flat, sortable projection of a reading. This is what the table and export use. */
export function toReading(packet, source, evidence, baseline) {
  return {
    timestamp: packet.timestamp,
    sequence: packet.sequence,
    ratio: evidence?.ratio ?? packet.highBandPower / Math.max(packet.lowBandPower, 1e-6),
    lowBandPower: packet.lowBandPower,
    highBandPower: packet.highBandPower,
    baselineRatio: baseline?.ratio ?? null,
    deltaPercent: evidence?.ratioDelta ?? null,
    amplitude: packet.amplitude,
    quality: packet.quality,
    dominantFrequencyHz: packet.dominantFrequencyHz,
    spo2: packet.spo2 ?? null,
    bpm: packet.bpm ?? null,
    perfusionIndex: packet.perfusionIndex ?? null,
    ppgValid: packet.ppgValid,
    contact: packet.contact,
    faulty: packet.faulty,
    protocol: packet.version,
    source,
    anomalous: Boolean(evidence?.isAnomalous),
    reason: evidence?.reason ?? null,
    reasons: evidence?.reasons ?? []
  };
}

/**
 * Normalise a reading restored from local storage so that rows written by an older
 * build (which had no optical fields) still render instead of showing as corrupt.
 */
export function normaliseStoredReading(record) {
  if (!record || typeof record !== 'object') return null;
  const ratio = Number.isFinite(record.ratio)
    ? record.ratio
    : Number.isFinite(record.packet?.highBandPower) && record.packet.lowBandPower > 0
      ? record.packet.highBandPower / record.packet.lowBandPower
      : null;
  if (ratio == null) return null;
  const packet = record.packet || {};
  return {
    ...record,
    ratio,
    amplitude: record.amplitude ?? packet.amplitude ?? null,
    quality: record.quality ?? packet.quality ?? null,
    dominantFrequencyHz: record.dominantFrequencyHz ?? packet.dominantFrequencyHz ?? null,
    spo2: record.spo2 ?? null,
    bpm: record.bpm ?? null,
    perfusionIndex: record.perfusionIndex ?? null,
    deltaPercent: record.deltaPercent ?? null,
    anomalous: Boolean(record.anomalous),
    reasons: Array.isArray(record.reasons) ? record.reasons : record.reason ? [record.reason] : [],
    reason: record.reason ?? null,
    source: record.source || 'live',
    protocol: record.protocol ?? 1
  };
}
