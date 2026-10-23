import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { finishBenchmark } from "../benchmark-cleanup.mjs";

test("benchmark preserves failures and removes source when shutdown or sampling fails", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "bifoil failed benchmark Ω "));
  try {
    const directory = path.join(root, "scenes");
    await mkdir(directory);
    await writeFile(path.join(directory, "startup.txt"), "Original disposable source.");
    const resultFile = path.join(root, "report.json");
    const monitor = Object.assign(new EventEmitter(), {
      pid: 1,
      exitCode: null,
      signalCode: null,
      kill(signal) {
        this.signalCode = signal;
        queueMicrotask(() => this.emit("exit", null, signal));
        return true;
      },
    });
    const report = { completed: false, failure: "Original interaction failure", memory: null };
    await finishBenchmark({
      server: {
        close: async () => {
          throw new Error("Original shutdown failure");
        },
      },
      monitor,
      report,
      resultFile,
      directory,
      memoryTimeout: 5,
    });
    const saved = JSON.parse(await readFile(resultFile, { encoding: "utf8" }));
    assert.equal(saved.completed, false);
    assert.match(
      saved.failure,
      /Original interaction failure.*Original shutdown failure.*memory sampling ended without any samples/,
    );
    assert.equal(saved.memory.available, false);
    assert.equal(saved.memory.peakMiB, null);
    assert.equal(monitor.signalCode, "SIGKILL");
    assert.equal(monitor.listenerCount("exit"), 0);
    await assert.rejects(readFile(path.join(directory, "startup.txt")), { code: "ENOENT" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("benchmark retains the 256 MiB limit and rejects malformed sampler output", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "bifoil benchmark memory Ω "));
  try {
    for (const [name, sample, expected] of [
      ["valid", { peakMiB: 128, samples: [{ rss: 128 * 1048576 }] }, true],
      ["oversize", { peakMiB: 257, samples: [{ rss: 257 * 1048576 }] }, false],
      ["empty", { peakMiB: null, samples: [] }, false],
      ["malformed", { peakMiB: null, samples: [{}] }, false],
      ["spawn-error", { peakMiB: 128, samples: [{}] }, false],
      ["not-started", { peakMiB: 128, samples: [{}] }, false],
      ["nonzero-exit", { peakMiB: 128, samples: [{}] }, false],
      ["invalid-json", "{", false],
    ]) {
      const directory = path.join(root, name);
      await mkdir(directory);
      const resultFile = path.join(root, name + ".json");
      await writeFile(resultFile + ".memory.json", name === "invalid-json" ? sample : JSON.stringify(sample));
      const report = { completed: true, memory: null };
      await finishBenchmark({
        monitor: {
          pid: name === "not-started" ? undefined : 1,
          exitCode: name === "nonzero-exit" ? 7 : 0,
          signalCode: null,
        },
        monitorError: name === "spawn-error" ? new Error("Original sampler start failure") : undefined,
        report,
        resultFile,
        directory,
      });
      const saved = JSON.parse(await readFile(resultFile, { encoding: "utf8" }));
      assert.equal(saved.completed, expected, name);
      if (name === "oversize") assert.match(saved.failure, /exceeded 256 MiB/);
      if (name === "valid") assert.equal(saved.memory.peakMiB, 128);
      if (!expected && name !== "oversize") assert.equal(saved.memory.available, false, name);
      if (name === "spawn-error") assert.match(saved.failure, /Original sampler start failure/);
      if (name === "not-started") assert.match(saved.failure, /sampler did not start/);
      if (name === "nonzero-exit") assert.match(saved.failure, /sampler exited 7/);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
