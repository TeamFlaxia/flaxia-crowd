interface ConsentConfig {
  brandName: string;
  position: 'bottom-right' | 'bottom-left' | 'top-right' | 'top-left';
  accentColor?: string;
}

export class ConsentUI {
  private shadow: ShadowRoot;

  constructor(
    container: HTMLElement,
    config: ConsentConfig,
    onConsent: () => void,
    onReject?: () => void,
  ) {
    this.shadow = container.attachShadow({ mode: 'open' });
    this.render(config, onConsent, onReject);
  }

  private render(config: ConsentConfig, onConsent: () => void, onReject?: () => void) {
    const { brandName, position, accentColor = '#6366f1' } = config;
    const [y, x] = position.split('-');

    const style = document.createElement('style');
    style.textContent = `
      .overlay {
        position: fixed;
        ${y}: 20px;
        ${x}: 20px;
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
      button {
        background: ${accentColor};
        color: white;
        border: none;
        padding: 10px 15px;
        border-radius: 4px;
        cursor: pointer;
        margin-top: 10px;
        width: 100%;
        font-size: 14px;
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
        .overlay p {
          color: #d1d5db;
        }
        button.reject {
          color: #d1d5db;
          border-color: #4b5563;
        }
      }
    `;

    const div = document.createElement('div');
    div.className = 'overlay';
    div.innerHTML = `
      <h3>${brandName}</h3>
      <p>サイトのパフォーマンス向上にご協力ください。</p>
      <button id="consent-btn">同意して開始</button>
      <button id="reject-btn" class="reject">拒否</button>
    `;

    div.querySelector('#consent-btn')?.addEventListener('click', () => {
      div.remove();
      onConsent();
    });

    div.querySelector('#reject-btn')?.addEventListener('click', () => {
      div.remove();
      onReject?.();
    });

    this.shadow.appendChild(style);
    this.shadow.appendChild(div);
  }
}
