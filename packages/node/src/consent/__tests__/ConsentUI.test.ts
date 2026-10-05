import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ConsentUI } from '../ConsentUI';
import type { ConsentConfig, ConsentUIOptions } from '../ConsentUI';
import { CONSENT_DISCLOSURE } from '../notice';

/** Deterministic clock/scheduler so the minimum-visible gate is testable. */
function manualClock(start = 1_000) {
  let time = start;
  const timers: Array<{ at: number; callback: () => void }> = [];
  return {
    now: () => time,
    schedule: (callback: () => void, delayMs: number) => {
      timers.push({ at: time + delayMs, callback });
    },
    advance: (ms: number) => {
      time += ms;
      for (const timer of [...timers]) {
        if (timer.at <= time) {
          timers.splice(timers.indexOf(timer), 1);
          timer.callback();
        }
      }
    },
  };
}

function mount(
  config: Partial<ConsentConfig> & Pick<ConsentConfig, 'brandName' | 'position'>,
  options?: ConsentUIOptions,
) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const onConsent = vi.fn();
  const onReject = vi.fn();
  const ui = new ConsentUI(container, config, onConsent, onReject, options);
  return { container, ui, onConsent, onReject, root: ui.shadowRootForTesting() };
}

const baseConfig: Pick<ConsentConfig, 'brandName' | 'position'> = {
  brandName: 'Test Brand',
  position: 'bottom-right',
};

describe('ConsentUI', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    delete (window as unknown as Record<string, unknown>).__flaxiaPwned;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders the banner inside a closed shadow root', () => {
    const { container, root } = mount(baseConfig);

    expect(root.querySelector('.overlay')).not.toBeNull();
    // Closed: host-page scripts cannot reach the banner through the element.
    expect(container.shadowRoot).toBeNull();
    expect(document.querySelector('.overlay')).toBeNull();
  });

  it('renders the brand name as text and never executes injected markup', () => {
    const hostile = '<img src=x onerror="window.__flaxiaPwned=true">';
    const { root } = mount({ ...baseConfig, brandName: hostile });

    const title = root.querySelector('h3');
    expect(title?.textContent).toBe(hostile);
    expect(root.querySelector('img')).toBeNull();
    expect(root.querySelector('svg')).toBeNull();
    expect((window as unknown as Record<string, unknown>).__flaxiaPwned).toBeUndefined();
  });

  it('renders label overrides as text', () => {
    const { root } = mount({
      ...baseConfig,
      acceptLabel: '<b>accept</b>',
      rejectLabel: '<script>x</script>',
    });

    expect(root.querySelector('#consent-btn')?.textContent).toBe('<b>accept</b>');
    expect(root.querySelector('#reject-btn')?.textContent).toBe('<script>x</script>');
    expect(root.querySelector('b')).toBeNull();
    expect(root.querySelector('script')).toBeNull();
  });

  it('discloses what actually runs on the device', () => {
    const { root } = mount(baseConfig);

    const items = Array.from(root.querySelectorAll('.overlay li')).map((li) => li.textContent ?? '');
    expect(items).toHaveLength(CONSENT_DISCLOSURE.items.length);
    const disclosure = items.join('\n');
    expect(disclosure).toContain('WebAssembly');
    expect(disclosure).toContain('NSFW');
    expect(disclosure).toContain('WebSocket');
    expect(disclosure).toContain('第三者');
  });

  it('accepts valid accent colors', () => {
    const cases: Array<[string, string]> = [
      ['#ff0000', '#ff0000'],
      ['#F0A', '#f0a'],
      ['rgb(1, 2, 3)', 'rgb(1, 2, 3)'],
      ['rgba(1, 2, 3, 0.5)', 'rgba(1, 2, 3, 0.5)'],
      ['tomato', 'tomato'],
    ];
    for (const [input, expected] of cases) {
      const { root } = mount({ ...baseConfig, accentColor: input });
      const style = root.querySelector('style')?.textContent ?? '';
      expect(style).toContain(`background: ${expected}`);
    }
  });

  it('falls back to the default accent color for CSS injection attempts', () => {
    const injection = '#6366f1; } .overlay button.reject { display:none; } .x {';
    const { root } = mount({ ...baseConfig, accentColor: injection });

    const style = root.querySelector('style')?.textContent ?? '';
    expect(style).toContain('background: #6366f1');
    expect(style).not.toContain('display:none');
    expect(style).not.toContain('.x {');
    expect(style).not.toContain(injection);
  });

  it('keeps the reject button present and working when the accent color is hostile', () => {
    const { root, onReject } = mount({
      ...baseConfig,
      accentColor: 'red; } .overlay button.reject { display: none; } .x {',
    });

    const reject = root.querySelector('#reject-btn') as HTMLButtonElement;
    expect(reject).not.toBeNull();
    expect(reject.className).toBe('reject');

    reject.click();
    expect(onReject).toHaveBeenCalledTimes(1);
  });

  it('rejects malformed rgb()/rgba() values', () => {
    for (const input of ['rgb(999, 0, 0)', 'rgba(0, 0, 0, 2)', 'rgb(1,2)', 'url(https://evil)']) {
      const { root } = mount({ ...baseConfig, accentColor: input });
      const style = root.querySelector('style')?.textContent ?? '';
      expect(style).toContain('background: #6366f1');
    }
  });

  it('whitelists the banner position', () => {
    const { root } = mount({
      ...baseConfig,
      // Cast: the value is intentionally outside the union.
      position: 'middle; } .overlay { display: none' as ConsentConfig['position'],
    });

    const style = root.querySelector('style')?.textContent ?? '';
    expect(style).toContain('bottom: 20px; right: 20px');
    expect(style).not.toContain('display: none');
  });

  it('renders at each supported position', () => {
    const positions = ['bottom-right', 'bottom-left', 'top-right', 'top-left'] as const;

    for (const position of positions) {
      const { root } = mount({ ...baseConfig, position });
      const style = root.querySelector('style')?.textContent ?? '';
      const [y, x] = position.split('-');
      expect(style).toContain(`${y}: 20px`);
      expect(style).toContain(`${x}: 20px`);
    }
  });

  it('only links to http(s) privacy policies', () => {
    const valid = mount({ ...baseConfig, privacyPolicyUrl: 'https://example.com/privacy' });
    const anchor = valid.root.querySelector('a') as HTMLAnchorElement;
    expect(anchor).not.toBeNull();
    expect(anchor.href).toBe('https://example.com/privacy');
    expect(anchor.rel).toContain('noopener');

    const invalid = mount({ ...baseConfig, privacyPolicyUrl: 'javascript:alert(1)' });
    expect(invalid.root.querySelector('a')).toBeNull();
  });

  it('gates the accept button behind the minimum visible duration', () => {
    const clock = manualClock();
    const { root, onConsent } = mount(baseConfig, {
      minVisibleMs: 1500,
      now: clock.now,
      schedule: clock.schedule,
    });

    const accept = root.querySelector('#consent-btn') as HTMLButtonElement;
    const hint = root.querySelector('.hint');
    expect(accept.disabled).toBe(true);
    expect(hint?.textContent).toBe(CONSENT_DISCLOSURE.acceptGateHint);

    // Too early: ignored.
    accept.click();
    expect(onConsent).not.toHaveBeenCalled();

    clock.advance(1500);
    expect(accept.disabled).toBe(false);
    expect(root.querySelector('.hint')).toBeNull();

    accept.click();
    expect(onConsent).toHaveBeenCalledTimes(1);
  });

  it('cannot be bypassed by dispatching a click straight at the button', () => {
    const clock = manualClock();
    const { root, onConsent } = mount(baseConfig, {
      minVisibleMs: 1500,
      now: clock.now,
      schedule: clock.schedule,
    });

    const accept = root.querySelector('#consent-btn') as HTMLButtonElement;
    // `disabled` does not stop `dispatchEvent`, so the handler gates on time.
    accept.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    clock.advance(1400);
    accept.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(onConsent).not.toHaveBeenCalled();

    clock.advance(100);
    accept.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(onConsent).toHaveBeenCalledTimes(1);
  });

  it('does not grant twice when the accept button is clicked repeatedly', () => {
    const clock = manualClock();
    const { root, onConsent } = mount(baseConfig, {
      minVisibleMs: 10,
      now: clock.now,
      schedule: clock.schedule,
    });

    const accept = root.querySelector('#consent-btn') as HTMLButtonElement;
    clock.advance(10);
    accept.click();
    accept.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(onConsent).toHaveBeenCalledTimes(1);
  });

  it('lets the visitor reject immediately', () => {
    const clock = manualClock();
    const { root, onReject } = mount(baseConfig, {
      minVisibleMs: 1500,
      now: clock.now,
      schedule: clock.schedule,
    });

    (root.querySelector('#reject-btn') as HTMLButtonElement).click();
    expect(onReject).toHaveBeenCalledTimes(1);
  });

  it('cannot be configured below the minimum-visible floor', () => {
    const { root, onConsent } = mount({ ...baseConfig, minVisibleMs: 0 });

    const accept = root.querySelector('#consent-btn') as HTMLButtonElement;
    expect(accept.disabled).toBe(true);
    accept.click();
    expect(onConsent).not.toHaveBeenCalled();
  });

  it('raises the minimum-visible duration when the host asks for more', () => {
    const clock = manualClock();
    const { root, onConsent } = mount(
      { ...baseConfig, minVisibleMs: 5000 },
      { now: clock.now, schedule: clock.schedule },
    );

    const accept = root.querySelector('#consent-btn') as HTMLButtonElement;
    clock.advance(1500);
    accept.click();
    expect(onConsent).not.toHaveBeenCalled();

    clock.advance(3500);
    accept.click();
    expect(onConsent).toHaveBeenCalledTimes(1);
  });

  it('keeps the explicit text color and dark-mode styles', () => {
    const { root } = mount(baseConfig);

    const style = root.querySelector('style')?.textContent ?? '';
    expect(style).toContain('color: #1f2937');
    expect(style).toContain('@media (prefers-color-scheme: dark)');
  });
});