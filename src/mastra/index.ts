import { Mastra } from "@mastra/core";
import { Agent } from "@mastra/core/agent";
import { ToolSearchProcessor } from "@mastra/core/processors";
import { createTool } from "@mastra/core/tools";
import { LibSQLStore } from "@mastra/libsql";
import { Memory } from "@mastra/memory";
import { z } from "zod";

// A tool that needs human approval. In the failing setup it is only reachable
// through ToolSearchProcessor with `storage: "context"`. With STATIC_TOOL=1 it
// is registered on the agent's static `tools` instead; the cold rebuild finds
// static tools, so the late approval works.
const approvalEcho = createTool({
  id: "approvalEcho",
  description: "Echoes a message back after asking the user for approval.",
  inputSchema: z.object({ message: z.string() }),
  outputSchema: z.object({ echoed: z.string() }),
  requireApproval: true,
  execute: async ({ message }) => ({ echoed: message }),
});

const storage = new LibSQLStore({ id: "repro-storage", url: "file:./mastra.db" });
const staticTool = process.env.STATIC_TOOL === "1";

export const agent = new Agent({
  id: "repro",
  name: "repro",
  instructions: "You are a test harness. Do exactly what the user asks, without questions.",
  model: process.env.MODEL ?? "openai/gpt-4.1",
  memory: new Memory({ storage }),
  durable: true,
  ...(staticTool ? { tools: { approvalEcho } } : {}),
  inputProcessors: staticTool
    ? []
    : [
        new ToolSearchProcessor({
          tools: { approvalEcho },
          storage: "context",
          search: { topK: 5, autoLoad: true },
        }),
      ],
});

export const mastra = new Mastra({
  agents: { repro: agent },
  storage,
  server: { port: Number(process.env.PORT ?? 4111) },
});
