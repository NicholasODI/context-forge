import { expect, it } from "vitest";
import { runWorkerAttempt, WorkerAttemptTimeoutError } from "./worker-attempt";

it("bounds a provider that ignores cancellation and aborts the child signal", async () => {
  let child: AbortSignal | undefined;
  await expect(runWorkerAttempt("observer", 20, new AbortController().signal, signal => {
    child = signal; return new Promise(() => {});
  })).rejects.toBeInstanceOf(WorkerAttemptTimeoutError);
  expect(child?.aborted).toBe(true);
});
it("settles immediately on parent cancellation even if the provider does not cooperate", async () => {
  const controller = new AbortController();
  const attempt = runWorkerAttempt("reflector", 1000, controller.signal, () => new Promise(() => {}));
  controller.abort(new Error("synthetic session ended"));
  await expect(attempt).rejects.toThrow("synthetic session ended");
});
