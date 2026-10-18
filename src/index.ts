import { imessage } from "@spectrum-ts/imessage";
import { Spectrum } from "spectrum-ts";
import { bookPollChoice, cancelPollChoice, linkMembers, syncMembers } from "./actions.ts";
import { runTurn } from "./agent.ts";
import { findOption, insertMessage, migrate, recordVote, recentMessages, upsertPerson, upsertThread } from "./db.ts";
import { env } from "./env.ts";
import { startServer } from "./http.ts";

await migrate();
startServer();

const app = await Spectrum({
  projectId: env.projectId,
  projectSecret: env.projectSecret,
  providers: [imessage.config()],
});

const pending = new Map<string, Timer>();

console.log("secretary is listening for iMessage");

for await (const [space, message] of app.messages) {
  try {
    if (message.direction === "outbound") continue;
    if (message.sender?.kind === "agent") continue;

    if (message.content.type === "poll_option") {
      const phone = message.sender?.id;
      if (!phone) continue;
      const person = await upsertPerson(phone);
      const match = await findOption({
        spaceId: space.id,
        pollGuid: message.content.pollMessageGuid ?? message.content.poll.pollMessageGuid,
        optionIdentifier: message.content.option.optionIdentifier,
        label: message.content.option.title,
      });
      if (!match) {
        console.log("poll vote unmatched", message.content.option.optionIdentifier, message.content.option.title);
        continue;
      }
      console.log("poll vote", message.content.selected, message.content.option.title);
      await recordVote(match.planId, match.optionId, person.id, message.content.selected);
      if (message.content.selected) {
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
      continue;
    }

    if (message.content.type !== "text") continue;
    const phone = message.sender?.id;
    if (!phone || !message.content.text.trim()) continue;

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
