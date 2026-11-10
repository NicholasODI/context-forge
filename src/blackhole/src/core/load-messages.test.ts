import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { loadAllMessages, clearSessionCache, MAX_CACHED_SESSION_BYTES } from "./load-messages";

const fake = vi.hoisted(() => ({ sizes: new Map<string, number>(), scans: new Map<string, number>() }));
vi.mock("fs", async original => {
  const actual = await original<typeof import("fs")>();
  return { ...actual, statSync: (path: string, ...args: any[]) => {
    const info = actual.statSync(path, ...args);
    return fake.sizes.has(path) ? { ...info, size: fake.sizes.get(path)! } : info;
  } };
});
vi.mock("./session-lines.js", () => ({
  scanSessionEntries(file: string, onEntry: Function) {
    fake.scans.set(file, (fake.scans.get(file) ?? 0) + 1);
    onEntry({ type: "message", id: "source", message: { role: "user", content: "A real rendered message", timestamp: 1 } });
    return { missing: false, parseErrors: 0 };
  },
}));
let root: string;
beforeEach(async () => { clearSessionCache(); fake.sizes.clear(); fake.scans.clear(); root = await mkdtemp(join(tmpdir(), "forge-cache-test-")); });
afterEach(async () => { clearSessionCache(); await rm(root, { recursive: true, force: true }); });
async function file(name: string, size: number) {
  const path = join(root, name); await writeFile(path, "fixture"); fake.sizes.set(path, size); return path;
}

it("does not retain session results above 64 MiB source size", async () => {
  const path = await file("large.jsonl", MAX_CACHED_SESSION_BYTES + 1);
  expect(loadAllMessages(path, false).rendered).toHaveLength(1);
  loadAllMessages(path, false);
  expect(fake.scans.get(path)).toBe(2);
});
it("evicts by the aggregate source-byte budget, not just the three-entry count", async () => {
  const files = await Promise.all(["a", "b", "c"].map(name => file(name, 60 * 1024 * 1024)));
  files.forEach(path => loadAllMessages(path, false));
  loadAllMessages(files[2], false); expect(fake.scans.get(files[2])).toBe(1);
  loadAllMessages(files[0], false); expect(fake.scans.get(files[0])).toBe(2);
});
it("invalidates a cached result when file size changes even if mtime does not", async () => {
  const path = await file("growing.jsonl", 100);
  loadAllMessages(path, false); loadAllMessages(path, false);
  expect(fake.scans.get(path)).toBe(1);
  fake.sizes.set(path, 200);
  loadAllMessages(path, false);
  expect(fake.scans.get(path)).toBe(2);
});
