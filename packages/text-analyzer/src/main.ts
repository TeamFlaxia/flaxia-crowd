import './index.css';
import { submitCrowdTask, getCrowdTask } from './crowd-client';
import { initFlaxiaNode, getFlaxiaNodeConsentState } from '@flaxia/node';
import { resolveOrchestratorUrl } from './orchestrator';

const LABELS = ['1 star', '2 stars', '3 stars', '4 stars', '5 stars'] as readonly string[];
const SENTIMENT_NAMES = ['Very Negative', 'Negative', 'Neutral', 'Positive', 'Very Positive'];

interface SentimentResult {
  label: string;
  score: number;
}

interface HistoryEntry {
  text: string;
  label: string;
  score: number;
}

// Node signaling connects to the orchestrator configured at build time.
// Authenticated task API calls are intentionally separate and always go
// through same-origin /crowd/* so the browser never receives the API key.
// `null` means the build was shipped without VITE_ORCHESTRATOR_URL: every entry
// point then shows a configuration error instead of guessing an origin.
const orchestratorUrl = resolveOrchestratorUrl();

// UI Elements
const analysisInput = document.getElementById('analysis-input') as HTMLTextAreaElement;
const analyzeBtn = document.getElementById('analyze-btn') as HTMLButtonElement;
const resultsSection = document.getElementById('results-section') as HTMLDivElement;
const resultBadge = document.getElementById('result-badge') as HTMLSpanElement;
const scoreBars = document.getElementById('score-bars') as HTMLDivElement;
const resultText = document.getElementById('result-text') as HTMLDivElement;
const historyList = document.getElementById('history-list') as HTMLDivElement;
const clearHistoryBtn = document.getElementById('clear-history-btn') as HTMLButtonElement;
const newAnalysisBtn = document.getElementById('new-analysis-btn') as HTMLButtonElement;
const consentTrigger = document.getElementById('consent-trigger') as HTMLButtonElement;

/**
 * Surface a missing/invalid build-time orchestrator configuration. The demo
 * never falls back to a hardcoded origin, so this is the only thing an
 * unconfigured build can do.
 */
function showOrchestratorConfigError(): void {
  const existing = document.querySelector('.config-error');
  if (existing) return;
  const msg = document.createElement('div');
  msg.className = 'status-message error config-error';
  msg.textContent =
    'オーケストレーターが設定されていません。ビルド時に VITE_ORCHESTRATOR_URL を設定してください。';
  resultsSection.parentNode?.insertBefore(msg, resultsSection);
}

// Task Visualizer
function resetVisualizer() { }
function updateVisualizer(status: 'pending' | 'processing' | 'done' | 'failed', taskId: string, nodeId = '-', elapsedSec = 0) { }

// Scoring
const SCORE_CLASSES = ['very-negative', 'negative', 'neutral', 'positive', 'very-positive'];

function getLabelIndex(label: string): number {
  const lower = label.toLowerCase().trim();
  const starMatch = lower.match(/^(\d+)\s*star/);
  if (starMatch) {
    const n = parseInt(starMatch[1], 10);
    if (n >= 1 && n <= 5) return n - 1;
  }
  for (let i = 0; i < 5; i++) {
    if (lower === SENTIMENT_NAMES[i].toLowerCase()) return i;
    if (lower === LABELS[i].toLowerCase()) return i;
  }
  if (lower.includes('very') && lower.includes('negative')) return 0;
  if (lower.includes('very') && lower.includes('positive')) return 4;
  if (lower.includes('negative')) return 1;
  if (lower.includes('positive')) return 3;
  if (lower.includes('neutral')) return 2;
  return 2;
}

function getScoreClass(label: string): string {
  return SCORE_CLASSES[getLabelIndex(label)] || 'neutral';
}

function getBadgeClass(label: string): string {
  return 'result-badge ' + (SCORE_CLASSES[getLabelIndex(label)] || 'neutral');
}

function renderScores(results: SentimentResult[], topLabel: string, topScore: number, elapsedSec: number) {
  const scoreMap = new Map<string, number>();
  for (const r of results) {
    const idx = getLabelIndex(r.label);
    scoreMap.set(LABELS[idx], r.score);
  }

  const rows = scoreBars.querySelectorAll('.score-row');
  for (const row of rows) {
    const dataLabel = row.getAttribute('data-label') || '';
    const idx = getLabelIndex(dataLabel);
    const score = scoreMap.get(LABELS[idx]) || 0;
    const fill = row.querySelector('.score-fill') as HTMLElement;
    const value = row.querySelector('.score-value') as HTMLElement;
    const pct = (score * 100).toFixed(1);
    fill.style.width = `${score * 100}%`;
    value.textContent = `${pct}%`;
  }

  const topIdx = getLabelIndex(topLabel);
  resultBadge.className = getBadgeClass(topLabel);
  resultBadge.textContent = SENTIMENT_NAMES[topIdx];

  resultText.textContent = `判定: ${SENTIMENT_NAMES[topIdx]} (${(topScore * 100).toFixed(1)}%) • ${elapsedSec.toFixed(1)}s`;
  resultsSection.style.display = 'flex';
}

function addHistory(text: string, label: string, score: number) {
  const emptyMsg = historyList.querySelector('.history-empty');
  if (emptyMsg) emptyMsg.remove();

  const idx = getLabelIndex(label);
  const displayName = SENTIMENT_NAMES[idx];

  const item = document.createElement('div');
  item.className = 'history-item';
  item.innerHTML = `
    <span class="history-item-text">${escapeHtml(text)}</span>
    <span class="history-item-badge score-${idx}">${displayName}</span>
    <span class="history-item-score">${(score * 100).toFixed(0)}%</span>
  `;
  item.addEventListener('click', () => {
    analysisInput.value = text;
    analysisInput.focus();
    resultsSection.style.display = 'none';
  });
  historyList.prepend(item);

  const entries: HistoryEntry[] = JSON.parse(localStorage.getItem('ta_history') || '[]');
  entries.unshift({ text, label: displayName, score });
  localStorage.setItem('ta_history', JSON.stringify(entries.slice(0, 50)));
}

function restoreHistory() {
  const entries: HistoryEntry[] = JSON.parse(localStorage.getItem('ta_history') || '[]');
  if (entries.length === 0) return;
  const emptyMsg = historyList.querySelector('.history-empty');
  if (emptyMsg) emptyMsg.remove();
  for (const entry of entries) {
    const idx = getLabelIndex(entry.label);
    const displayName = SENTIMENT_NAMES[idx];
    const item = document.createElement('div');
    item.className = 'history-item';
    item.innerHTML = `
      <span class="history-item-text">${escapeHtml(entry.text)}</span>
      <span class="history-item-badge score-${idx}">${displayName}</span>
      <span class="history-item-score">${(entry.score * 100).toFixed(0)}%</span>
    `;
    item.addEventListener('click', () => {
      analysisInput.value = entry.text;
      analysisInput.focus();
      resultsSection.style.display = 'none';
    });
    historyList.appendChild(item);
  }
}

function escapeHtml(text: string): string {
  const d = document.createElement('div');
  d.textContent = text;
  return d.innerHTML;
}

clearHistoryBtn.addEventListener('click', () => {
  localStorage.removeItem('ta_history');
  historyList.innerHTML = '<div class="history-empty">まだ分析履歴がありません</div>';
});

newAnalysisBtn.addEventListener('click', () => {
  analysisInput.value = '';
  analysisInput.focus();
  resultsSection.style.display = 'none';
});

restoreHistory();

function startFlaxiaNode(): void {
  if (!orchestratorUrl) {
    showOrchestratorConfigError();
    return;
  }
  initFlaxiaNode({
    orchestratorUrl,
    siteId: 'textanalyzer-example',
    consent: {
      brandName: 'TextAnalyzer Node',
      position: 'bottom-right',
      accentColor: '#7c3aed'
    }
  });
}

consentTrigger.addEventListener('click', startFlaxiaNode);

// Use the library's consent API so the record's integrity/expiry rules apply.
// A raw localStorage flag must never be trusted as consent.
if (getFlaxiaNodeConsentState() === 'granted') {
  startFlaxiaNode();
}

// Parse classification results
function parseResults(resultPayload: any): { results: SentimentResult[]; topLabel: string; topScore: number } | null {
  if (!resultPayload) return null;
  const output = resultPayload.output;
  if (!output) return null;

  if (Array.isArray(output)) {
    const results: SentimentResult[] = output.map((item: any) => ({
      label: typeof item.label === 'string' ? item.label : String(item.label),
      score: typeof item.score === 'number' ? item.score : 0,
    }));
    results.sort((a, b) => b.score - a.score);
    return { results, topLabel: results[0]?.label || 'Unknown', topScore: results[0]?.score || 0 };
  }

  if (typeof output === 'object') {
    const label = output.label || 'Unknown';
    const score = typeof output.score === 'number' ? output.score : 0;
    return { results: [{ label, score }], topLabel: label, topScore: score };
  }

  return null;
}

// Submit Analysis
analysisInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    submitAnalysis();
  }
});

analyzeBtn.addEventListener('click', submitAnalysis);

async function submitAnalysis() {
  const text = analysisInput.value.trim();
  if (!text) return;

  if (!orchestratorUrl) {
    showOrchestratorConfigError();
    return;
  }

  analyzeBtn.disabled = true;
  analyzeBtn.textContent = '分析中...';
  resultsSection.style.display = 'none';

  const statusMsg = document.createElement('div');
  statusMsg.className = 'status-message';
  statusMsg.textContent = 'Submitting analysis task to Flaxia Crowd...';
  resultsSection.parentNode?.insertBefore(statusMsg, resultsSection);

  try {
    resetVisualizer();
    updateVisualizer('pending', 'Submitting...');

    const taskRecord = await submitCrowdTask({
      workload: 'ai-inference',
      payload: {
        task: 'text-classification',
        model: 'Xenova/bert-base-multilingual-uncased-sentiment',
        input: text,
        options: {
          dtype: 'q4f16',
          top_k: 5,
        } as any
      }
    });

    const taskId = taskRecord.id || (taskRecord as any).taskId;
    const startTime = Date.now();
    let pollInterval = 1000;
    let isFinished = false;

    updateVisualizer('pending', taskId, '-', 0);
    statusMsg.textContent = `Task queued. ID: ${taskId}`;

    while (!isFinished) {
      await new Promise(r => setTimeout(r, pollInterval));
      const elapsed = (Date.now() - startTime) / 1000;

      if (elapsed > 60) {
        isFinished = true;
        updateVisualizer('failed', taskId);
        statusMsg.className = 'status-message error';
        statusMsg.textContent = 'Task timed out after 60 seconds.';
        break;
      }

      const currentTask = await getCrowdTask(taskId);

      if (currentTask.status === 'processing') {
        updateVisualizer('processing', taskId, currentTask.assignedNodeId || 'Assigned Node', elapsed);
        statusMsg.textContent = `Assigned to node: ${currentTask.assignedNodeId || '...'}. Analyzing...`;
      } else if (currentTask.status === 'done') {
        isFinished = true;
        updateVisualizer('done', taskId, currentTask.assignedNodeId || 'Assigned Node', elapsed);
        statusMsg.remove();

        const parsed = parseResults(currentTask.result);
        if (parsed) {
          renderScores(parsed.results, parsed.topLabel, parsed.topScore, elapsed);
          addHistory(text, parsed.topLabel, parsed.topScore);
        } else {
          const errorMsg = document.createElement('div');
          errorMsg.className = 'status-message error';
          errorMsg.textContent = 'Could not parse analysis results.';
          resultsSection.parentNode?.insertBefore(errorMsg, resultsSection);
        }
      } else if (currentTask.status === 'failed') {
        isFinished = true;
        updateVisualizer('failed', taskId);
        statusMsg.className = 'status-message error';
        statusMsg.textContent = `Task failed: ${currentTask.error || 'Unknown Error'}`;
      }
    }
  } catch (error: any) {
    statusMsg.className = 'status-message error';
    statusMsg.textContent = `Submission error: ${error.message || error}`;
    updateVisualizer('failed', 'Error');
  } finally {
    analyzeBtn.disabled = false;
    analyzeBtn.innerHTML = `
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><path d="M21 21L16.65 16.65"/></svg>
      感情分析を実行
    `;
  }
}
