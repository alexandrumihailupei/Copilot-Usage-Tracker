import * as vscode from 'vscode';
import * as path from 'path';
import { TrackerDatabase } from './db/database';
import { syncAll } from './db/sync';
import { SessionTreeProvider, QuickStatsTreeProvider } from './views/treeView/statsTreeProvider';
import { DashboardPanel } from './views/webview/dashboardPanel';
import { ProviderId } from './core/types';
import { detectCopilotEditors } from './core/logDiscovery';

let db: TrackerDatabase | undefined;

const ACTIVE_PROVIDER_KEY = 'copilotUsageTracker.activeProvider';

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  // Resolve WASM path — try dist/ first (webpack-copied), fall back to node_modules
  let wasmPath = path.join(context.extensionPath, 'dist', 'sql-wasm.wasm');
  if (!require('fs').existsSync(wasmPath)) {
    wasmPath = path.join(context.extensionPath, 'node_modules', 'sql.js', 'dist', 'sql-wasm.wasm');
  }

  // Initialize database in extension global storage
  db = await TrackerDatabase.create(context.globalStorageUri.fsPath, wasmPath);

  // Active provider is a user-global preference (one global DB; ~/.claude and VS Code
  // workspaceStorage are user-global). The toggle re-queries; it never re-syncs.
  let activeProvider = context.globalState.get<ProviderId>(ACTIVE_PROVIDER_KEY, 'copilot');

  // Tree view providers
  const sessionTree = new SessionTreeProvider(db);
  const quickStatsTree = new QuickStatsTreeProvider(db);
  // Seed both trees from persisted state BEFORE the first render (§15 #11a),
  // otherwise a restart shows Copilot even when Claude was the active provider.
  sessionTree.setActiveProvider(activeProvider);
  quickStatsTree.setActiveProvider(activeProvider);

  context.subscriptions.push(
    vscode.window.registerTreeDataProvider('copilotUsageTracker.sessions', sessionTree),
    vscode.window.registerTreeDataProvider('copilotUsageTracker.quickStats', quickStatsTree),
  );

  // Switch the active provider across the webview AND both trees in lockstep.
  // This is a re-query + re-render path only — it must NOT call syncAll (§8/§15 #10).
  const setActiveProvider = (provider: ProviderId): void => {
    activeProvider = provider;
    context.globalState.update(ACTIVE_PROVIDER_KEY, provider);
    sessionTree.setActiveProvider(provider);
    quickStatsTree.setActiveProvider(provider);
    sessionTree.refresh();
    quickStatsTree.refresh();
    DashboardPanel.currentPanel?.setActiveProvider(provider);
  };

  // Commands
  context.subscriptions.push(
    vscode.commands.registerCommand('copilotUsageTracker.setProvider', (provider: ProviderId) => {
      if (provider === 'copilot' || provider === 'claude') { setActiveProvider(provider); }
    }),

    vscode.commands.registerCommand('copilotUsageTracker.toggleProvider', () => {
      const next: ProviderId = activeProvider === 'claude' ? 'copilot' : 'claude';
      setActiveProvider(next);
      vscode.window.showInformationMessage(`AI Usage: now showing ${next === 'claude' ? 'Claude' : 'GitHub Copilot'}.`);
    }),

    vscode.commands.registerCommand('copilotUsageTracker.refresh', async () => {
      if (!db) { return; }
      const result = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: 'Scanning AI usage logs...', cancellable: false },
        (progress) => syncAll(db!, progress, wasmPath)
      );
      sessionTree.refresh();
      quickStatsTree.refresh();
      DashboardPanel.currentPanel?.refresh();
      vscode.window.showInformationMessage(
        `AI Usage: Found ${result.totalDiscovered} sessions. ${result.newOrUpdated} parsed, ${result.skipped} up-to-date, ${result.emptyCount} empty, ${result.errors} errors.`
      );
    }),

    vscode.commands.registerCommand('copilotUsageTracker.openDashboard', () => {
      if (!db) { return; }
      DashboardPanel.createOrShow(db, context.extensionUri, activeProvider);
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

    vscode.commands.registerCommand('copilotUsageTracker.selectIdeSources', async () => {
      if (!db) { return; }
      const detected = detectCopilotEditors();
      if (detected.length === 0) {
        vscode.window.showInformationMessage(
          'AI Usage: no GitHub Copilot debug-logs found in any IDE. Enable file logging (VS Code: "github.copilot.chat.agentDebugLog.fileLogging.enabled"; JetBrains: Tools › GitHub Copilot › Chat › Enable Agent debug File Logging), run an agent chat, then retry.'
        );
        return;
      }
      const cfg = vscode.workspace.getConfiguration('copilotUsageTracker');
      const enabled = cfg.get<string[]>('enabledEditors', []);
      type IdeItem = vscode.QuickPickItem & { editor: string };
      const items: IdeItem[] = detected.map(d => ({
        label: d.editor === 'JetBrains' ? 'JetBrains IDEs (experimental)' : d.editor,
        description: `${d.sessionCount} Copilot session${d.sessionCount === 1 ? '' : 's'}`,
        editor: d.editor,
        picked: enabled.length === 0 ? true : enabled.includes(d.editor),
      }));
      const chosen = await vscode.window.showQuickPick(items, {
        canPickMany: true,
        title: 'Select IDEs to include (GitHub Copilot only)',
        placeHolder: 'Only checked IDEs are summed · selecting all = auto-include future editors',
      });
      if (!chosen) { return; }                                  // cancelled: no change
      const selected = chosen.map(c => c.editor);
      if (selected.length === 0) {
        vscode.window.showWarningMessage('AI Usage: no IDE selected — selection left unchanged.');
        return;
      }
      // Store [] when EVERY detected editor is selected ("all"; also auto-includes
      // future installs); otherwise persist the explicit subset.
      const toStore = selected.length === detected.length ? [] : selected;
      await cfg.update('enabledEditors', toStore, vscode.ConfigurationTarget.Global);

      // Re-sum: clear ONLY Copilot data (Claude untouched), then resync with the
      // new editor filter so totals reflect exactly the selection.
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: 'Rebuilding GitHub Copilot usage from selected IDEs...', cancellable: false },
        async (progress) => {
          db!.clearProvider('copilot');
          await syncAll(db!, progress, wasmPath);
        }
      );
      sessionTree.refresh();
      quickStatsTree.refresh();
      DashboardPanel.currentPanel?.refresh();
      vscode.window.showInformationMessage(
        `AI Usage: now summing ${selected.length} IDE source${selected.length === 1 ? '' : 's'}: ${selected.join(', ')}.`
      );
    }),

    vscode.commands.registerCommand('copilotUsageTracker.clearCache', async () => {
      if (!db) { return; }
      const label = activeProvider === 'claude' ? 'Claude' : 'GitHub Copilot';
      const answer = await vscode.window.showWarningMessage(
        `Clear cached ${label} data? Other providers are unaffected. Data is re-parsed on next refresh.`,
        'Clear', 'Cancel'
      );
      if (answer === 'Clear') {
        db.clearProvider(activeProvider);
        sessionTree.refresh();
        quickStatsTree.refresh();
        DashboardPanel.currentPanel?.refresh();
        vscode.window.showInformationMessage(`${label} cache cleared.`);
      }
    }),

    vscode.commands.registerCommand('copilotUsageTracker.openRawLog', (item: { id?: string }) => {
      if (!item?.id || !db) { return; }
      const detail = db.getSessionDetail(item.id);
      if (!detail?.session.dirPath) { return; }
      // Copilot writes main.jsonl under the session dir; Claude's raw file is
      // <stem>.jsonl in the project dir (strip the 'claude:' id prefix). §15 #9.
      const fsMod = require('fs');
      let target: vscode.Uri;
      if (detail.session.provider === 'claude') {
        const stem = item.id.replace(/^claude:/, '');
        target = vscode.Uri.file(path.join(detail.session.dirPath, stem + '.jsonl'));
      } else {
        target = vscode.Uri.file(path.join(detail.session.dirPath, 'main.jsonl'));
      }
      if (fsMod.existsSync(target.fsPath)) {
        vscode.window.showTextDocument(target);
      } else {
        vscode.window.showWarningMessage(`Raw log not found: ${target.fsPath}`);
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
        `AI Usage: Loaded ${result.newOrUpdated} sessions.`
      );
    }
  }).catch(err => {
    console.error('AI Usage Tracker: Initial sync failed:', err);
  });
}

export function deactivate(): void {
  db?.close();
  db = undefined;
}
