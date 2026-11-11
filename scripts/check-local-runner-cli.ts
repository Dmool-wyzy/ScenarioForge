import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { runnerDirectory } from "../lib/local-runner/directory";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cliPath = path.join(projectRoot, "scripts", "scenarioforge-local-runner.mjs");

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((accept, decline) => { resolve = accept; reject = decline; });
  // A server assertion can fail before the test starts awaiting its completion.
  void promise.catch(() => {});
  return { promise, resolve, reject };
}

async function withTimeout<T>(promise: Promise<T>, label: string, milliseconds = 15_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`Timed out waiting for ${label}.`)), milliseconds);
    })]);
  } finally { clearTimeout(timer); }
}

type Exit = { code: number | null; signal: NodeJS.Signals | null; error?: Error };
type CapturedProcess = { child: ChildProcess; stdout: string; stderr: string; exited: Promise<Exit>; done: boolean };

function startCli(arguments_: string[], appData: string): CapturedProcess {
  const child = spawn(process.execPath, ["--import", "tsx", cliPath, ...arguments_], {
    cwd: projectRoot, env: { ...process.env, APPDATA: appData }, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
  });
  const capture: CapturedProcess = { child, stdout: "", stderr: "", done: false, exited: Promise.resolve({ code: null, signal: null }) };
  child.stdout?.on("data", chunk => { capture.stdout += String(chunk); });
  child.stderr?.on("data", chunk => { capture.stderr += String(chunk); });
  capture.exited = new Promise<Exit>(resolve => {
    child.once("error", error => { capture.done = true; resolve({ code: null, signal: null, error }); });
    child.once("close", (code, signal) => { capture.done = true; resolve({ code, signal }); });
  });
  return capture;
}

async function stopCli(capture: CapturedProcess) {
  if (capture.done) return;
  capture.child.kill("SIGTERM");
  try { await withTimeout(capture.exited, "Runner shutdown", 3_000); }
  catch {
    capture.child.kill("SIGKILL");
    await withTimeout(capture.exited, "forced Runner shutdown", 5_000);
  }
}

async function jsonBody(request: IncomingMessage) {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

function reply(response: ServerResponse, body: unknown, status = 200) {
  response.writeHead(status, { "Content-Type": "application/json", Connection: "close" });
  response.end(JSON.stringify(body));
}

test("directory display metadata accepts absolute roots across Runner platforms and rejects relative/control paths", () => {
  for (const directory of ["/home/research/课题项目", "D:\\projects\\课题项目", "C:/projects/demo", "\\\\lab-server\\shared\\project"]) assert.equal(runnerDirectory.parse(directory), directory);
  for (const directory of ["", "relative/project", "C:project", "\\project", "D:\\bad\npath", "/bad\u0000path", "/" + "a".repeat(1000)]) assert.equal(runnerDirectory.safeParse(directory).success, false);
});

test("real local Runner pairs, modifies files, retries receipts and enforces its process lock", { timeout: 45_000 }, async () => {
  const fixtureRoot = await realpath(await mkdtemp(path.join(tmpdir(), "sf-local-runner-cli-")));
  const appData = path.join(fixtureRoot, "appdata");
  const workspace = path.join(fixtureRoot, "selected-project");
  const target = path.join(workspace, "message.txt");
  const code = "offline-pairing-code";
  const token = "offline-private-runner-token-never-log";
  const runnerId = "offline-runner";
  const executionId = "offline-cli-execution";
  const updatedText = "Updated by the real local Runner.\n";
  const processes: CapturedProcess[] = [];
  const firstPoll = deferred<void>();
  const finished = deferred<void>();
  const requests: { path: string; method: string | undefined; body: string }[] = [];
  const receipts = new Map<string, Record<string, unknown>>();
  const operations = ["list", "write", "read", "inspect"];
  let pairCount = 0, directoryReports = 0, phase = 0, issued = false, currentHead = "";
  let writeReceipts = 0, firstWriteReceipt = "", writtenModificationTime = 0;

  const handleRequest = async (request: IncomingMessage, response: ServerResponse) => {
    const pathname = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
    const rawBody = await jsonBody(request);
    requests.push({ path: pathname, method: request.method, body: rawBody });
    if (pathname === "/api/local-runner/pair" && request.method === "POST") {
      assert.deepEqual(JSON.parse(rawBody), { code, workspaceDirectory: await realpath(workspace) });
      pairCount++;
      reply(response, { runnerId, projectId: "offline-project", label: "Offline local project", token, expiresAt: "2099-01-01T00:00:00.000Z" });
      return;
    }
    assert.equal(pathname, `/api/local-runner/${runnerId}/commands`);
    assert.equal(request.headers.authorization, `Bearer ${token}`);
    if (request.method === "PUT") {
      assert.deepEqual(JSON.parse(rawBody), { workspaceDirectory: await realpath(workspace) });
      directoryReports++;
      reply(response, { ok: true });
      return;
    }
    if (request.method === "GET") {
      firstPoll.resolve();
      if (phase >= operations.length || issued) { reply(response, { command: null }); return; }
      const operation = operations[phase];
      const input = operation === "write" ? { head: currentHead, changes: [{ path: "message.txt", content: updatedText }], receiptBudget: 100_000 }
        : operation === "read" ? { path: "message.txt" }
          : operation === "inspect" ? { paths: ["message.txt"] } : {};
      issued = true;
      reply(response, { command: { id: `command-${operation}`, executionId, operation, input, leaseOwner: `lease-${operation}` } });
      return;
    }
    assert.equal(request.method, "POST");
    const receipt = JSON.parse(rawBody) as { commandId: string; leaseOwner: string; error?: string; result?: Record<string, unknown> };
    const operation = receipt.commandId.replace("command-", "");
    assert.equal(receipt.leaseOwner, `lease-${operation}`);
    assert.equal(receipt.error, undefined, `Runner reported an operation error: ${receipt.error ?? ""}`);
    assert.ok(receipt.result);
    const result = receipt.result;
    assert.match(String(result.head), /^[a-f0-9]{40}$/);

    if (operation === "list") {
      assert.equal(phase, 0);
      assert.deepEqual((result.files as { path: string }[]).map(file => file.path), ["message.txt"]);
      currentHead = String(result.head);
    } else if (operation === "write") {
      assert.equal(phase, 1);
      assert.notEqual(result.head, currentHead);
      assert.deepEqual(result.entries, [{ path: "message.txt", before: "Original local content.\n", after: updatedText }]);
      assert.equal(await readFile(target, "utf8"), updatedText, "the actual CLI must update the selected local file");
      writeReceipts++;
      if (writeReceipts === 1) {
        firstWriteReceipt = rawBody;
        writtenModificationTime = (await stat(target)).mtimeMs;
        // The server received the completed write but its HTTP response was lost.
        request.socket.destroy();
        return;
      }
      assert.equal(rawBody, firstWriteReceipt, "a retry must deliver the same receipt rather than rerun the write");
      assert.equal((await stat(target)).mtimeMs, writtenModificationTime, "receipt retry must not modify the file again");
      currentHead = String(result.head);
    } else if (operation === "read") {
      assert.equal(phase, 2);
      assert.deepEqual(result, { path: "message.txt", head: currentHead, content: updatedText });
    } else if (operation === "inspect") {
      assert.equal(phase, 3);
      assert.deepEqual(result, { head: currentHead, entries: [{ path: "message.txt", content: updatedText }] });
    } else assert.fail(`Unexpected receipt operation: ${operation}`);

    receipts.set(operation, result);
    phase++;
    issued = false;
    reply(response, { ok: true });
    if (phase === operations.length) finished.resolve();
  };

  const server = createServer((request, response) => {
    void handleRequest(request, response).catch(error => {
      finished.reject(error);
      if (!response.destroyed) reply(response, { error: "Offline test server assertion failed." }, 500);
    });
  });

  try {
    await mkdir(appData);
    await mkdir(workspace);
    await writeFile(target, "Original local content.\n");
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const origin = `http://127.0.0.1:${address.port}`;
    const pairing = startCli(["pair", "--url", origin, "--code", code, "--directory", workspace], appData);
    processes.push(pairing);
    const pairingExit = await withTimeout(pairing.exited, "pairing command");
    assert.equal(pairingExit.error, undefined);
    assert.equal(pairingExit.code, 0, pairing.stderr);
    assert.equal(pairCount, 1);
    const config = JSON.parse(await readFile(path.join(appData, "ScenarioForge", "runner.json"), "utf8"));
    assert.equal(config.directory, await realpath(workspace));
    assert.equal(config.token, token);

    const runner = startCli(["run"], appData);
    processes.push(runner);
    await withTimeout(Promise.race([firstPoll.promise, runner.exited.then(exit => { throw new Error(`Runner exited before polling: ${JSON.stringify(exit)} ${runner.stderr}`); })]), "initial Runner poll");
    const duplicate = startCli(["run"], appData);
    processes.push(duplicate);
    const duplicateExit = await withTimeout(duplicate.exited, "duplicate Runner refusal");
    assert.equal(duplicateExit.error, undefined);
    assert.equal(duplicateExit.code, 1);
    assert.match(duplicate.stderr, /Another Runner already owns this workspace/);

    await withTimeout(Promise.race([finished.promise, runner.exited.then(exit => { throw new Error(`Runner exited before completing operations: ${JSON.stringify(exit)} ${runner.stderr}`); })]), "Runner command chain");
    assert.deepEqual([...receipts.keys()], operations);
    assert.equal(directoryReports, 1, "already-paired Runner reports its directory once on startup, before polling");
    assert.equal(writeReceipts, 2);
    assert.equal(await readFile(target, "utf8"), updatedText);
    for (const request of requests) {
      if (request.path !== "/api/local-runner/pair" && request.method !== "PUT") assert.ok(!request.body.includes(workspace) && !request.body.includes(JSON.stringify(workspace).slice(1, -1)), "command receipts must not expose the selected absolute directory");
      assert.ok(!request.body.includes(token), "the Runner token belongs only in Authorization headers");
    }
    for (const process_ of processes) {
      assert.ok(!(process_.stdout + process_.stderr).includes(token), "CLI output must not reveal its private token");
    }
  } finally {
    const cleanup = await Promise.allSettled(processes.map(stopCli));
    server.closeAllConnections();
    await new Promise<void>(resolve => { server.close(() => resolve()); });
    const cleanupFailure = cleanup.find(result => result.status === "rejected");
    if (cleanupFailure?.status === "rejected") throw cleanupFailure.reason;
    // Only remove the unique directory created by this test, after all children stopped.
    const temporaryRoot = await realpath(tmpdir());
    assert.equal(path.dirname(fixtureRoot), temporaryRoot);
    assert.match(path.basename(fixtureRoot), /^sf-local-runner-cli-[A-Za-z0-9]+$/);
    await rm(fixtureRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
