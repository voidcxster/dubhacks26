import { imessage } from "@spectrum-ts/imessage";
import { Spectrum } from "spectrum-ts";
import { bookPollChoice, cancelPollChoice, linkMembers, syncMembers } from "./actions.ts";
import { runTurn } from "./agent.ts";
import { findOption, insertMessage, migrate, recordVote, recentMessages, upsertPerson, upsertThread } from "./db.ts";
import { env } from "./env.ts";
import { startServer } from "./http.ts";

await migrate();
startServer();

const pending = new Map<string, Timer>();
const pollCommit = new Map<string, number>();

type RunningApp = Awaited<ReturnType<typeof Spectrum>>;
type Delivery = RunningApp["messages"] extends AsyncIterable<infer Pair> ? Pair : never;

async function listen(): Promise<void> {
  for (;;) {
    const app = await Spectrum({
      projectId: env.projectId,
      projectSecret: env.projectSecret,
      providers: [imessage.config()],
    });
    try {
      console.log("secretary is listening for iMessage");
      for await (const [space, message] of app.messages) {
        await handleMessage(app, [space, message]);
      }
      console.error("iMessage stream ended; opening a fresh session");
    } catch (error) {
      console.error("listener failed", error instanceof Error ? error.message : error);
    } finally {
      for (const timer of pending.values()) clearTimeout(timer);
      pending.clear();
      await app.stop().catch(() => undefined);
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
}

async function handleMessage(app: RunningApp, [space, message]: Delivery): Promise<void> {
  try {
    if (message.direction === "outbound") return;
    if (message.sender?.kind === "agent") return;

    if (message.content.type === "poll_option") {
      const phone = message.sender?.id;
      if (!phone) return;
      const person = await upsertPerson(phone);
      const match = await findOption({
        spaceId: space.id,
        pollGuid: message.content.pollMessageGuid ?? message.content.poll.pollMessageGuid,
        optionIdentifier: message.content.option.optionIdentifier,
        label: message.content.option.title,
      });
      if (!match) {
        console.log("poll vote unmatched", message.content.option.optionIdentifier, message.content.option.title);
        return;
      }
      console.log("poll vote", message.content.selected, message.content.option.title);
      await recordVote(match.planId, match.optionId, person.id, message.content.selected);
      const committedAt = pollCommit.get(match.planId) ?? 0;
      if (Date.now() - committedAt < 2_000) {
        console.log("poll vote ignored while booking", message.content.option.title);
        return;
      }
      if (message.content.selected) {
        pollCommit.set(match.planId, Date.now());
        void bookPollChoice({
          space: space as Parameters<typeof bookPollChoice>[0]["space"],
          planId: match.planId,
          optionId: match.optionId,
          phone,
        }).catch((error: unknown) => {
          console.error("poll booking failed", error instanceof Error ? error.message : error);
        });
      } else {
        cancelPollChoice(match.planId, match.optionId);
      }
      return;
    }

    if (message.content.type !== "text") return;
    const phone = message.sender?.id;
    if (!phone || !message.content.text.trim()) return;

    console.log("inbound", phone, message.content.text);
    const thread = await upsertThread(space.id);
    const people = await syncMembers(space, phone);
    await linkMembers(thread.id, people);
    const person = await upsertPerson(phone);
    await insertMessage({
      threadId: thread.id,
      personId: person.id,
      photonId: message.id,
      body: message.content.text,
      sentAt: message.timestamp ?? new Date(),
    });

    const previous = pending.get(space.id);
    if (previous) clearTimeout(previous);
    const current = space;
    pending.set(space.id, setTimeout(() => {
      pending.delete(space.id);
      void current.responding(async () => {
        const transcript = await recentMessages(thread.id);
        await runTurn({
          app,
          space: current as Parameters<typeof runTurn>[0]["space"],
          threadId: thread.id,
          direct: current.id.includes(";-;"),
          transcript,
        });
      }).catch((error: unknown) => {
        console.error("turn failed", error instanceof Error ? error.message : error);
      });
    }, 4_000));
  } catch (error) {
    console.error("message failed", error instanceof Error ? error.message : error);
  }
}

void listen();
