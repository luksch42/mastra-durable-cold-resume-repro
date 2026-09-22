import { ToolSearchProcessor } from "@mastra/core/processors";
import { createTool } from "@mastra/core/tools";
import { z } from "zod";

// Processor-level view of the bug. No server, no model.
//
// `Agent.listInputProcessorLoadedTools` (the path a durable run takes when its
// run-registry entry is gone) asks the processor with `{ requestContext, tools }`
// only. With `storage: "context"` the loaded set lives in the thread's messages,
// so that call returns nothing even though the thread has loaded the tool.

const approvalEcho = createTool({
  id: "approvalEcho",
  description: "Echoes a message back after asking the user for approval.",
  inputSchema: z.object({ message: z.string() }),
  requireApproval: true,
  execute: async ({ message }) => ({ echoed: message }),
});

const processor = new ToolSearchProcessor({
  tools: { approvalEcho },
  storage: "context",
  search: { topK: 5, autoLoad: true },
});

// The thread as persisted after the model searched: one search_tools result
// naming the tool. This is exactly what the context store derives "loaded" from.
const messages = [
  {
    id: "m1",
    role: "assistant",
    createdAt: new Date(),
    content: {
      format: 2,
      parts: [
        {
          type: "tool-invocation",
          toolInvocation: {
            toolCallId: "c1",
            toolName: "search_tools",
            state: "result",
            args: { query: "echo" },
            result: {
              results: [{ name: "approvalEcho", description: "Echoes a message back.", score: 1 }],
              message:
                "Found and loaded 1 tool(s): approvalEcho. They are available on your next turn — call them directly.",
            },
          },
        },
      ],
    },
  },
];

const requestContext = { get: () => undefined } as never;
const loaded = (args: object) =>
  processor
    .getLoadedToolsForRequestContext(args as Parameters<typeof processor.getLoadedToolsForRequestContext>[0])
    .then((tools) => Object.keys(tools));

// What the LLM step passes (stepArgs carry the messages): the tool is loaded.
const stepPath = await loaded({ stepArgs: { messages, requestContext, tools: {} } });
// What the durable rebuild passes (Agent.listInputProcessorLoadedTools): nothing.
const rebuildPath = await loaded({ requestContext, tools: {} });

console.log("in-step path,  { stepArgs: { messages, ... } }:", stepPath);
console.log("rebuild path,  { requestContext, tools }:      ", rebuildPath);

if (stepPath.includes("approvalEcho") && rebuildPath.length === 0) {
  console.log("\nBUG: the rebuild path cannot see the tool this thread loaded.");
  process.exit(1);
}
console.log("\nOK: the rebuild path sees the loaded tool.");
