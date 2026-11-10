/** A mutable, bounded prefix; never fold an old task snapshot into history. */
export const CONTINUITY_START = "<!-- context-forge:continuity:start -->";
export const CONTINUITY_END = "<!-- context-forge:continuity:end -->";
export interface ContinuityBlock {
  version: 1;
  text: string;
  revision: number;
  taskUpdatedAt: string;
  status: "active" | "blocked" | "done";
  freshness: "current" | "stale" | "unverified" | "superseded";
}
export function stripContinuity(text: string): string {
  // Only generated standalone blocks; preserve inline code quoting the markers.
  return text.replace(/(?:^|\n)<!-- context-forge:continuity:start -->\r?\n[\s\S]*?\r?\n<!-- context-forge:continuity:end -->(?:\r?\n)*/g, "\n").trim();
}
export function withContinuity(summary: string, block?: ContinuityBlock): string {
  return [block?.text, stripContinuity(summary)].filter(Boolean).join("\n\n");
}
