/**
 * Project memory corpus — walks past-session JSONL files + OM pending buffers
 * and extracts the observational-memory corpus for project-wide features
 * (export now, project recall later).
 *
 * Design receipts: work_docs/plan-07-project-recall.md §17, §19.
 *
 * Walk strategy (one scope folder = one project):
 *  1. Candidate selection visits ONLY the cwd-encoded scope dir under
 *     ~/.pi/agent/sessions/ plus, when different, the git-root-encoded dir —
 *     sessions from other projects are never opened.
 *  2. Attributed files get a cheap substring prefilter (`om.`) before any
 *     JSON line parsing — marker-less sessions cost one buffered read.
 *  3. Compaction NEVER removes entries (append-only trees, verified in §19.2):
 *     whole-file scanning sees the full history; only the actively-written
 *     session file is excluded (race safety, D7).
 */
import {
  existsSync,
  openSync,
  readFileSync,
  readSync,
  closeSync,
  readdirSync,
} from "node:fs";
import { basename, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import {
  OM_OBSERVATIONS_RECORDED,
  OM_OBSERVATIONS_UNANCHORED,
  OM_REFLECTIONS_RECORDED,
  OM_OBSERVATIONS_DROPPED,
  RELEVANCE_VALUES,
  type Relevance,
} from "../om/ledger/types.ts";

const LEGACY_OM_OBSERVATION = "om.observation";
const PENDING_DIR = "pi-blackhole";
const PENDING_SUFFIX = "-pending.json";
const STALE_SUFFIX = "-pending.stale.json";
const HEADER_CHUNK = 4096;
const HEADER_MAX = 65536;

export type MemorySource = "branch" | "pending" | "orphan";

export interface CorpusObservation {
  /** Observation memory id (12-hex) when present — links against droppedIds. */
  id: string | null;
  content: string;
  relevance: Relevance;
  /** Observation-local timestamp when parseable, else null. */
  timestamp: string | null;
  sessionId: string;
  source: MemorySource;
}

export interface CorpusReflection {
  content: string;
  supportingObservationIds: string[];
  timestamp: string | null;
  sessionId: string;
  source: MemorySource;
}

export interface ProjectCorpus {
  projectRoot: string;
  /** Attributed session files inspected (marker-bearing + marker-less). */
  sessionsConsidered: number;
  /** Attributed session files that actually carried om markers. */
  filesWithMarkers: number;
  observations: CorpusObservation[];
  reflections: CorpusReflection[];
  droppedIds: Set<string>;
  /** Session ids seen in attributed project files (for pending attribution). */
  knownSessionIds: Set<string>;
  /** Pending-buffer sessions that no longer exist on disk. */
  orphanedSessions: number;
}

/**
 * pi's exact session-scope encoding: /home/u/proj → --home-u-proj--
 * (leading slash stripped, separators/colons → single dash, double-dash wrap).
 */
export function encodeScopeDir(cwd: string): string {
  return `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
}

export interface BuildCorpusOptions {
  /** Launch directory whose scope folder identifies "the project". */
  cwd: string;
  /** Enclosing git root when available — scanned as a secondary candidate. */
  gitRoot?: string | null;
  /** Actively-written session file to exclude (D7 race safety). */
  activeSessionFile?: string;
  agentDir?: string;
}

function normalizeRelevance(value: unknown): Relevance {
  return typeof value === "string" && (RELEVANCE_VALUES as readonly string[]).includes(value)
    ? (value as Relevance)
    : "low";
}

function parseTimestamp(value: unknown): string | null {
  if (typeof value !== "string" || !value) return null;
  if (Number.isNaN(Date.parse(value))) {
    // Legacy format: "2026-05-11 19:01" (no timezone/seconds)
    const patched = value.replace(" ", "T") + ":00Z";
    return Number.isNaN(Date.parse(patched)) ? null : patched;
  }
  return value;
}

/** Read just the first line of a file (the session header). */
function readFirstLine(filePath: string): string | null {
  let fd: number;
  try {
    fd = openSync(filePath, "r");
  } catch {
    return null;
  }
  try {
    const buf = Buffer.alloc(HEADER_MAX);
    let total = 0;
    while (total < HEADER_MAX) {
      const n = readSync(fd, buf, total, Math.min(HEADER_CHUNK, HEADER_MAX - total), total);
      if (n <= 0) break;
      const slice = buf.subarray(total, total + n);
      const nl = slice.indexOf(0x0a);
      if (nl !== -1) return buf.subarray(0, total + nl).toString("utf-8");
      total += n;
    }
    return total > 0 ? buf.subarray(0, total).toString("utf-8") : null;
  } catch {
    return null;
  } finally {
    try {
      closeSync(fd);
    } catch {
      /* best-effort */
    }
  }
}

interface SessionHeaderInfo {
  id: string;
  cwd: string | null;
}

function parseSessionHeader(line: string | null): SessionHeaderInfo | null {
  if (!line) return null;
  try {
    const header = JSON.parse(line);
    if (header?.type !== "session") return null;
    return {
      id: typeof header.id === "string" ? header.id : "",
      cwd: typeof header.cwd === "string" ? header.cwd : null,
    };
  } catch {
    return null;
  }
}

interface RawMarkerData {
  observations?: Array<{
    content?: unknown;
    relevance?: unknown;
    timestamp?: unknown;
  }>;
  records?: Array<{
    content?: unknown;
    relevance?: unknown;
    timestamp?: unknown;
  }>;
  reflections?: Array<{
    content?: unknown;
    supportingObservationIds?: unknown;
  }>;
  observationIds?: unknown;
}

function extractFromEntries(
  entries: Array<Record<string, unknown>>,
  sessionId: string,
  observations: CorpusObservation[],
  reflections: CorpusReflection[],
  droppedIds: Set<string>,
): void {
  for (const entry of entries) {
    if (entry.type !== "custom") continue;
    const customType = entry.customType;
    const data = (entry.data ?? {}) as RawMarkerData;
    const entryTs = parseTimestamp(entry.timestamp);
    if (
      customType === OM_OBSERVATIONS_RECORDED ||
      customType === OM_OBSERVATIONS_UNANCHORED ||
      customType === LEGACY_OM_OBSERVATION
    ) {
      const list =
        customType === LEGACY_OM_OBSERVATION ? (data.records ?? []) : (data.observations ?? []);
      for (const o of list) {
        if (typeof o.content !== "string" || !o.content.trim()) continue;
        observations.push({
          id:
            typeof (o as { id?: unknown }).id === "string"
              ? ((o as { id: string }).id as string)
              : null,
          content: o.content,
          relevance: normalizeRelevance(o.relevance),
          timestamp: parseTimestamp(o.timestamp) ?? entryTs,
          sessionId,
          source: "branch",
        });
      }
    } else if (customType === OM_REFLECTIONS_RECORDED) {
      for (const r of data.reflections ?? []) {
        if (typeof r.content !== "string" || !r.content.trim()) continue;
        reflections.push({
          content: r.content,
          supportingObservationIds: Array.isArray(r.supportingObservationIds)
            ? (r.supportingObservationIds as string[])
            : [],
          timestamp: entryTs,
          sessionId,
          source: "branch",
        });
      }
    } else if (customType === OM_OBSERVATIONS_DROPPED) {
      if (Array.isArray(data.observationIds)) {
        for (const id of data.observationIds) {
          if (typeof id === "string") droppedIds.add(id);
        }
      }
    }
  }
}

interface PendingBatch {
  data?: RawMarkerData;
}

interface PendingState {
  observation?: PendingBatch;
  reflection?: PendingBatch;
  dropped?: PendingBatch;
  observationBatches?: PendingBatch[];
  reflectionBatches?: PendingBatch[];
  droppedBatches?: PendingBatch[];
  // Coverage-inert kept facts: same observation payload, no coverage point.
  unanchoredBatches?: PendingBatch[];
}

function extractFromPendingState(
  state: PendingState,
  sessionId: string,
  source: MemorySource,
  observations: CorpusObservation[],
  reflections: CorpusReflection[],
  droppedIds: Set<string>,
): void {
  // Reflections in pending files have no individual timestamp; fall back
  // to the newest observation timestamp in the same file so they render
  // with a useful (N ago) suffix in the export.
  // Consider both batched and singular observation forms for timestamp fallback.
  const allObsBatches: PendingBatch[] = [
    ...(state.observationBatches && state.observationBatches.length > 0
      ? state.observationBatches
      : state.observation
        ? [state.observation]
        : []),
    // Kept tail facts share the observation payload shape; they carry no
    // coverage point but are still facts recall must serve.
    ...(state.unanchoredBatches ?? []),
  ];
  const allReflBatches: PendingBatch[] =
    state.reflectionBatches && state.reflectionBatches.length > 0
      ? state.reflectionBatches
      : state.reflection
        ? [state.reflection]
        : [];
  const allDroppedBatches: PendingBatch[] =
    state.droppedBatches && state.droppedBatches.length > 0
      ? state.droppedBatches
      : state.dropped
        ? [state.dropped]
        : [];

  let maxObsTs: number | null = null;
  for (const batch of allObsBatches) {
    for (const o of batch.data?.observations ?? []) {
      const ts = parseTimestamp((o as { timestamp?: unknown }).timestamp);
      if (ts != null) {
        const ms = Date.parse(ts);
        if (!Number.isNaN(ms) && (maxObsTs === null || ms > maxObsTs)) {
          maxObsTs = ms;
        }
      }
    }
  }
  const reflectionTimestamp = maxObsTs != null ? new Date(maxObsTs).toISOString() : null;

  for (const batch of allObsBatches) {
    for (const o of batch.data?.observations ?? []) {
      if (typeof o.content !== "string" || !o.content.trim()) continue;
      observations.push({
        id:
          typeof (o as { id?: unknown }).id === "string"
            ? ((o as { id: string }).id as string)
            : null,
        content: o.content,
        relevance: normalizeRelevance(o.relevance),
        timestamp: parseTimestamp(o.timestamp),
        sessionId,
        source,
      });
    }
  }
  for (const batch of allReflBatches) {
    for (const r of batch.data?.reflections ?? []) {
      if (typeof r.content !== "string" || !r.content.trim()) continue;
      reflections.push({
        content: r.content,
        supportingObservationIds: Array.isArray(r.supportingObservationIds)
          ? (r.supportingObservationIds as string[])
          : [],
        timestamp: reflectionTimestamp,
        sessionId,
        source,
      });
    }
  }
  for (const batch of allDroppedBatches) {
    const ids = batch.data?.observationIds;
    if (!Array.isArray(ids)) continue;
    for (const id of ids as unknown[]) {
      if (typeof id === "string") droppedIds.add(id);
    }
  }
}

function emptyCorpus(projectRoot: string): ProjectCorpus {
  return {
    projectRoot,
    sessionsConsidered: 0,
    filesWithMarkers: 0,
    observations: [],
    reflections: [],
    droppedIds: new Set(),
    knownSessionIds: new Set(),
    orphanedSessions: 0,
  };
}

function readDirectory(path: string): string[] {
  try {
    return readdirSync(path);
  } catch {
    return [];
  }
}

function* projectSessionFiles(sessionsRoot: string, scopes: Set<string>, activeFile?: string) {
  const seenFiles = new Set<string>();
  for (const scope of scopes) {
    const directory = join(sessionsRoot, scope);
    for (const file of readDirectory(directory)) {
      if (!file.endsWith(".jsonl") || seenFiles.has(file)) continue;
      seenFiles.add(file);
      const path = join(directory, file);
      if (path !== activeFile) yield path;
    }
  }
}

function scanSessionFile(corpus: ProjectCorpus, path: string): void {
  corpus.sessionsConsidered++;
  const sessionId = parseSessionHeader(readFirstLine(path))?.id || basename(path, ".jsonl");
  corpus.knownSessionIds.add(sessionId);

  let raw: string;
  try {
    raw = readFileSync(path, "utf-8");
  } catch {
    return;
  }
  if (!raw.includes("om.")) return;
  corpus.filesWithMarkers++;

  const entries: Array<Record<string, unknown>> = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      entries.push(JSON.parse(trimmed));
    } catch {
      // Like the host, continue past corrupt lines.
    }
  }
  extractFromEntries(entries, sessionId, corpus.observations, corpus.reflections, corpus.droppedIds);
}

function otherSessionIds(sessionsRoot: string, projectScopes: Set<string>): Set<string> {
  const ids = new Set<string>();
  for (const scope of readDirectory(sessionsRoot)) {
    if (projectScopes.has(scope)) continue;
    const directory = join(sessionsRoot, scope);
    for (const file of readDirectory(directory)) {
      if (!file.endsWith(".jsonl")) continue;
      const header = parseSessionHeader(readFirstLine(join(directory, file)));
      const id = header?.id || file.slice(file.lastIndexOf("_") + 1, -6);
      if (id) ids.add(id);
    }
  }
  return ids;
}

/** Yield after each attributed or orphaned buffer so callers can pace the scan. */
function* scanPendingBuffers(
  corpus: ProjectCorpus,
  agentDir: string,
  sessionsRoot: string,
  projectScopes: Set<string>,
): Generator<void> {
  const pendingDir = join(agentDir, PENDING_DIR);
  const files = readDirectory(pendingDir);
  const mains = new Set(files.filter(file => file.endsWith(PENDING_SUFFIX)));
  let foreignIds: Set<string> | undefined;

  for (const file of files) {
    const isMain = file.endsWith(PENDING_SUFFIX);
    if (!isMain && !file.endsWith(STALE_SUFFIX)) continue;
    const sessionId = file.slice(0, -(isMain ? PENDING_SUFFIX : STALE_SUFFIX).length);
    if (!sessionId || (!isMain && mains.has(sessionId + PENDING_SUFFIX))) continue;

    let state: PendingState;
    try {
      state = JSON.parse(readFileSync(join(pendingDir, file), "utf-8"));
    } catch {
      continue;
    }
    if (!state) continue;
    const hasBatches = [state.observationBatches, state.unanchoredBatches, state.reflectionBatches, state.droppedBatches]
      .some(batches => Array.isArray(batches) && batches.length > 0);
    const hasLegacyBatch = [state.observation, state.reflection, state.dropped]
      .some(batch => typeof batch === "object" && batch !== null);
    if (!hasBatches && !hasLegacyBatch) continue;

    const attributed = corpus.knownSessionIds.has(sessionId);
    if (!attributed) {
      foreignIds ??= otherSessionIds(sessionsRoot, projectScopes);
      if (foreignIds.has(sessionId)) continue;
      corpus.orphanedSessions++;
    }
    extractFromPendingState(
      state,
      sessionId,
      attributed ? "pending" : "orphan",
      corpus.observations,
      corpus.reflections,
      corpus.droppedIds,
    );
    yield;
  }
}

function prepareScan(options: BuildCorpusOptions) {
  const agentDir = options.agentDir ?? getAgentDir();
  const sessionsRoot = join(agentDir, "sessions");
  const projectRoot = options.gitRoot || options.cwd;
  const scopes = new Set([encodeScopeDir(options.cwd), encodeScopeDir(projectRoot)]);
  const activeFile = options.activeSessionFile && existsSync(options.activeSessionFile)
    ? options.activeSessionFile
    : undefined;
  return {
    corpus: emptyCorpus(projectRoot),
    files: projectSessionFiles(sessionsRoot, scopes, activeFile),
    agentDir,
    sessionsRoot,
    scopes,
  };
}

/** Build the project corpus without yielding between files. */
export function buildProjectMemoryCorpus(options: BuildCorpusOptions): ProjectCorpus {
  const { corpus, files, agentDir, sessionsRoot, scopes } = prepareScan(options);
  for (const path of files) scanSessionFile(corpus, path);
  for (const _ of scanPendingBuffers(corpus, agentDir, sessionsRoot, scopes)) {
    // The scan updates the corpus before each yield.
  }
  return corpus;
}

export interface CorpusProgress {
  scanned: number;
  total: number;
  phase: "scanning" | "pending";
}

const YIELD_EVERY_FILES = 10;

function yieldToEventLoop(): Promise<void> {
  return new Promise<void>((resolve) => setImmediate(resolve));
}

/** Share the corpus scan while letting the TUI paint progress between batches. */
export async function buildProjectMemoryCorpusAsync(
  options: BuildCorpusOptions,
  onProgress?: (p: CorpusProgress) => void,
): Promise<ProjectCorpus> {
  const { corpus, files, agentDir, sessionsRoot, scopes } = prepareScan(options);
  const paths = [...files];
  const total = paths.length;
  if (total > 0) onProgress?.({ scanned: 0, total, phase: "scanning" });

  for (const path of paths) {
    scanSessionFile(corpus, path);
    const scanned = corpus.sessionsConsidered;
    if (scanned % YIELD_EVERY_FILES === 0) await yieldToEventLoop();
    if (scanned % 25 === 0) onProgress?.({ scanned, total, phase: "scanning" });
  }
  if (total > 0) onProgress?.({ scanned: total, total, phase: "scanning" });

  let pendingProcessed = 0;
  for (const _ of scanPendingBuffers(corpus, agentDir, sessionsRoot, scopes)) {
    pendingProcessed++;
    if (pendingProcessed % YIELD_EVERY_FILES === 0) await yieldToEventLoop();
  }
  return corpus;
}
