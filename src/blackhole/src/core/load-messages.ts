import { statSync } from "fs";
import type { Message } from "@earendil-works/pi-ai";
import { renderMessage, type RenderedEntry } from "./render-entries";
import { isCountedMessageEntry } from "./global-indices.js";
import { scanSessionEntries } from "./session-lines.js";

export interface LoadedMessages {
  rendered: RenderedEntry[];
  rawMessages: Message[];
  entryIds: string[];
}

// ── Session-file cache (LRU, invalidated by mtime) ─────────────────────────

interface CacheEntry {
  result: LoadedMessages;
  mtimeMs: number;
  timestamp: number;
  sourceBytes: number;
}

const MAX_CACHE_SIZE = 3;
const CACHE_TTL_MS = 2_000;
export const MAX_CACHED_SESSION_BYTES = 64 * 1024 * 1024;
export const MAX_TOTAL_CACHED_SOURCE_BYTES = 128 * 1024 * 1024;
const cache = new Map<string, CacheEntry>();

export function clearSessionCache(): void { cache.clear(); }

function cacheKey(
  sessionFile: string,
  full: boolean,
  allowedEntryIds: Set<string> | undefined,
): string {
  let hash = `${sessionFile}::${full}`;
  if (allowedEntryIds && allowedEntryIds.size > 0) {
    // Include the full set as sorted JSON for collision-free caching
    hash += `::${JSON.stringify([...allowedEntryIds].sort())}`;
  }
  return hash;
}

function getCached(
  sessionFile: string,
  full: boolean,
  allowedEntryIds?: Set<string>,
): LoadedMessages | undefined {
  const key = cacheKey(sessionFile, full, allowedEntryIds);
  const entry = cache.get(key);
  if (!entry) return undefined;

  // Check TTL (mtime-based invalidation)
  if (Date.now() - entry.timestamp > CACHE_TTL_MS) {
    cache.delete(key);
    return undefined;
  }

  // Verify file mtime hasn't changed
  try {
    const info = statSync(sessionFile);
    if (info.mtimeMs !== entry.mtimeMs || info.size !== entry.sourceBytes) {
      cache.delete(key);
      return undefined;
    }
  } catch {
    cache.delete(key);
    return undefined;
  }

  cache.delete(key);
  cache.set(key, entry);
  return entry.result;
}

function setCache(
  sessionFile: string,
  full: boolean,
  allowedEntryIds: Set<string> | undefined,
  result: LoadedMessages,
): void {
  try {
    const info = statSync(sessionFile);
    const key = cacheKey(sessionFile, full, allowedEntryIds);
    cache.delete(key);
    if (info.size > MAX_CACHED_SESSION_BYTES) return;
    const retained = () => [...cache.values()].reduce((sum, entry) => sum + entry.sourceBytes, 0);
    while (cache.size >= MAX_CACHE_SIZE || retained() + info.size > MAX_TOTAL_CACHED_SOURCE_BYTES) {
      const oldest = cache.keys().next();
      if (oldest.done) break;
      cache.delete(oldest.value);
    }
    cache.set(key, { result, mtimeMs: info.mtimeMs, sourceBytes: info.size, timestamp: Date.now() });
  } catch {
    // Can't stat the file — don't cache
  }
}

export const loadAllMessages = (
  sessionFile: string,
  full: boolean,
  allowedEntryIds?: Set<string>,
): LoadedMessages => {
  // Check cache first (same sessionFile + full flag + lineage size — approximate)
  const cached = getCached(sessionFile, full, allowedEntryIds);
  if (cached) return cached;

  const rendered: RenderedEntry[] = [];
  const rawMessages: Message[] = [];
  const entryIds: string[] = [];

  let messageIndex = 0;
  // Streamed per upstream pi-vcc #26: never materialize the whole session
  // file as one string (V8 limit). Counting rule shared with
  // src/core/global-indices.ts — both index spaces must agree by construction.
  const scan = scanSessionEntries(sessionFile, (e) => {
    if (!isCountedMessageEntry(e)) return;

    const allowed = !allowedEntryIds || allowedEntryIds.has(e.id);
    if (allowed) {
      const entryId = e.id != null ? String(e.id) : "";
      rendered.push(renderMessage(e.message, messageIndex, entryId, full));
      rawMessages.push(e.message);
      entryIds.push(entryId);
    }
    messageIndex++;
  });
  if (scan.missing) {
    // Pi does not create a new session's JSONL until its first persisted
    // entry: empty current-session history, not a failure. Not cached — the
    // file may appear at any moment.
    return { rendered, rawMessages, entryIds };
  }
  if (scan.parseErrors > 0) {
    console.warn(`blackhole: ${scan.parseErrors} malformed JSONL line(s) in ${sessionFile}`);
  }

  const result: LoadedMessages = { rendered, rawMessages, entryIds };
  setCache(sessionFile, full, allowedEntryIds, result);
  return result;
};
