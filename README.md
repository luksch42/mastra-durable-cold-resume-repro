# Mastra repro: approving a search-loaded tool after a cold resume throws ToolNotFoundError

Minimal reproduction for a `@mastra/core` durable-agent bug: a tool that is
only reachable through `ToolSearchProcessor` (`storage: "context"`) and has
`requireApproval: true` suspends the run for approval. If the process
restarts before the approval (or the run registry's 10-minute TTL passes), the
approval resumes the run, the durable tool-call step cannot find the tool, and
the run carries on with `ToolNotFoundError` as the tool result.

Verified with `@mastra/core` 1.68.0, `@mastra/client-js` 1.47.0,
`@mastra/libsql` 1.23.1, `@mastra/memory` 1.31.0, `mastra` 1.31.0, Node 22,
model `openai/gpt-4.1`.

## Setup

```bash
pnpm install
cp .env.example .env   # add OPENAI_API_KEY (or set MODEL to another model-router id)
```

## Reproduce

Terminal 1:

```bash
pnpm dev               # mastra dev on http://localhost:4111 (PORT=4112 to move it)
```

Terminal 2:

```bash
pnpm repro start       # sends one message; the run suspends for approval
```

```
thread dd0a9720-634d-4703-a3bc-8a101c9b1146
← tool-call-approval approvalEcho {"message":"Alpha"} (call_drmVOrP3sGfU6ivM0M1jRE0J)

suspended for approval (.repro-state.json written).
Now restart `mastra dev` (or wait more than 10 minutes), then run: pnpm repro approve
```

Now stop terminal 1 with Ctrl+C and start `pnpm dev` again (or leave it
running and wait more than 10 minutes). Then, in terminal 2:

```bash
pnpm repro approve
```

Output with the bug (exit code 1):

```
thread dd0a9720-634d-4703-a3bc-8a101c9b1146
→ approving call_drmVOrP3sGfU6ivM0M1jRE0J
← tool-error ToolNotFoundError: Tool "approvalEcho" not found.. Call tools by their exact name only — never add prefixes, namespaces, or colons.

BUG REPRODUCED: the approved tool was not found on resume; the run carried on with the error as its result.
```

Approving without the restart (within the TTL) works.

## Control

Register the tool statically instead of through tool search:

```bash
STATIC_TOOL=1 pnpm dev   # terminal 1, restart it between start and approve as above
pnpm repro start         # terminal 2
pnpm repro approve
```

The cold rebuild finds static tools, so the same late approval executes (exit
code 0):

```
→ approving call_af8PELA4R2IRpgpn8eKl070r
← tool-result {"echoed":"Alpha"}

OK: the approved tool executed.
```

## Processor-level view

No server or model needed:

```bash
pnpm unit
```

```
in-step path,  { stepArgs: { messages, ... } }: [ 'approvalEcho' ]
rebuild path,  { requestContext, tools }:       []

BUG: the rebuild path cannot see the tool this thread loaded.
```

The same processor, asked the way the LLM step asks (with the thread's
messages), reports the tool as loaded; asked the way the durable rebuild asks
(request context only), it reports nothing.

## Where it breaks

- `globalRunRegistry` (`create-durable-agent`) is a `TTLCache` with a
  10-minute TTL. A suspended run touches nothing, so its entry expires; a
  restart drops it as well.
- On resume, `toolCallStep` finds no registry entry and calls
  `rebuildRunToolsFromMastra` → `agent.getToolsForExecution(...)` →
  `listInputProcessorLoadedTools(...)`, which asks each processor with
  `getLoadedToolsForRequestContext({ requestContext, tools })`. No messages.
- `ToolSearchProcessor.getLoadedToolsForRequestContext` (no `stepArgs`) calls
  `store.getLoadedNames({ threadId, args: undefined })`, and
  `ContextLoadedToolStore` can only derive loaded names from
  `ctx.args.messages`. Its same-process supplemental set is emptied once the
  names are in the messages, and does not survive a restart anyway. Result:
  empty set, the rebuilt tool map holds only the agent's static tools.
- `storage: "in-memory"` is not a workaround: it survives the registry TTL
  only until its own `ttl` (1 hour by default) and loses everything on a
  restart.

## Suggested fix

Give the rebuild path the thread's messages. In `Agent.listInputProcessorLoadedTools`:

```js
const memory = await this.getMemory({ requestContext });
const recalled = threadId && memory ? await memory.recall({ threadId, resourceId }).catch(() => undefined) : undefined;
const loadedTools = await toolProvider.getLoadedToolsForRequestContext({ requestContext, tools, messages: recalled?.messages });
```

and in `ToolSearchProcessor.getLoadedToolsForRequestContext` (no-`stepArgs` branch):

```js
const loadedNames = await this.store.getLoadedNames({
  threadId,
  args: Array.isArray(args?.messages) ? { messages: args.messages } : undefined,
});
```

We run this as a pnpm patch on 1.59.0; with it, the late approval executes.

## Files

- `src/mastra/index.ts` — agent (`durable: true`, LibSQL memory) with the
  approval tool behind `ToolSearchProcessor({ storage: "context" })`, or
  static with `STATIC_TOOL=1`
- `src/repro.ts` — `start` sends the prompt and records the pending approval,
  `approve` approves it and reports `tool-result` or `tool-error`
- `src/unit.ts` — the processor asked both ways, without a server

The client sends `x-mastra-dev-playground: true`, which is how Studio gets
past the dev server's auth check on the durable thread routes.
