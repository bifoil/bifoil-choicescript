import { URI } from "vscode-uri";
import { finished as streamFinished } from "node:stream/promises";
import {
  mkdtemp,
  cp,
  mkdir,
  rm,
  readFile,
  writeFile,
  readdir,
  stat,
  realpath,
} from "node:fs/promises";
import { createReadStream, createWriteStream } from "node:fs";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type Server } from "node:http";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
import type {
  Project,
  JobRequest,
  JobResult,
  JobEvent,
  BufferSnapshot,
} from "../../protocol/src/index.js";
import { contains, exists } from "./projects.js";
type Job = {
  id: string;
  project: Project;
  stage: string;
  child?: ChildProcess;
  server?: Server;
  stale: boolean;
  cancelled: boolean;
  completion?: Promise<void>;
};
export class ToolRunner {
  readonly jobs = new Map<string, Job>();
  private readonly results = new Map<string, Job>();
  constructor(
    readonly engine: string,
    readonly emit: (event: JobEvent) => void,
    readonly node = process.execPath,
  ) {}
  event(job: Job, kind: JobEvent["kind"], rest: Partial<JobEvent> = {}) {
    this.emit({
      protocolVersion: 1,
      jobId: job.id,
      projectId: job.project.id,
      kind,
      stale: job.stale,
      ...rest,
    });
  }
  async createProject(destination: string) {
    if ((await exists(destination)) && (await readdir(destination)).length)
      throw new Error(
        "Choose an empty directory; existing files will not be overwritten.",
      );
    await mkdir(destination, { recursive: true });
    await cp(path.join(this.engine, "web/mygame"), destination, {
      recursive: true,
    });
    await cp(
      path.join(this.engine, "LICENSE.txt"),
      path.join(destination, "CHOICESCRIPT-LICENSE.txt"),
    );
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
    );
    await writeFile(
      path.join(destination, "UPSTREAM-TEMPLATE.md"),
      "This game was created from the unmodified ChoiceScript template at commit 60a6c3ee7393c9ee7e42650b8e1642ae38e3cb6a. Template and engine materials retain the ChoiceScript License in CHOICESCRIPT-LICENSE.txt. The independent editor tooling is unaffiliated with Choice of Games.\n",
    );
    return {
      jobId: "created",
      projectId: URI.file(path.join(destination, "scenes")).toString(),
    };
  }
  async stage(project: Project, buffers: BufferSnapshot[]) {
    const dir = await mkdtemp(path.join(os.tmpdir(), "choicescript-tools-"));
    try {
      await cp(this.engine, dir, { recursive: true });
      const game = path.join(dir, "web/mygame");
      await rm(path.join(game, "scenes"), { recursive: true, force: true });
      for (const e of await readdir(project.assetDir, {
        withFileTypes: true,
      })) {
        if (
          [
            ".git",
            ".cache",
            "node_modules",
            "vendor",
            "dist",
            "build",
            "export",
            ".idea",
            ".choicescript-tools",
            "scenes",
          ].includes(e.name) ||
          e.isSymbolicLink()
        )
          continue;
        const src = path.join(project.assetDir, e.name);
        if (path.resolve(src) === path.resolve(project.sceneDir)) continue;
        await cp(src, path.join(game, e.name), {
          recursive: true,
          filter: (source) =>
            !source
              .split(path.sep)
              .some((x) => [".git", "node_modules", ".cache"].includes(x)),
        });
      }
      await cp(project.sceneDir, path.join(game, "scenes"), {
        recursive: true,
      });
      for (const buffer of buffers) {
        const file = fileURLToPath(buffer.uri);
        if (contains(project.sceneDir, file)) {
          const dest = path.join(
            game,
            "scenes",
            path.relative(project.sceneDir, file),
          );
          await mkdir(path.dirname(dest), { recursive: true });
          await writeFile(dest, buffer.text);
        }
      }
      const generated = await this.capture(dir, "mygamegenerator.js", [
        "mygame",
      ]);
      await writeFile(path.join(game, "mygame.js"), generated);
      return dir;
    } catch (error) {
      await rm(dir, { recursive: true, force: true });
      throw error;
    }
  }
  capture(cwd: string, script: string, args: string[]) {
    return new Promise<string>((resolve, reject) => {
      const child = spawn(this.node, [script, ...args], {
        cwd,
        windowsHide: true,
      });
      let out = "",
        err = "";
      child.stdout.on("data", (b) => (out += b));
      child.stderr.on("data", (b) => (err += b));
      child.on("error", reject);
      child.on("close", (code) =>
        code === 0
          ? resolve(out)
          : reject(new Error(err || out || `Process exited ${code}`)),
      );
    });
  }
  async start(
    request: JobRequest,
    project: Project,
    buffers: BufferSnapshot[],
  ): Promise<JobResult> {
    if (
      !["stop", "run", "quicktest", "randomtest", "exportHtml"].includes(
        request.operation,
      )
    )
      throw new Error("Unknown tooling operation.");
    if (!request.trusted && request.operation !== "stop")
      throw new Error("Trust this workspace before running game code.");
    if (request.protocolVersion !== 1)
      throw new Error("Unsupported tooling protocol version.");
    if (request.operation === "stop") {
      if (request.jobId) await this.stop(request.jobId);
      else
        for (const j of this.jobs.values())
          if (j.project.id === project.id) await this.stop(j.id);
      return { jobId: request.jobId ?? "", projectId: project.id };
    }
    const stage = await this.stage(project, buffers),
      job: Job = {
        id: randomUUID(),
        project,
        stage,
        stale: false,
        cancelled: false,
      };
    this.jobs.set(job.id, job);
    this.event(job, "started");
    try {
      if (request.operation === "run") {
        try {
          return await this.preview(job);
        } catch (e) {
          await this.stop(job.id);
          throw e;
        }
      }
      const count =
          request.iterations ?? project.randomtest?.iterations ?? 1000,
        seed = request.seed ?? project.randomtest?.seed ?? 0;
      if (
        !Number.isSafeInteger(count) ||
        count < 1 ||
        count > 10000000 ||
        !Number.isSafeInteger(seed)
      ) {
        await this.stop(job.id);
        throw new Error(
          "Iterations must be an integer between 1 and 10,000,000; seed must be an integer.",
        );
      }
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
        if (!request.destination) {
          await this.stop(job.id);
          throw new Error("Choose an export destination.");
        }
        script = "compile.js";
        args = ["export.html"];
      }
      const logDir = path.join(project.root, ".choicescript-tools", "logs");
      await mkdir(logDir, { recursive: true });
      const output = path.join(logDir, job.id + ".log"),
        log = createWriteStream(output);
      let pending = "";
      let sawError = false;
      log.on("error", (error) => {
        sawError = true;
        this.event(job, "output", {
          message: "Could not save test output: " + error.message,
        });
      });
      const coverage: Record<string, number[]> = {};
      let coverageScene = "";
      const handle = (message: string) => {
        this.event(job, "output", { message });
        const match = /\b([\w-]+)(?:\.txt)?\s+line\s+(\d+)\s*:\s*(.*)/i.exec(
          message,
        );
        if (match) {
          sawError = true;
          this.event(job, "diagnostic", {
            uri: URI.file(
              path.join(project.sceneDir, match[1] + ".txt"),
            ).toString(),
            line: Math.max(0, Number(match[2]) - 1),
            message: match[3],
          });
        }
        const count = /^([\w-]+) (\d+): /.exec(message);
        if (count) (coverage[count[1]] ??= []).push(Number(count[2]));
      };
      const nodeArgs = [script, ...args];
      if (request.operation === "exportHtml") {
        const preload = path.join(stage, "choicescript-tools-preload.cjs");
        await writeFile(
          preload,
          "// Bridge the upstream compiler's VM-loaded generator to its CommonJS host.\nglobal.rootDir = 'web/';\n",
        );
        nodeArgs.unshift("--require", preload);
      }
      const child = spawn(this.node, nodeArgs, {
        cwd: stage,
        windowsHide: true,
      });
      job.child = child;
      const data = (b: Buffer) => {
        log.write(b);
        pending += b.toString();
        const lines = pending.split(/\r?\n/);
        pending = lines.pop() ?? "";
        for (const line of lines) handle(line);
      };
      child.stdout.on("data", data);
      child.stderr.on("data", data);
      let resolveCompletion!: () => void;
      job.completion = new Promise<void>((resolve) => {
        resolveCompletion = resolve;
      });
      let finished = false;
      const finish = async (code: number, message?: string) => {
        if (finished) return;
        finished = true;
        if (pending) handle(pending);
        if (message) this.event(job, "output", { message });
        log.end();
        await streamFinished(log).catch(() => {
          sawError = true;
        });
        try {
          if (
            request.operation === "exportHtml" &&
            code === 0 &&
            !job.cancelled
          ) {
            const dest = request.destination!;
            await mkdir(path.dirname(dest), { recursive: true });
            await cp(path.join(stage, "export.html"), dest, {
              force: false,
              errorOnExist: true,
            });
            for (const e of await readdir(path.join(stage, "web/mygame"), {
              withFileTypes: true,
            }))
              if (
                ![
                  "scenes",
                  "mygame.js",
                  "index.html",
                  "choicescript.json",
                ].includes(e.name)
              )
                await cp(
                  path.join(stage, "web/mygame", e.name),
                  path.join(path.dirname(dest), e.name),
                  { recursive: true, force: false, errorOnExist: true },
                );
            this.event(job, "output", { message: `Exported ${dest}` });
          }
          if (Object.keys(coverage).length)
            this.event(job, "coverage", { coverage });
        } catch (e) {
          code = 1;
          this.event(job, "output", { message: String(e) });
        } finally {
          this.jobs.delete(job.id);
          await rm(stage, { recursive: true, force: true });
          this.results.set(job.id, job);
          if (this.results.size > 50)
            this.results.delete(this.results.keys().next().value!);
          resolveCompletion();
          this.event(job, "completed", {
            exitCode: job.cancelled ? 130 : sawError ? 1 : code,
            message: output,
          });
        }
      };
      child.on("error", (e) => void finish(1, e.message));
      child.on("close", (code) => void finish(code ?? 1));
      return { jobId: job.id, projectId: project.id, output };
    } catch (error) {
      await this.stop(job.id);
      throw error;
    }
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
        if ((await stat(file)).isDirectory())
          file = path.join(file, "index.html");
        file = await realpath(file);
        if (!contains(base, file)) {
          res.writeHead(403).end();
          return;
        }
        res.setHeader(
          "Content-Type",
          types[path.extname(file)] ?? "application/octet-stream",
        );
        res.setHeader("Cache-Control", "no-store");
        createReadStream(file)
          .on("error", () => res.destroy())
          .pipe(res);
      } catch {
        res.writeHead(404).end("File not found");
      }
    });
    job.server = server;
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => resolve());
    });
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("Preview failed to bind");
    const url = `http://127.0.0.1:${address.port}/${token}/mygame/index.html`;
    this.event(job, "preview", { url });
    return { jobId: job.id, projectId: job.project.id, url };
  }
  markStale(projectId: string) {
    for (const job of [...this.jobs.values(), ...this.results.values()])
      if (job.project.id === projectId && !job.stale) {
        job.stale = true;
        this.event(job, "stale", {
          message:
            "Source changed; restart preview or rerun tests to use the current snapshot.",
        });
      }
  }
  async stop(id: string) {
    const job = this.jobs.get(id);
    if (!job) return;
    job.cancelled = true;
    if (job.child) {
      job.child.kill();
      const timer = setTimeout(() => job.child?.kill("SIGKILL"), 1500);
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
    }
    this.jobs.delete(id);
    await rm(job.stage, { recursive: true, force: true });
    this.event(job, "completed", { exitCode: 130 });
  }
  async dispose() {
    await Promise.all([...this.jobs.keys()].map((id) => this.stop(id)));
  }
}
