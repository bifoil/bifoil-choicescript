import { URI } from "vscode-uri";
import runtimeInventory from "../../../vendor/runtime-files.json" with { type: "json" };
import { finished as streamFinished, pipeline } from "node:stream/promises";
import type { Readable } from "node:stream";
import { cp, lstat, mkdir, mkdtemp, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import { StringDecoder } from "node:string_decoder";
import { createReadStream, createWriteStream } from "node:fs";
import { type ChildProcess, spawn } from "node:child_process";
import { createServer, type Server } from "node:http";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import {
  type BufferSnapshot,
  ITERATIONS_ERROR,
  type JobEvent,
  type JobRequest,
  type JobResult,
  type Project,
  PROTOCOL_VERSION,
  SEED_ERROR,
  SEED_RANGE_ERROR,
  validIterations,
  validSeed,
  validSeedRange,
} from "@bifoil/choicescript-protocol";
import { contains, exists, projectSources, sameFileUri } from "./projects.js";

const enginePaths = new Set(
  runtimeInventory.files.flatMap((file) => {
    const parts = file.split("/");
    return parts.map((_, index) => parts.slice(0, index + 1).join("/"));
  }),
);

function enqueue<T>(queue: Map<string, Promise<void>>, key: string, run: () => Promise<T>): Promise<T> {
  const previous = queue.get(key) ?? Promise.resolve();
  const result = previous.then(run);
  const settled = result.then(
    () => {},
    () => {},
  );
  queue.set(key, settled);
  void settled.then(() => {
    if (queue.get(key) === settled) queue.delete(key);
  });
  return result;
}
function sceneFilename(sceneDir: string, file: string): string | undefined {
  if (!contains(sceneDir, file) || !/\.txt$/i.test(file)) return undefined;
  const relative = path.relative(sceneDir, file);
  if (path.dirname(relative) !== ".")
    throw new Error("ChoiceScript runtime scenes must be directly inside the scene directory: " + relative);
  return relative;
}
type Job = {
  id: string;
  project: Project;
  stage: string;
  child?: ChildProcess;
  server?: Server;
  stale: boolean;
  cancelled: boolean;
  completion?: Promise<void>;
  stopping?: Promise<void>;
  controller: AbortController;
  resolveCompletion: () => void;
  finished?: boolean;
};
export class ToolRunner {
  readonly jobs = new Map<string, Job>();
  private readonly results = new Map<string, Job>();
  private readonly starts = new Map<string, Promise<void>>();
  private readonly creates = new Map<string, Promise<void>>();
  private readonly revisions = new Map<string, number>();
  private closing = false;
  private readonly cleanupPaths = new Set<string>();
  constructor(
    readonly engine: string,
    readonly emit: (event: JobEvent) => void,
    readonly node = process.execPath,
  ) {}
  event(job: Job, kind: JobEvent["kind"], rest: Partial<JobEvent> = {}) {
    this.emit({
      protocolVersion: PROTOCOL_VERSION,
      jobId: job.id,
      projectId: job.project.id,
      kind,
      stale: job.stale,
      ...rest,
    });
  }
  async createProject(destination: string) {
    if (this.closing) throw new Error("Game tooling is shutting down.");
    const key = path.resolve(destination);
    return enqueue(this.creates, key, () => this.createProjectNow(destination));
  }
  async stage(project: Project, buffers: BufferSnapshot[], job?: Job) {
    this.check(job);
    const dir = await mkdtemp(path.join(os.tmpdir(), "bifoil-choicescript-"));
    if (job) job.stage = dir;
    try {
      const files = await projectSources(project, buffers, job?.controller.signal);
      this.check(job);
      await this.copySnapshot(this.engine, dir, job, (source) => {
        const relative = path.relative(this.engine, source).split(path.sep).join("/");
        return relative === "" || enginePaths.has(relative);
      });
      const game = path.join(dir, "web/mygame");
      await rm(path.join(game, "scenes"), { recursive: true, force: true });
      const excluded = new Set([
        ".git",
        ".cache",
        "node_modules",
        "vendor",
        "dist",
        "build",
        "export",
        ".idea",
        ".gradle",
        ".bifoil-choicescript",
        ".branchlight",
        "scenes",
        ".env",
        ".npmrc",
        ".pnpmrc",
        ".yarnrc",
        ".yarnrc.yml",
        ".ssh",
        ".aws",
      ]);
      await this.copySnapshot(project.assetDir, game, job, (source) => {
        if (source === project.assetDir) return true;
        const name = path.basename(source);
        return !(
          excluded.has(name) ||
          name.startsWith(".") ||
          /\.(?:pem|key|p12|pfx)$/i.test(name) ||
          path.resolve(source) === path.resolve(project.sceneDir) ||
          (project.assetDir === project.sceneDir && /\.txt$/i.test(name))
        );
      });
      await mkdir(path.join(game, "scenes"), { recursive: true });
      // Only regular scene files are staged. Never copy links or arbitrary directories
      // into the generator's flat scene directory and never overlay a copied link.
      for (const source of files) {
        this.check(job);
        const relative = sceneFilename(project.sceneDir, source.file);
        if (relative === undefined) continue;
        const destination = path.join(game, "scenes", relative);
        if (source.buffer) await writeFile(destination, source.buffer.text, { signal: job?.controller.signal });
        else {
          const before = await lstat(source.file, { bigint: true });
          if (!before.isFile() || before.isSymbolicLink())
            throw new Error("Scene source must be a regular file: " + relative);
          await pipeline(createReadStream(source.file), createWriteStream(destination, { flags: "wx" }), {
            signal: job?.controller.signal,
          });
          const after = await lstat(source.file, { bigint: true });
          if (
            !after.isFile() ||
            after.isSymbolicLink() ||
            before.ino !== after.ino ||
            before.size !== after.size ||
            before.mtimeNs !== after.mtimeNs ||
            before.ctimeNs !== after.ctimeNs
          )
            throw new Error("Scene changed while preparing the game; run it again: " + relative);
        }
      }
      const generated = await this.capture(dir, "mygamegenerator.js", ["mygame"], job);
      this.check(job);
      await writeFile(path.join(game, "mygame.js"), generated, { signal: job?.controller.signal });
      return dir;
    } catch (error) {
      await this.cleanup(dir, job);
      throw error;
    }
  }
  async capture(cwd: string, script: string, args: string[], job?: Job) {
    this.check(job);
      this.check(job);
      return await new Promise<string>((resolve, reject) => {
        const child = spawn(this.node, [script, ...args], { cwd, windowsHide: true });
        if (job) job.child = child;
        const out: Buffer[] = [],
          err: Buffer[] = [];
        let bytes = 0,
          failure: Error | undefined;
        const abort = () => {
          failure ??= new Error("Operation cancelled.");
          child.kill("SIGKILL");
        };
        job?.controller.signal.addEventListener("abort", abort, { once: true });
        const timer = setTimeout(() => {
          failure = new Error("ChoiceScript preparation exceeded 30 seconds.");
          child.kill("SIGKILL");
        }, 30_000);
        timer.unref();
        const collect = (chunks: Buffer[], chunk: Buffer) => {
          bytes += chunk.length;
          if (bytes > 16 * 1024 * 1024) {
            failure ??= new Error("ChoiceScript preparation exceeded its 16 MiB output limit.");
            child.kill("SIGKILL");
          } else chunks.push(chunk);
        };
        child.stdout.on("data", (chunk: Buffer) => collect(out, chunk));
        child.stderr.on("data", (chunk: Buffer) => collect(err, chunk));
        child.once("error", (error) => {
          failure = error;
        });
        child.once("close", (code) => {
          clearTimeout(timer);
          job?.controller.signal.removeEventListener("abort", abort);
          if (job?.child === child) job.child = undefined;
          if (failure) reject(failure);
          else if (code !== 0)
            reject(
              new Error(
                Buffer.concat(err).toString() || Buffer.concat(out).toString() || "Preparation process exited " + code,
              ),
            );
          else resolve(Buffer.concat(out).toString());
        });
      });
  }
  async stopProject(projectId?: string, jobId?: string): Promise<JobResult> {
    if (jobId) {
      const job = this.jobs.get(jobId);
      if (job && projectId && job.project.id !== projectId) throw new Error("Job belongs to another project.");
      await this.stop(jobId);
    } else
      await Promise.all(
        [...this.jobs.values()].filter((j) => !projectId || j.project.id === projectId).map((j) => this.stop(j.id)),
      );
    return { jobId: jobId ?? "", projectId: projectId ?? "" };
  }
  async start(request: JobRequest, project: Project, buffers: BufferSnapshot[]): Promise<JobResult> {
    if (request.protocolVersion !== PROTOCOL_VERSION) throw new Error("Unsupported tooling protocol version.");
    if (request.operation === "stop") return this.stopProject(project.id, request.jobId);
    if (this.closing) throw new Error("Game tooling is shutting down.");
    if (!["run", "quicktest", "randomtest", "exportHtml"].includes(request.operation))
      throw new Error("Unknown tooling operation.");
    if (!request.trusted) throw new Error("Trust this workspace before running game code.");
    const count = request.iterations ?? project.randomtest?.iterations ?? 1000;
    const seed = request.seed ?? project.randomtest?.seed ?? 0;
    if (request.operation === "randomtest") {
      if (!validIterations(count)) throw new Error(ITERATIONS_ERROR);
      if (!validSeed(seed)) throw new Error(SEED_ERROR);
      if (!validSeedRange(seed, count)) throw new Error(SEED_RANGE_ERROR);
    }
    if (request.operation === "exportHtml" && !request.destination) throw new Error("Choose an export destination.");
    const id = request.jobId ?? randomUUID();
    if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(id)) throw new Error("Job ID must be a UUID.");
    if (this.jobs.has(id) || this.results.has(id)) throw new Error("Job ID is already in use.");
    let resolveCompletion!: () => void;
    const completion = new Promise<void>((resolve) => {
      resolveCompletion = resolve;
    });
    const job: Job = {
      id,
      project,
      stage: "",
      stale: false,
      cancelled: false,
      controller: new AbortController(),
      completion,
      resolveCompletion,
    };
    const revision = this.revisions.get(project.id) ?? 0;
    const snapshot = buffers.map((buffer) => ({ ...buffer }));
    this.jobs.set(id, job);
    this.event(job, "started");
    return enqueue(this.starts, project.id, async () => {
      try {
        this.check(job);
        return await this.startNow({ ...request }, project, snapshot, revision, job);
      } catch (error) {
        await this.complete(job, job.cancelled ? 130 : 1, String(error));
        throw error;
      }
    });
  }
  async preview(job: Job): Promise<JobResult> {
    const base = await realpath(path.join(job.stage, "web"));
    const types: Record<string, string> = {
      ".html": "text/html",
      ".js": "text/javascript",
      ".css": "text/css",
      ".txt": "text/plain",
      ".png": "image/png",
      ".jpg": "image/jpeg",
      ".svg": "image/svg+xml",
      ".mp3": "audio/mpeg",
    };
    const token = randomUUID();
    const server = createServer(async (req, res) => {
      try {
        const url = new URL(req.url ?? "/", "http://localhost");
        const prefix = "/" + token + "/";
        if (!url.pathname.startsWith(prefix)) {
          res.writeHead(404).end();
          return;
        }
        const decoded = decodeURIComponent(url.pathname.slice(prefix.length));
        let file = path.resolve(base, decoded || "mygame/index.html");
        if (!contains(base, file)) {
          res.writeHead(403).end();
          return;
        }
        if ((await stat(file)).isDirectory()) file = path.join(file, "index.html");
        file = await realpath(file);
        if (!contains(base, file)) {
          res.writeHead(403).end();
          return;
        }
        res.setHeader("Content-Type", types[path.extname(file)] ?? "application/octet-stream");
        res.setHeader("Cache-Control", "no-store");
        createReadStream(file)
          .on("error", () => res.destroy())
          .pipe(res);
      } catch {
        res.writeHead(404).end("File not found");
      }
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => resolve());
    });
    if (job.controller.signal.aborted) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      this.check(job);
    }
    job.server = server;
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Preview failed to bind");
    const url = `http://127.0.0.1:${address.port}/${token}/mygame/index.html`;
    this.event(job, "preview", { url });
    return { jobId: job.id, projectId: job.project.id, url };
  }
  markStale(projectId: string) {
    this.revisions.set(projectId, (this.revisions.get(projectId) ?? 0) + 1);
    for (const job of [...this.jobs.values(), ...this.results.values()])
      if (job.project.id === projectId && !job.stale) {
        job.stale = true;
        this.event(job, "stale", {
          message: "Source changed; restart preview or rerun tests to use the current snapshot.",
        });
      }
  }
  async stop(id: string) {
    const job = this.jobs.get(id);
    if (!job) return;
    return (job.stopping ??= this.stopJob(job));
  }
  async dispose() {
    this.closing = true;
    await Promise.all([...this.jobs.keys()].map((id) => this.stop(id)));
    await Promise.all(this.starts.values());
    await Promise.all(this.creates.values());
    await Promise.all([...this.cleanupPaths].map((stage) => this.cleanup(stage)));
  }
  private async createProjectNow(destination: string) {
    if ((await exists(destination)) && (await readdir(destination)).length)
      throw new Error("Choose an empty directory; existing files will not be overwritten.");
    await mkdir(destination, { recursive: true });
    await this.copySnapshot(path.join(this.engine, "web/mygame"), destination, undefined, () => true, true, true);
    await cp(path.join(this.engine, "LICENSE.txt"), path.join(destination, "CHOICESCRIPT-LICENSE.txt"), {
      force: false,
      errorOnExist: true,
    });
    await writeFile(
      path.join(destination, "choicescript.json"),
      JSON.stringify(
        {
          scenes: "scenes",
          assets: ".",
          randomtest: { iterations: 1000, seed: 0 },
        },
        null,
        2,
      ) + "\n",
      { flag: "wx" },
    );
    await writeFile(
      path.join(destination, "UPSTREAM-TEMPLATE.md"),
      "This game was created from the unmodified ChoiceScript template at commit 60a6c3ee7393c9ee7e42650b8e1642ae38e3cb6a. Template and engine materials retain the ChoiceScript License in CHOICESCRIPT-LICENSE.txt. The independent editor tooling is unaffiliated with Choice of Games.\n",
      { flag: "wx" },
    );
    return {
      jobId: "created",
      projectId: URI.file(path.join(destination, "scenes")).toString(),
    };
  }
  private check(job?: Job) {
    job?.controller.signal.throwIfAborted();
  }
  private async copySnapshot(
    source: string,
    destination: string,
    job: Job | undefined,
    include: (source: string) => boolean,
    root = true,
    exclusive = false,
  ): Promise<void> {
    this.check(job);
    if (!include(source)) return;
    const entry = root ? await stat(source) : await lstat(source);
    if (entry.isSymbolicLink()) return;
    if (entry.isDirectory()) {
      if (exclusive && (await exists(destination))) {
        const output = await lstat(destination);
        if (!output.isDirectory() || output.isSymbolicLink())
          throw new Error("Export directory must not replace a file or follow a symbolic link: " + destination);
      }
      await mkdir(destination, { recursive: true });
      for (const name of await readdir(source))
        await this.copySnapshot(path.join(source, name), path.join(destination, name), job, include, false, exclusive);
    } else if (entry.isFile()) {
      await pipeline(createReadStream(source), createWriteStream(destination, { flags: exclusive ? "wx" : "w" }), {
        signal: job?.controller.signal,
      });
    }
  }
  private async startNow(
    request: JobRequest,
    project: Project,
    buffers: BufferSnapshot[],
    revision: number,
    job: Job,
  ): Promise<JobResult> {
    const count = request.iterations ?? project.randomtest?.iterations ?? 1000,
      seed = request.seed ?? project.randomtest?.seed ?? 0;
    if (request.operation === "run") {
      for (const job of this.jobs.values()) if (job.project.id === project.id && job.server) await this.stop(job.id);
    }
    const stage = await this.stage(project, buffers, job);
    this.check(job);
    job.stale ||= revision !== (this.revisions.get(project.id) ?? 0);
    try {
      if (request.operation === "run") return await this.preview(job);
      let script = "quicktest.js",
        args = ["mygame"];
      if (request.operation === "randomtest") {
        script = "randomtest.js";
        args = [
          `num=${count}`,
          "game=mygame",
          `seed=${seed}`,
          `showText=${!!request.showText}`,
          "showChoices=false",
          "showCoverage=true",
          "delay=false",
        ];
      }
      if (request.operation === "exportHtml") {
        script = "compile.js";
        args = ["export.html"];
      }
      const nodeArgs = [script, ...args];
      if (request.operation === "exportHtml") {
        const preload = path.join(stage, "bifoil-choicescript-preload.cjs");
        await writeFile(
          preload,
          "// Bridge the upstream compiler's VM-loaded generator to its CommonJS host.\nglobal.rootDir = 'web/';\n",
        );
        nodeArgs.unshift("--require", preload);
      }
      const sceneNames = new Set(
        (await readdir(path.join(stage, "web/mygame/scenes"))).map((file) => file.replace(/\.txt$/i, "")),
      );
      const logDir = path.join(project.root, ".bifoil-choicescript", "logs");
      await mkdir(logDir, { recursive: true });
      this.check(job);
      const output = path.join(logDir, job.id + ".log"),
        log = createWriteStream(output);
      let sawError = false;
      const paused = new Set<Readable>();
      log.on("error", (error) => {
        for (const stream of paused) stream.resume();
        paused.clear();
        sawError = true;
        this.event(job, "output", {
          message: "Could not save test output: " + error.message,
        });
      });
      const coverage: Record<string, number[]> = Object.create(null);
      let coverageReady = !request.showText;
      let quicktestFailed = false;
      let failure: Partial<JobEvent> | undefined;
      const warnings: Partial<JobEvent>[] = [];
      const handle = (message: string) => {
        this.event(job, "output", { message });
        // Coverage echoes arbitrary source text. Consume it before parsing errors.
        if (/^Word count: \d+$/.test(message)) {
          coverageReady = true;
          // Actual final coverage follows the final word count, after prose output.
          for (const scene of Object.keys(coverage)) delete coverage[scene];
        }
        if (message === "QUICKTEST FAILED") quicktestFailed = true;
        const count = /^(.*?) (\d+): /.exec(message);
        if (request.operation === "randomtest" && coverageReady && count && sceneNames.has(count[1])) {
          (coverage[count[1]] ??= []).push(Number(count[2]));
          return;
        }
        const match = /^(RANDOMTEST FAILED: (?:Error: )?|WARNING |Error: )?(.+?) line (\d+):\s*(.*)$/i.exec(message);
        if (
          match &&
          sceneNames.has(match[2].replace(/\.txt$/i, "")) &&
          (quicktestFailed || match[1] || /^WARNING\b/.test(match[4]))
        ) {
          const warning = match[1] === "WARNING " || /^WARNING\b/.test(match[4]);
          const file = path.join(project.sceneDir, match[2].replace(/\.txt$/i, "") + ".txt");
          if (!contains(project.sceneDir, file)) return;
          const diagnostic: Partial<JobEvent> = {
            uri:
              buffers.find((buffer) => sameFileUri(buffer.uri, pathToFileURL(file).href))?.uri ??
              pathToFileURL(file).href,
            line: Math.max(0, Number(match[3]) - 1),
            message: match[4],
            severity: warning ? 2 : 1,
          };
          if (warning && request.operation === "quicktest") warnings.push(diagnostic);
          else if (!warning) failure = diagnostic;
        }
      };
      this.check(job);
      const child = spawn(this.node, nodeArgs, {
        cwd: stage,
        windowsHide: true,
      });
      job.child = child;
      const streams = [child.stdout, child.stderr].map((stream) => {
        const decoder = new StringDecoder("utf8");
        let pending = "";
        const accept = (text: string) => {
          pending += text;
          const lines = pending.split(/\r?\n/);
          pending = lines.pop() ?? "";
          for (const line of lines) handle(line);
          // Bound line buffering even for scripts emitting no newlines.
          if (pending.length > 1024 * 1024) {
            handle(pending);
            pending = "";
          }
        };
        stream.on("data", (chunk: Buffer) => {
          if (!log.destroyed && !log.write(chunk)) {
            stream.pause();
            paused.add(stream);
            log.once("drain", () => {
              paused.delete(stream);
              stream.resume();
            });
          }
          accept(decoder.write(chunk));
        });
        return () => {
          accept(decoder.end());
          if (pending) {
            handle(pending);
            pending = "";
          }
        };
      });
      let finished = false;
      const finish = async (code: number, message?: string) => {
        if (finished) return;
        finished = true;
        for (const flush of streams) flush();
        if (message) this.event(job, "output", { message });
        log.end();
        await streamFinished(log).catch(() => {
          sawError = true;
        });
        try {
          // The official process exit status decides failure. Narrative text can
          // resemble a runner message, so only publish a failure on failed runs.
          if (!job.cancelled) {
            if (code !== 0 && failure) this.event(job, "diagnostic", failure);
            for (const warning of warnings) this.event(job, "diagnostic", warning);
          }
          if (request.operation === "exportHtml" && code === 0 && !job.cancelled) {
            const dest = request.destination!;
            await mkdir(path.dirname(dest), { recursive: true });
            await this.copySnapshot(path.join(stage, "export.html"), dest, job, () => true, true, true);
            for (const e of await readdir(path.join(stage, "web/mygame"), {
              withFileTypes: true,
            }))
              if (!["scenes", "mygame.js", "index.html", "choicescript.json"].includes(e.name))
                await this.copySnapshot(
                  path.join(stage, "web/mygame", e.name),
                  path.join(path.dirname(dest), e.name),
                  job,
                  () => true,
                  true,
                  true,
                );
            this.check(job);
            this.event(job, "output", { message: `Exported ${dest}` });
          }
          if (Object.keys(coverage).length) this.event(job, "coverage", { coverage });
        } catch (e) {
          code = 1;
          this.event(job, "output", { message: String(e) });
        } finally {
          await this.complete(job, job.cancelled ? 130 : sawError ? 1 : code, output);
        }
      };
      child.on("error", (e) => void finish(1, e.message));
      child.on("close", (code) => void finish(code ?? 1));
      return { jobId: job.id, projectId: project.id, output };
    } catch (error) {
      await this.complete(job, job.cancelled ? 130 : 1, String(error));
      throw error;
    }
  }
  private async cleanup(stage: string, job?: Job) {
    if (!stage) return;
    try {
      await rm(stage, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
      this.cleanupPaths.delete(stage);
    } catch (error) {
      this.cleanupPaths.add(stage);
      if (job)
        this.event(job, "output", { message: "Could not remove temporary directory " + stage + ": " + String(error) });
    }
  }
  private async complete(job: Job, exitCode: number, message?: string) {
    if (job.finished) return;
    job.finished = true;
    try {
      await this.cleanup(job.stage, job);
    } finally {
      this.jobs.delete(job.id);
      this.results.set(job.id, job);
      if (this.results.size > 50) this.results.delete(this.results.keys().next().value!);
      job.resolveCompletion();
      this.event(job, "completed", { exitCode, message });
    }
  }
  private async stopJob(job: Job) {
    job.cancelled = true;
    job.controller.abort();
    const child = job.child;
    if (child) {
      child.kill();
      const timer = setTimeout(() => child.kill("SIGKILL"), 1500);
      timer.unref();
      try {
        await job.completion;
      } finally {
        clearTimeout(timer);
      }
      return;
    }
    if (job.server) {
      job.server.closeAllConnections();
      await new Promise<void>((resolve) => job.server!.close(() => resolve()));
      await this.complete(job, 130);
    }
    // Preparation and queued jobs settle their own completion after aborting.
    await job.completion;
  }
}
