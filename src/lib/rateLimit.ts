// Small in-memory fixed-window limiter for the public website's write
// endpoints. Per-process is enough here: one API process, and the goal is to
// blunt form spam, not to meter usage precisely.

const windows = new Map<string, { start: number; count: number }>();
const MAX_KEYS = 20_000;

/** True when `key` may act now; counts the attempt either way. */
export function allow(key: string, limit: number, windowMs: number): boolean {
  const now = Date.now();
  const entry = windows.get(key);
  if (!entry || now - entry.start >= windowMs) {
    if (windows.size >= MAX_KEYS) {
      for (const [k, v] of windows) if (now - v.start >= windowMs) windows.delete(k);
      if (windows.size >= MAX_KEYS) windows.delete(windows.keys().next().value!);
    }
    windows.set(key, { start: now, count: 1 });
    return true;
  }
  entry.count += 1;
  return entry.count <= limit;
}
