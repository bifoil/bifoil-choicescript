import { readFile, rm, writeFile } from "node:fs/promises";

/** Wait for an owned child without leaving listeners or timers after settlement. */
function waitForExit(child, timeout) {
  if (child.exitCode !== null || child.signalCode !== null) return globalThis.Promise.resolve();
  return new globalThis.Promise((resolve, reject) => {
    const done = (error) => {
      clearTimeout(timer);
      child.off("exit", exited);
      child.off("error", failed);
      error ? reject(error) : resolve();
    };
    const exited = () => done();
    const failed = (error) => done(error);
    const timer = setTimeout(() => done(new Error("Timed out stopping the memory sampler")), timeout);
    child.once("exit", exited);
    child.once("error", failed);
  });
}

/** Validate a sampler result before it can establish a successful memory check. */
async function readMemoryReport(monitor, monitorError, resultFile, timeout) {
  if (monitorError) throw monitorError;
  if (!monitor.pid) throw new Error("Memory sampler did not start");
  await waitForExit(monitor, timeout);
  if (monitor.exitCode !== 0) throw new Error("Memory sampler exited " + monitor.exitCode);
  const value = await readFile(resultFile + ".memory.json", { encoding: "utf8" });
  const memory = JSON.parse(value.replace(/^\uFEFF/, ""));
  if (!Array.isArray(memory.samples) || !memory.samples.length)
    throw new Error("Memory sampler did not record any samples");
  if (!Number.isFinite(memory.peakMiB) || memory.peakMiB < 0)
    throw new Error("Memory sampler returned an invalid peak");
  return memory;
}

/** Preserve failed measurements and remove disposable source even when teardown fails. */
export async function finishBenchmark({
  server,
  monitor,
  monitorError,
  report,
  resultFile,
  directory,
  memoryTimeout = 10000,
}) {
  const fail = (message) => {
    report.failure = report.failure ? report.failure + "; " + message : message;
    report.completed = false;
  };
  try {
    await server?.close();
  } catch (error) {
    fail("Runtime shutdown failed: " + error);
  }
  if (monitor) {
    try {
      report.memory = await readMemoryReport(monitor, monitorError, resultFile, memoryTimeout);
      if (report.memory.peakMiB > 256) fail("Combined runtime memory exceeded 256 MiB");
    } catch (error) {
      fail("Runtime memory sampling ended without any samples: " + error);
      report.memory = { available: false, peakMiB: null, samples: [] };
    } finally {
      if (monitor.pid && monitor.exitCode === null && monitor.signalCode === null) {
        monitor.kill("SIGKILL");
        try {
          await waitForExit(monitor, 3000);
        } catch (error) {
          fail("Memory sampler cleanup failed: " + error);
        }
      }
    }
  }
  try {
    await rm(directory, { recursive: true, force: true });
  } catch (error) {
    fail("Temporary source cleanup failed: " + error);
  }
  await writeFile(resultFile, JSON.stringify(report, null, 2));
}
