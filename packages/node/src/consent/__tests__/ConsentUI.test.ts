import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ConsentUI } from '../ConsentUI';

describe('ConsentUI', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('should render consent banner in shadow DOM', () => {
    const container = document.createElement('div');
    const onConsent = vi.fn();

    new ConsentUI(container, {
      brandName: 'Test Brand',
      position: 'bottom-right',
    }, onConsent);

    expect(container.shadowRoot).toBeDefined();
    const overlay = container.shadowRoot?.querySelector('.overlay');
    expect(overlay).toBeDefined();
  });

  it('should display brand name', () => {
    const container = document.createElement('div');

    new ConsentUI(container, {
      brandName: 'My Site',
      position: 'bottom-right',
    }, vi.fn());

    const h3 = container.shadowRoot?.querySelector('h3');
    expect(h3?.textContent).toBe('My Site');
  });

  it('should trigger onConsent callback when button clicked', () => {
    const container = document.createElement('div');
    const onConsent = vi.fn();

    new ConsentUI(container, {
      brandName: 'Test',
      position: 'bottom-right',
    }, onConsent);

    const btn = container.shadowRoot?.querySelector('#consent-btn') as HTMLButtonElement;
    btn?.click();

    expect(onConsent).toHaveBeenCalledTimes(1);
  });

  it('should render a reject button', () => {
    const container = document.createElement('div');

    new ConsentUI(container, {
      brandName: 'Test',
      position: 'bottom-right',
    }, vi.fn());

    const rejectBtn = container.shadowRoot?.querySelector('#reject-btn') as HTMLButtonElement;
    expect(rejectBtn).toBeDefined();
    expect(rejectBtn?.textContent).toBe('拒否');
  });

  it('should trigger onReject callback when reject button clicked', () => {
    const container = document.createElement('div');
    const onReject = vi.fn();

    new ConsentUI(container, {
      brandName: 'Test',
      position: 'bottom-right',
    }, vi.fn(), onReject);

    const btn = container.shadowRoot?.querySelector('#reject-btn') as HTMLButtonElement;
    btn?.click();

    expect(onReject).toHaveBeenCalledTimes(1);
  });

  it('should not call onReject when omitted', () => {
    const container = document.createElement('div');

    new ConsentUI(container, {
      brandName: 'Test',
      position: 'bottom-right',
    }, vi.fn());

    const btn = container.shadowRoot?.querySelector('#reject-btn') as HTMLButtonElement;
    expect(() => btn?.click()).not.toThrow();
  });

  it('should set explicit text color to avoid white-on-white in dark mode', () => {
    const container = document.createElement('div');

    new ConsentUI(container, {
      brandName: 'Test',
      position: 'bottom-right',
    }, vi.fn());

    const style = container.shadowRoot?.querySelector('style')?.textContent || '';
    expect(style).toContain('color: #1f2937');
    expect(style).toContain('@media (prefers-color-scheme: dark)');
  });

  it('should render with custom accent color', () => {
    const container = document.createElement('div');

    new ConsentUI(container, {
      brandName: 'Test',
      position: 'bottom-left',
      accentColor: '#ff0000',
    }, vi.fn());

    const style = container.shadowRoot?.querySelector('style')?.textContent || '';
    expect(style).toContain('#ff0000');
  });

  it('should render at different positions', () => {
    const positions = ['bottom-right', 'bottom-left', 'top-right', 'top-left'] as const;

    for (const position of positions) {
      const container = document.createElement('div');

      new ConsentUI(container, {
        brandName: 'Test',
        position,
      }, vi.fn());

      const style = container.shadowRoot?.querySelector('style')?.textContent || '';
      const [y, x] = position.split('-');
      expect(style).toContain(`${y}: 20px`);
      expect(style).toContain(`${x}: 20px`);
    }
  });
});
