import OpenAI from "openai";
import { applyAvailability, applyOverride, bookDirect, isOverride, offerTimes, publishPoll, syncCalendars, type Offer } from "./actions.ts";
import { activeFacts, addMember, latestProposal, loadRanges, rememberFact, threadMembers, upsertPerson, type Person } from "./db.ts";
import { env } from "./env.ts";
import { decideOutgoing, fixedEvent, isConfusion, pickSlot, resolveSpokenTime } from "./scheduling/slots.ts";
import { clock } from "./time.ts";

const client = new OpenAI({
  apiKey: env.xaiApiKey,
  baseURL: "https://api.x.ai/v1",
});

const canned = /I'll send a poll|right now, in 2 hours, at 8, or tomorrow at 5/i;

const tools: OpenAI.Chat.ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "record_availability",
      description: "Save one absolute availability window the person stated. Resolve relative phrases against NOW. A named start is point=true. 'From 4' is point=false and open=true. Homework or another conflict is kind=busy.",
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
      description: "Store a short fact. Ephemeral facts expire. Durable facts are the activity itself.",
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
      name: "suggest_times",
      description: "Look at this person's calendar and the chat, then return 3 open times. Those times are sent as an iMessage poll. Call this when they propose a plan and have not chosen one time yet.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          title: { type: "string" },
          duration_minutes: { type: "number" },
          locus: { type: "string", enum: ["in_person", "remote"] },
          earliest: { type: "string", description: "Optional ISO start of the search window" },
          latest: { type: "string", description: "Optional ISO end of the search window" },
        },
        required: ["title", "duration_minutes", "locus"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "book_event",
      description: "Book one concrete time that does not overlap their calendar. Adds the Google Calendar event when they are connected, and always returns a manual add link. Call this when they pick a suggested time or name one time.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          title: { type: "string" },
          start: { type: "string", description: "ISO 8601 timestamp" },
          duration_minutes: { type: "number" },
          locus: { type: "string", enum: ["in_person", "remote"] },
        },
        required: ["title", "start", "duration_minutes", "locus"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "reply",
      description: "Send one short greeting. Do not use this to list times. suggest_times and book_event already produce the only message the person sees.",
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
];

type Turn = {
  app: unknown;
  space: { send: (body: unknown) => Promise<unknown> };
  threadId: string;
  direct: boolean;
  transcript: { phone: string | null; body: string; sent_at: Date }[];
};

type Suggestion = Offer;

const lastSent = new Map<string, string>();

export async function runTurn(input: Turn): Promise<void> {
  if (!input.direct) {
    await input.space.send("Text me one-to-one and I'll suggest times from your calendar. Group chats aren't available on this line.");
    return;
  }

  const phone = input.transcript[0]?.phone ?? "";
  const latest = input.transcript[0]?.body ?? "";
  if (phone) {
    const person = await upsertPerson(phone);
    await syncCalendars(input.threadId, [person]);
  }
  if (phone && isOverride(latest)) {
    await input.space.send(await applyOverride(input.threadId, phone));
    return;
  }
  const chosen = phone ? await bookExistingChoice(input, phone) : null;
  if (chosen) {
    await present(input, chosen);
    return;
  }
  const stated = phone ? fixedEvent(latest, new Date()) : null;
  if (stated) {
    await present(input, bookedMessage(await bookDirect({
      threadId: input.threadId,
      phone,
      title: stated.title,
      start: stated.start.toISOString(),
      durationMin: stated.durationMin,
      locus: stated.locus,
      requestText: latest,
    })));
    return;
  }

  const people = await threadMembers(input.threadId);
  const facts = await activeFacts(input.threadId);
  const ranges = await loadRanges(input.threadId, people.map((person) => person.id));
  const now = new Date();
  const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
    {
      role: "system",
      content: [
        "You schedule for one person in a private iMessage. suggest_times is delivered as an iMessage poll. Do not write the times yourself.",
        "If they propose a plan without choosing one listed time, call record_availability for anything they stated, then suggest_times once. Do not call reply.",
        "Search the day they just asked about. A request for Wednesday or for five days from now must use that day, not today or tomorrow.",
        "If they give a range, such as before Friday, spread the three suggestions across different days in that range.",
        "If they choose one suggested time, or state an activity at one concrete time such as 'I have to brush my teeth at 10pm', call book_event and nothing else. Do not reply that it is noted or blocked.",
        "If they reply override, a number, or tap a poll choice, do not call any tool. That booking is already handled.",
        "Never rewrite a list of times. The tool result is the only message they see.",
        "Google Calendar was just refreshed. A deleted event is free. Do not call a time busy unless it is in Windows.",
        "A greeting with no plan gets one short reply.",
        "Remote games such as Overwatch use locus=remote and duration 120. In-person plans such as basketball use locus=in_person and duration 60.",
        `NOW is ${now.toISOString()} (${clock(now)} America/Los_Angeles).`,
        `People: ${people.map(describe).join("; ") || "none yet"}`,
        `Facts: ${JSON.stringify(facts)}`,
        `Windows: ${JSON.stringify(ranges.map((range) => ({
          phone: people.find((person) => person.id === range.personId)?.phone,
          kind: range.kind,
          source: range.source,
          start: range.start.toISOString(),
          end: range.end.toISOString(),
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

  let replyText: string | null = null;
  let bookText: string | null = null;
  let suggestion: Suggestion | null = null;

  try {
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
      if (calls.length === 0) {
        const written = message.content?.trim();
        if (written && !canned.test(written)) replyText = written;
        break;
      }
      messages.push(message);
      for (const call of calls) {
        if (call.type !== "function") continue;
        const args = JSON.parse(call.function.arguments || "{}") as Record<string, unknown>;
        console.log("tool", call.function.name);
        const result = await dispatch(input, phone, args, call.function.name, {
          setReply: (text) => {
            replyText = text;
          },
          setBook: (text) => {
            bookText = text;
          },
          setSuggestion: (value) => {
            suggestion = value;
          },
        });
        messages.push({ role: "tool", tool_call_id: call.id, content: result });
      }
    }
  } catch (error) {
    console.error("model failed", error instanceof Error ? error.message : error);
  }

  const outgoing = await chooseOutgoing(input, phone, replyText, bookText, suggestion);
  await present(input, outgoing);
}

async function present(input: Turn, result: string | Offer | null): Promise<void> {
  if (!result) return;
  if (typeof result !== "string" && result.poll) {
    const key = `poll:${result.poll.labels.join("|")}`;
    const latest = input.transcript[0]?.body ?? "";
    if (lastSent.get(input.threadId) === key && !isConfusion(latest)) {
      console.log("suppressed repeat");
      return;
    }
    await publishPoll(input.space, result);
    lastSent.set(input.threadId, key);
    return;
  }
  const text = typeof result === "string" ? result : result.text;
  await deliver(input, text);
}

async function deliver(input: Turn, text: string | null): Promise<void> {
  const latest = input.transcript[0]?.body ?? "";
  const next = decideOutgoing({ next: text, previous: lastSent.get(input.threadId) ?? null, latestUser: latest });
  if (!next) {
    console.log("suppressed repeat");
    return;
  }
  const body = next.replace(/^Here they are again:\n/, "");
  if (/^\d+\. /m.test(body) || !lastSent.has(input.threadId)) lastSent.set(input.threadId, body);
  await input.space.send(next);
}

async function chooseOutgoing(
  input: Turn,
  phone: string,
  replyText: string | null,
  bookText: string | null,
  suggestion: Suggestion | null,
): Promise<string | Offer | null> {
  if (bookText?.includes("is set for")) return bookText;
  if (suggestion?.poll) return suggestion;
  if (bookText?.includes("conflicts with")) return bookText;
  if (suggestion) return suggestion;
  if (bookText) return bookText;
  if (replyText && !canned.test(replyText)) return replyText;
  return fallback(input, phone);
}

async function bookExistingChoice(input: Turn, phone: string): Promise<string | Offer | null> {
  const latest = input.transcript[0]?.body?.trim() ?? "";
  if (!isChoice(latest)) return null;
  const proposal = await latestProposal(input.threadId);
  if (!proposal) return null;
  const index = pickSlot(latest, proposal.options.map((option) => ({
    label: option.label,
    start: new Date(option.start_at),
  })));
  const chosen = index === null ? null : proposal.options[index];
  if (!chosen) return null;
  if (chosen.label === "Override") {
    return applyOverride(input.threadId, phone);
  }
  return bookedMessage(await bookDirect({
    threadId: input.threadId,
    phone,
    title: proposal.title,
    start: new Date(chosen.start_at).toISOString(),
    durationMin: proposal.duration_minutes,
    locus: proposal.locus === "in_person" ? "in_person" : "remote",
  }));
}

function bookedMessage(result: string | Offer | { stale: true }): string | Offer | null {
  if (typeof result !== "string" && "stale" in result) return null;
  return result;
}

function isChoice(text: string): boolean {
  return /^\s*(?:option\s*)?[1-6]\s*$/i.test(text)
    || /^\s*(?:the\s+)?(?:first|second|third|fourth|fifth|sixth)(?:\s+one)?\s*$/i.test(text)
    || /^\s*(?:today|tonight|tomorrow)?\s*(?:at\s+)?\d{1,2}(?::\d{2})?\s*(?:am|pm)?\s*$/i.test(text);
}

async function fallback(input: Turn, phone: string): Promise<string | Offer | null> {
  const latest = input.transcript[0]?.body?.trim() ?? "";
  if (!phone || !latest) return null;
  if (/^\s*(hi|hey|hello)\b[.!]*\s*$/i.test(latest)) {
    return "I'm here. Tell me what you want to schedule and I'll suggest times that fit your calendar.";
  }
  const plan = guessPlan(latest);
  const requested = resolveSpokenTime(latest, new Date());
  const offer = await offerTimes({
    threadId: input.threadId,
    phone,
    title: plan.title,
    durationMin: plan.durationMin,
    locus: plan.locus,
    requested: requested?.toISOString(),
    requestText: latest,
  });
  return offer;
}

function guessPlan(text: string): { title: string; durationMin: number; locus: "in_person" | "remote" } {
  const inPerson = /basketball|dinner|lunch|coffee|meet|in person/i.test(text);
  let title = "Plan";
  if (/overwatch/i.test(text)) title = "Overwatch";
  else if (/basketball/i.test(text)) title = "Basketball";
  else title = text.replace(/^(can we|i want to|i wanna|let's|lets|anyone want to)\s+/i, "").replace(/\s+/g, " ").trim().slice(0, 60) || "Plan";
  return {
    title,
    durationMin: /overwatch|valorant|game|hop on/i.test(text) ? 120 : 60,
    locus: inPerson ? "in_person" : "remote",
  };
}

function describe(person: Person): string {
  const name = person.display_name || person.phone;
  return `${name} <${person.phone}> calendar=${person.google_refresh_token ? "connected" : "no"}`;
}

async function dispatch(
  input: Turn,
  phone: string,
  args: Record<string, unknown>,
  name: string,
  sink: {
    setReply: (text: string) => void;
    setBook: (text: string) => void;
    setSuggestion: (value: Suggestion) => void;
  },
): Promise<string> {
  try {
    if (name === "record_availability") {
      return await applyAvailability({
        threadId: input.threadId,
        phone: String(args.person_phone ?? phone),
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
      const owner = String(args.person_phone ?? phone);
      const person = owner ? await upsertPerson(owner) : null;
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
    if (name === "suggest_times") {
      const requested = resolveSpokenTime(input.transcript[0]?.body ?? "", new Date());
      const offer = await offerTimes({
        threadId: input.threadId,
        phone: String(args.person_phone ?? phone),
        title: String(args.title ?? "Plan"),
        durationMin: Number(args.duration_minutes ?? 0),
        locus: args.locus === "in_person" ? "in_person" : "remote",
        earliest: args.earliest ? String(args.earliest) : undefined,
        latest: args.latest ? String(args.latest) : undefined,
        requested: requested?.toISOString(),
        requestText: input.transcript[0]?.body ?? "",
      });
      sink.setSuggestion(offer);
      return JSON.stringify(offer);
    }
    if (name === "book_event") {
      const result = await bookDirect({
        threadId: input.threadId,
        phone,
        title: String(args.title ?? "Plan"),
        start: String(args.start ?? ""),
        durationMin: Number(args.duration_minutes ?? 0),
        locus: args.locus === "in_person" ? "in_person" : "remote",
        requestText: input.transcript[0]?.body ?? "",
      });
      if (typeof result === "string") {
        sink.setBook(result);
        return result;
      }
      if ("stale" in result) return "Superseded.";
      sink.setSuggestion(result);
      return result.text;
    }
    if (name === "reply") {
      const text = String(args.text ?? "").trim();
      if (!text || canned.test(text)) return "That reply was dropped. Use the suggested times instead.";
      sink.setReply(text);
      return "Queued.";
    }
    return `Unknown tool ${name}`;
  } catch (error) {
    return error instanceof Error ? error.message : "Tool failed";
  }
}
