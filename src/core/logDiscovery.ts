import * as fs from 'fs';
import * as path from 'path';
import { DiscoveredSession } from './types';

const COPILOT_CHAT_DEBUG = 'GitHub.copilot-chat/debug-logs';
const COPILOT_CHAT_DEBUG_ALT = 'GitHub.copilot-chat\\debug-logs';

/**
 * Discover all Copilot Chat debug-log sessions across configured directories
 * and (optionally) all VS Code workspaceStorage folders.
 */
export function discoverSessions(
  logDirectories: string[],
  autoScanWorkspaceStorage: boolean
): DiscoveredSession[] {
  const debugLogRoots: { dirPath: string; workspaceId: string }[] = [];

  // User-configured directories: can point to a debug-logs folder or a parent
  for (const dir of logDirectories) {
    collectDebugLogRoots(dir, debugLogRoots);
  }

  // Auto-scan workspaceStorage
  if (autoScanWorkspaceStorage) {
    const wsStorageDir = getWorkspaceStorageDir();
    if (wsStorageDir && fs.existsSync(wsStorageDir)) {
      for (const entry of readdirSafe(wsStorageDir)) {
        const wsPath = path.join(wsStorageDir, entry);
        const debugLogsPath = path.join(wsPath, COPILOT_CHAT_DEBUG);
        const debugLogsPathAlt = path.join(wsPath, COPILOT_CHAT_DEBUG_ALT);
        const actual = fs.existsSync(debugLogsPath) ? debugLogsPath
          : fs.existsSync(debugLogsPathAlt) ? debugLogsPathAlt
            : undefined;
        if (actual) {
          debugLogRoots.push({ dirPath: actual, workspaceId: entry });
        }
      }
    }
  }

  // Enumerate session folders inside each debug-logs root
  const sessions: DiscoveredSession[] = [];
  const seenIds = new Set<string>();

  for (const { dirPath, workspaceId } of debugLogRoots) {
    for (const sessionDir of readdirSafe(dirPath)) {
      if (seenIds.has(sessionDir)) { continue; }
      const sessionPath = path.join(dirPath, sessionDir);
      const mainJsonl = path.join(sessionPath, 'main.jsonl');
      if (!fs.existsSync(mainJsonl)) { continue; }

      const stat = fs.statSync(mainJsonl);
      const modelsJson = path.join(sessionPath, 'models.json');
      const childJsonlPaths = findChildJsonlFiles(sessionPath);

      seenIds.add(sessionDir);
      sessions.push({
        sessionId: sessionDir,
        dirPath: sessionPath,
        workspaceId,
        mainJsonlPath: mainJsonl,
        modelsJsonPath: fs.existsSync(modelsJson) ? modelsJson : undefined,
        childJsonlPaths,
        mtimeMs: stat.mtimeMs,
      });
    }
  }

  return sessions;
}

/**
 * Resolve the VS Code workspaceStorage directory based on platform.
 */
function getWorkspaceStorageDir(): string | undefined {
  const appData = process.env.APPDATA
    || (process.platform === 'darwin'
      ? path.join(process.env.HOME || '', 'Library', 'Application Support')
      : path.join(process.env.HOME || '', '.config'));
  const candidate = path.join(appData, 'Code', 'User', 'workspaceStorage');
  return fs.existsSync(candidate) ? candidate : undefined;
}

/**
 * Given a directory, determine if it is a debug-logs root directly
 * or contains workspace storage structure. Adds results to `out`.
 */
function collectDebugLogRoots(
  dir: string,
  out: { dirPath: string; workspaceId: string }[]
): void {
  if (!fs.existsSync(dir)) { return; }
  // If the dir itself contains session-like UUID folders with main.jsonl
  const first = readdirSafe(dir)[0];
  if (first) {
    const probe = path.join(dir, first, 'main.jsonl');
    if (fs.existsSync(probe)) {
      out.push({ dirPath: dir, workspaceId: path.basename(path.dirname(dir)) });
      return;
    }
  }
  // Otherwise try to find debug-logs subfolder
  const debugLogsPath = path.join(dir, COPILOT_CHAT_DEBUG);
  if (fs.existsSync(debugLogsPath)) {
    out.push({ dirPath: debugLogsPath, workspaceId: path.basename(dir) });
  }
}

/**
 * Find child JSONL files (runSubagent-*.jsonl, etc.) in a session directory.
 */
function findChildJsonlFiles(sessionDir: string): string[] {
  return readdirSafe(sessionDir)
    .filter(f => f.endsWith('.jsonl') && f !== 'main.jsonl')
    .map(f => path.join(sessionDir, f));
}

function readdirSafe(dir: string): string[] {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
}
