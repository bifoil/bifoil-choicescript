/**
 * Private pipe transport for the native language server. Source snapshots arrive
 * as owned capture-file references, keeping large buffers out of this V8 heap.
 * Only this process and official tool children need Node; language analysis does not.
 */
import { createInterface } from "node:readline";
import path from "node:path";
import { brokerOutputChunks, type BrokerOutput } from "./broker-output.js";
import { ToolRunner, type GameBufferSnapshot } from "./runner.js";
import { type JobRequest, type Project, PROTOCOL_VERSION } from "@bifoil/choicescript-protocol";

interface Message {
  id?: number;
  method: string;
  params?: {
    request?: JobRequest;
    project?: Project;
    buffers?: GameBufferSnapshot[];
    projectId?: string;
    jobId?: string;
    destination?: string;
  };
}

let closing: Promise<void> | undefined;
let output = Promise.resolve();
const send = (message: BrokerOutput): void => {
  output = output.then(async () => {
    for (const chunk of brokerOutputChunks(message))
      await new Promise<void>((resolve, reject) =>
        process.stdout.write(chunk, (error) => (error ? reject(error) : resolve())),
      );
  });
  void output.catch(() => close());
};
const runner = new ToolRunner(
  path.join(process.argv[2], "vendor", "choicescript"),
  (event) => {
    send({ method: "choicescript/jobEvent", params: event });
  },
  process.execPath,
  path.join(process.argv[2], "tool-source-preload.cjs"),
  () => output,
);
const input = createInterface({ input: process.stdin, crlfDelay: Infinity });

async function close() {
  await (closing ??= runner.dispose());
  input.close();
}

async function dispatch(message: Message) {
  const params = message.params ?? {};
  switch (message.method) {
    case "job": {
      const request = params.request;
      if (!request || request.protocolVersion !== PROTOCOL_VERSION) throw new Error("Unsupported tooling protocol.");
      if (request.operation === "stop") return runner.stopProject(request.projectId, request.jobId);
      if (!request.trusted) throw new Error("Trust this workspace before running game code.");
      if (request.operation === "createProject") {
        if (!request.destination) throw new Error("Choose a project destination.");
        await runner.createProject(request.destination);
        return { jobId: "created", projectId: request.destination };
      }
      if (!params.project) throw new Error("Choose a detected ChoiceScript project.");
      return runner.start(request, params.project, params.buffers ?? []);
    }
    case "stale":
      if (params.projectId) runner.markStale(params.projectId);
      return null;
    case "dispose":
      await close();
      return null;
    default:
      throw new Error("Unknown private tooling request.");
  }
}

input.on("line", (line) => {
  let message: Message;
  try {
    const decoded: unknown = JSON.parse(line);
    if (
      !decoded ||
      typeof decoded !== "object" ||
      Array.isArray(decoded) ||
      typeof (decoded as Message).method !== "string"
    )
      throw new Error("Expected a private tooling request object.");
    message = decoded as Message;
  } catch {
    send({ id: null, error: { code: -32600, message: "Malformed private tooling message." } });
    return;
  }
  if (closing && message.method !== "dispose") {
    if (message.id !== undefined)
      send({ id: message.id, error: { code: -32603, message: "Game tooling is stopping." } });
    return;
  }
  void dispatch(message).then(
    (result) => {
      if (message.id !== undefined) send({ id: message.id, result });
    },
    (error: unknown) => {
      if (message.id !== undefined) send({ id: message.id, error: { code: -32603, message: String(error) } });
    },
  );
});
input.on("close", () => void close());
process.once("SIGTERM", () => void close());
process.once("SIGINT", () => void close());
