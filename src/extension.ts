import * as vscode from 'vscode';
import * as path from 'path';
import { TrackerDatabase } from './db/database';
import { syncAll } from './db/sync';
import { SessionTreeProvider, QuickStatsTreeProvider } from './views/treeView/statsTreeProvider';
import { DashboardPanel } from './views/webview/dashboardPanel';

let db: TrackerDatabase | undefined;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  // Resolve WASM path — try dist/ first (webpack-copied), fall back to node_modules
  let wasmPath = path.join(context.extensionPath, 'dist', 'sql-wasm.wasm');
  if (!require('fs').existsSync(wasmPath)) {
    wasmPath = path.join(context.extensionPath, 'node_modules', 'sql.js', 'dist', 'sql-wasm.wasm');
  }

  // Initialize database in extension global storage
  db = await TrackerDatabase.create(context.globalStorageUri.fsPath, wasmPath);

  // Tree view providers
  const sessionTree = new SessionTreeProvider(db);
  const quickStatsTree = new QuickStatsTreeProvider(db);

  context.subscriptions.push(
    vscode.window.registerTreeDataProvider('copilotUsageTracker.sessions', sessionTree),
    vscode.window.registerTreeDataProvider('copilotUsageTracker.quickStats', quickStatsTree),
  );

  // Commands
  context.subscriptions.push(
    vscode.commands.registerCommand('copilotUsageTracker.refresh', async () => {
      if (!db) { return; }
      const result = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: 'Scanning Copilot logs...', cancellable: false },
        (progress) => syncAll(db!, progress, wasmPath)
      );
      sessionTree.refresh();
      quickStatsTree.refresh();
      DashboardPanel.currentPanel?.refresh();
      vscode.window.showInformationMessage(
        `Copilot Usage: Found ${result.totalDiscovered} sessions. ${result.newOrUpdated} parsed, ${result.skipped} up-to-date, ${result.emptyCount} empty, ${result.errors} errors.`
      );
    }),

    vscode.commands.registerCommand('copilotUsageTracker.openDashboard', () => {
      if (!db) { return; }
      DashboardPanel.createOrShow(db, context.extensionUri);
    }),

    vscode.commands.registerCommand('copilotUsageTracker.addLogDirectory', async () => {
      const uris = await vscode.window.showOpenDialog({
        canSelectFolders: true,
        canSelectFiles: false,
        canSelectMany: false,
        openLabel: 'Select Log Directory',
      });
      if (uris && uris.length > 0) {
        const config = vscode.workspace.getConfiguration('copilotUsageTracker');
        const dirs = config.get<string[]>('logDirectories', []);
        const newDir = uris[0].fsPath;
        if (!dirs.includes(newDir)) {
          dirs.push(newDir);
          await config.update('logDirectories', dirs, vscode.ConfigurationTarget.Global);
          vscode.window.showInformationMessage(`Added log directory: ${newDir}`);
        }
      }
    }),

    vscode.commands.registerCommand('copilotUsageTracker.clearCache', async () => {
      if (!db) { return; }
      const answer = await vscode.window.showWarningMessage(
        'Clear all cached data? This will re-parse all logs on next refresh.',
        'Clear', 'Cancel'
      );
      if (answer === 'Clear') {
        db.clearAll();
        sessionTree.refresh();
        quickStatsTree.refresh();
        vscode.window.showInformationMessage('Cache cleared.');
      }
    }),

    vscode.commands.registerCommand('copilotUsageTracker.openRawLog', (item: { id?: string }) => {
      if (!item?.id || !db) { return; }
      const detail = db.getSessionDetail(item.id);
      if (detail?.session.dirPath) {
        const mainJsonl = vscode.Uri.file(path.join(detail.session.dirPath, 'main.jsonl'));
        vscode.window.showTextDocument(mainJsonl);
      }
    }),

    vscode.commands.registerCommand('copilotUsageTracker.stats.prevMonth', () => {
      quickStatsTree.navOlder();
    }),
    vscode.commands.registerCommand('copilotUsageTracker.stats.nextMonth', () => {
      quickStatsTree.navNewer();
    }),
    vscode.commands.registerCommand('copilotUsageTracker.stats.allTime', () => {
      quickStatsTree.navAllTime();
    }),
    vscode.commands.registerCommand('copilotUsageTracker.stats.currentMonth', () => {
      quickStatsTree.navCurrentMonth();
    }),
    vscode.commands.registerCommand('copilotUsageTracker.stats.selectMonth', () => {
      quickStatsTree.showMonthPicker();
    }),
  );

  // Auto-sync on activation
  syncAll(db, undefined, wasmPath).then(result => {
    sessionTree.refresh();
    quickStatsTree.refresh();
    if (result.newOrUpdated > 0) {
      vscode.window.showInformationMessage(
        `Copilot Usage: Loaded ${result.newOrUpdated} sessions.`
      );
    }
  }).catch(err => {
    console.error('Copilot Usage Tracker: Initial sync failed:', err);
  });
}

export function deactivate(): void {
  db?.close();
  db = undefined;
}
