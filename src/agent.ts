import OpenAI from "openai";
import { activeFacts, addMember, loadRanges, rememberFact, threadMembers, upsertPerson, type Person } from "./db.ts";
import { env } from "./env.ts";
import { applyAvailability, connectLink, propose } from "./actions.ts";
import { clock } from "./time.ts";

const client = new OpenAI({
  apiKey: env.xaiApiKey,
  baseURL: "https://api.x.ai/v1",
});

const tools: OpenAI.Chat.ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "record_availability",
      description: "Save one absolute availability window for a person in this chat. Resolve relative phrases against NOW before calling. 'Right now', 'in 2 hours', 'at 8', and 'tomorrow at 5' are point=true. If they can start then and did not name a stop, also set open=true and end at 9:00pm local the same day. 'From 4' is point=false, open=true, start at 4:00pm, end at 9:00pm. A reason like chem homework is kind=busy for only that interval, plus a separate free window for when they can start.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          person_phone: { type: "string" },
          display_name: { type: "string" },
          kind: { type: "string", enum: ["free", "busy"] },
          start: { type: "string", description: "ISO 8601 timestamp" },
          end: { type: "string", description: "ISO 8601 timestamp" },
          point: { type: "boolean" },
          open: { type: "boolean" },
          reason: { type: "string" },
        },
        required: ["person_phone", "kind", "start", "end", "point", "open"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "remember_fact",
      description: "Store a short fact. Ephemeral facts expire. Durable facts are the activity itself, not one-off homework.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          person_phone: { type: "string" },
          kind: { type: "string" },
          durability: { type: "string", enum: ["ephemeral", "durable"] },
          note: { type: "string" },
          valid_until: { type: "string" },
        },
        required: ["kind", "durability", "note"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "reply",
      description: "Send one short message into the chat. Use this to greet, or to ask when people can make a plan before a poll exists.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          text: { type: "string" },
        },
        required: ["text"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "send_poll",
      description: "Build poll times from recorded availability and connected calendars, then send one iMessage poll. Call this once after availability is saved. Do not invent the option text.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          title: { type: "string" },
          duration_minutes: { type: "number" },
          locus: { type: "string", enum: ["in_person", "remote"] },
        },
        required: ["title", "duration_minutes", "locus"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "send_calendar_link",
      description: "DM one person a Google Calendar connect link.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          person_phone: { type: "string" },
          display_name: { type: "string" },
        },
        required: ["person_phone"],
      },
    },
  },
];

export async function runTurn(input: {
  app: unknown;
  space: Parameters<typeof propose>[0]["space"];
  threadId: string;
  transcript: { phone: string | null; body: string; sent_at: Date }[];
}): Promise<void> {
  const people = await threadMembers(input.threadId);
  const facts = await activeFacts(input.threadId);
  const ranges = await loadRanges(input.threadId, people.map((person) => person.id));
  const now = new Date();
  const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
    {
      role: "system",
      content: [
        "You schedule plans inside an iMessage group.",
        "If someone proposes an activity and people have already named times, record every availability window, then call send_poll once.",
        "If someone proposes an activity and there are not yet two concrete times, call reply and ask the group when they can make it.",
        "A greeting with no plan gets a one-line reply that says you can schedule.",
        "Do not ask who is organizing.",
        "Remote games such as Overwatch use locus=remote and duration 120 when nobody names one. In-person plans such as basketball use locus=in_person and duration 60.",
        "A connected calendar belongs to a person even if they have not replied. Record only what was said; send_poll applies calendars.",
        `NOW is ${now.toISOString()} (${clock(now)} America/Los_Angeles).`,
        `People: ${people.map(describe).join("; ") || "none yet"}`,
        `Facts: ${JSON.stringify(facts)}`,
        `Windows: ${JSON.stringify(ranges.map((range) => ({
          phone: people.find((person) => person.id === range.personId)?.phone,
          kind: range.kind,
          source: range.source,
          start: range.start.toISOString(),
          end: range.end.toISOString(),
          point: range.point,
          open: range.open,
        })))}`,
      ].join("\n"),
    },
    {
      role: "user",
      content: input.transcript
        .slice()
        .reverse()
        .map((line) => `[${line.sent_at.toISOString()}] ${line.phone ?? "unknown"}: ${line.body}`)
        .join("\n"),
    },
  ];

  let spoke = false;
  for (let step = 0; step < 6; step += 1) {
    const completion = await client.chat.completions.create({
      model: env.xaiModel,
      messages,
      tools,
      tool_choice: "auto",
    });
    const message = completion.choices[0]?.message;
    if (!message) break;
    const calls = message.tool_calls ?? [];
    if (calls.length === 0) break;
    messages.push(message);
    for (const call of calls) {
      if (call.type !== "function") continue;
      const args = JSON.parse(call.function.arguments || "{}") as Record<string, unknown>;
      console.log("tool", call.function.name);
      const result = await dispatch(input, args, call.function.name);
      if (call.function.name === "reply" || call.function.name === "send_poll") spoke = true;
      messages.push({ role: "tool", tool_call_id: call.id, content: result });
    }
  }
  if (!spoke) await fallbackReply(input.space, input.transcript);
}

async function fallbackReply(
  space: Parameters<typeof propose>[0]["space"],
  transcript: { body: string }[],
): Promise<void> {
  const text = transcript.map((line) => line.body).join("\n");
  if (/overwatch|hop on|available|basketball|tonight|tomorrow|free at|meet/i.test(text)) {
    await space.send("I'm in. Reply with when you can — right now, in 2 hours, at 8, or tomorrow at 5 — and I'll send a poll.");
    return;
  }
  const latest = transcript[0]?.body ?? "";
  if (/^\s*hi\b/i.test(latest)) {
    await space.send("I'm here. Name a plan, like Overwatch tonight, and I'll turn the replies into a poll.");
  }
}

function describe(person: Person): string {
  const name = person.display_name || person.phone;
  return `${name} <${person.phone}> calendar=${person.google_refresh_token ? "connected" : "no"}`;
}

async function dispatch(
  input: { app: unknown; space: Parameters<typeof propose>[0]["space"]; threadId: string },
  args: Record<string, unknown>,
  name: string,
): Promise<string> {
  try {
    if (name === "record_availability") {
      return await applyAvailability({
        threadId: input.threadId,
        phone: String(args.person_phone ?? ""),
        displayName: args.display_name ? String(args.display_name) : undefined,
        kind: args.kind === "busy" ? "busy" : "free",
        start: String(args.start ?? ""),
        end: String(args.end ?? ""),
        point: Boolean(args.point),
        open: Boolean(args.open),
        reason: args.reason ? String(args.reason) : undefined,
      });
    }
    if (name === "remember_fact") {
      const phone = args.person_phone ? String(args.person_phone) : "";
      const person = phone ? await upsertPerson(phone) : null;
      if (person) await addMember(input.threadId, person.id);
      await rememberFact({
        threadId: input.threadId,
        personId: person?.id ?? null,
        kind: String(args.kind ?? "note"),
        durability: args.durability === "durable" ? "durable" : "ephemeral",
        payload: { note: String(args.note ?? "") },
        validUntil: args.valid_until ? new Date(String(args.valid_until)) : null,
      });
      return "Remembered.";
    }
    if (name === "reply") {
      const text = String(args.text ?? "").trim();
      if (!text) return "Empty reply.";
      await input.space.send(text);
      return "Sent.";
    }
    if (name === "send_poll") {
      const result = await propose({
        app: input.app,
        space: input.space,
        threadId: input.threadId,
        title: String(args.title ?? "Plan"),
        durationMin: Number(args.duration_minutes ?? 0),
        locus: args.locus === "in_person" ? "in_person" : "remote",
      });
      if (!result.startsWith("Poll sent")) {
        await input.space.send("I'm in. Reply with when you can — right now, in 2 hours, at 8, or tomorrow at 5 — and I'll send a poll.");
      }
      return result;
    }
    if (name === "send_calendar_link") {
      return await connectLink(input.app, String(args.person_phone ?? ""), args.display_name ? String(args.display_name) : undefined);
    }
    return `Unknown tool ${name}`;
  } catch (error) {
    return error instanceof Error ? error.message : "Tool failed";
  }
}
