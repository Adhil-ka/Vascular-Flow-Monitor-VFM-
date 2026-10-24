/**
 * Dual-theme controller.
 *
 * Two complete palettes live here as token sets. Components never name a colour
 * directly, so the light theme is a token swap rather than a second stylesheet.
 * Dark is the default because the instrument aesthetic is the primary experience;
 * `prefers-color-scheme` is honoured only on a first visit.
 */

const STORAGE_KEY = 'vfm.theme';

const PALETTES = {
  dark: {
    'canvas': '#0a0b0e',
    'canvas-deep': '#06070a',
    'surface': '#111318',
    'surface-2': '#181c25',
    'surface-3': '#1f242f',
    'surface-inset': '#0c0e13',
    'line': '#232a36',
    'line-strong': '#313a49',
    'ink': '#eceef2',
    'ink-2': '#b6bfcb',
    'muted': '#7b8494',
    'accent': '#ffb340',
    'accent-ink': '#140d02',
    'accent-soft': 'rgba(255,179,64,0.13)',
    'accent-line': 'rgba(255,179,64,0.38)',
    'info': '#7d9cff',
    'info-soft': 'rgba(125,156,255,0.13)',
    'nominal': '#5ee6a8',
    'nominal-soft': 'rgba(94,230,168,0.12)',
    'watch': '#ffc247',
    'watch-soft': 'rgba(255,194,71,0.13)',
    'alert': '#ff5c72',
    'alert-soft': 'rgba(255,92,114,0.13)',
    'shadow-sm': '0 1px 2px rgba(0,0,0,0.5)',
    'shadow-md': '0 10px 28px rgba(0,0,0,0.42)',
    'shadow-lg': '0 28px 70px rgba(0,0,0,0.6)',
    'grid': 'rgba(255,255,255,0.05)',
    'grid-strong': 'rgba(255,255,255,0.1)',
    'scrim': 'rgba(4,5,8,0.74)',
    'phosphor': 'rgba(255,179,64,0.05)'
  },
  light: {
    'canvas': '#f7f7f5',
    'canvas-deep': '#eeefec',
    'surface': '#ffffff',
    'surface-2': '#fafaf8',
    'surface-3': '#f1f2ef',
    'surface-inset': '#f4f5f2',
    'line': '#dedfda',
    'line-strong': '#c3c6bd',
    'ink': '#14161a',
    'ink-2': '#3c4149',
    'muted': '#5f6673',
    'accent': '#a86400',
    'accent-ink': '#ffffff',
    'accent-soft': 'rgba(168,100,0,0.10)',
    'accent-line': 'rgba(168,100,0,0.34)',
    'info': '#2f4fb8',
    'info-soft': 'rgba(47,79,184,0.10)',
    'nominal': '#0f7048',
    'nominal-soft': 'rgba(15,112,72,0.11)',
    'watch': '#8a5a00',
    'watch-soft': 'rgba(138,90,0,0.12)',
    'alert': '#c02b45',
    'alert-soft': 'rgba(192,43,69,0.10)',
    'shadow-sm': '0 1px 2px rgba(20,22,26,0.07)',
    'shadow-md': '0 10px 26px rgba(20,22,26,0.10)',
    'shadow-lg': '0 28px 64px rgba(20,22,26,0.20)',
    'grid': 'rgba(20,22,26,0.06)',
    'grid-strong': 'rgba(20,22,26,0.12)',
    'scrim': 'rgba(24,26,30,0.46)',
    'phosphor': 'rgba(168,100,0,0.04)'
  }
};

function prefersDark() {
  return !window.matchMedia || window.matchMedia('(prefers-color-scheme: dark)').matches;
}

function readStored() {
  try {
    const value = localStorage.getItem(STORAGE_KEY);
    return value === 'dark' || value === 'light' ? value : null;
  } catch {
    return null;
  }
}

export function createTheme({ onChange } = {}) {
  let current = readStored() || (prefersDark() ? 'dark' : 'light');
  const listeners = new Set();
  if (onChange) listeners.add(onChange);

  function apply(theme) {
    const palette = PALETTES[theme];
    const root = document.documentElement;
    for (const [token, value] of Object.entries(palette)) {
      root.style.setProperty(`--${token}`, value);
    }
    root.dataset.theme = theme;
    current = theme;
    // Keep the browser chrome in step with the app. Without this the OS status
    // bar and any installed-PWA title bar stay dark in light mode.
    const themeColorMeta = document.querySelector('meta[name="theme-color"]');
    if (themeColorMeta) themeColorMeta.setAttribute('content', palette.canvas);
    try { localStorage.setItem(STORAGE_KEY, theme); } catch { /* private mode */ }
    for (const listener of listeners) listener(theme);
  }

  apply(current);

  return {
    get current() { return current; },
    toggle() { apply(current === 'dark' ? 'light' : 'dark'); return current; },
    set(theme) { if (theme !== current) apply(theme); },
    onChange(listener) { listeners.add(listener); return () => listeners.delete(listener); }
  };
}

/**
 * Motion budget. Every hand-built animation in this app checks this. Respecting
 * `prefers-reduced-motion` is not optional here: some users are reading a
 * dialysis-access alert and should not be shown sweeping or pulsing motion.
 */
const motionQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
let reduced = motionQuery.matches;
const motionListeners = new Set();

motionQuery.addEventListener('change', (event) => {
  reduced = event.matches;
  for (const listener of motionListeners) listener(reduced);
});

export const motion = {
  get reduced() { return reduced; },
  onChange(listener) { motionListeners.add(listener); return () => motionListeners.delete(listener); },
  /** Duration helper: returns 0 when motion is reduced, so callers can stay unconditional. */
  duration(ms) { return reduced ? 0 : ms; },
  on(target, type, handler, options) {
    if (reduced && type !== 'click' && type !== 'pointerdown') return () => {};
    target.addEventListener(type, handler, options);
    return () => target.removeEventListener(type, handler, options);
  }
};

/**
 * Motion pref for CSS too. Set as a data attribute so the stylesheet can collapse
 * every transition and animation in one place.
 */
export function syncMotionAttribute() {
  const apply = () => {
    document.documentElement.dataset.motion = reduced ? 'reduced' : 'full';
  };
  apply();
  motion.onChange(apply);
}
