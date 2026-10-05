import { CONSENT_DISCLOSURE, CONSENT_NOTICE_VERSION } from './notice';
import { markUserGestureConsent } from './storage';

export type ConsentPosition = 'bottom-right' | 'bottom-left' | 'top-right' | 'top-left';

export interface ConsentConfig {
  brandName: string;
  position: ConsentPosition;
  accentColor?: string;
  /** Optional copy overrides; sanitized like every other config string. */
  acceptLabel?: string;
  rejectLabel?: string;
  /** Optional link to the host's privacy policy (http/https only). */
  privacyPolicyUrl?: string;
  /**
   * Host-facing minimum-visible duration. Hosts may only *raise* it: values
   * below {@link MIN_VISIBLE_MS_FLOOR} are clamped so the notice cannot be
   * clicked through by configuration. Tests use `ConsentUIOptions` instead.
   */
  minVisibleMs?: number;
}

export interface ConsentUIOptions {
  /**
   * Minimum time (ms) the banner must stay visible before the accept button
   * becomes actionable. Guards against click-through flicker; defaults to
   * {@link DEFAULT_MIN_VISIBLE_MS}. Tests may inject a smaller value together
   * with `now`/`schedule`, but production defaults never disable the gate.
   */
  minVisibleMs?: number;
  /** Clock used by the minimum-visible gate. Defaults to `Date.now`. */
  now?: () => number;
  /** Scheduler used to re-enable the accept button. Defaults to `setTimeout`. */
  schedule?: (callback: () => void, delayMs: number) => void;
}

/** Sanitized, whitelisted copy of the host configuration. */
interface SanitizedConsentConfig {
  brandName: string;
  position: ConsentPosition;
  accentColor: string;
  acceptLabel: string;
  rejectLabel: string;
  privacyPolicyUrl: string | null;
  minVisibleMs: number;
}

const DEFAULT_ACCENT_COLOR = '#6366f1';
const DEFAULT_MIN_VISIBLE_MS = 1500;
/** Host configuration cannot go below this; only tests may inject less. */
const MIN_VISIBLE_MS_FLOOR = 1500;
const MAX_VISIBLE_MS = 60_000;
const MAX_BRAND_LENGTH = 80;
const MAX_LABEL_LENGTH = 40;

const POSITIONS: readonly ConsentPosition[] = [
  'bottom-right',
  'bottom-left',
  'top-right',
  'top-left',
];

const HEX_SHORT = /^#[0-9a-f]{3}$/i;
const HEX_LONG = /^#[0-9a-f]{6}$/i;
const RGB_FUNCTION = /^rgb\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*\)$/i;
const RGBA_FUNCTION =
  /^rgba\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(0|1|0?\.\d+)\s*\)$/i;

/** Conservative named-color allowlist, mapped to the canonical spelling. */
const NAMED_COLORS: ReadonlyMap<string, string> = new Map(
  [
    'black',
    'white',
    'red',
    'green',
    'blue',
    'indigo',
    'violet',
    'purple',
    'teal',
    'cyan',
    'orange',
    'pink',
    'brown',
    'gray',
    'grey',
    'slate',
    'navy',
    'maroon',
    'olive',
    'gold',
    'crimson',
    'tomato',
    'salmon',
    'coral',
    'seagreen',
    'steelblue',
    'royalblue',
    'dodgerblue',
    'mediumseagreen',
    'mediumpurple',
    'rebeccapurple',
  ].map((name) => [name, name]),
);

/**
 * Never interpolate host input into markup or CSS text. `accentColor` is
 * parsed against a strict allowlist and re-emitted in a canonical form, so the
 * string that reaches the stylesheet cannot contain `;`, `{`, `}` or quotes.
 */
export function sanitizeAccentColor(input: unknown): string {
  if (typeof input !== 'string') return DEFAULT_ACCENT_COLOR;
  const value = input.trim();
  if (value.length === 0 || value.length > 64) return DEFAULT_ACCENT_COLOR;

  if (HEX_SHORT.test(value) || HEX_LONG.test(value)) return value.toLowerCase();

  const rgb = RGB_FUNCTION.exec(value);
  if (rgb) {
    const [r, g, b] = rgb.slice(1).map(Number);
    if (r <= 255 && g <= 255 && b <= 255) return `rgb(${r}, ${g}, ${b})`;
    return DEFAULT_ACCENT_COLOR;
  }

  const rgba = RGBA_FUNCTION.exec(value);
  if (rgba) {
    const [r, g, b] = rgba.slice(1, 4).map(Number);
    const alpha = Number(rgba[4]);
    if (r <= 255 && g <= 255 && b <= 255 && alpha >= 0 && alpha <= 1) {
      return `rgba(${r}, ${g}, ${b}, ${alpha})`;
    }
    return DEFAULT_ACCENT_COLOR;
  }

  const named = NAMED_COLORS.get(value.toLowerCase());
  return named ?? DEFAULT_ACCENT_COLOR;
}

/** Strip control/bidi characters, collapse whitespace and bound the length. */
function sanitizeText(input: unknown, fallback: string, maxLength: number): string {
  if (typeof input !== 'string') return fallback;
  const cleaned = input
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (cleaned.length === 0) return fallback;
  return cleaned.length > maxLength ? `${cleaned.slice(0, maxLength)}…` : cleaned;
}

/** Only absolute http(s) URLs are accepted; anything else disables the link. */
function sanitizeUrl(input: unknown): string | null {
  if (typeof input !== 'string' || input.trim().length === 0) return null;
  try {
    const url = new URL(input.trim());
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    return url.toString();
  } catch {
    return null;
  }
}

function sanitizeConfig(config: ConsentConfig): SanitizedConsentConfig {
  const brandName = sanitizeText(config?.brandName, 'Flaxia Crowd', MAX_BRAND_LENGTH);
  const position = POSITIONS.includes(config?.position) ? config.position : 'bottom-right';
  return {
    brandName,
    position,
    accentColor: sanitizeAccentColor(config?.accentColor),
    acceptLabel: sanitizeText(
      config?.acceptLabel,
      CONSENT_DISCLOSURE.acceptLabel,
      MAX_LABEL_LENGTH,
    ),
    rejectLabel: sanitizeText(
      config?.rejectLabel,
      CONSENT_DISCLOSURE.rejectLabel,
      MAX_LABEL_LENGTH,
    ),
    privacyPolicyUrl: sanitizeUrl(config?.privacyPolicyUrl),
    minVisibleMs: clampHostMinVisibleMs(config?.minVisibleMs),
  };
}

/** Host values may only raise the minimum-visible duration. */
function clampHostMinVisibleMs(requested: unknown): number {
  if (typeof requested !== 'number' || !Number.isFinite(requested)) return DEFAULT_MIN_VISIBLE_MS;
  return Math.min(Math.max(Math.floor(requested), MIN_VISIBLE_MS_FLOOR), MAX_VISIBLE_MS);
}

/**
 * `options.minVisibleMs` is the explicit override used by tests and direct
 * construction; the host-facing `config.minVisibleMs` is clamped so production
 * defaults can never be configured away.
 */
function resolveMinVisibleMs(
  fromConfig: number,
  options: ConsentUIOptions,
): number {
  if (typeof options.minVisibleMs === 'number' && Number.isFinite(options.minVisibleMs)) {
    return Math.min(Math.max(Math.floor(options.minVisibleMs), 0), MAX_VISIBLE_MS);
  }
  return fromConfig;
}

/**
 * Static stylesheet. `__flaxia_accent__` is replaced with the *sanitized*
 * accent color only — host input never reaches this string verbatim.
 */
const STYLE_TEMPLATE = `
  .overlay {
    position: fixed;
    __flaxia_position__;
    padding: 20px;
    background: #fff;
    color: #1f2937;
    border: 1px solid #ccc;
    box-shadow: 0 4px 6px rgba(0,0,0,0.1);
    z-index: 9999;
    border-radius: 8px;
    max-width: 300px;
    font-family: sans-serif;
  }
  .overlay h3 {
    margin: 0 0 8px;
    color: #111827;
    font-size: 16px;
  }
  .overlay p {
    margin: 0 0 12px;
    color: #4b5563;
    font-size: 14px;
    line-height: 1.4;
  }
  .overlay ul {
    margin: 0 0 12px;
    padding-left: 18px;
    color: #4b5563;
    font-size: 13px;
    line-height: 1.45;
  }
  .overlay li {
    margin-bottom: 6px;
  }
  .overlay .hint {
    margin: 0 0 8px;
    color: #6b7280;
    font-size: 12px;
  }
  .overlay .privacy {
    margin: 0 0 8px;
    font-size: 12px;
  }
  .overlay .privacy a {
    color: __flaxia_accent__;
  }
  button {
    background: __flaxia_accent__;
    color: white;
    border: none;
    padding: 10px 15px;
    border-radius: 4px;
    cursor: pointer;
    margin-top: 10px;
    width: 100%;
    font-size: 14px;
  }
  button:disabled {
    opacity: 0.6;
    cursor: default;
  }
  button.reject {
    background: transparent;
    color: #4b5563;
    border: 1px solid #ccc;
  }
  @media (prefers-color-scheme: dark) {
    .overlay {
      background: #1f2937;
      color: #f9fafb;
      border-color: #374151;
      box-shadow: 0 4px 6px rgba(0,0,0,0.4);
    }
    .overlay h3 {
      color: #f9fafb;
    }
    .overlay p,
    .overlay ul {
      color: #d1d5db;
    }
    .overlay .hint {
      color: #9ca3af;
    }
    button.reject {
      color: #d1d5db;
      border-color: #4b5563;
    }
  }
`;

export class ConsentUI {
  private readonly root: ShadowRoot;
  /** Sanitized copy of the host configuration, kept for the banner's lifetime. */
  private readonly config: SanitizedConsentConfig;
  private readonly options: ConsentUIOptions;

  constructor(
    container: HTMLElement,
    config: ConsentConfig,
    onConsent: () => void,
    onReject?: () => void,
    options?: ConsentUIOptions,
  ) {
    this.config = sanitizeConfig(config);
    this.options = options ?? {};
    // Closed: host-page scripts cannot reach into the banner and drive the
    // buttons programmatically.
    this.root = container.attachShadow({ mode: 'closed' });
    this.render(onConsent, onReject);
  }

  /**
   * @internal The closed shadow root, exposed for tests and diagnostics. The
   * banner is never registered globally, so host scripts cannot reach this
   * instance through the DOM.
   */
  shadowRootForTesting(): ShadowRoot {
    return this.root;
  }

  private render(onConsent: () => void, onReject?: () => void): void {
    const { brandName, position, accentColor, acceptLabel, rejectLabel, privacyPolicyUrl } =
      this.config;
    const [y, x] = position.split('-') as [string, string];

    const style = document.createElement('style');
    style.textContent = STYLE_TEMPLATE.replace(/__flaxia_accent__/g, accentColor).replace(
      '__flaxia_position__',
      `${y}: 20px; ${x}: 20px`,
    );

    const overlay = document.createElement('div');
    overlay.className = 'overlay';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-labelledby', 'flaxia-consent-title');

    const title = document.createElement('h3');
    title.id = 'flaxia-consent-title';
    // textContent: config strings are rendered as text, never parsed as HTML.
    title.textContent = brandName;

    const summary = document.createElement('p');
    summary.textContent = CONSENT_DISCLOSURE.summary;

    const list = document.createElement('ul');
    for (const item of CONSENT_DISCLOSURE.items) {
      const entry = document.createElement('li');
      entry.textContent = item;
      list.appendChild(entry);
    }

    overlay.append(title, summary, list);

    if (privacyPolicyUrl) {
      const privacy = document.createElement('p');
      privacy.className = 'privacy';
      const link = document.createElement('a');
      link.href = privacyPolicyUrl;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      link.textContent = 'プライバシーポリシー';
      privacy.appendChild(link);
      overlay.appendChild(privacy);
    }

    const hint = document.createElement('p');
    hint.className = 'hint';
    hint.textContent = CONSENT_DISCLOSURE.acceptGateHint;

    const acceptBtn = document.createElement('button');
    acceptBtn.id = 'consent-btn';
    acceptBtn.type = 'button';
    acceptBtn.textContent = acceptLabel;

    const rejectBtn = document.createElement('button');
    rejectBtn.id = 'reject-btn';
    rejectBtn.type = 'button';
    rejectBtn.className = 'reject';
    rejectBtn.textContent = rejectLabel;

    const now = this.options.now ?? (() => Date.now());
    const schedule =
      this.options.schedule ?? ((callback: () => void, delayMs: number) => void setTimeout(callback, delayMs));
    const minVisibleMs = resolveMinVisibleMs(this.config.minVisibleMs, this.options);
    const acceptEnabledAt = now() + minVisibleMs;
    let acceptEnabled = minVisibleMs <= 0;
    let decided = false;

    if (!acceptEnabled) {
      acceptBtn.disabled = true;
      acceptBtn.setAttribute('aria-disabled', 'true');
      schedule(() => {
        acceptEnabled = true;
        acceptBtn.disabled = false;
        acceptBtn.removeAttribute('aria-disabled');
        hint.remove();
      }, minVisibleMs);
    }

    const decide = (callback?: () => void) => {
      if (decided) return;
      decided = true;
      overlay.remove();
      callback?.();
    };

    acceptBtn.addEventListener('click', () => {
      // Second gate: even a synthetic click dispatched straight at the button
      // (which bypasses `disabled`) cannot accept before the notice has been
      // visible for the minimum duration.
      if (!acceptEnabled || now() < acceptEnabledAt) return;
      markUserGestureConsent(CONSENT_NOTICE_VERSION);
      decide(onConsent);
    });

    rejectBtn.addEventListener('click', () => {
      decide(onReject);
    });

    // The gate hint is only meaningful while the button is disabled.
    if (!acceptEnabled) overlay.appendChild(hint);
    overlay.append(acceptBtn, rejectBtn);
    this.root.append(style, overlay);
  }
}