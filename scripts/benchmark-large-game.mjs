/**
 * Opt-in synthetic scale probe: <chapters> <words-per-chapter> [report-path].
 * Requires built server output. Generates original temporary scenes and removes them
 * afterward; JSON reports persist in ignored development output.
 * Current evidence limits: repeated prose edits can be no-ops; memory sampling is
 * Windows/server-only; no native UI or game-tool-child acceptance is established here.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { narrativeWords as count } from "../packages/core/src/plain-text.ts";
import { classification, startServer, waitFor } from "../packages/server/test/helpers.ts";
import { artifactPath } from "./artifact-paths.mjs";
import { hostTool } from "./host-tools.mjs";
import { finishBenchmark } from "./benchmark-cleanup.mjs";

const scenes = Number(process.argv[2] ?? 1000),
  wordsPerScene = Number(process.argv[3] ?? 30000);

assert(Number.isSafeInteger(scenes) && scenes >= 2 && scenes <= 10000);
assert(Number.isSafeInteger(wordsPerScene) && wordsPerScene >= 1000 && wordsPerScene <= 1000000);

const resultFile = await artifactPath(
  process.argv[4] ?? ".bifoil-choicescript/development/evidence/performance-30m/benchmark.json",
  [".bifoil-choicescript/development"],
);
await mkdir(path.dirname(resultFile), { recursive: true });

const dir = await mkdtemp(path.join(os.tmpdir(), "bifoil thirty million Ω "));
const sceneDir = path.join(dir, "scenes");
await mkdir(sceneDir);

const name = (i) => "chapter" + String(i).padStart(4, "0");

const narrative = ['She said "This passage will end', '    with William."', '    with Belle."', "She walked away."];
const sentence =
  "Original synthetic prose records the changing light along a quiet path while each traveler considers another direction before moving onward.";
const sentenceWords = count(sentence);

function chapter(i) {
  const rows = [
    "*label entry",
    "*temp local_metric 7",
    "*print local_metric",
    "*print metric",
    narrative[0],
    "*if gate",
    narrative[1],
    "*else",
    narrative[2],
    narrative[3],
  ];
  let remaining = wordsPerScene - narrative.reduce((n, line) => n + count(line), 0),
    paragraphs = 0;

  while (remaining > 0) {
    const words = Math.min(remaining, sentenceWords);
    rows.push(sentence.split(" ").slice(0, words).join(" "));
    remaining -= words;
    paragraphs++;

    if (paragraphs % 200 === 0) {
      rows.push("*set local_metric + 1");
      rows.push("");
    }
  }

  rows.push("*print metric");
  rows.push(i + 1 < scenes ? "*goto_scene " + name(i + 1) : "*ending");

  return rows.join("\r\n");
}

const report = {
  scenes: scenes + 1,
  words: scenes * wordsPerScene,
  wordsPerScene,
  sourceBytes: 0,
  sourceLines: 0,
  commands: 0,
  measurements: [],
  memory: null,
  errors: [],
  completed: false,
};
let server, monitor, monitorError;

try {
  const startup =
    "*title Original scale benchmark\r\n*author Test\r\n*create implicit_control_flow true\r\n*create gate true\r\n*create metric 7\r\n*scene_list\r\n  startup\r\n" +
    Array.from({ length: scenes }, (_, i) => "  " + name(i)).join("\r\n") +
    "\r\n*goto_scene " +
    name(0);

  for (let i = -1; i < scenes; i++) {
    const text = i < 0 ? startup : chapter(i);
    report.sourceBytes += Buffer.byteLength(text);
    report.sourceLines += text.split("\r\n").length;
    report.commands += (text.match(/^[ \t]*\*/gm) ?? []).length;
    await writeFile(path.join(sceneDir, (i < 0 ? "startup" : name(i)) + ".txt"), text);
  }

  console.log(JSON.stringify({ phase: "generated", ...report, measurements: undefined, errors: undefined }));
  process.env.BIFOIL_CHOICESCRIPT_PROFILE = "1";

  const h = (server = await startServer([dir]));
  h.child.stderr.on("data", (bytes) => {
    for (const line of bytes.toString().split(/\r?\n/))
      if (line.startsWith("BIFOIL_ANALYSIS_PROFILE ")) console.log(line);
  });
  h.rpc.onNotification("window/logMessage", (message) => {
    if (message.type === 1) report.errors.push(message.message);
  });

  if (process.platform === "win32") {
    const memoryFile = resultFile + ".memory.json";
    const ps =
      "$ErrorActionPreference='Stop';$ownedProcessId=" +
      h.child.pid +
      ";$samples=New-Object System.Collections.Generic.List[object];$peak=0L;" +
      "while($true){$p=Get-Process -Id $ownedProcessId -ErrorAction SilentlyContinue;if(!$p){break};" +
      "try{$rss=[long]$p.WorkingSet64}catch{break};if($rss -gt $peak){$peak=$rss};" +
      "$samples.Add([pscustomobject]@{time=[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds();rss=$rss});" +
      "Start-Sleep -Milliseconds 50};$available=$samples.Count -gt 0;" +
      "[pscustomobject]@{available=$available;peakMiB=$(if($available){$peak/1MB}else{$null});samples=$samples;scope='Server and analysis-worker threads; no tool children active'} | ConvertTo-Json -Depth 5 -Compress | Set-Content -LiteralPath '" +
      memoryFile.replaceAll("'", "''") +
      "' -Encoding UTF8";
    monitor = spawn(await hostTool("powershell"), ["-NoProfile", "-NonInteractive", "-Command", ps], {
      windowsHide: true,
      stdio: ["ignore", "ignore", "inherit"],
    });
    monitor.on("error", (error) => {
      monitorError = error;
    });
  }

  const active = Math.floor(scenes / 2),
    uri = pathToFileURL(path.join(sceneDir, name(active) + ".txt")).href;
  const text = chapter(active),
    position = { line: 2, character: 10 };

  const timed = async (name, action, limit = 1000) => {
    const start = performance.now(),
      value = await action(),
      ms = performance.now() - start;
    report.measurements.push({ name, ms });
    console.log(JSON.stringify({ name, ms }));

    assert(ms < limit, name + " exceeded " + limit + " ms");

    return value;
  };

  await timed("cold active-scene diagnostics", async () => {
    h.open(uri, text);
    await waitFor(() => h.diagnostics.find((d) => d.uri === uri && d.version === 1));
  });

  const initialized = performance.now();
  let lastProgress = 0;
  await waitFor(
    async () => {
      if (report.errors.length) throw new Error(report.errors.join("\n"));

      const states = await h.rpc.sendRequest("choicescript/indexStatus");

      if (states.some((state) => state.limited)) throw new Error("Project analysis reached its work limit.");

      if (performance.now() - lastProgress > 10000) {
        console.log(JSON.stringify({ phase: "indexing", states }));
        lastProgress = performance.now();
      }

      return states;
    },
    (states) => states.length === 1 && states[0].complete,
    300000,
  );

  const [indexed] = await h.rpc.sendRequest("choicescript/indexStatus");

  assert.equal(indexed.words, report.words);

  report.indexedWords = indexed.words;
  report.indexingMs = performance.now() - initialized;
  console.log(JSON.stringify({ phase: "indexed", ms: report.indexingMs }));

  const currentCount = await h.rpc.sendRequest("choicescript/wordCount", { uri });

  assert.equal(currentCount, wordsPerScene);

  const params = { textDocument: { uri }, position };

  for (let i = 0; i < 3; i++) {
    const hover = await timed("warm hover", () => h.rpc.sendRequest("textDocument/hover", params));

    assert(hover.contents.value.includes("Type: " + String.fromCharCode(96) + "number"));

    const completion = await timed("warm completion", () => h.rpc.sendRequest("textDocument/completion", params));

    assert(completion.some((item) => item.label === "metric"));

    const definition = await timed("warm definition", () => h.rpc.sendRequest("textDocument/definition", params));

    assert.equal(definition.uri, uri);

    const tokens = await timed("warm highlighting", () =>
      h.rpc.sendRequest("textDocument/semanticTokens/full", { textDocument: { uri } }),
    );

    assert.equal(classification(tokens, h.legend, 6, 4), "dialogue");
    assert.equal(classification(tokens, h.legend, 8, 4), "dialogue");
    assert.equal(classification(tokens, h.legend, 9, 0), "narrative");
  }

  const metricParams = { textDocument: { uri }, position: { line: 3, character: 8 } };
  const refs = await timed("project references", () =>
    h.rpc.sendRequest("textDocument/references", { ...metricParams, context: { includeDeclaration: true } }),
  );

  assert(refs.length >= scenes * 2 + 1);

  const renamed = await timed("project rename", () =>
    h.rpc.sendRequest("textDocument/rename", { ...metricParams, newName: "story_metric" }),
  );

  assert(Object.keys(renamed.changes).length === scenes + 1);

  for (let version = 2; version <= 7; version++) {
    const type = version % 2 ? "number" : "boolean";
    const changed = text.replace("*temp local_metric 7", "*temp local_metric " + (type === "number" ? "7" : "true"));
    await timed("structural edit and current hover", async () => {
      h.change(uri, changed, version);

      let value;

      try {
        value = await h.rpc.sendRequest("textDocument/hover", params);
      } catch (error) {
        await waitFor(() => h.diagnostics.find((d) => d.uri === uri && d.version === version), undefined, 10000);
        throw error;
      }

      assert(value.contents.value.includes("Type: " + String.fromCharCode(96) + type));

      await waitFor(() => h.diagnostics.find((d) => d.uri === uri && d.version === version));

      const tokens = await h.rpc.sendRequest("textDocument/semanticTokens/full", { textDocument: { uri } });

      assert.equal(classification(tokens, h.legend, 2, 10), type + "Variable");
    });
  }

  for (let version = 8; version <= 12; version++)
    await timed(
      "plain prose edit and current feedback",
      async () => {
        h.change(uri, text.replace(sentence, sentence + " another"), version);

        const value = await h.rpc.sendRequest("textDocument/hover", params);

        assert(value.contents.value.includes("local_metric"));

        await waitFor(() => h.diagnostics.find((d) => d.uri === uri && d.version === version));

        assert.equal(await h.rpc.sendRequest("choicescript/wordCount", { uri }), wordsPerScene + 1);
      },
      500,
    );

  assert.equal(report.errors.length, 0, report.errors.join("\n"));

  report.completed = true;
} catch (error) {
  report.failure = String(error);
  process.exitCode = 1;
} finally {
  await finishBenchmark({ server, monitor, monitorError, report, resultFile, directory: dir });
  if (!report.completed) process.exitCode = 1;
  console.log(
    JSON.stringify({
      phase: "finished",
      completed: report.completed,
      failure: report.failure,
      peakMiB: report.memory?.peakMiB,
      evidence: resultFile,
    }),
  );
}
