import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { DiscoveredSession } from '../types';

/** The 'claude:' id prefix that namespaces Claude session ids away from Copilot UUIDs. */
export const CLAUDE_ID_PREFIX = 'claude:';

/**
 * Expand a leading `~` to the user home directory.
 */
function expandHome(p: string): string {
  if (p === '~') { return os.homedir(); }
  if (p.startsWith('~/') || p.startsWith('~\\')) { return path.join(os.homedir(), p.slice(2)); }
  return p;
}

function readdirSafe(dir: string): fs.Dirent[] {
  try {
    return fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

function mtimeSafe(p: string): number {
  try { return fs.statSync(p).mtimeMs; } catch { return 0; }
}

/**
 * Recursively collect every `*.jsonl` file under `dir` (any depth).
 *
 * Claude Code nests subagent transcripts arbitrarily deep — direct subagents in
 * "subagents", but Workflow-tool subagents live one level further down under
 * "subagents/workflows/wf_<id>". A single-level readdir misses those nested
 * workflow transcripts entirely (the bulk of requests in heavy agentic sessions),
 * silently under-counting tokens and cost. Walking the whole session subtree
 * captures them all and is robust to future nesting. Read-only and tolerant:
 * unreadable dirs are skipped. "seen" guards against symlink loops.
 */
function collectJsonlRecursive(dir: string, out: string[], seen: Set<string>): void {
  let realDir: string;
  try { realDir = fs.realpathSync(dir); } catch { return; }
  if (seen.has(realDir)) { return; }
  seen.add(realDir);
  for (const entry of readdirSafe(dir)) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      collectJsonlRecursive(full, out, seen);
    } else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
      out.push(full);
    }
  }
}

/**
 * Discover Claude Code sessions under `~/.claude/projects`.
 *
 * Layout: <projectsDir>/<projectSlug>/<sessionId>.jsonl is one session; its
 * subagent transcripts live under <projectSlug>/<sessionId>/subagents/agent-*.jsonl.
 *
 * Read-only and tolerant: a missing/inaccessible root returns [] (new users
 * without Claude installed must not error the shared sync). Session ids are
 * namespaced with the 'claude:' prefix (CLAUDE-PROVIDER-PLAN.md §6 invariant).
 */
export function discoverClaudeSessions(claudeProjectsDirectory: string): DiscoveredSession[] {
  const root = expandHome(claudeProjectsDirectory || path.join('~', '.claude', 'projects'));
  if (!fs.existsSync(root)) { return []; }

  const sessions: DiscoveredSession[] = [];

  for (const projectEntry of readdirSafe(root)) {
    if (!projectEntry.isDirectory()) { continue; }
    const projectDir = path.join(root, projectEntry.name);

    for (const fileEntry of readdirSafe(projectDir)) {
      if (!fileEntry.isFile() || !fileEntry.name.endsWith('.jsonl')) { continue; }
      const stem = fileEntry.name.slice(0, -'.jsonl'.length);
      const mainJsonlPath = path.join(projectDir, fileEntry.name);

      // Subagent transcripts live anywhere under <projectDir>/<stem>/ — directly in
      // subagents/, and nested under subagents/workflows/wf_*/ for Workflow-tool runs.
      // Recurse the whole session subtree so nested transcripts are not dropped.
      const sessionSubtree = path.join(projectDir, stem);
      const childJsonlPaths: string[] = [];
      collectJsonlRecursive(sessionSubtree, childJsonlPaths, new Set<string>());
      let latestMtime = mtimeSafe(mainJsonlPath);
      for (const childPath of childJsonlPaths) {
        const cm = mtimeSafe(childPath);
        if (cm > latestMtime) { latestMtime = cm; }
      }

      sessions.push({
        sessionId: CLAUDE_ID_PREFIX + stem,
        provider: 'claude',
        dirPath: projectDir,
        workspaceId: projectEntry.name,
        mainJsonlPath,
        modelsJsonPath: undefined,
        childJsonlPaths,
        mtimeMs: latestMtime,
      });
    }
  }

  return sessions;
}
