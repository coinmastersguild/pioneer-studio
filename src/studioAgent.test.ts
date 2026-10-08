import { expect, test } from "bun:test";
import { actionForTool, actionTools, clearActions, registerActions } from "./control";
import { beginStudioAgentTurn, continueStudioAgentTurn, executeStudioAction, finishStudioAgentTurn } from "./studioAgent";

test("registered actions become model tools and execute through the same handler", async () => {
  let sought = -1;
  registerActions([
    {
      name: "test.seek",
      description: "Seek the test timeline",
      parameters: {
        type: "object",
        properties: { t: { type: "number" } },
        required: ["t"],
        additionalProperties: false,
      },
      confirmation: "test confirmation",
      confirmationFor: (params) => `confirm seek to ${params.t}`,
      run: (params) => void (sought = Number(params?.t)),
    },
  ]);
  expect(actionTools()[0].function.name).toBe("test_seek");
  expect(actionForTool("test_seek")?.confirmation).toBe("test confirmation");

  const requests: any[] = [];
  let n = 0;
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    requests.push(JSON.parse(String(init?.body)));
    n++;
    return new Response(
      JSON.stringify(
        n === 1
          ? {
              choices: [{ message: { content: null, tool_calls: [{ id: "call-1", type: "function", function: { name: "test_seek", arguments: "{\"t\":4}" } }] } }],
            }
          : { choices: [{ message: { content: "Moved the playhead to four seconds." } }] },
      ),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as typeof fetch;

  const turn = await beginStudioAgentTurn("key", "seek to four seconds", { mode: "studio", board: null });
  expect(requests[0].messages[0].content).toContain("When jobs_submit is advertised");
  expect(requests[0].messages[0].content).toContain('Never print a {"job": ...} plan');
  expect(turn.actions[0]).toMatchObject({ actionName: "test.seek", params: { t: 4 }, confirmation: "confirm seek to 4" });
  const result = await executeStudioAction(turn.actions[0]);
  expect(sought).toBe(4);
  expect(result.error).toBeUndefined();
  expect(await finishStudioAgentTurn("key", turn, [result])).toBe("Moved the playhead to four seconds.");
  expect(requests[0].tools[0].function.parameters.required).toEqual(["t"]);
  expect(requests[1].messages.at(-1)).toMatchObject({ role: "tool", tool_call_id: "call-1" });
  expect(requests[1].tool_choice).toBe("none");
});

test("unknown model tools fail before any action can be reported as completed", async () => {
  clearActions();
  const original = globalThis.fetch;
  globalThis.fetch = (async () => new Response(JSON.stringify({ choices: [{ message: {
    content: null,
    tool_calls: [{ id: "invented", type: "function", function: { name: "ltx_video_generate", arguments: "{}" } }],
  } }] }), { status: 200 })) as typeof fetch;
  try {
    await expect(beginStudioAgentTurn("test-key", "make a cat video", { mode: "chat", board: null })).rejects.toThrow("unavailable tool");
  } finally { globalThis.fetch = original; }
});

test("the app copilot stages explicit delegation through advertised hosted-agent actions", async () => {
  clearActions();
  registerActions([{ name: "agents.delegate", description: "Prepare a hosted-agent task for its UI confirmation", run: () => ({ prepared: true, confirmation_required: true }) }]);
  const original = globalThis.fetch;
  let prompt = "";
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    prompt = JSON.parse(String(init?.body)).messages[0].content;
    return new Response(JSON.stringify({ choices: [{ message: { content: "Review the prepared task." } }] }), { status: 200 });
  }) as typeof fetch;
  try {
    await beginStudioAgentTurn("test-key", "tell the agent to make a cat video", { mode: "chat", board: null });
    expect(prompt).toContain("agents_delegate");
    expect(prompt).toContain("confirmation_required");
    expect(prompt).toContain("Never substitute a generation job");
    expect(prompt).toContain("Do not invent");
  } finally { globalThis.fetch = original; }
});

test("agent turns retain history and continue through multiple action rounds", async () => {
  let total = 0;
  registerActions([
    {
      name: "test.increment",
      description: "Increment a test counter",
      parameters: { type: "object", properties: { amount: { type: "number" } }, required: ["amount"], additionalProperties: false },
      run: (params) => { total += Number(params?.amount) || 0; return { total }; },
    },
  ]);
  const requests: any[] = [];
  let call = 0;
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    requests.push(JSON.parse(String(init?.body)));
    call++;
    const message = call <= 2
      ? { content: null, tool_calls: [{ id: `round-${call}`, type: "function", function: { name: "test_increment", arguments: `{"amount":${call}}` } }] }
      : { content: "Counter is three." };
    return new Response(JSON.stringify({ choices: [{ message }] }), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;

  let turn = await beginStudioAgentTurn("key", "increment twice", {
    mode: "studio",
    board: null,
    history: [{ role: "user", content: "we are testing a counter" }, { role: "assistant", content: "Understood." }],
  });
  expect(requests[0].messages.some((message: any) => message.content === "we are testing a counter")).toBe(true);
  turn = await continueStudioAgentTurn("key", turn, [await executeStudioAction(turn.actions[0])]);
  turn = await continueStudioAgentTurn("key", turn, [await executeStudioAction(turn.actions[0])]);
  expect(total).toBe(3);
  expect(turn.actions).toHaveLength(0);
  expect(turn.assistant.content).toBe("Counter is three.");
  expect(requests[1].tool_choice).toBe("auto");
  expect(requests[2].messages.filter((message: any) => message.role === "tool")).toHaveLength(2);
});
