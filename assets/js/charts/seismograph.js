/**
 * Event seismograph.
 *
 * A strip-chart of recent system activity on a real time axis. An earlier
 * revision spaced events evenly by index, which made a burst of alerts and an
 * hour of quiet look identical — the gaps, which are the whole point of a
 * timeline, were erased. Events are now placed by timestamp across a rolling
 * window, so a quiet stretch reads as empty track and a burst reads as a cluster.
 *
 * Severity drives stem height and colour; recency drives horizontal position.
 */

const HEIGHT = 76;
const PADDING = 10;
const WEIGHT = { neutral: 0.2, good: 0.38, nominal: 0.38, watch: 0.66, alert: 1 };
/** Candidate window widths, in minutes. */
const WINDOW_STEPS = [1, 2, 5, 10, 20];

/**
 * Pick the narrowest window that still contains every event.
 *
 * A fixed 20-minute window is honest but useless in practice: during a demo or
 * a short session every event lands inside the last minute and the whole strip
 * collapses into a sliver at the right edge. Choosing the smallest fitting step
 * spreads the marks across the full width and keeps the axis labels meaningful.
 */
function chooseWindow(list, now) {
  let oldest = 0;
  for (const event of list) {
    const age = now - event.timestamp;
    if (age >= 0 && age > oldest) oldest = age;
  }
  const step = WINDOW_STEPS.find((minutes) => oldest <= minutes * 60_000 * 0.9) ?? 20;
  return { ms: step * 60_000, minutes: step };
}

function token(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(`--${name}`).trim();
}

export function createSeismograph({ canvas, capacity = 20 } = {}) {
  const context = canvas.getContext('2d');
  let events = [];
  let box = { width: 0, height: HEIGHT };

  function measure() {
    const rect = canvas.getBoundingClientRect();
    box = { width: rect.width, height: rect.height || HEIGHT };
    const scale = Math.min(window.devicePixelRatio || 1, 2.5);
    canvas.width = Math.max(1, Math.floor(rect.width * scale));
    canvas.height = Math.max(1, Math.floor(box.height * scale));
    context.setTransform(scale, 0, 0, scale, 0, 0);
  }

  function render() {
    if (!box.width || !box.height) return;
    context.clearRect(0, 0, box.width, box.height);

    const mono = '10px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';
    const floor = box.height - PADDING - 12;
    const ceiling = PADDING + 4;
    const reach = floor - ceiling;
    const width = box.width;

    // The rail events rise from. Drawn even when nothing is plotted, so an
    // empty strip reads as "no activity yet" rather than a broken chart.
    context.strokeStyle = token('grid');
    context.lineWidth = 1;
    context.beginPath();
    context.moveTo(0, Math.round(floor) + 0.5);
    context.lineTo(width, Math.round(floor) + 0.5);
    context.stroke();

    context.font = mono;
    context.textBaseline = 'top';
    context.fillStyle = token('muted');

    if (!events.length) {
      context.textAlign = 'center';
      context.fillText('No activity recorded', width / 2, ceiling + reach / 2);
      return;
    }

    const now = Date.now();
    const { ms: windowMs, minutes: windowMinutes } = chooseWindow(events, now);
    const start = now - windowMs;

    // Midpoint and "now" gridlines, so the strip is readable without
    // cross-referencing the list underneath.
    const marks = windowMinutes <= 1 ? [0.5, 0] : [windowMinutes, 0];
    context.textAlign = 'left';
    marks.forEach((minutes) => {
      const x = width - (minutes / windowMinutes) * width;
      context.strokeStyle = token('grid');
      context.globalAlpha = minutes === 0 ? 0.9 : 0.5;
      context.beginPath();
      context.moveTo(Math.round(x) + 0.5, ceiling - 4);
      context.lineTo(Math.round(x) + 0.5, floor);
      context.stroke();
      context.globalAlpha = 1;
      const label = minutes === 0 ? 'now' : minutes < 1 ? `${Math.round(minutes * 60)}s` : `${minutes}m`;
      context.fillText(label, Math.min(x + 4, width - 24), floor + 4);
    });

    const visible = events.filter((event) => event.timestamp >= start && event.timestamp <= now + 1000);

    for (const event of visible) {
      const age = Math.max(0, now - event.timestamp);
      const x = width - (age / windowMs) * width;
      if (x < -2 || x > width + 2) continue;

      const weight = WEIGHT[event.tone] ?? WEIGHT.neutral;
      const height = Math.max(4, reach * weight);
      const isAlert = event.tone === 'alert';
      const colour =
        event.tone === 'alert'
          ? token('alert')
          : event.tone === 'watch'
            ? token('watch')
            : event.tone === 'good' || event.tone === 'nominal'
              ? token('nominal')
              : token('muted');

      // Fade with age so recency reads as a channel beyond position alone.
      const freshness = 1 - Math.min(1, age / windowMs);
      context.globalAlpha = 0.3 + freshness * 0.7;

      context.save();
      if (isAlert) {
        context.shadowColor = token('alert');
        context.shadowBlur = 10;
      }
      context.strokeStyle = colour;
      context.lineWidth = 2;
      context.lineCap = 'round';
      context.beginPath();
      context.moveTo(Math.round(x) + 0.5, floor);
      context.lineTo(Math.round(x) + 0.5, floor - height);
      context.stroke();
      context.restore();

      // A cap reads as an event marker rather than a bar chart column.
      context.fillStyle = colour;
      context.beginPath();
      context.arc(x, floor - height, isAlert ? 3.2 : 2.2, 0, Math.PI * 2);
      context.fill();
    }

    context.globalAlpha = 1;

    if (!visible.length) {
      context.textAlign = 'center';
      context.fillStyle = token('muted');
      context.fillText(
        windowMinutes < 1 ? 'Nothing in the last minute' : `Nothing in the last ${windowMinutes} minutes`,
        width / 2,
        ceiling + reach / 2 - 6
      );
    }
  }

  const observer = new ResizeObserver(() => {
    measure();
    render();
  });
  observer.observe(canvas);

  const paletteObserver = new MutationObserver(() => render());
  paletteObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });

  // The strip is on a time axis, so it has to keep moving between events —
  // otherwise marks sit frozen at the position they held when they arrived.
  const ticker = setInterval(render, 30_000);

  return {
    setData(next) {
      events = next || [];
      measure();
      render();
    },
    refresh: render,
    destroy() {
      observer.disconnect();
      paletteObserver.disconnect();
      clearInterval(ticker);
    }
  };
}
