import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { MastraClient } from "@mastra/client-js";

// Drives the running `mastra dev` server the way a @mastra/react client does.
//
//   pnpm repro start    sends one message; the run suspends for approval and
//                       the thread/toolCallId are written to .repro-state.json
//   (restart `mastra dev`, or wait > 10 minutes)
//   pnpm repro approve  approves that call and reports what the run did
//
// With the bug: the approval resumes the run, the tool-call step cannot find
// the tool ("ToolNotFoundError"), the error becomes the tool result (exit 1).
// Without the bug (STATIC_TOOL=1, or a fixed core): tool-result arrives (exit 0).

const baseUrl = process.env.MASTRA_URL ?? "http://localhost:4111";
// The dev server protects the durable thread routes; without an auth provider
// it lets requests through that carry the header Studio sends.
const client = new MastraClient({ baseUrl, headers: { "x-mastra-dev-playground": "true" } });
const agent = client.getAgent("repro");
const resourceId = "repro-user";
const stateFile = ".repro-state.json";

const waiters: Array<() => void> = [];
const notify = () => {
  for (const w of waiters.splice(0)) w();
};
const until = async (predicate: () => boolean, label: string, ms: number) => {
  const deadline = Date.now() + ms;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timeout waiting for ${label}`);
    await new Promise<void>((resolve) => {
      waiters.push(resolve);
      setTimeout(resolve, 500);
    });
  }
};

type Chunk = { type: string; payload?: Record<string, unknown> };

const subscribe = async (threadId: string, onChunk: (chunk: Chunk) => void) => {
  const subscription = await agent.subscribeToThread({ resourceId, threadId });
  void subscription.processDataStream({
    reconnect: true,
    onChunk: (chunk) => {
      onChunk(chunk as Chunk);
      notify();
    },
  });
};

const phase = process.argv[2] ?? "start";

if (phase === "start") {
  const threadId = randomUUID();
  const approvals: string[] = [];
  await subscribe(threadId, (chunk) => {
    if (chunk.type === "tool-call-approval") {
      const { toolCallId, toolName, args } = chunk.payload as { toolCallId: string; toolName: string; args: unknown };
      console.log(`← tool-call-approval ${toolName} ${JSON.stringify(args)} (${toolCallId})`);
      approvals.push(toolCallId);
    }
  });
  console.log(`thread ${threadId}`);
  await agent.sendMessage({
    resourceId,
    threadId,
    message: 'Call the tool approvalEcho once with message "Alpha". No questions.',
  });
  await until(() => approvals.length >= 1, "the tool-call-approval chunk", 90_000);
  writeFileSync(stateFile, JSON.stringify({ threadId, toolCallId: approvals[0] }));
  console.log(`\nsuspended for approval (${stateFile} written).`);
  console.log("Now restart `mastra dev` (or wait more than 10 minutes), then run: pnpm repro approve");
  process.exit(0);
}

if (phase === "approve") {
  const { threadId, toolCallId } = JSON.parse(readFileSync(stateFile, "utf8")) as { threadId: string; toolCallId: string };
  let outcome: "result" | "error" | undefined;
  await subscribe(threadId, (chunk) => {
    if (chunk.type === "tool-result" && chunk.payload?.toolName === "approvalEcho") {
      console.log(`← tool-result ${JSON.stringify(chunk.payload.result)}`);
      outcome = "result";
    }
    if (chunk.type === "tool-error") {
      const error = chunk.payload?.error as { name?: string; message?: string } | string | undefined;
      console.log(`← tool-error ${typeof error === "string" ? error : `${error?.name}: ${error?.message}`}`);
      outcome = "error";
    }
  });
  console.log(`thread ${threadId}\n→ approving ${toolCallId}`);
  await agent.sendToolApproval({ resourceId, threadId, toolCallId, approved: true });
  await until(() => outcome !== undefined, "tool-result or tool-error", 60_000);
  if (outcome === "error") {
    console.log("\nBUG REPRODUCED: the approved tool was not found on resume; the run carried on with the error as its result.");
    process.exit(1);
  }
  console.log("\nOK: the approved tool executed.");
  process.exit(0);
}

console.error(`unknown phase "${phase}"; use start or approve`);
process.exit(2);
