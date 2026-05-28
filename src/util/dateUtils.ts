/**
 * Format a timestamp (epoch ms) to a locale date string.
 */
export function formatDate(ts: number): string {
  return new Date(ts).toLocaleDateString();
}

/**
 * Format a timestamp to a locale date+time string.
 */
export function formatDateTime(ts: number): string {
  return new Date(ts).toLocaleString();
}

/**
 * Format a number of tokens with thousands separators.
 */
export function formatTokens(n: number): string {
  return n.toLocaleString();
}

/**
 * Format milliseconds as a human-readable duration.
 */
export function formatDuration(ms: number): string {
  if (ms < 1000) { return `${ms}ms`; }
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) { return `${seconds}s`; }
  const minutes = Math.floor(seconds / 60);
  const remaining = seconds % 60;
  if (minutes < 60) { return `${minutes}m ${remaining}s`; }
  const hours = Math.floor(minutes / 60);
  const remainingMin = minutes % 60;
  return `${hours}h ${remainingMin}m`;
}

/**
 * Get a human-readable relative date label for grouping.
 */
export function getDateGroup(ts: number): string {
  const now = new Date();
  const date = new Date(ts);
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const yesterdayStart = todayStart - 86400000;
  const weekStart = todayStart - (now.getDay() * 86400000);

  if (ts >= todayStart) { return 'Today'; }
  if (ts >= yesterdayStart) { return 'Yesterday'; }
  if (ts >= weekStart) { return 'This Week'; }

  // Use month label for older
  return date.toLocaleDateString(undefined, { year: 'numeric', month: 'long' });
}

/**
 * Convert a date string (YYYY-MM-DD) to epoch ms at start of day.
 */
export function dateStringToEpoch(dateStr: string): number {
  return new Date(dateStr + 'T00:00:00').getTime();
}
