import * as vscode from 'vscode';
import { TrackerDatabase } from '../../db/database';
import {
  WebviewMessage,
  ExtensionMessage,
  OverviewData,
  SessionListData,
  SessionDetailData,
} from '../../core/types';
import { dateStringToEpoch } from '../../util/dateUtils';
import { computeBillingStatus } from '../../stats/billingCalculator';
import { getConfig } from '../../config';

export class DashboardPanel {
  public static currentPanel: DashboardPanel | undefined;
  private readonly panel: vscode.WebviewPanel;
  private disposables: vscode.Disposable[] = [];

  private constructor(
    panel: vscode.WebviewPanel,
    private db: TrackerDatabase,
    private extensionUri: vscode.Uri
  ) {
    this.panel = panel;
    this.panel.webview.html = this.getHtml();
    this.panel.webview.onDidReceiveMessage(
      (msg: WebviewMessage) => this.handleMessage(msg),
      undefined,
      this.disposables
    );
    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
  }

  static createOrShow(db: TrackerDatabase, extensionUri: vscode.Uri): void {
    if (DashboardPanel.currentPanel) {
      DashboardPanel.currentPanel.panel.reveal(vscode.ViewColumn.One);
      return;
    }
    const panel = vscode.window.createWebviewPanel(
      'copilotUsageDashboard',
      'Copilot Usage Dashboard',
      vscode.ViewColumn.One,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [],
      }
    );
    DashboardPanel.currentPanel = new DashboardPanel(panel, db, extensionUri);
  }

  public refresh(): void {
    this.postMessage({ type: 'overview', data: this.getOverviewData() });
  }

  private handleMessage(msg: WebviewMessage): void {
    switch (msg.type) {
      case 'requestOverview':
        this.postMessage({ type: 'overview', data: this.getOverviewData() });
        break;
      case 'requestSessions': {
        const dateFrom = msg.dateFrom ? dateStringToEpoch(msg.dateFrom) : undefined;
        const dateTo = msg.dateTo ? dateStringToEpoch(msg.dateTo) + 86400000 : undefined;
        const sessions = this.db.getSessionsWithStats(dateFrom, dateTo);
        this.postMessage({ type: 'sessions', data: { sessions, groupBy: msg.groupBy } });
        break;
      }
      case 'requestSessionDetail': {
        const detail = this.db.getSessionDetail(msg.sessionId);
        if (detail) {
          const analytics = this.db.getSessionAnalytics(msg.sessionId);
          const toolCalls = this.db.getSessionToolCalls(msg.sessionId);
          this.postMessage({ type: 'sessionDetail', data: { ...detail, analytics, toolCalls } });
        } else {
          this.postMessage({ type: 'error', message: `Session ${msg.sessionId} not found` });
        }
        break;
      }
      case 'requestBilling': {
        const config = getConfig();
        const billing = computeBillingStatus(
          this.db, config.plan, Date.now(),
          { start: msg.periodStart, end: msg.periodEnd }
        );
        this.postMessage({
          type: 'billingStatus',
          data: this.mapBilling(billing, msg.periodLabel),
        });
        break;
      }
      case 'refresh':
        this.postMessage({ type: 'overview', data: this.getOverviewData() });
        break;
    }
  }

  private mapBilling(billing: ReturnType<typeof computeBillingStatus>, periodLabel: string): NonNullable<OverviewData['billing']> {
    return {
      periodLabel,
      isHistoricalPeriod: billing.isHistoricalPeriod,
      plan: billing.plan,
      daysRemaining: billing.daysRemaining,
      notes: billing.notes,
      current: {
        used: billing.current.premiumRequestsUsed,
        quota: billing.current.premiumRequestsQuota,
        pct: billing.current.percentUsed,
        breakdown: billing.current.costBreakdown.map(b => ({ model: b.model, requests: b.requests, cost: b.multipliedCost })),
      },
      new: {
        used: billing.new.aiCreditsUsed,
        quota: billing.new.aiCreditsQuota,
        quotaIsPromotional: billing.new.quotaIsPromotional,
        pct: billing.new.percentUsed,
        costUSD: billing.new.estimatedCostUSD,
        cachedTokensCaptured: billing.new.cachedTokensCaptured,
        cachedTokensEstimated: billing.new.cachedTokensEstimated,
        breakdown: billing.new.costBreakdown,
      },
    };
  }

  private getOverviewData(): OverviewData {
    const config = getConfig();
    const billing = computeBillingStatus(this.db, config.plan);
    const now = new Date();
    const MONTH_NAMES = ['January','February','March','April','May','June','July','August','September','October','November','December'];
    const periodLabel = `${MONTH_NAMES[now.getUTCMonth()]} ${now.getUTCFullYear()}`;
    const wf = this.db.getWorkflowSummary();
    return {
      aggregate: this.db.getAggregateStats(),
      dailyStats: this.db.getDailyStats(),
      modelStats: this.db.getModelStats(),
      topSessions: this.db.getTopSessions(10),
      availableMonths: this.db.getAvailableMonths(),
      billing: this.mapBilling(billing, periodLabel),
      workflow: {
        toolCalls: wf.totalToolCalls,
        subagents: wf.totalSubagents,
        turns: wf.totalTurns,
        errors: wf.totalErrors,
        turnsPerMsg: wf.avgTurnsPerMessage,
        toolsPerTurn: wf.avgToolsPerTurn,
      },
    };
  }

  private postMessage(msg: ExtensionMessage): void {
    this.panel.webview.postMessage(msg);
  }

  private dispose(): void {
    DashboardPanel.currentPanel = undefined;
    this.panel.dispose();
    while (this.disposables.length) {
      this.disposables.pop()?.dispose();
    }
  }

  private getHtml(): string {
    const nonce = getNonce();
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Copilot Usage Dashboard</title>
<style nonce="${nonce}">
  :root {
    --bg: var(--vscode-editor-background);
    --fg: var(--vscode-editor-foreground);
    --border: var(--vscode-widget-border);
    --card-bg: var(--vscode-editorWidget-background);
    --accent: var(--vscode-textLink-foreground);
    --muted: var(--vscode-descriptionForeground);
    --badge-bg: var(--vscode-badge-background);
    --badge-fg: var(--vscode-badge-foreground);
    --success: #3fb950;
    --warning: #d29922;
    --danger: #f85149;
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: var(--vscode-font-family); color: var(--fg); background: var(--bg); padding: 20px; max-width: 1200px; margin: 0 auto; }
  h1 { font-size: 1.3em; margin-bottom: 16px; font-weight: 600; }
  h2 { font-size: 1em; margin: 20px 0 10px; color: var(--accent); font-weight: 600; text-transform: uppercase; letter-spacing: 0.5px; font-size: 0.8em; }

  .tabs { display: flex; gap: 0; border-bottom: 1px solid var(--border); margin-bottom: 20px; }
  .tab { padding: 8px 16px; cursor: pointer; border-bottom: 2px solid transparent; color: var(--muted); font-size: 0.9em; }
  .tab:hover { color: var(--fg); }
  .tab.active { color: var(--accent); border-bottom-color: var(--accent); }
  .tab-content { display: none; }
  .tab-content.active { display: block; }

  /* Billing section */
  .billing-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; margin-bottom: 20px; }
  .billing-card { background: var(--card-bg); border: 1px solid var(--border); border-radius: 8px; padding: 16px; }
  .billing-card h3 { font-size: 0.85em; color: var(--muted); margin-bottom: 12px; text-transform: uppercase; letter-spacing: 0.3px; }
  .billing-card .headline { font-size: 1.8em; font-weight: 700; margin-bottom: 4px; }
  .billing-card .sub { font-size: 0.8em; color: var(--muted); margin-bottom: 12px; }
  .progress-bar { height: 6px; background: var(--border); border-radius: 3px; overflow: hidden; margin-bottom: 8px; }
  .progress-fill { height: 100%; border-radius: 3px; transition: width 0.3s; }
  .progress-fill.low { background: var(--success); }
  .progress-fill.mid { background: var(--warning); }
  .progress-fill.high { background: var(--danger); }
  .billing-breakdown { font-size: 0.8em; color: var(--muted); }
  .billing-breakdown .row { display: flex; justify-content: space-between; padding: 3px 0; }
  .billing-comparison { background: var(--card-bg); border: 1px solid var(--border); border-radius: 8px; padding: 16px; margin-bottom: 20px; }
  .billing-comparison .verdict { font-size: 0.95em; font-weight: 600; padding: 8px 12px; border-radius: 4px; display: inline-block; }
  .billing-comparison .verdict.more { background: rgba(248,81,73,0.1); color: var(--danger); }
  .billing-comparison .verdict.less { background: rgba(63,185,80,0.1); color: var(--success); }
  .billing-comparison .verdict.same { background: rgba(210,153,34,0.1); color: var(--warning); }
  .billing-comparison .note { font-size: 0.8em; color: var(--muted); margin-top: 8px; }

  /* Metric cards */
  .metrics { display: grid; grid-template-columns: repeat(auto-fill, minmax(140px, 1fr)); gap: 10px; margin-bottom: 20px; }
  .metric { background: var(--card-bg); border: 1px solid var(--border); border-radius: 6px; padding: 10px 12px; }
  .metric .label { font-size: 0.7em; color: var(--muted); text-transform: uppercase; letter-spacing: 0.3px; }
  .metric .value { font-size: 1.2em; font-weight: 600; margin-top: 2px; }

  /* Charts */
  .chart-container { background: var(--card-bg); border: 1px solid var(--border); border-radius: 8px; padding: 16px; margin-bottom: 16px; }
  canvas { width: 100% !important; max-height: 250px; }

  /* Tables */
  table { width: 100%; border-collapse: collapse; font-size: 0.85em; }
  th { text-align: left; padding: 8px; border-bottom: 2px solid var(--border); color: var(--muted); cursor: pointer; font-size: 0.8em; text-transform: uppercase; letter-spacing: 0.3px; }
  th:hover { color: var(--fg); }
  td { padding: 8px; border-bottom: 1px solid var(--border); }
  tr:hover td { background: var(--card-bg); }
  tr.clickable { cursor: pointer; }
  .badge { display: inline-block; padding: 2px 8px; border-radius: 10px; font-size: 0.75em; background: var(--badge-bg); color: var(--badge-fg); }
  .badge-repo { background: rgba(56,132,244,0.15); color: var(--accent); font-weight: 600; }
  .badge-otel { background: rgba(63,185,80,0.15); color: var(--success); font-size: 0.7em; font-weight: 700; }
  .badge-hybrid { background: rgba(210,153,34,0.15); color: var(--warning); font-size: 0.7em; font-weight: 700; }
  .badge-jsonl { background: rgba(139,148,158,0.12); color: var(--muted); font-size: 0.7em; font-weight: 700; }

  .loading { text-align: center; padding: 40px; color: var(--muted); }
  .filters { display: flex; gap: 8px; align-items: center; margin-bottom: 12px; flex-wrap: wrap; }
  .filters input, .filters select { background: var(--card-bg); color: var(--fg); border: 1px solid var(--border); padding: 4px 8px; border-radius: 4px; font-size: 0.85em; }
  .filters button { background: var(--accent); color: var(--badge-fg); border: none; padding: 4px 12px; border-radius: 4px; cursor: pointer; font-size: 0.85em; }

  .detail-back { cursor: pointer; color: var(--accent); margin-bottom: 12px; display: inline-block; font-size: 0.9em; }
  .request-list { margin-top: 12px; }
  .request-item { background: var(--card-bg); border: 1px solid var(--border); border-radius: 4px; padding: 8px 12px; margin-bottom: 6px; }
  .request-item .meta { font-size: 0.8em; color: var(--muted); }

  /* Session analytics */
  .signals-box { background: rgba(210,153,34,0.08); border: 1px solid var(--warning); border-radius: 6px; padding: 10px 14px; margin: 12px 0; }
  .signal { font-size: 0.85em; padding: 3px 0; color: var(--warning); }
  .analytics-grid { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 16px; margin: 12px 0 20px; }
  .analytics-col { background: var(--card-bg); border: 1px solid var(--border); border-radius: 6px; padding: 14px; }
  .analytics-col h3 { font-size: 0.75em; text-transform: uppercase; letter-spacing: 0.4px; color: var(--accent); margin-bottom: 10px; }
  .stat-row { display: flex; justify-content: space-between; padding: 4px 0; font-size: 0.85em; border-bottom: 1px solid var(--border); }
  .stat-row:last-child { border-bottom: none; }
  .stat-label { color: var(--muted); }
  .stat-value { font-weight: 600; }

  /* Insight bars */
  .insight-bar { height: 8px; border-radius: 4px; overflow: hidden; display: flex; background: var(--border); margin: 8px 0 2px; }
  .insight-bar-fill { height: 100%; }
  .insight-bar-fill.prod { background: var(--accent); }
  .insight-bar-fill.expl { background: var(--muted); }
  .insight-bar-fill.meta { background: var(--warning); }
  .insight-bar-fill.ctx-low { background: #4caf50; }
  .insight-bar-fill.ctx-mid { background: #ff9800; }
  .insight-bar-fill.ctx-high { background: #f44336; }
  .insight-bar-labels { display: flex; justify-content: space-between; font-size: 0.7em; color: var(--muted); }
  .eff-good { color: #4caf50; font-weight: 600; }
  .eff-normal { color: var(--muted); }
  .eff-bad { color: var(--danger); font-weight: 600; }

  /* Timeline */
  .timeline { margin-top: 12px; border-left: 2px solid var(--border); padding-left: 16px; }
  .tl-msg { padding: 8px 12px; margin: 10px 0; background: rgba(63,185,80,0.06); border: 1px solid rgba(63,185,80,0.2); border-radius: 4px; position: relative; }
  .tl-msg::before { content: ''; position: absolute; left: -21px; top: 12px; width: 8px; height: 8px; background: var(--success); border-radius: 50%; }
  .tl-llm { padding: 8px 12px; margin: 4px 0; background: var(--card-bg); border: 1px solid var(--border); border-radius: 4px; position: relative; }
  .tl-llm::before { content: ''; position: absolute; left: -21px; top: 12px; width: 8px; height: 8px; background: var(--accent); border-radius: 50%; }
  .tl-llm-header { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
  .tl-toolgroup { padding: 4px 12px; margin: 2px 0; font-size: 0.82em; position: relative; color: var(--muted); border-left: 2px solid var(--border); margin-left: 4px; padding-left: 10px; }
  .tl-toolgroup::before { content: ''; position: absolute; left: -21px; top: 8px; width: 4px; height: 4px; background: var(--muted); border-radius: 50%; }
  .tl-tools-inline { font-size: 0.95em; }
  .tl-error { border-color: rgba(248,81,73,0.3) !important; background: rgba(248,81,73,0.05) !important; }
  .tl-badge { display: inline-block; padding: 1px 6px; border-radius: 3px; font-size: 0.7em; font-weight: 700; letter-spacing: 0.3px; vertical-align: middle; }
  .tl-badge-msg { background: rgba(63,185,80,0.15); color: var(--success); }
  .tl-badge-llm { background: rgba(56,132,244,0.15); color: var(--accent); }
  .tl-badge-sub { background: rgba(210,153,34,0.15); color: var(--warning); }
  .tl-badge-tool { background: rgba(139,148,158,0.15); color: var(--muted); }
  .tl-model { font-weight: 600; font-size: 0.9em; }
  .tl-action { display: inline-block; padding: 1px 6px; border-radius: 3px; font-size: 0.68em; font-weight: 600; letter-spacing: 0.2px; }
  .act-route { background: rgba(139,148,158,0.12); color: var(--muted); }
  .act-plan { background: rgba(56,132,244,0.1); color: var(--accent); }
  .act-analyze { background: rgba(163,113,247,0.1); color: #a371f7; }
  .act-reason { background: rgba(210,153,34,0.1); color: var(--warning); }
  .act-edit { background: rgba(63,185,80,0.1); color: var(--success); }
  .act-respond { background: rgba(56,132,244,0.12); color: var(--accent); }
  .act-generate { background: rgba(63,185,80,0.15); color: var(--success); font-weight: 700; }
  .tl-err-tag { display: inline-block; padding: 1px 6px; border-radius: 3px; font-size: 0.7em; font-weight: 700; background: rgba(248,81,73,0.15); color: var(--danger); }
  .tl-detail { display: flex; justify-content: space-between; font-size: 0.82em; margin-top: 4px; color: var(--fg); }
  .tl-cost { font-weight: 600; color: var(--warning); }
  .tl-delta { color: var(--warning); font-size: 0.9em; }
  .tl-reasoning { color: #a371f7; font-size: 0.9em; font-weight: 600; }
  .tl-cached { color: var(--success); font-size: 0.9em; }
  .tl-gap { color: var(--warning); font-weight: 600; }
  .tl-meta { font-size: 0.78em; color: var(--muted); margin-top: 2px; }
  .tl-running { font-size: 0.75em; color: var(--muted); margin-top: 3px; padding-top: 3px; border-top: 1px dashed var(--border); }
  .tl-text { font-size: 0.85em; }
  .tl-msg .tl-meta { display: block; margin-top: 4px; }
  .tl-efficiency { font-size: 0.76em; margin-top: 3px; display: flex; gap: 10px; flex-wrap: wrap; align-items: center; }
  .tl-eff-tag { display: inline-block; padding: 1px 5px; border-radius: 3px; font-size: 0.9em; font-weight: 600; }
  .tl-eff-productive { background: rgba(63,185,80,0.1); color: var(--success); }
  .tl-eff-exploration { background: rgba(139,148,158,0.1); color: var(--muted); }
  .tl-eff-routing { background: rgba(210,153,34,0.08); color: var(--warning); }
  .tl-eff-item { color: var(--muted); }
  .tl-eff-good { color: var(--success); }
  .tl-eff-warn { color: var(--warning); }
  .tl-eff-bad { color: var(--danger); }

  /* Legend */
  .legend { margin-top: 24px; border: 1px solid var(--border); border-radius: 6px; font-size: 0.85em; }
  .legend summary { padding: 10px 14px; cursor: pointer; color: var(--accent); font-weight: 600; font-size: 0.8em; text-transform: uppercase; letter-spacing: 0.3px; }
  .legend summary:hover { background: var(--card-bg); }
  .legend dl { padding: 0 14px 14px; margin: 0; }
  .legend dt { font-weight: 600; margin-top: 10px; color: var(--fg); }
  .legend dd { margin: 3px 0 0 0; color: var(--muted); line-height: 1.5; }
</style>
</head>
<body>
<h1>Copilot Usage Dashboard</h1>

<div class="tabs">
  <div class="tab active" data-tab="overview">Overview</div>
  <div class="tab" data-tab="sessions">Sessions</div>
</div>

<div id="overview" class="tab-content active">
  <div class="loading" id="overview-loading">Loading...</div>
  <div id="overview-content" style="display:none;">
    <div id="billing-period-row" style="display:flex;align-items:center;gap:10px;margin-bottom:6px;">
      <select id="billing-period-select" style="background:var(--card-bg);color:var(--fg);border:1px solid var(--border);border-radius:4px;padding:4px 10px;font-size:0.85em;cursor:pointer;min-width:160px;">
        <option value="">Loading\u2026</option>
      </select>
    </div>
    <div id="billing-section"></div>
    <h2>Workflow</h2>
    <div class="metrics" id="workflow-metrics"></div>
    <h2>Usage</h2>
    <div class="metrics" id="overview-cards"></div>
    <h2>Daily Token Usage (last 30 days)</h2>
    <div class="chart-container"><canvas id="dailyChart"></canvas></div>
    <h2>Model Distribution</h2>
    <div class="chart-container"><canvas id="modelChart"></canvas></div>
    <h2>Top Sessions</h2>
    <table id="topSessionsTable"><thead><tr>
      <th>Date</th><th>Tokens</th><th>Premium reqs</th><th>Cost (Jun)</th><th>Model</th><th>Msgs</th>
    </tr></thead><tbody></tbody></table>
  </div>
</div>

<div id="sessions" class="tab-content">
  <div class="filters">
    <label>From: <input type="date" id="dateFrom"></label>
    <label>To: <input type="date" id="dateTo"></label>
    <button id="filterBtn">Filter</button>
  </div>
  <table id="sessionsTable"><thead><tr>
    <th data-sort="startTime">Date</th>
    <th data-sort="totalTokens">Tokens</th>
    <th data-sort="_costNow">Premium reqs</th>
    <th data-sort="_costJun">Cost (Jun)</th>
    <th data-sort="_costPerMsg">$ / Msg</th>
    <th data-sort="dominantModel">Model</th>
    <th data-sort="repository">Repo</th>
    <th data-sort="userMessageCount">Msgs</th>
    <th data-sort="durationMs">Duration</th>
  </tr></thead><tbody></tbody></table>
</div>

<div id="sessionDetail" class="tab-content">
  <span class="detail-back" id="detailBack">&larr; Back to sessions</span>
  <div id="detailContent"></div>
</div>

<script nonce="${nonce}">
const vscode = acquireVsCodeApi();
let overviewData = null;
let sessionsData = [];
let sortCol = 'startTime';
let sortDir = -1;

// Billing lookup tables (in sync with src/stats/billingCalculator.ts).
// Aliases sorted longest-first so e.g. "gpt-5.4-mini" matches before "gpt-5.4".
// All pricing is per 1M tokens; 1 AI credit = $0.01 USD.
const MODEL_TABLE = [
  { aliases: ['claude-haiku-4.5','haiku-4.5'],          mult: 0.33, input: 1.00, cachedInput: 0.10, cacheWrite: 1.25, output: 5.00 },
  { aliases: ['claude-sonnet-4.6','sonnet-4.6'],        mult: 1,    input: 3.00, cachedInput: 0.30, cacheWrite: 3.75, output: 15.00 },
  { aliases: ['claude-sonnet-4.5','sonnet-4.5'],        mult: 1,    input: 3.00, cachedInput: 0.30, cacheWrite: 3.75, output: 15.00 },
  { aliases: ['claude-sonnet-4','sonnet-4'],            mult: 1,    input: 3.00, cachedInput: 0.30, cacheWrite: 3.75, output: 15.00 },
  { aliases: ['claude-opus-4.6-fast','opus-4.6-fast'],  mult: 30,   input: 30.00, cachedInput: 3.00, cacheWrite: 37.50, output: 150.00 },
  { aliases: ['claude-opus-4.6','opus-4.6'],            mult: 3,    input: 5.00, cachedInput: 0.50, cacheWrite: 6.25, output: 25.00 },
  { aliases: ['claude-opus-4.7','opus-4.7'],            mult: 15,   input: 5.00, cachedInput: 0.50, cacheWrite: 6.25, output: 25.00 },
  { aliases: ['claude-opus-4.5','opus-4.5'],            mult: 3,    input: 5.00, cachedInput: 0.50, cacheWrite: 6.25, output: 25.00 },
  { aliases: ['gpt-5.2-codex'],                          mult: 1,    input: 1.75, cachedInput: 0.175, output: 14.00 },
  { aliases: ['gpt-5.3-codex'],                          mult: 1,    input: 1.75, cachedInput: 0.175, output: 14.00 },
  { aliases: ['gpt-5.4-mini'],                           mult: 0.33, input: 0.75, cachedInput: 0.075, output: 4.50 },
  { aliases: ['gpt-5.4-nano'],                           mult: 0.25, input: 0.20, cachedInput: 0.02,  output: 1.25 },
  { aliases: ['gpt-5.4'],                                mult: 1,    input: 2.50, cachedInput: 0.25,  output: 15.00 },
  { aliases: ['gpt-5.5'],                                mult: 7.5,  input: 5.00, cachedInput: 0.50,  output: 30.00 },
  { aliases: ['gpt-5.2'],                                mult: 1,    input: 1.75, cachedInput: 0.175, output: 14.00 },
  { aliases: ['gpt-5-mini'],                             mult: 0,    input: 0.25, cachedInput: 0.025, output: 2.00 },
  { aliases: ['gpt-4.1'],                                mult: 0,    input: 2.00, cachedInput: 0.50,  output: 8.00 },
  { aliases: ['gpt-4o-mini','gpt-4o-mini-2024-07-18'],   mult: 0,    input: 0.15, cachedInput: 0.075, output: 0.60 },
  { aliases: ['gpt-4o'],                                 mult: 0,    input: 2.50, cachedInput: 1.25,  output: 10.00 },
  { aliases: ['gemini-2.5-pro'],                         mult: 1,    input: 1.25, cachedInput: 0.125, output: 10.00 },
  { aliases: ['gemini-3-flash'],                         mult: 0.33, input: 0.50, cachedInput: 0.05,  output: 3.00 },
  { aliases: ['gemini-3.1-pro'],                         mult: 1,    input: 2.00, cachedInput: 0.20,  output: 12.00 },
  { aliases: ['grok-code-fast-1','grok-code-fast'],      mult: 0.25, input: 0.20, cachedInput: 0.02,  output: 1.50 },
  { aliases: ['raptor-mini'],                            mult: 0,    input: 0.25, cachedInput: 0.025, output: 2.00 },
  { aliases: ['goldeneye'],                              mult: 1,    input: 1.25, cachedInput: 0.125, output: 10.00 },
];
const ALIAS_INDEX = MODEL_TABLE
  .flatMap(e => e.aliases.map(a => ({ alias: a, entry: e })))
  .sort((a, b) => b.alias.length - a.alias.length);
const DEFAULT_ENTRY = { mult: 1, input: 3, cachedInput: 0.30, output: 15, cacheWrite: 3.75 };

function resolveModel(model) {
  if (!model) return { entry: DEFAULT_ENTRY, resolved: false };
  const norm = String(model).toLowerCase()
    .replace(/^(anthropic\\/|openai\\/|google\\/|xai\\/|github\\/)/, '')
    .replace(/_/g, '-')
    .trim();
  for (const { alias, entry } of ALIAS_INDEX) {
    if (norm.includes(alias)) return { entry, resolved: true };
  }
  return { entry: DEFAULT_ENTRY, resolved: false };
}
function getMultiplier(model) { return resolveModel(model).entry.mult; }
function getCostUSD(model, inTok, outTok, cachedTok, cacheWriteTok) {
  const { entry } = resolveModel(model);
  cachedTok = cachedTok || 0; cacheWriteTok = cacheWriteTok || 0;
  const uncachedIn = Math.max(0, (inTok || 0) - cachedTok - cacheWriteTok);
  const cw = entry.cacheWrite || entry.input;
  return (uncachedIn * entry.input + cachedTok * entry.cachedInput + cacheWriteTok * cw + (outTok || 0) * entry.output) / 1_000_000;
}
function sessionBilling(s) {
  const model = s.dominant_model || s.dominantModel || '';
  const msgs = s.user_message_count ?? s.userMessageCount ?? 0;
  const inTok = s.total_input_tokens ?? s.totalInputTokens ?? 0;
  const outTok = s.total_output_tokens ?? s.totalOutputTokens ?? 0;
  const mult = getMultiplier(model);
  const reqs = Math.round(msgs * mult * 10) / 10;
  // Prefer authoritative server-computed cost if present.
  const costUSD = (typeof s.costUSD === 'number') ? s.costUSD
                : (typeof s.cost_usd === 'number') ? s.cost_usd
                : getCostUSD(model, inTok, outTok);
  const credits = Math.round(costUSD * 100 * 10) / 10;
  return { reqs, mult, credits, costUSD };
}

// Tab switching
document.querySelectorAll('.tab').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
    tab.classList.add('active');
    document.getElementById(tab.dataset.tab).classList.add('active');
    if (tab.dataset.tab === 'sessions' && sessionsData.length === 0) {
      vscode.postMessage({ type: 'requestSessions', groupBy: 'date' });
    }
  });
});

vscode.postMessage({ type: 'requestOverview' });

window.addEventListener('message', e => {
  const msg = e.data;
  switch (msg.type) {
    case 'overview': renderOverview(msg.data); break;
    case 'sessions': renderSessions(msg.data); break;
    case 'sessionDetail': renderDetail(msg.data); break;
    case 'billingStatus': renderBilling(msg.data); break;
  }
});

function renderOverview(data) {
  overviewData = data;
  document.getElementById('overview-loading').style.display = 'none';
  document.getElementById('overview-content').style.display = 'block';

  populateBillingPeriodSelect(data.availableMonths || []);
  renderBilling(data.billing);
  renderWorkflow(data.workflow);
  renderMetrics(data.aggregate);
  renderDailyChart(data.dailyStats);
  renderModelChart(data.modelStats);
  renderTopSessions(data.topSessions);
}

// Keyed period options map populated by populateBillingPeriodSelect.
let _periodOptions = {};

function populateBillingPeriodSelect(months) {
  const sel = document.getElementById('billing-period-select');
  if (!sel) { return; }
  _periodOptions = {};
  sel.innerHTML = '';
  months.forEach((m, i) => {
    const key = 'month_' + i;
    _periodOptions[key] = m;
    const opt = document.createElement('option');
    opt.value = key;
    opt.textContent = m.label;
    if (i === 0) { opt.selected = true; }
    sel.appendChild(opt);
  });
  // Add "All Time" option.
  _periodOptions['alltime'] = { label: 'All Time', start: 0, end: 253402300800000 };
  const optAll = document.createElement('option');
  optAll.value = 'alltime';
  optAll.textContent = 'All Time (total)';
  sel.appendChild(optAll);

  sel.onchange = function() {
    const p = _periodOptions[this.value];
    if (p) {
      vscode.postMessage({ type: 'requestBilling', periodStart: p.start, periodEnd: p.end, periodLabel: p.label });
    }
  };
}

function renderBilling(b) {
  if (!b) { document.getElementById('billing-section').innerHTML = ''; return; }

  const pctClass = (p) => p > 80 ? 'high' : p > 50 ? 'mid' : 'low';
  const isHistorical = !!b.isHistoricalPeriod;

  // Header: show period label and days remaining (current month only).
  let header = '<h2>Billing \u2014 ' + esc(b.plan.toUpperCase()) + ' Plan';
  if (b.periodLabel) { header += ' | ' + esc(b.periodLabel); }
  if (!isHistorical && b.daysRemaining > 0) { header += ' (' + b.daysRemaining + ' days left)'; }
  header += '</h2>';

  let html = header;
  html += '<div class="billing-grid">';

  // Current plan card
  html += '<div class="billing-card">';
  html += '<h3>Current (Request-based)</h3>';
  if (isHistorical) {
    // Historical: show total used, no quota bar.
    html += '<div class="headline">' + b.current.used.toFixed(1) + ' <span style="font-size:0.5em;color:var(--muted)">reqs (total)</span></div>';
    html += '<div class="sub">Period total \u2014 quota not applicable</div>';
  } else {
    html += '<div class="headline">' + b.current.used.toFixed(1) + ' <span style="font-size:0.5em;color:var(--muted)">/ ' + b.current.quota + ' reqs</span></div>';
    html += '<div class="sub">' + b.current.pct + '% used this month</div>';
    html += '<div class="progress-bar"><div class="progress-fill ' + pctClass(b.current.pct) + '" style="width:' + Math.min(b.current.pct, 100) + '%"></div></div>';
  }
  html += '<div class="billing-breakdown">';
  html += '<div class="row" style="font-weight:600"><span>Only your messages count</span><span>x multiplier</span></div>';
  for (const item of b.current.breakdown.slice(0, 4)) {
    html += '<div class="row"><span>' + esc(item.model) + '</span><span>' + item.requests + ' msgs -> ' + item.cost + ' reqs</span></div>';
  }
  html += '</div></div>';

  // New plan card
  html += '<div class="billing-card">';
  html += '<h3>From June 1 (Token-based)</h3>';
  if (isHistorical) {
    // Historical: show total credits and cost, no quota bar.
    html += '<div class="headline">' + b.new.used.toFixed(1) + ' <span style="font-size:0.5em;color:var(--muted)">credits (total)</span></div>';
    html += '<div class="sub">$' + b.new.costUSD.toFixed(2) + ' USD \u2014 quota not applicable</div>';
  } else {
    const quotaLabel = b.new.quota === null ? 'n/a' : (b.new.quota + ' credits' + (b.new.quotaIsPromotional ? ' (promo)' : ''));
    const pctLabel = b.new.pct === null ? 'quota n/a' : (b.new.pct + '% used');
    const pctWidth = b.new.pct === null ? 0 : Math.min(b.new.pct, 100);
    const pctCls = b.new.pct === null ? 'low' : pctClass(b.new.pct);
    html += '<div class="headline">' + b.new.used.toFixed(1) + ' <span style="font-size:0.5em;color:var(--muted)">/ ' + esc(quotaLabel) + '</span></div>';
    html += '<div class="sub">' + esc(pctLabel) + ' | $' + b.new.costUSD.toFixed(2) + ' USD equivalent</div>';
    html += '<div class="progress-bar"><div class="progress-fill ' + pctCls + '" style="width:' + pctWidth + '%"></div></div>';
  }
  html += '<div class="billing-breakdown">';
  html += '<div class="row" style="font-weight:600"><span>ALL tokens count (incl. tools)</span><span>Credits</span></div>';
  for (const item of b.new.breakdown.slice(0, 4)) {
    html += '<div class="row"><span>' + esc(item.model) + '</span><span>' + item.credits.toFixed(1) + ' cr (' + fmt(item.inputTokens) + ' in / ' + fmt(item.outputTokens) + ' out)</span></div>';
  }
  html += '</div></div>';
  html += '</div>';

  html += '<div class="billing-comparison">';
  if (isHistorical) {
    html += '<div class="note">Showing period totals. Monthly quota bars are only applicable for the current billing period.</div>';
  } else {
    html += '<div class="note">Premium-request and AI-credit allowances use different units and cannot be compared directly. Both views describe the same underlying usage.</div>';
  }
  if (b.notes && b.notes.length) {
    for (const n of b.notes) {
      html += '<div class="note">[i] ' + esc(n) + '</div>';
    }
  }
  if (b.new.cachedTokensCaptured === false && !b.new.cachedTokensEstimated) {
    html += '<div class="note">[!] Cached / cache-write tokens are not present in the logs - the June cost shown is an UPPER BOUND.</div>';
  } else if (b.new.cachedTokensEstimated && !b.new.cachedTokensCaptured) {
    html += '<div class="note">[~] Cached token values are ESTIMATED based on provider caching rules (prefix matching, TTL, min thresholds). Actual savings may vary.</div>';
  } else if (b.new.cachedTokensCaptured && b.new.cachedTokensEstimated) {
    html += '<div class="note">[~] Some cached token values are measured from logs; others are estimated based on provider caching rules.</div>';
  }
  html += '</div>';

  document.getElementById('billing-section').innerHTML = html;
}

function renderWorkflow(wf) {
  if (!wf || wf.turns === 0) { document.getElementById('workflow-metrics').innerHTML = '<div style="color:var(--muted);font-size:0.85em">No workflow data yet</div>'; return; }
  document.getElementById('workflow-metrics').innerHTML = [
    metric('Turns/Message', wf.turnsPerMsg),
    metric('Tools/Turn', wf.toolsPerTurn),
    metric('Tool Calls', fmt(wf.toolCalls)),
    metric('Subagents', fmt(wf.subagents)),
    metric('Errors', fmt(wf.errors)),
  ].join('');
}

function renderMetrics(a) {
  document.getElementById('overview-cards').innerHTML = [
    metric('Sessions', fmt(a.totalSessions)),
    metric('Tokens', fmt(a.totalTokens)),
    metric('Requests', fmt(a.totalRequests)),
    metric('Messages', fmt(a.totalMessages)),
    metric('Avg/Session', fmt(a.avgTokensPerSession)),
    metric('Avg/Request', fmt(a.avgTokensPerRequest)),
  ].join('');
}

function metric(label, value) {
  return '<div class="metric"><div class="label">' + esc(label) + '</div><div class="value">' + esc(String(value)) + '</div></div>';
}

function renderDailyChart(dailyStats) {
  const canvas = document.getElementById('dailyChart');
  const ctx = canvas.getContext('2d');
  const sorted = [...dailyStats].sort((a, b) => a.date.localeCompare(b.date)).slice(-30);
  drawBarChart(ctx, canvas, sorted.map(d => d.date.slice(5)), sorted.map(d => d.total_tokens || d.totalTokens || 0));
}

function renderModelChart(modelStats) {
  const canvas = document.getElementById('modelChart');
  const ctx = canvas.getContext('2d');
  const colors = ['#4dc9f6','#f67019','#f53794','#537bc4','#acc236','#166a8f','#00a950','#58595b'];
  drawPieChart(ctx, canvas, modelStats.map(m => m.model), modelStats.map(m => m.total_tokens || m.totalTokens || 0), colors);
}

function renderTopSessions(topSessions) {
  const tbody = document.querySelector('#topSessionsTable tbody');
  tbody.innerHTML = topSessions.map(s => {
    const date = new Date(s.startTime).toLocaleDateString();
    const b = sessionBilling(s);
    return '<tr><td>' + esc(date) + '</td><td>' + fmt(s.total_tokens || s.totalTokens || 0) + '</td><td>' + b.reqs + ' x' + b.mult + '</td><td>$' + b.costUSD.toFixed(3) + '</td><td><span class="badge">' + esc(s.dominant_model || s.dominantModel || '') + '</span></td><td>' + (s.user_message_count || s.userMessageCount || 0) + '</td></tr>';
  }).join('');
}

function renderSessions(data) {
  sessionsData = data.sessions;
  renderSessionsTable();
}

function renderSessionsTable() {
  // Pre-compute virtual sort fields
  const enriched = sessionsData.map(s => {
    const b = sessionBilling(s);
    const msgs = s.user_message_count ?? s.userMessageCount ?? 0;
    return Object.assign({}, s, {
      _costNow: b.reqs,
      _costJun: b.costUSD,
      _costPerMsg: msgs > 0 ? b.costUSD / msgs : 0,
      _billing: b,
    });
  });
  const sorted = enriched.sort((a, b) => {
    const aVal = a[sortCol] ?? a[toSnake(sortCol)] ?? 0;
    const bVal = b[sortCol] ?? b[toSnake(sortCol)] ?? 0;
    if (typeof aVal === 'string') return sortDir * aVal.localeCompare(bVal);
    return sortDir * (aVal - bVal);
  });
  const tbody = document.querySelector('#sessionsTable tbody');
  tbody.innerHTML = sorted.map(s => {
    const date = new Date(s.start_time || s.startTime).toLocaleString();
    const tokens = s.total_tokens ?? s.totalTokens ?? 0;
    const model = s.dominant_model || s.dominantModel || '';
    const msgs = s.user_message_count ?? s.userMessageCount ?? 0;
    const dur = fmtDur(s.duration_ms ?? s.durationMs ?? 0);
    const sid = s.id || s.session_id || '';
    const b = s._billing;
    const cpm = msgs > 0 ? '$' + (b.costUSD / msgs).toFixed(3) : '-';
    const repo = s.repository || '';
    const repoShort = repo ? (repo.split('/').pop() || repo) : '';
    const ds = s.data_source || s.dataSource || '';
    const dsBadge = ds === 'otel' ? '<span class="badge badge-otel">OTel</span>' : ds === 'hybrid' ? '<span class="badge badge-hybrid">Hyb</span>' : '';
    const audit = s.cost_audit_state || s.costAuditState || '';
    const auditBadge = audit && audit !== 'measured' ? ' <span class="badge badge-hybrid">' + esc(audit) + '</span>' : '';
    return '<tr class="clickable" data-sid="' + sid + '"><td>' + esc(date) + '</td><td>' + fmt(tokens) + '</td><td>' + b.reqs + ' x' + b.mult + '</td><td>$' + b.costUSD.toFixed(3) + auditBadge + '</td><td>' + cpm + '</td><td><span class="badge">' + esc(model) + '</span></td><td>' + (repoShort ? esc(repoShort) : '<span class="muted">-</span>') + ' ' + dsBadge + '</td><td>' + msgs + '</td><td>' + esc(dur) + '</td></tr>';
  }).join('');
  tbody.querySelectorAll('tr.clickable').forEach(row => {
    row.addEventListener('click', () => {
      vscode.postMessage({ type: 'requestSessionDetail', sessionId: row.dataset.sid });
      document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
      document.getElementById('sessionDetail').classList.add('active');
    });
  });
}

document.querySelectorAll('#sessionsTable th[data-sort]').forEach(th => {
  th.addEventListener('click', () => {
    const col = th.dataset.sort;
    if (sortCol === col) { sortDir *= -1; } else { sortCol = col; sortDir = -1; }
    renderSessionsTable();
  });
});

document.getElementById('filterBtn').addEventListener('click', () => {
  vscode.postMessage({ type: 'requestSessions', groupBy: 'date', dateFrom: document.getElementById('dateFrom').value || undefined, dateTo: document.getElementById('dateTo').value || undefined });
});

document.getElementById('detailBack').addEventListener('click', () => {
  document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
  document.getElementById('sessions').classList.add('active');
  document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
  document.querySelector('[data-tab="sessions"]').classList.add('active');
});

function renderDetail(data) {
  const s = data.session;
  const st = data.stats;
  const a = data.analytics;
  const parts = [];

  // Session header with repo/branch badge and data source
  let headerExtra = '';
  const repo = s.repository || '';
  const branch = s.branch || '';
  if (repo) {
    const repoName = repo.split('/').pop() || repo;
    headerExtra += ' <span class="badge badge-repo" title="' + esc(repo) + '">' + esc(repoName) + (branch ? ':' + esc(branch) : '') + '</span>';
  }
  const ds = s.data_source || s.dataSource || st.data_source || st.dataSource || 'jsonl';
  const dsBadge = ds === 'otel' ? '<span class="badge badge-otel" title="High-fidelity data from OTel traces">OTel</span>'
    : ds === 'hybrid' ? '<span class="badge badge-hybrid" title="Combined OTel + JSONL data">Hybrid</span>'
    : '<span class="badge badge-jsonl" title="Parsed from JSONL debug logs">JSONL</span>';
  headerExtra += ' ' + dsBadge;

  parts.push('<h2>Session ' + esc((s.id || '').substring(0, 8)) + ' &mdash; ' + new Date(s.start_time || s.startTime).toLocaleString() + headerExtra + '</h2>');

  // Billing costs
  const b = sessionBilling(st);
  const msgs = st.user_message_count ?? st.userMessageCount ?? 0;
  const totalTok = st.total_tokens ?? st.totalTokens ?? 0;
  const costPerMsg = msgs > 0 ? (b.costUSD / msgs) : 0;

  // Summary row - the metrics that actually matter
  parts.push('<div class="metrics">');
  parts.push(metric('Cost (Jun 2026)', '$' + b.costUSD.toFixed(3)));
  parts.push(metric('Audit state', st.cost_audit_state || st.costAuditState || 'unknown'));
  parts.push(metric('Cost / Message', msgs > 0 ? '$' + costPerMsg.toFixed(3) : '-'));
  parts.push(metric('Premium reqs', b.reqs + ' x' + b.mult));
  parts.push(metric('Messages', String(msgs)));
  parts.push(metric('Tokens', fmt(totalTok)));
  parts.push(metric('Duration', a ? (a.activeMinutes + ' min') : '-'));
  // Reasoning tokens (only show when present)
  if (a && a.totalReasoningTokens > 0) {
    parts.push(metric('Reasoning', fmt(a.totalReasoningTokens) + ' (' + a.reasoningPct + '%)'));
  }
  // Cache metrics
  if (a && a.totalCachedTokens > 0) {
    parts.push(metric('Cache hit rate', a.cacheHitRate + '%' + (a.dataConfidence === 'estimated' ? ' ~est' : '')));
  }
  if (a && a.cacheSavingsUSD > 0.001) {
    parts.push(metric('Cache savings', '$' + a.cacheSavingsUSD.toFixed(3)));
  }
  parts.push('</div>');

  if (a) {
    // Optimization signals (top priority)
    if (a.signals && a.signals.length > 0) {
      parts.push('<div class="signals-box">');
      for (const sig of a.signals) {
        parts.push('<div class="signal">[!] ' + esc(sig) + '</div>');
      }
      parts.push('</div>');
    }

    // Three-column analytics grid
    parts.push('<div class="analytics-grid">');

    // Column 1: Cost shape
    parts.push('<div class="analytics-col">');
    parts.push('<h3>Cost Shape</h3>');
    parts.push(statRow('Cost / message', msgs > 0 ? '$' + costPerMsg.toFixed(4) : '-'));
    parts.push(statRow('Most expensive turn', a.insights ? '$' + a.insights.expensiveTurnCost.toFixed(4) : '-'));
    parts.push(statRow('Median turn', a.insights ? '$' + a.insights.medianTurnCost.toFixed(4) : '-'));
    if (a.reasoningCostUSD > 0.001) {
      parts.push(statRow('Reasoning cost', '$' + a.reasoningCostUSD.toFixed(4) + ' (' + a.reasoningPct + '% of output)'));
    }
    if (a.cacheSavingsUSD > 0.001) {
      parts.push(statRow('Cache savings', '$' + a.cacheSavingsUSD.toFixed(4) + ' (' + a.cacheHitRate + '% hit)'));
    }
    parts.push(statRow('Wasted (errors)', a.wastedPct > 0 ? fmt(a.wastedTokens) + ' (' + a.wastedPct + '%)' : 'None'));
    parts.push(statRow('Subagent share', a.subagentPct + '%'));
    parts.push('</div>');

    // Column 2: Performance
    parts.push('<div class="analytics-col">');
    parts.push('<h3>Performance</h3>');
    parts.push(statRow('Avg TTFT', a.avgTtft + ' ms'));
    parts.push(statRow('P90 TTFT', a.p90Ttft + ' ms'));
    parts.push(statRow('Avg request time', fmtDur(a.avgRequestDuration)));
    parts.push(statRow('Error rate', a.errorRate + '%'));
    parts.push(statRow('Avg think time', a.avgThinkTime > 0 ? a.avgThinkTime + 's' : '-'));
    parts.push('</div>');

    // Column 3: Workflow shape
    parts.push('<div class="analytics-col">');
    parts.push('<h3>Workflow Shape</h3>');
    parts.push(statRow('Turns/message', String(a.turnsPerMessage)));
    parts.push(statRow('Tools/turn', String(a.toolsPerTurn)));
    parts.push(statRow('Unique tools', String(a.uniqueTools)));
    parts.push(statRow('Input/Output ratio', a.inputOutputRatio + ':1'));
    parts.push(statRow('Tokens/minute', fmt(a.tokensPerMinute)));
    parts.push('</div>');
    parts.push('</div>');

    // Model breakdown table
    if (a.modelBreakdown && a.modelBreakdown.length > 0) {
      const hasReasoning = a.modelBreakdown.some(m => m.reasoningTokens > 0);
      const hasCached = a.modelBreakdown.some(m => m.cachedTokens > 0);
      parts.push('<h2>Model Breakdown</h2>');
      parts.push('<table><thead><tr><th>Model</th><th>Requests</th><th>Tokens</th><th>Share</th>');
      if (hasReasoning) { parts.push('<th>Reasoning</th>'); }
      if (hasCached) { parts.push('<th>Cached</th>'); }
      parts.push('</tr></thead><tbody>');
      for (const m of a.modelBreakdown) {
        parts.push('<tr><td><span class="badge">' + esc(m.model) + '</span></td><td>' + m.requests + '</td><td>' + fmt(m.tokens) + '</td><td>' + m.pct + '%</td>');
        if (hasReasoning) { parts.push('<td>' + (m.reasoningTokens > 0 ? fmt(m.reasoningTokens) : '-') + '</td>'); }
        if (hasCached) { parts.push('<td>' + (m.cachedTokens > 0 ? fmt(m.cachedTokens) : '-') + '</td>'); }
        parts.push('</tr>');
      }
      parts.push('</tbody></table>');
    }

    // Top tools table
    if (a.topTools && a.topTools.length > 0) {
      parts.push('<h2>Tool Usage</h2>');
      parts.push('<table><thead><tr><th>Tool</th><th>Calls</th><th>Avg Time</th><th>Errors</th></tr></thead><tbody>');
      for (const t of a.topTools) {
        const errBadge = t.errors > 0 ? '<span style="color:var(--danger)">' + t.errors + '</span>' : '0';
        parts.push('<tr><td>' + esc(t.name) + '</td><td>' + t.count + '</td><td>' + fmtDur(t.avgMs) + '</td><td>' + errBadge + '</td></tr>');
      }
      parts.push('</tbody></table>');
    }

    // Deep Workflow Insights
    if (a.insights) {
      const ins = a.insights;
      parts.push('<h2>Workflow Insights</h2>');
      parts.push('<div class="analytics-grid">');

      // Column 1: Tool taxonomy
      parts.push('<div class="analytics-col">');
      parts.push('<h3>What Tools Did</h3>');
      const totalCalls = ins.explorationCalls + ins.productionCalls + ins.metaCalls;
      const prodPct = totalCalls > 0 ? Math.round((ins.productionCalls / totalCalls) * 100) : 0;
      const metaPct = totalCalls > 0 ? Math.round((ins.metaCalls / totalCalls) * 100) : 0;
      parts.push(statRow('Production (edits/runs)', ins.productionCalls + ' (' + prodPct + '%)'));
      parts.push(statRow('Exploration (read/search)', ins.explorationCalls + ' (' + ins.explorationPct + '%)'));
      parts.push(statRow('Meta (todo/memory)', ins.metaCalls + ' (' + metaPct + '%)'));
      parts.push(statRow('Productive turn tokens', fmt(ins.productionTokens)));
      parts.push(statRow('Non-productive tokens', fmt(ins.explorationTokens)));
      // 3-way bar
      parts.push('<div class="insight-bar">');
      parts.push('<div class="insight-bar-fill prod" style="width:' + prodPct + '%" title="Production ' + prodPct + '%"></div>');
      parts.push('<div class="insight-bar-fill expl" style="width:' + ins.explorationPct + '%" title="Exploration ' + ins.explorationPct + '%"></div>');
      parts.push('<div class="insight-bar-fill meta" style="width:' + metaPct + '%" title="Meta ' + metaPct + '%"></div>');
      parts.push('</div>');
      parts.push('<div class="insight-bar-labels"><span>Prod ' + prodPct + '%</span><span>Expl ' + ins.explorationPct + '%</span><span>Meta ' + metaPct + '%</span></div>');
      parts.push('</div>');

      // Column 2: Context dynamics
      parts.push('<div class="analytics-col">');
      parts.push('<h3>Context Dynamics</h3>');
      parts.push(statRow('Avg growth/turn', '+' + fmt(ins.avgContextGrowthPerTurn) + ' tok'));
      parts.push(statRow('Peak context', fmt(ins.maxContextReached) + ' tok'));
      parts.push(statRow('Utilization', ins.contextUtilizationPct + '% of capacity'));
      parts.push(statRow('Saturation turn', ins.contextSaturationTurn > 0 ? '#' + ins.contextSaturationTurn : 'Never'));
      parts.push(statRow('Bloat ratio', ins.bloatRatio > 0 ? ins.bloatRatio + 'x (late vs early)' : '-'));
      const utilPct = Math.min(ins.contextUtilizationPct, 100);
      const utilClass = utilPct > 80 ? 'high' : utilPct > 50 ? 'mid' : 'low';
      parts.push('<div class="insight-bar"><div class="insight-bar-fill ctx-' + utilClass + '" style="width:' + utilPct + '%"></div></div>');
      parts.push('<div class="insight-bar-labels"><span>0%</span><span>Context window</span><span>100%</span></div>');
      parts.push('</div>');

      // Column 3: Cost efficiency (the actionable column)
      parts.push('<div class="analytics-col">');
      parts.push('<h3>Cost Efficiency</h3>');
      const meEff = ins.marginalEfficiencyPct;
      const meCls = meEff > 30 ? 'eff-good' : meEff > 15 ? 'eff-normal' : 'eff-bad';
      parts.push(statRow('Total cost', '$' + b.costUSD.toFixed(3)));
      parts.push(statRow('New-work cost', '$' + ins.totalMarginalCost.toFixed(3)));
      parts.push('<div class="stat-row"><span class="stat-label">Marginal efficiency</span><span class="stat-value ' + meCls + '">' + meEff + '% new vs re-billed</span></div>');
      // Reasoning breakdown in cost efficiency
      if (a.totalReasoningTokens > 0) {
        parts.push(statRow('Reasoning cost', '$' + a.reasoningCostUSD.toFixed(4) + ' (' + a.reasoningPct + '% of output)'));
      }
      if (a.cacheSavingsUSD > 0.001) {
        parts.push('<div class="stat-row"><span class="stat-label">Cache savings</span><span class="stat-value eff-good">-$' + a.cacheSavingsUSD.toFixed(4) + '</span></div>');
      }
      if (ins.stallSequences > 0) {
        parts.push(statRow('Stall events', ins.stallSequences + ' (longest: ' + ins.longestStall + ' turns)'));
        parts.push('<div class="stat-row"><span class="stat-label">Stall waste</span><span class="stat-value eff-bad">' + fmt(ins.stallTokens) + ' tokens</span></div>');
      } else {
        parts.push('<div class="stat-row"><span class="stat-label">Stall events</span><span class="stat-value eff-good">None</span></div>');
      }
      parts.push('</div>');
      parts.push('</div>');

      // Per-message breakdown - REAL timestamp-based attribution
      if (ins.promptEfficiency && ins.promptEfficiency.length > 0) {
        parts.push('<h2>Per-Message Breakdown</h2>');
        parts.push('<table><thead><tr><th>#</th><th>Prompt</th><th>Turns</th><th>Productive</th><th>Tokens</th><th>Cost</th><th>Verdict</th></tr></thead><tbody>');
        for (let pi = 0; pi < ins.promptEfficiency.length; pi++) {
          const pe = ins.promptEfficiency[pi];
          const prodRatio = pe.turnsAfter > 0 ? pe.productiveTurns / pe.turnsAfter : 0;
          let verdict, vCls;
          if (pe.turnsAfter === 0) { verdict = 'Skipped'; vCls = 'eff-normal'; }
          else if (pe.turnsAfter <= 3 && prodRatio >= 0.5) { verdict = 'Efficient'; vCls = 'eff-good'; }
          else if (pe.turnsAfter > 15 || prodRatio < 0.3) { verdict = 'Wasteful'; vCls = 'eff-bad'; }
          else { verdict = 'Normal'; vCls = 'eff-normal'; }
          parts.push('<tr><td>' + (pi + 1) + '</td><td>' + pe.msgLength + ' ch</td><td>' + pe.turnsAfter + '</td><td>' + pe.productiveTurns + '/' + pe.turnsAfter + '</td><td>' + fmt(pe.tokensAfter) + '</td><td>$' + pe.costAfter.toFixed(4) + '</td><td><span class="' + vCls + '">' + verdict + '</span></td></tr>');
        }
        parts.push('</tbody></table>');
      }
    }
  }

  // Request timeline - enriched
  parts.push('<h2>Request Timeline</h2>');

  // Build interleaved timeline
  const timeline = [];
  for (const r of data.requests) {
    timeline.push({ type: 'llm', ts: r.timestamp, data: r });
  }
  if (data.messages) {
    for (const m of data.messages) {
      timeline.push({ type: 'msg', ts: m.timestamp, data: m });
    }
  }
  if (data.toolCalls) {
    for (const t of data.toolCalls) {
      timeline.push({ type: 'tool', ts: t.timestamp || t.ts, data: t });
    }
  }
  timeline.sort((a, b) => a.ts - b.ts);

  // Pre-process: group tool calls before each LLM turn
  const processedTimeline = [];
  let pendingTools = [];
  for (const ev of timeline) {
    if (ev.type === 'tool') {
      pendingTools.push(ev.data);
    } else {
      if (pendingTools.length > 0) {
        processedTimeline.push({ type: 'toolgroup', ts: pendingTools[0].timestamp || pendingTools[0].ts, tools: [...pendingTools] });
        pendingTools = [];
      }
      processedTimeline.push(ev);
    }
  }
  if (pendingTools.length > 0) {
    processedTimeline.push({ type: 'toolgroup', ts: pendingTools[0].timestamp || pendingTools[0].ts, tools: [...pendingTools] });
  }

  // Action classification helper
  function classifyAction(outTok, toolsBefore, toolsAfter) {
    // Based on output size and surrounding tool context
    if (outTok < 80) return { label: 'Routing', cls: 'act-route', desc: 'Deciding next action' };
    if (outTok < 300) {
      // Check what tools are around
      const hasEdit = toolsAfter.some(t => (t.tool_name||t.toolName||'').match(/replace|create_file|multi_replace/));
      const hasSearch = toolsBefore.some(t => (t.tool_name||t.toolName||'').match(/read_file|grep|semantic|file_search/));
      if (hasEdit) return { label: 'Planning edit', cls: 'act-plan', desc: 'Preparing code change' };
      if (hasSearch) return { label: 'Analyzing', cls: 'act-analyze', desc: 'Processing search results' };
      return { label: 'Reasoning', cls: 'act-reason', desc: 'Thinking through approach' };
    }
    if (outTok < 2000) {
      const hasEdit = toolsAfter.some(t => (t.tool_name||t.toolName||'').match(/replace|create_file|multi_replace/));
      if (hasEdit) return { label: 'Editing', cls: 'act-edit', desc: 'Making code changes' };
      return { label: 'Responding', cls: 'act-respond', desc: 'Generating response' };
    }
    return { label: 'Generating', cls: 'act-generate', desc: 'Large code generation' };
  }

  // Compute running totals and render
  let runningTokens = 0;
  let runningCredits = 0;
  let turnIndex = 0;
  let prevTs = 0;
  let prevInputTok = 0;

  parts.push('<div class="timeline">');

  for (let idx = 0; idx < processedTimeline.length; idx++) {
    const ev = processedTimeline[idx];

    if (ev.type === 'msg') {
      const m = ev.data;
      const preview = m.content_preview || m.contentPreview || '';
      const len = m.content_length || m.contentLength || 0;
      parts.push('<div class="tl-msg"><span class="tl-badge tl-badge-msg">USER</span> ');
      parts.push('<span class="tl-text">' + esc(preview.substring(0, 150)) + (len > 150 ? '...' : '') + '</span>');
      parts.push('<span class="tl-meta">' + new Date(ev.ts).toLocaleTimeString() + ' | ' + len + ' chars</span>');
      parts.push('</div>');
      turnIndex = 0;
      prevInputTok = 0;

    } else if (ev.type === 'toolgroup') {
      const tools = ev.tools;
      // Group by tool name
      const grouped = {};
      let totalDur = 0;
      let errors = 0;
      for (const t of tools) {
        const name = t.tool_name || t.toolName || 'unknown';
        const dur = t.duration || 0;
        totalDur += dur;
        if (t.status === 'error') errors++;
        if (!grouped[name]) grouped[name] = { count: 0, dur: 0, errors: 0 };
        grouped[name].count++;
        grouped[name].dur += dur;
        if (t.status === 'error') grouped[name].errors++;
      }
      const errMark = errors > 0 ? ' tl-error' : '';
      const toolSummary = Object.entries(grouped).map(([name, v]) => {
        const e = v.errors > 0 ? ' <span style="color:var(--danger)">[' + v.errors + ' failed]</span>' : '';
        return esc(name) + (v.count > 1 ? ' x' + v.count : '') + (v.dur > 1000 ? ' (' + fmtDur(v.dur) + ')' : '') + e;
      }).join(', ');

      parts.push('<div class="tl-toolgroup' + errMark + '">');
      parts.push('<span class="tl-badge tl-badge-tool">TOOLS</span> ');
      parts.push('<span class="tl-tools-inline">' + toolSummary + '</span>');
      if (totalDur > 1000) {
        parts.push('<span class="tl-meta"> | Total: ' + fmtDur(totalDur) + '</span>');
      }
      parts.push('</div>');

    } else if (ev.type === 'llm') {
      turnIndex++;
      const r = ev.data;
      const inTok = r.input_tokens || r.inputTokens || 0;
      const outTok = r.output_tokens || r.outputTokens || 0;
      const total = inTok + outTok;
      runningTokens += total;
      const cachedTok = r.cached_input_tokens ?? r.cachedInputTokens ?? 0;
      const cwTok = r.cache_write_tokens ?? r.cacheWriteTokens ?? 0;
      const reasoningTok = r.reasoning_tokens ?? r.reasoningTokens ?? 0;
      const respModel = r.response_model ?? r.responseModel ?? '';
      const costUSD = getCostUSD(r.model, inTok, outTok, cachedTok, cwTok);
      runningCredits += costUSD;
      const ttft = r.ttft || 0;
      const dur = r.duration || r.dur || 0;
      const gap = prevTs > 0 ? Math.round((ev.ts - prevTs) / 1000) : 0;
      prevTs = ev.ts + dur;

      // Context delta
      const inputDelta = prevInputTok > 0 ? inTok - prevInputTok : 0;
      prevInputTok = inTok;

      // Classify action by looking at tools before and after this LLM call
      const toolsBefore = (idx > 0 && processedTimeline[idx-1].type === 'toolgroup') ? processedTimeline[idx-1].tools : [];
      const toolsAfter = (idx < processedTimeline.length-1 && processedTimeline[idx+1].type === 'toolgroup') ? processedTimeline[idx+1].tools : [];
      const action = classifyAction(outTok, toolsBefore, toolsAfter);

      const isSub = r.is_subagent || r.isSubagent;
      const badgeClass = isSub ? 'tl-badge-sub' : 'tl-badge-llm';
      const badgeText = isSub ? 'SUB' : 'LLM';
      const subName = r.subagent_name || r.subagentName || '';
      const errClass = r.status === 'error' ? ' tl-error' : '';

      parts.push('<div class="tl-llm' + errClass + '">');

      // Classify productivity: did this turn produce real progress?
      const PROD_TOOLS = /replace|create_file|multi_replace|run_in_terminal|send_to_terminal|vscode_renameSymbol|edit_notebook/;
      const hasProductionTool = toolsAfter.some(t => (t.tool_name||t.toolName||'').match(PROD_TOOLS));
      const isProductive = hasProductionTool || outTok >= 150;

      // Marginal cost: cost of NEW input tokens (delta) + output. The rest is re-billed context from prior turns.
      const newInput = turnIndex === 1 ? inTok : Math.max(0, inputDelta);
      const marginalCost = getCostUSD(r.model, newInput, outTok);
      const marginalPct = costUSD > 0 ? Math.round((marginalCost / costUSD) * 100) : 0;

      // Header line: badge, turn#, model, action tag
      parts.push('<div class="tl-llm-header">');
      parts.push('<span class="tl-badge ' + badgeClass + '">' + badgeText + ' #' + turnIndex + '</span>');
      const modelLabel = respModel && respModel !== r.model ? esc(r.model) + ' ? ' + esc(respModel) : esc(r.model);
      parts.push('<span class="tl-model">' + modelLabel + (subName ? ' [' + esc(subName) + ']' : '') + '</span>');
      parts.push('<span class="tl-action ' + action.cls + '" title="' + esc(action.desc) + '">' + action.label + '</span>');
      if (!isProductive) { parts.push('<span class="tl-eff-tag tl-eff-exploration" title="No edits and minimal output - likely exploration or stall">non-productive</span>'); }
      if (r.status === 'error') { parts.push('<span class="tl-err-tag">ERROR</span>'); }
      parts.push('</div>');

      // Token detail line
      parts.push('<div class="tl-detail">');
      parts.push('<span>' + fmt(inTok) + ' in / ' + fmt(outTok) + ' out');
      if (reasoningTok > 0) { parts.push(' <span class="tl-reasoning" title="Reasoning/thinking tokens (included in output)">[' + fmt(reasoningTok) + ' reasoning]</span>'); }
      if (cachedTok > 0) { parts.push(' <span class="tl-cached" title="Cached input tokens (reduced cost)">[' + fmt(cachedTok) + ' cached]</span>'); }
      if (inputDelta > 0) { parts.push(' <span class="tl-delta">(+' + fmt(inputDelta) + ' new ctx)</span>'); }
      parts.push('</span>');
      parts.push('<span class="tl-cost">$' + costUSD.toFixed(4) + '</span>');
      parts.push('</div>');

      // Marginal efficiency line - the actually meaningful per-turn metric
      parts.push('<div class="tl-efficiency">');
      const mcCls = marginalPct > 30 ? 'tl-eff-good' : marginalPct > 10 ? 'tl-eff-item' : 'tl-eff-warn';
      parts.push('<span class="tl-eff-item" title="Cost of NEW tokens this turn (delta input + output). The rest is re-billed context from previous turns. Higher = this turn paid for itself with new work.">New-work cost: <span class="' + mcCls + '">$' + marginalCost.toFixed(4) + ' (' + marginalPct + '% of turn)</span></span>');
      parts.push('</div>');

      // Performance line
      parts.push('<div class="tl-meta">');
      parts.push(new Date(ev.ts).toLocaleTimeString());
      parts.push(' | TTFT: ' + ttft + 'ms');
      parts.push(' | Duration: ' + fmtDur(dur));
      parts.push(' | ' + (dur > 0 ? Math.round(outTok / (dur / 1000)) : 0) + ' tok/s');
      if (gap > 2) { parts.push(' | <span class="tl-gap">Gap ' + fmtDur(gap * 1000) + '</span>'); }
      parts.push('</div>');

      // Running total
      parts.push('<div class="tl-running">' + fmt(runningTokens) + ' tokens cumulative | $' + runningCredits.toFixed(3) + ' total spend</div>');
      parts.push('</div>');
    }
  }
  parts.push('</div>');

  // Legend
  parts.push('<details class="legend"><summary>Legend - What these metrics mean</summary><dl>');
  parts.push('<dt>Cost / Message</dt><dd>Total session cost divided by number of user messages. The single best metric to compare across sessions - what each prompt actually cost in dollars.</dd>');
  parts.push('<dt>New-work cost (Timeline)</dt><dd>Cost attributable to NEW tokens this turn (delta input from previous turn + this turn output). The remaining cost is re-billed context that was already paid for in earlier turns. The percentage shows how much of the turn was actual new work vs re-processing.</dd>');
  parts.push('<dt>Marginal Efficiency</dt><dd>Session-wide ratio: cost of new tokens vs total cost. High (>30%) = mostly doing new work. Low (<15%) = lots of money spent on re-billed context, suggesting the conversation is too long or context-heavy.</dd>');
  parts.push('<dt>Bloat Ratio</dt><dd>Cost of the second half of turns divided by cost of the first half. 1.0 = balanced. 2-3x = normal context growth. >3x = the conversation got bloated and late turns were much more expensive than early ones.</dd>');
  parts.push('<dt>Production / Exploration / Meta tools</dt><dd>Production = makes changes (edits, runs commands). Exploration = gathers info (read, search). Meta = housekeeping (todo lists, memory, subagent calls). A healthy session has a mix; high exploration without production suggests over-investigation.</dd>');
  parts.push('<dt>Non-productive turn (Timeline)</dt><dd>A turn that produced no edits and less than 150 output tokens. Usually routing or short reasoning between tool calls. Several in a row form a stall.</dd>');
  parts.push('<dt>Stall Events</dt><dd>3+ consecutive non-productive turns - the agent looping through searches/reads without making progress. Stall waste shows the tokens consumed during these loops.</dd>');
  parts.push('<dt>Context Saturation Turn</dt><dd>The turn number where input first exceeded 80% of model capacity. After this point, every turn pays the maximum context cost.</dd>');
  parts.push('<dt>TTFT / P90 TTFT</dt><dd>Time To First Token - how fast the model started responding. P90 = 90th percentile (worst-case latency). High P90 with normal avg = occasional slowdowns.</dd>');
  parts.push('<dt>Turns/Message</dt><dd>Average agent loop iterations per user prompt. >8 suggests the agent is over-iterating; consider more specific prompts.</dd>');
  parts.push('<dt>Tools/Turn</dt><dd>Average tool invocations per turn. ~1.0 is typical; higher means parallel tool use.</dd>');
  parts.push('<dt>Input/Output Ratio</dt><dd>Total input vs output tokens. >15:1 = context-heavy; ~1:1 = generative tasks.</dd>');
  parts.push('<dt>Wasted Tokens</dt><dd>Tokens consumed by failed requests (errors, refusals). Pure cost with no value.</dd>');
  parts.push('<dt>Subagent Tokens</dt><dd>Tokens consumed by delegated sub-agents. Counted against the new (Jun 2026) billing model.</dd>');
  parts.push('<dt>Reasoning Tokens</dt><dd>Tokens the model used for internal "thinking" (chain-of-thought). Already included in output token count and billed at output rate. High reasoning relative to visible output means the model is over-thinking. Only available from OTel data source.</dd>');
  parts.push('<dt>Cache Hit Rate</dt><dd>Percentage of input tokens served from cache. Cache hits are billed at a much lower rate (typically 10% of input). Higher is better. "~est" means the value is estimated from heuristics, not measured.</dd>');
  parts.push('<dt>Cache Savings</dt><dd>Dollar amount saved by cache hits vs paying full input price. Calculated as cached_tokens × (input_price - cached_price) per model.</dd>');
  parts.push('<dt>Data Source Badge</dt><dd>OTel = high-fidelity data from VS Code agent traces (real cached/reasoning tokens). JSONL = parsed from debug logs (estimated cache values). Hybrid = combined from both sources.</dd>');
  parts.push('<dt>Model Routing (?)</dt><dd>When the response model differs from the requested model, shown as "requested ? actual" in the timeline. Usually indicates capacity constraints or automatic fallback.</dd>');
  parts.push('<dt>Verdict (Per-Message Table)</dt><dd>Efficient = at most 3 turns and at least 50% productive. Wasteful = more than 15 turns OR less than 30% productive turns. Normal = anything in between.</dd>');
  parts.push('</dl></details>');

  document.getElementById('detailContent').innerHTML = parts.join('');
}

function statRow(label, value) {
  return '<div class="stat-row"><span class="stat-label">' + esc(label) + '</span><span class="stat-value">' + esc(String(value)) + '</span></div>';
}

function drawBarChart(ctx, canvas, labels, values) {
  const w = canvas.width = canvas.parentElement.clientWidth - 32;
  const h = canvas.height = 220;
  const max = Math.max(...values, 1);
  const barW = Math.max(4, (w - 50) / labels.length - 3);
  ctx.clearRect(0, 0, w, h);
  const accentColor = getComputedStyle(document.body).getPropertyValue('--vscode-textLink-foreground') || '#4dc9f6';
  const mutedColor = getComputedStyle(document.body).getPropertyValue('--vscode-descriptionForeground') || '#888';

  for (let i = 0; i < labels.length; i++) {
    const x = 40 + i * (barW + 3);
    const barH = (values[i] / max) * (h - 35);
    ctx.fillStyle = accentColor;
    ctx.fillRect(x, h - 20 - barH, barW, barH);
    ctx.fillStyle = mutedColor;
    ctx.font = '9px sans-serif';
    ctx.save();
    ctx.translate(x + barW / 2, h - 4);
    ctx.rotate(-0.7);
    ctx.fillText(labels[i], 0, 0);
    ctx.restore();
  }
}

function drawPieChart(ctx, canvas, labels, values, colors) {
  const w = canvas.width = canvas.parentElement.clientWidth - 32;
  const h = canvas.height = 180;
  const total = values.reduce((a, b) => a + b, 0) || 1;
  const cx = h / 2 + 10;
  const cy = h / 2;
  const r = Math.min(cx, cy) - 8;
  let angle = -Math.PI / 2;
  ctx.clearRect(0, 0, w, h);

  for (let i = 0; i < values.length; i++) {
    const slice = (values[i] / total) * 2 * Math.PI;
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.arc(cx, cy, r, angle, angle + slice);
    ctx.fillStyle = colors[i % colors.length];
    ctx.fill();
    angle += slice;
  }
  const lx = h + 20;
  ctx.font = '11px sans-serif';
  const fgColor = getComputedStyle(document.body).getPropertyValue('--vscode-editor-foreground') || '#ccc';
  for (let i = 0; i < labels.length; i++) {
    const y = 16 + i * 18;
    ctx.fillStyle = colors[i % colors.length];
    ctx.fillRect(lx, y - 8, 10, 10);
    ctx.fillStyle = fgColor;
    ctx.fillText(labels[i] + ' (' + Math.round(values[i] / total * 100) + '%)', lx + 16, y + 1);
  }
}

function fmt(n) { return (n || 0).toLocaleString(); }
function esc(s) { const d = document.createElement('div'); d.textContent = s || ''; return d.innerHTML; }
function fmtDur(ms) {
  if (!ms) return '-';
  const s = Math.floor(ms / 1000);
  if (s < 60) return s + 's';
  const m = Math.floor(s / 60);
  if (m < 60) return m + 'm ' + (s % 60) + 's';
  return Math.floor(m / 60) + 'h ' + (m % 60) + 'm';
}
function toSnake(s) { return s.replace(/([A-Z])/g, '_$1').toLowerCase(); }
</script>
</body>
</html>`;
  }
}

function getNonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let result = '';
  for (let i = 0; i < 32; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}
