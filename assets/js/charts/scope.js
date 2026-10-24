/**
 * Oscilloscope trace.
 *
 * Drawn as a phosphor instrument rather than a line chart: the trace brightens
 * toward the head and carries a short high-glow ghost of the most recent samples,
 * anomaly points are marked, and the personal tolerance band is shaded between the
 * learned baseline and the alert threshold.
 *
 * A `ResizeObserver` drives redraws. The previous implementation only listened to
 * `window.resize`, which left the canvas blank whenever layout changed for any
 * other reason (view switch, theme change, a scrollbar appearing).
 */

const AXIS_FONT = '10px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';
const PADDING = { top: 18, right: 14, bottom: 24, left: 42 };
const MAX_SAMPLES = 72;
const GHOST_SAMPLES = 14;

function token(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(`--${name}`).trim();
}

export function createScope({ canvas, tooltip, onHover } = {}) {
  const context = canvas.getContext('2d');
  let readings = [];
  let baseline = null;
  let hovered = null;
  let pinned = null;
  let box = { width: 0, height: 0 };

  const ratioCap = () => Math.min(window.devicePixelRatio || 1, 2.5);

  function measure() {
    const rect = canvas.getBoundingClientRect();
    box = { width: rect.width, height: rect.height };
    const scale = ratioCap();
    canvas.width = Math.max(1, Math.floor(rect.width * scale));
    canvas.height = Math.max(1, Math.floor(rect.height * scale));
    context.setTransform(scale, 0, 0, scale, 0, 0);
  }

  function plotArea() {
    return {
      left: PADDING.left,
      top: PADDING.top,
      width: Math.max(1, box.width - PADDING.left - PADDING.right),
      height: Math.max(1, box.height - PADDING.top - PADDING.bottom)
    };
  }

  function scales() {
    const area = plotArea();
    const values = readings.map((r) => r.ratio);
    if (baseline) {
      values.push(baseline.ratio);
      if (Number.isFinite(baseline.thresholdRatio)) values.push(baseline.thresholdRatio);
    }
    if (!values.length) return null;
    let min = Math.min(...values);
    let max = Math.max(...values);
    const span = Math.max(max - min, max * 0.06, 0.04);
    min -= span * 0.25;
    max += span * 0.25;
    const toY = (value) => area.top + (1 - (value - min) / (max - min)) * area.height;
    const toX = (index) =>
      readings.length <= 1 ? area.left + area.width / 2 : area.left + (index / (readings.length - 1)) * area.width;
    return { area, min, max, toX, toY };
  }

  function drawEmpty() {
    context.clearRect(0, 0, box.width, box.height);
    context.fillStyle = token('muted');
    context.font = AXIS_FONT;
    context.textAlign = 'center';
    context.textBaseline = 'middle';
    context.fillText('Awaiting readings', box.width / 2, box.height / 2);
  }

  function drawGrid(frame) {
    const { area, min, max, toY } = frame;
    context.strokeStyle = token('grid');
    context.lineWidth = 1;
    context.fillStyle = token('muted');
    context.font = AXIS_FONT;
    context.textAlign = 'right';
    context.textBaseline = 'middle';

    for (let step = 0; step <= 4; step += 1) {
      const value = min + ((max - min) * step) / 4;
      const y = Math.round(toY(value)) + 0.5;
      context.beginPath();
      context.moveTo(area.left, y);
      context.lineTo(area.left + area.width, y);
      context.stroke();
      context.fillText(value.toFixed(2), area.left - 7, y);
    }
  }

  function drawBaseline(frame) {
    if (!baseline || !Number.isFinite(baseline.ratio)) return;
    const { area, toY } = frame;

    if (Number.isFinite(baseline.thresholdRatio)) {
      const top = toY(baseline.thresholdRatio);
      const bottom = toY(baseline.ratio);
      context.fillStyle = token('phosphor');
      context.fillRect(area.left, Math.min(top, bottom), area.width, Math.abs(bottom - top));
    }

    context.setLineDash([2, 4]);
    context.lineWidth = 1;
    context.strokeStyle = token('info');
    context.globalAlpha = 0.7;
    const baselineY = Math.round(toY(baseline.ratio)) + 0.5;
    context.beginPath();
    context.moveTo(area.left, baselineY);
    context.lineTo(area.left + area.width, baselineY);
    context.stroke();

    if (Number.isFinite(baseline.thresholdRatio)) {
      context.strokeStyle = token('alert');
      context.globalAlpha = 0.85;
      const thresholdY = Math.round(toY(baseline.thresholdRatio)) + 0.5;
      context.beginPath();
      context.moveTo(area.left, thresholdY);
      context.lineTo(area.left + area.width, thresholdY);
      context.stroke();
    }
    context.globalAlpha = 1;
    context.setLineDash([]);
  }

  function drawTrace(frame) {
    const { area, toX, toY } = frame;
    const accent = token('accent');
    const total = readings.length;

    // Alpha ramp from dim tail to bright head.
    for (let i = 1; i < total; i += 1) {
      const ramp = total === 1 ? 1 : i / (total - 1);
      context.globalAlpha = 0.22 + ramp * 0.78;
      context.strokeStyle = accent;
      context.lineWidth = 1.4 + ramp * 1.1;
      context.lineCap = 'round';
      context.beginPath();
      context.moveTo(toX(i - 1), toY(readings[i - 1].ratio));
      context.lineTo(toX(i), toY(readings[i].ratio));
      context.stroke();
    }
    context.globalAlpha = 1;

    // Phosphor ghost over the most recent samples.
    const ghostStart = Math.max(0, total - GHOST_SAMPLES);
    if (total - ghostStart > 1) {
      context.save();
      context.globalCompositeOperation = 'lighter';
      context.strokeStyle = accent;
      context.shadowColor = accent;
      context.shadowBlur = 12;
      context.globalAlpha = 0.22;
      context.lineWidth = 1.6;
      context.beginPath();
      context.moveTo(toX(ghostStart), toY(readings[ghostStart].ratio));
      for (let i = ghostStart + 1; i < total; i += 1) context.lineTo(toX(i), toY(readings[i].ratio));
      context.stroke();
      context.restore();
    }

    // Anomaly markers sit above the trace so they never sit under the line.
    context.fillStyle = token('alert');
    for (let i = 0; i < total; i += 1) {
      if (!readings[i].anomalous) continue;
      const x = toX(i);
      const y = toY(readings[i].ratio);
      context.beginPath();
      context.moveTo(x, y - 7);
      context.lineTo(x - 4, y - 13);
      context.lineTo(x + 4, y - 13);
      context.closePath();
      context.fill();
    }

    // Head marker with glow.
    const head = readings[total - 1];
    if (head) {
      const x = toX(total - 1);
      const y = toY(head.ratio);
      context.save();
      context.globalCompositeOperation = 'lighter';
      context.fillStyle = head.anomalous ? token('alert') : accent;
      context.shadowColor = head.anomalous ? token('alert') : accent;
      context.shadowBlur = 14;
      context.beginPath();
      context.arc(x, y, 3.4, 0, Math.PI * 2);
      context.fill();
      context.restore();
    }
  }

  function drawAxes(frame) {
    const { area } = frame;
    context.fillStyle = token('muted');
    context.font = AXIS_FONT;
    context.textBaseline = 'top';
    context.textAlign = 'left';
    const first = readings[0];
    const last = readings[readings.length - 1];
    if (first) {
      const label = new Date(first.timestamp).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
      context.fillText(label, area.left, area.top + area.height + 8);
    }
    if (last) {
      const label = new Date(last.timestamp).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit', second: '2-digit' });
      context.textAlign = 'right';
      context.fillText(label, area.left + area.width, area.top + area.height + 8);
    }
  }

  function drawCrosshair(frame) {
    const index = pinned ?? hovered;
    if (index == null || !readings[index]) return;
    const { area, toX, toY } = frame;
    const reading = readings[index];
    const x = Math.round(toX(index)) + 0.5;
    const y = toY(reading.ratio);

    context.save();
    context.strokeStyle = token('line-strong');
    context.setLineDash([2, 3]);
    context.lineWidth = 1;
    context.beginPath();
    context.moveTo(x, area.top);
    context.lineTo(x, area.top + area.height);
    context.stroke();
    context.setLineDash([]);

    context.fillStyle = reading.anomalous ? token('alert') : token('accent');
    context.beginPath();
    context.arc(x, y, 3.6, 0, Math.PI * 2);
    context.fill();
    context.restore();
  }

  function render() {
    if (!box.width || !box.height) return;
    context.clearRect(0, 0, box.width, box.height);
    if (!readings.length) {
      drawEmpty();
      return;
    }
    const frame = scales();
    drawGrid(frame);
    drawBaseline(frame);
    drawTrace(frame);
    drawAxes(frame);
    drawCrosshair(frame);
    positionTooltip(frame);
  }

  function indexFromPointer(event) {
    if (!readings.length) return null;
    const rect = canvas.getBoundingClientRect();
    const { area, toX } = scales() || {};
    if (!area) return null;
    const ratio = (event.clientX - rect.left - area.left) / area.width;
    const index = Math.round(ratio * (readings.length - 1));
    return Math.min(readings.length - 1, Math.max(0, index));
  }

  function positionTooltip(frame) {
    if (!tooltip) return;
    const index = pinned ?? hovered;
    if (index == null || !readings[index] || !tooltip) {
      tooltip.dataset.visible = 'false';
      return;
    }
    const reading = readings[index];
    const x = frame.toX(index);
    const flip = x > frame.area.left + frame.area.width * 0.62;
    tooltip.replaceChildren();
    tooltip.dataset.visible = 'true';

    const time = el('span', 'scope-tip-time', new Date(reading.timestamp).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit', second: '2-digit' }));
    const value = el('span', 'scope-tip-value');
    value.append(el('b', null, Number(reading.ratio).toFixed(3)));
    value.append(el('i', null, 'ratio'));

    const vitals = el('div', 'scope-tip-vitals');
    for (const [label, text] of [
      ['SpO₂', reading.spo2 == null ? '—' : `${reading.spo2}%`],
      ['HR', reading.bpm == null ? '—' : `${reading.bpm}`],
      ['Δ', reading.deltaPercent == null ? '—' : `${reading.deltaPercent > 0 ? '+' : ''}${reading.deltaPercent.toFixed(1)}%`]
    ]) {
      const pair = el('span', 'scope-tip-pair');
      pair.append(el('i', null, label), el('b', null, text));
      vitals.append(pair);
    }

    tooltip.append(time, value, vitals);
    if (reading.anomalous && reading.reason) {
      tooltip.append(el('p', 'scope-tip-reason', reading.reason));
    }

    tooltip.style.setProperty('--tip-x', `${x}px`);
    tooltip.style.setProperty('--tip-shift', flip ? '-100%' : '0%');
    tooltip.style.setProperty('--tip-pad', flip ? '-10px' : '10px');
  }

  function handleMove(event) {
    if (!readings.length) return;
    const index = indexFromPointer(event);
    if (index !== hovered) {
      hovered = index;
      render();
    }
    onHover?.(readings[index] ?? null);
  }

  function handleLeave() {
    if (hovered == null) return;
    hovered = null;
    render();
    onHover?.(null);
  }

  function handleClick(event) {
    if (!readings.length) return;
    const index = indexFromPointer(event);
    pinned = pinned === index ? null : index;
    render();
  }

  /* On a touch device the finger goes away on lift, but the pointer does not
     generate a matching leave event, so the tooltip would stay pinned to
     whatever was last touched until the next tap elsewhere. */
  function handleUp(event) {
    if (event.pointerType === 'mouse') return;
    if (hovered == null) return;
    hovered = null;
    render();
    onHover?.(null);
  }

  canvas.addEventListener('pointermove', handleMove);
  canvas.addEventListener('pointerdown', handleClick);
  canvas.addEventListener('pointerleave', handleLeave);
  canvas.addEventListener('pointerup', handleUp);
  canvas.addEventListener('pointercancel', handleUp);

  const observer = new ResizeObserver(() => {
    measure();
    render();
  });
  observer.observe(canvas);

  // Re-render when the palette changes; colours are read from the token set.
  const paletteObserver = new MutationObserver(() => render());
  paletteObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });

  return {
    setData(nextReadings, nextBaseline) {
      readings = nextReadings.slice(-MAX_SAMPLES);
      baseline = nextBaseline;
      if (pinned != null && pinned >= readings.length) pinned = null;
      if (hovered != null && hovered >= readings.length) hovered = null;
      measure();
      render();
    },
    /** Lock the crosshair to a specific reading, e.g. when a table row is hovered. */
    focus(reading) {
      if (!reading) return this.blur();
      const index = readings.findIndex((r) => r.timestamp === reading.timestamp);
      if (index < 0) return;
      pinned = index;
      hovered = null;
      render();
    },
    blur() {
      if (pinned == null && hovered == null) return;
      pinned = null;
      hovered = null;
      render();
    },
    refresh: render,
    destroy() {
      observer.disconnect();
      paletteObserver.disconnect();
    }
  };
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}
