import { imessage } from "@spectrum-ts/imessage";
import { poll } from "spectrum-ts";
import type { Space } from "spectrum-ts";
import { accessToken, authUrl, freeBusy, insertEvent, templateUrl } from "./calendar.ts";
import {
  addMember,
  attachPoll,
  createPlan,
  getPerson,
  getPlan,
  loadRanges,
  markBooked,
  openPlan,
  recentSpeakerIds,
  recordWindow,
  rememberBooking,
  rememberFact,
  replaceGoogleBusy,
  replaceProposed,
  saveEvent,
  selectedVoters,
  threadMembers,
  upsertPerson,
  winningOption,
  yesVoters,
  type Person,
} from "./db.ts";
import { env } from "./env.ts";
import { addMinutes, clock, dayLabel, optionLabel } from "./time.ts";
import { buildCandidates, formatOffer, searchWindow, suggestOpenSlots, type Member } from "./scheduling/slots.ts";

type ToolSpace = Space & { send: (content: unknown) => Promise<{ content?: { type?: string; pollMessageGuid?: string; options?: { title: string; optionIdentifier?: string }[] } }> };

const settleTimers = new Map<string, Timer>();

export async function syncMembers(space: Space, senderPhone?: string): Promise<Person[]> {
  const phones = new Set<string>();
  if (senderPhone) phones.add(senderPhone);
  try {
    const members = await space.getMembers();
    for (const member of members) {
      if (member.kind === "agent") continue;
      phones.add(member.id);
    }
  } catch {
    // DMs cannot list members. The sender is enough.
  }
  const people: Person[] = [];
  for (const phone of phones) people.push(await upsertPerson(phone));
  return people;
}

export async function linkMembers(threadId: string, people: Person[]): Promise<void> {
  for (const person of people) await addMember(threadId, person.id);
}

async function refreshCalendars(threadId: string, people: Person[]): Promise<void> {
  const start = new Date();
  const end = addMinutes(start, 14 * 24 * 60);
  for (const person of people) {
    if (!person.google_refresh_token) continue;
    try {
      const token = await accessToken(person.id, person.google_refresh_token);
      const blocks = await freeBusy(token, start, end);
      await replaceGoogleBusy(person.id, threadId, blocks);
    } catch (error) {
      console.error("freebusy failed", person.phone, error instanceof Error ? error.message : error);
    }
  }
}

async function sendDirect(app: unknown, phone: string, text: string): Promise<boolean> {
  try {
    const im = imessage(app as never) as unknown as {
      user: (id: string) => Promise<{ id: string; __platform: string }>;
      space: { create: (user: { id: string; __platform: string }) => Promise<{ send: (body: string) => Promise<unknown> }> };
    };
    const user = await im.user(phone);
    const dm = await im.space.create(user);
    await dm.send(text);
    return true;
  } catch (error) {
    console.error("dm failed", error instanceof Error ? error.message : error);
    return false;
  }
}

export async function propose(input: {
  app: unknown;
  space: ToolSpace;
  threadId: string;
  title: string;
  durationMin: number;
  locus: "in_person" | "remote";
}): Promise<string> {
  const existing = await openPlan(input.threadId);
  if (existing) return `A poll is already open for ${existing.title}.`;

  const people = await threadMembers(input.threadId);
  await refreshCalendars(input.threadId, people);
  const ranges = await loadRanges(input.threadId, people.map((person) => person.id));
  const members: Member[] = people.map((person) => ({
    id: person.id,
    name: person.display_name || person.phone,
    calendarConnected: Boolean(person.google_refresh_token),
  }));
  const durationMin = input.durationMin > 0 ? input.durationMin : input.locus === "remote" ? 120 : 60;
  const built = buildCandidates({
    now: new Date(),
    durationMin,
    locus: input.locus,
    members,
    ranges,
  });
  if (built.options.length < 2) {
    return `Need at least two times. Recorded availability produced ${built.options.length}.`;
  }

  const planId = await createPlan({
    threadId: input.threadId,
    title: input.title,
    durationMin,
    locus: input.locus,
    options: built.options,
  });

  if (input.locus === "in_person") {
    for (const person of people) {
      if (person.google_refresh_token) continue;
      const url = authUrl(person.id);
      const sent = await sendDirect(input.app, person.phone, `Connect Google Calendar so I can schedule around what you already have: ${url}`);
      if (!sent) built.notes.push(`${person.display_name || person.phone}: ${url}`);
    }
  }

  if (built.notes.length > 0) await input.space.send(built.notes.join("\n"));
  const sent = await input.space.send(poll(input.title, built.options.map((option) => option.label)));
  const content = sent?.content;
  if (content?.type === "poll") {
    await attachPoll(planId, content.pollMessageGuid, content.options ?? []);
  }
  return `Poll sent with ${built.options.length} options.`;
}

export async function bookIfReady(input: {
  space: ToolSpace;
  planId: string;
  immediate: boolean;
}): Promise<void> {
  const existing = settleTimers.get(input.planId);
  if (existing) clearTimeout(existing);

  const ready = async () => {
    settleTimers.delete(input.planId);
    const plan = await getPlan(input.planId);
    if (!plan || plan.status !== "proposed") return;
    const speakers = await recentSpeakerIds(plan.thread_id);
    const voters = await selectedVoters(plan.id);
    const everyone = speakers.every((id) => voters.includes(id));
    if (!everyone && !input.immediate) return;
    if (voters.length === 0) return;
    await book(input.space, plan.id);
  };

  const speakers = await recentSpeakerIds((await getPlan(input.planId))?.thread_id ?? "");
  const voters = await selectedVoters(input.planId);
  if (speakers.length > 0 && speakers.every((id) => voters.includes(id))) {
    await ready();
    return;
  }
  settleTimers.set(input.planId, setTimeout(() => {
    void book(input.space, input.planId).catch((error) => {
      console.error("book failed", error instanceof Error ? error.message : error);
    });
  }, 3 * 60_000));
}

async function book(space: ToolSpace, planId: string): Promise<void> {
  const winner = await winningOption(planId);
  if (!winner || winner.votes < 1) return;
  const claimed = await markBooked(planId);
  if (!claimed) return;
  const plan = await getPlan(planId);
  if (!plan) return;
  const people = await threadMembers(plan.thread_id);
  const voterIds = await yesVoters(winner.id);
  const owner = people.find((person) => person.google_refresh_token) ?? null;
  const template = templateUrl(plan.title, new Date(winner.start_at), new Date(winner.end_at));
  let googleEventId: string | null = null;
  let htmlLink: string | null = null;
  if (owner?.google_refresh_token) {
    try {
      const token = await accessToken(owner.id, owner.google_refresh_token);
      const attendees = people
        .filter((person) => voterIds.includes(person.id) && person.google_email)
        .map((person) => person.google_email as string);
      const created = await insertEvent({
        token,
        title: plan.title,
        start: new Date(winner.start_at),
        end: new Date(winner.end_at),
        attendees,
      });
      googleEventId = created?.id ?? null;
      htmlLink = created?.htmlLink ?? null;
    } catch (error) {
      console.error("event insert failed", error instanceof Error ? error.message : error);
    }
  }
  const eventId = await saveEvent({
    planId,
    title: plan.title,
    start: new Date(winner.start_at),
    end: new Date(winner.end_at),
    templateUrl: template,
    googleEventId,
    htmlLink,
    ownerPersonId: owner?.id ?? null,
  });
  await rememberBooking({
    threadId: plan.thread_id,
    planId,
    start: new Date(winner.start_at),
    end: new Date(winner.end_at),
    personIds: voterIds,
  });
  const when = `${dayLabel(new Date(winner.start_at), new Date())} ${clock(new Date(winner.start_at))} – ${clock(new Date(winner.end_at))}`;
  const link = htmlLink ?? template;
  await space.send(`${plan.title} is booked for ${when}.\n${link}\nCalendar file: ${env.publicBaseUrl}/events/${eventId}.ics`);
}

export async function applyAvailability(input: {
  threadId: string;
  phone: string;
  displayName?: string;
  kind: "free" | "busy";
  start: string;
  end: string;
  point: boolean;
  open: boolean;
  reason?: string;
}): Promise<string> {
  const person = await upsertPerson(input.phone, input.displayName);
  await addMember(input.threadId, person.id);
  const start = new Date(input.start);
  const end = new Date(input.end);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end <= start) {
    return "Ignored an availability window with bad times.";
  }
  await recordWindow({
    personId: person.id,
    threadId: input.threadId,
    start,
    end,
    kind: input.kind,
    point: input.point,
    open: input.open,
  });
  if (input.reason) {
    await rememberFact({
      threadId: input.threadId,
      personId: person.id,
      kind: input.kind,
      durability: "ephemeral",
      payload: { reason: input.reason, start: input.start, end: input.end },
      validUntil: end,
    });
  }
  return `Saved ${input.kind} ${start.toISOString()} to ${end.toISOString()} for ${person.phone}.`;
}


export async function offerTimes(input: {
  threadId: string;
  phone: string;
  title: string;
  durationMin: number;
  locus: "in_person" | "remote";
  earliest?: string;
  latest?: string;
  requested?: string;
  requestText?: string;
}): Promise<{ text: string; slots: { label: string; start: string }[] }> {
  const person = await upsertPerson(input.phone);
  await addMember(input.threadId, person.id);
  await refreshCalendars(input.threadId, [person]);
  const ranges = await loadRanges(input.threadId, [person.id]);
  const durationMin = input.durationMin > 0 ? input.durationMin : input.locus === "remote" ? 120 : 60;
  const now = new Date();
  const spoken = searchWindow(input.requestText ?? "", now);
  const modelEarliest = input.earliest ? new Date(input.earliest) : undefined;
  const modelLatest = input.latest ? new Date(input.latest) : undefined;
  const earliest = spoken.named ? spoken.earliest : modelEarliest && !Number.isNaN(modelEarliest.getTime()) ? modelEarliest : spoken.earliest;
  const latest = spoken.named ? spoken.latest : modelLatest && !Number.isNaN(modelLatest.getTime()) ? modelLatest : spoken.latest;
  const requested = input.requested ? new Date(input.requested) : undefined;
  const preferred = ranges
    .filter((range) => range.kind === "free" && range.point && range.start >= earliest && range.start < latest)
    .map((range) => range.start);
  if (requested && !Number.isNaN(requested.getTime()) && requested >= earliest && requested < latest) preferred.push(requested);
  const built = suggestOpenSlots({
    now,
    durationMin,
    locus: input.locus,
    personId: person.id,
    ranges,
    preferred,
    earliest,
    latest,
    windowLabel: spoken.label,
  });
  await replaceProposed(input.threadId);
  if (built.slots.length > 0) {
    await createPlan({
      threadId: input.threadId,
      title: input.title,
      durationMin,
      locus: input.locus,
      options: built.slots,
    });
  }
  const connectUrl = person.google_refresh_token ? null : authUrl(person.id);
  return {
    text: formatOffer({ title: input.title, slots: built.slots, notes: built.notes, connectUrl, windowLabel: built.windowLabel }),
    slots: built.slots.map((slot) => ({ label: slot.label, start: slot.start.toISOString() })),
  };
}

export async function bookDirect(input: {
  threadId: string;
  phone: string;
  title: string;
  start: string;
  durationMin: number;
  locus: "in_person" | "remote";
  requestText?: string;
}): Promise<string> {
  const person = await upsertPerson(input.phone);
  await addMember(input.threadId, person.id);
  const start = new Date(input.start);
  const durationMin = input.durationMin > 0 ? input.durationMin : input.locus === "remote" ? 120 : 60;
  const spoken = searchWindow(input.requestText ?? "", new Date());
  if (Number.isNaN(start.getTime()) || (spoken.named && (start < spoken.earliest || start >= spoken.latest))) {
    const offer = await offerTimes({ ...input, requested: undefined });
    return offer.text;
  }
  const end = addMinutes(start, durationMin);
  await refreshCalendars(input.threadId, [person]);
  const ranges = await loadRanges(input.threadId, [person.id]);
  const bufferMin = input.locus === "in_person" ? 30 : 0;
  const conflict = ranges.find((range) => (
    range.personId === person.id
    && range.kind === "busy"
    && start < addMinutes(range.end, bufferMin)
    && end > range.start
  ));
  if (conflict) {
    const offer = await offerTimes({
      threadId: input.threadId,
      phone: input.phone,
      title: input.title,
      durationMin,
      locus: input.locus,
      requested: start.toISOString(),
      requestText: input.requestText,
    });
    return offer.text;
  }

  await replaceProposed(input.threadId);
  const planId = await createPlan({
    threadId: input.threadId,
    title: input.title,
    durationMin,
    locus: input.locus,
    options: [{ label: optionLabel(start, new Date()), start, end, yes: 1 }],
  });
  await markBooked(planId);
  const template = templateUrl(input.title, start, end);
  let googleEventId: string | null = null;
  let htmlLink: string | null = null;
  if (person.google_refresh_token) {
    try {
      const token = await accessToken(person.id, person.google_refresh_token);
      const created = await insertEvent({
        token,
        title: input.title,
        start,
        end,
        attendees: [],
      });
      googleEventId = created?.id ?? null;
      htmlLink = created?.htmlLink ?? null;
    } catch (error) {
      console.error("event insert failed", error instanceof Error ? error.message : error);
    }
  }
  await saveEvent({
    planId,
    title: input.title,
    start,
    end,
    templateUrl: template,
    googleEventId,
    htmlLink,
    ownerPersonId: person.id,
  });
  await rememberBooking({
    threadId: input.threadId,
    planId,
    start,
    end,
    personIds: [person.id],
  });
  const when = `${dayLabel(start, new Date())} ${clock(start)} – ${clock(end)}`;
  const lines = [`${input.title} is set for ${when}.`];
  if (htmlLink) {
    lines.push(`I added it to your Google Calendar: ${htmlLink}`);
    lines.push(`If you don't see it, add it yourself: ${template}`);
  } else {
    lines.push(`Add it to your calendar: ${template}`);
  }
  if (!person.google_refresh_token) {
    lines.push(`Connect Google Calendar so I can see when you're busy: ${authUrl(person.id)}`);
  }
  return lines.join("\n");
}

export async function connectLink(app: unknown, phone: string, displayName?: string): Promise<string> {
  const person = await upsertPerson(phone, displayName);
  const url = authUrl(person.id);
  const sent = await sendDirect(app, phone, `Connect Google Calendar: ${url}`);
  return sent ? `Sent ${phone} a calendar connect link.` : `Could not DM ${phone}. Link: ${url}`;
}

export async function personById(id: string): Promise<Person | null> {
  return getPerson(id);
}
