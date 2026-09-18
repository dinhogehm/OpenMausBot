import { createServer } from "node:http";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { launchVerificationServer, runControlOmb } from "../scripts/control-omb.ts";

// Jev as the reviewer for an engine with no Auto reviewer of its own. The
// chat-completions runtime opens a `native-approval` card for every tool
// call in Auto mode (nobody reviewed it, not "a reviewer declined"); with
// permission review on, Jev decides that card before a person sees it.
// Everything is loopback: an offline OpenAI-compatible provider, a TypeSafe
// test double answering /systemone, and an MCP fixture that can write one
// file inside the launcher's disposable home.
const MCP_FIXTURE = `
import { createInterface } from 'node:readline';
import { writeFileSync } from 'node:fs';
const lines = createInterface({ input: process.stdin });
lines.on('line', (line) => {
  const request = JSON.parse(line);
  if (request.id === undefined) return;
  let result;
  if (request.method === 'initialize') result = { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: '1' } };
  else if (request.method === 'tools/list') result = { tools: [{ name: 'write_file', description: 'Write the disposable verification artifact', inputSchema: { type: 'object', properties: { content: { type: 'string' } }, required: ['content'], additionalProperties: false } }] };
  else if (request.method === 'tools/call' && request.params.name === 'write_file') {
    writeFileSync(process.env.FIXTURE_ARTIFACT, request.params.arguments.content);
    result = { content: [{ type: 'text', text: 'created verification artifact' }] };
  } else result = { content: [{ type: 'text', text: 'Unknown fixture operation' }], isError: true };
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) + '\\n');
});
`;

type ChatRequest = { messages: Array<{ role: string }>; tools?: Array<{ function: { name: string; description?: string } }> };
type JevRequest = { model: string; state: Record<string, unknown>; questions: Record<string, { type: string }> };

const listen = async (server: ReturnType<typeof createServer>) => {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("fixture address missing");
  return address.port;
};
const shutdown = async (server: ReturnType<typeof createServer>) => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
};

it("lets Jev approve or hold a chat-completions engine's permission card in place of the absent native reviewer", async () => {
  const completions: ChatRequest[] = [];
  const upstream = createServer(async (req, res) => {
    if (req.url === "/v1/models") {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ data: [{ id: "fixture-model" }] }));
      return;
    }
    let body = "";
    for await (const chunk of req) body += chunk;
    const request = JSON.parse(body) as ChatRequest;
    completions.push(request);
    const name = request.tools?.find((tool) => tool.function.description?.includes("disposable verification artifact"))?.function.name ?? "fixture_write_file";
    const frame = (delta: unknown, finish_reason: string | null) => `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason }] })}\n\n`;
    res.writeHead(200, { "content-type": "text/event-stream" });
    if (request.messages.some((message) => message.role === "tool")) {
      res.end(frame({ content: "The artifact was created." }, "stop") + "data: [DONE]\n\n");
    } else {
      res.end(frame({ tool_calls: [{ index: 0, id: "fixture-call", type: "function", function: { name, arguments: '{"content":"verified"}' } }] }, "tool_calls") + "data: [DONE]\n\n");
    }
  });
  // The TypeSafe double: one verdict per scenario, and a record of what the
  // harness sent so the test can prove the summary reached Jev.
  const reviews: Array<{ authorization: string | undefined; body: JevRequest }> = [];
  let verdict: "allow" | "deny" = "allow";
  const jev = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    reviews.push({ authorization: req.headers.authorization, body: JSON.parse(body) as JevRequest });
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({
      model: "jev-1.13.0",
      answers: {
        verdict: verdict === "allow"
          ? { type: "choice", choice: "allow", probabilities: { allow: 0.93, deny: 0.07 }, confidence: 0.86 }
          : { type: "choice", choice: "deny", probabilities: { allow: 0.12, deny: 0.88 }, confidence: 0.76 },
        risky: { type: "noul", noul: verdict === "allow" ? 0.06 : 0.71 },
      },
      usage: { input_tokens: 120, output_tokens: 20 },
    }));
  });
  const upstreamPort = await listen(upstream);
  const jevPort = await listen(jev);
  const fixture = await launchVerificationServer().catch(async (error) => {
    await shutdown(upstream);
    await shutdown(jev);
    throw error;
  });
  const evidence: unknown[] = [{ fixture: fixture.info }];
  const control = async (args: string[]) => {
    const result = await runControlOmb([...args, "--url", fixture.info.url]) as any;
    evidence.push({ command: args, result });
    return result;
  };
  const api = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(`${fixture.info.url}${path}`, {
      method, headers: { "content-type": "application/json", origin: fixture.info.url },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const result = await response.json() as any;
    expect(response.ok, JSON.stringify(result)).toBe(true);
    return result;
  };
  try {
    await api("PATCH", "/api/config", {
      openaiCompat: { key: "synthetic-fixture-key", url: `http://127.0.0.1:${upstreamPort}/v1`, model: "fixture-model" },
      typesafe: { key: "synthetic-typesafe-key", url: `http://127.0.0.1:${jevPort}`, permissionReview: true },
    });
    const status = await api("GET", "/api/config");
    expect(status.typesafe).toMatchObject({ configured: true, available: true, gateway: "typesafe", permissionReview: true });
    const mcpScript = join(fixture.info.dataDir, "fixture-mcp.mjs");
    writeFileSync(mcpScript, MCP_FIXTURE);

    for (const scenario of ["allow", "deny"] as const) {
      verdict = scenario;
      const artifact = join(fixture.info.dataDir, `${scenario}-artifact.txt`);
      await api("POST", "/api/mcp/servers", { name: scenario, command: process.execPath, args: [mcpScript], env: { FIXTURE_ARTIFACT: artifact }, enabled: true });
      await api("PATCH", `/api/mcp/servers/${scenario}`, { enabled: true });
      const { bot } = await control(["new-bot", "--name", `Jev ${scenario}`]);
      await control(["set-model", "--bot", bot.id, "--instance", "openaiCompat", "--model", "fixture-model"]);
      // Auto mode on an engine with no native reviewer: every tool call is a
      // `native-approval` card. Enforce lets a reviewer's allow answer it.
      await api("PATCH", `/api/bots/${bot.id}`, {
        mcpServers: [scenario], approvalMode: "auto", autoReview: "enforce",
        description: "Verification assistant", soul: "Use structured tools when an operation is requested.",
      });
      const reviewsBefore = reviews.length;
      const completionsBefore = completions.length;
      expect((await control(["send", "--bot", bot.id, "--task", bot.activeTaskId, "--text", "Write the verification artifact."])).success).toBe(true);
      const settled = await control(["wait", "--bot", bot.id, "--task", bot.activeTaskId, "--timeout", "30"]);
      const messages = await control(["messages", "--bot", bot.id, "--task", bot.activeTaskId, "--limit", "20"]);
      const decisions = (await api("GET", "/api/decisions?limit=50")).decisions.filter((row: any) => row.botId === bot.id);
      evidence.push({ scenario, status: settled.status, artifactExists: existsSync(artifact), decisions, reviews: reviews.slice(reviewsBefore) });

      // Jev saw the card, not the provider: one review per card, carrying the
      // tool and the bot's persona, under the fixture key.
      expect(reviews).toHaveLength(reviewsBefore + 1);
      const review = reviews[reviewsBefore]!;
      expect(review.authorization).toBe("Bearer synthetic-typesafe-key");
      expect(review.body.model).toBe("jev-latest");
      expect(Object.keys(review.body.questions).sort()).toEqual(["risky", "verdict"]);
      expect(String(review.body.state.tool)).toContain("write_file");
      expect(String(review.body.state.bot)).toContain(`Jev ${scenario}`);
      expect(decisions.some((row: any) => row.decision === "card-shown" && row.source === "native-approval")).toBe(true);

      if (scenario === "allow") {
        expect(settled.status, JSON.stringify(settled.messages)).toBe("settled");
        expect(readFileSync(artifact, "utf8")).toBe("verified");
        expect(completions).toHaveLength(completionsBefore + 2);
        expect(messages.messages.some((message: any) => message.tool?.name?.startsWith("review approved") && message.tool.name.includes("jev-1.13.0"))).toBe(true);
        expect(messages.messages.some((message: any) => message.text?.includes("The artifact was created."))).toBe(true);
        expect(decisions.some((row: any) => row.decision === "auto-approved" && row.source === "auto-review" && /allow 93%/.test(row.rule))).toBe(true);
      } else {
        // A denial is not an answer: the card stays open for a person, the
        // tool never ran, and the provider got no continuation.
        expect(settled.status).toBe("needs-user");
        expect(existsSync(artifact)).toBe(false);
        expect(completions).toHaveLength(completionsBefore + 1);
        // the bounded control transcript keeps the card's state, not its ids
        expect(messages.messages.some((message: any) => message.card && !message.card.answered && !message.card.dismissed)).toBe(true);
        expect(decisions.some((row: any) => row.decision === "auto-approved")).toBe(false);
        await control(["interrupt", "--bot", bot.id, "--task", bot.activeTaskId]);
      }
    }
  } finally {
    const evidencePath = `${fixture.info.logPath}.jev-review.json`;
    writeFileSync(evidencePath, JSON.stringify(evidence, null, 2), { mode: 0o600 });
    console.info(JSON.stringify({ evidencePath }));
    await fixture.close();
    await shutdown(upstream);
    await shutdown(jev);
  }
}, 120_000);
