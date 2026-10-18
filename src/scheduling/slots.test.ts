import { describe, expect, test } from "bun:test";
import { ymd } from "../time.ts";
import { buildCandidates, decideOutgoing, fixedEvent, formatOffer, isOverride, pickSlot, pollChoices, pollPreface, resolveSpokenTime, searchWindow, suggestOpenSlots, type Member, type Range } from "./slots.ts";

const now = new Date("2026-10-17T23:00:00.000Z");
const at = (iso: string) => new Date(iso);

const alex: Member = { id: "alex", name: "Alex", calendarConnected: false };
const blair: Member = { id: "blair", name: "Blair", calendarConnected: false };
const casey: Member = { id: "casey", name: "Casey", calendarConnected: false };
const devon: Member = { id: "devon", name: "Devon", calendarConnected: false };

function chat(partial: Omit<Range, "source">): Range {
  return { ...partial, source: "chat" };
}

describe("overwatch poll", () => {
  test("offers the times people named, with headcount", () => {
    const ranges: Range[] = [
      chat({ personId: "alex", personName: "Alex", kind: "busy", start: at("2026-10-17T23:00:00Z"), end: at("2026-10-18T01:00:00Z") }),
      chat({ personId: "alex", personName: "Alex", kind: "free", point: true, open: true, start: at("2026-10-18T01:00:00Z"), end: at("2026-10-18T04:00:00Z") }),
      chat({ personId: "blair", personName: "Blair", kind: "free", point: true, open: true, start: now, end: at("2026-10-18T04:00:00Z") }),
      chat({ personId: "casey", personName: "Casey", kind: "busy", start: now, end: at("2026-10-18T03:00:00Z") }),
      chat({ personId: "casey", personName: "Casey", kind: "free", point: true, open: true, start: at("2026-10-18T03:00:00Z"), end: at("2026-10-18T04:00:00Z") }),
      chat({ personId: "devon", personName: "Devon", kind: "busy", start: now, end: at("2026-10-18T04:00:00Z") }),
      chat({ personId: "devon", personName: "Devon", kind: "free", point: true, open: false, start: at("2026-10-19T00:00:00Z"), end: at("2026-10-19T02:00:00Z") }),
    ];
    const plan = buildCandidates({
      now,
      durationMin: 120,
      locus: "remote",
      members: [alex, blair, casey, devon],
      ranges,
    });
    expect(plan.options.map((option) => option.label)).toEqual([
      "Right now (1 person)",
      "Today 6:00 PM (2 people)",
      "Today 8:00 PM (3 people)",
      "Tomorrow 5:00 PM (1, others unknown)",
    ]);
  });
});

describe("basketball calendar conflict", () => {
  test("slides an open window past a silent member's busy block", () => {
    const a: Member = { id: "a", name: "A", calendarConnected: true };
    const b: Member = { id: "b", name: "B", calendarConnected: false };
    const ranges: Range[] = [
      {
        personId: "a",
        personName: "A",
        kind: "busy",
        source: "google",
        start: at("2026-10-17T22:00:00Z"),
        end: at("2026-10-18T00:00:00Z"),
      },
      chat({
        personId: "b",
        personName: "B",
        kind: "free",
        open: true,
        point: false,
        start: now,
        end: at("2026-10-18T04:00:00Z"),
      }),
    ];
    const plan = buildCandidates({
      now,
      durationMin: 60,
      locus: "in_person",
      members: [a, b],
      ranges,
    });
    expect(plan.options.map((option) => option.label)).toEqual([
      "Today 5:30 PM (2 people)",
      "Today 6:00 PM (2 people)",
    ]);
    expect(plan.notes).toContain("A is busy until 5:00 PM");
    expect(plan.notes).toContain("B's calendar isn't connected");
  });
});

describe("direct calendar suggestions", () => {
  const person = "naresh";

  function google(start: string, end: string): Range {
    return {
      personId: person,
      personName: "Naresh",
      kind: "busy",
      source: "google",
      start: at(start),
      end: at(end),
    };
  }

  test("suggests spread-out open times and skips a busy block", () => {
    const plan = suggestOpenSlots({
      now,
      durationMin: 60,
      locus: "remote",
      personId: person,
      ranges: [google("2026-10-17T23:00:00Z", "2026-10-18T01:00:00Z")],
    });
    expect(plan.slots.map((slot) => slot.label)).toEqual([
      "Today 6:00 PM",
      "Tomorrow 2:00 PM",
      "Mon, Oct 19 2:00 PM",
    ]);
    expect(plan.notes).toContain("You're busy until 6:00 PM.");
  });

  test("drops a requested time that overlaps the calendar", () => {
    const plan = suggestOpenSlots({
      now,
      durationMin: 60,
      locus: "remote",
      personId: person,
      ranges: [google("2026-10-18T02:00:00Z", "2026-10-18T04:00:00Z")],
      preferred: [at("2026-10-18T03:00:00Z")],
    });
    expect(plan.slots.map((slot) => slot.label)).not.toContain("Today 8:00 PM");
    expect(plan.notes).toContain("Today 8:00 PM conflicts with your Google Calendar until 9:00 PM.");
  });

  test("picks a numbered reply or a named time", () => {
    const slots = [
      { label: "Today 6:00 PM", start: at("2026-10-18T01:00:00Z") },
      { label: "Today 7:30 PM", start: at("2026-10-18T02:30:00Z") },
      { label: "Tomorrow 9:00 AM", start: at("2026-10-18T16:00:00Z") },
    ];
    expect(pickSlot("2", slots)).toBe(1);
    expect(pickSlot("the second one", slots)).toBe(1);
    expect(pickSlot("today at 6", slots)).toBe(0);
    expect(pickSlot("tomorrow at 9", slots)).toBe(2);
  });

  test("names a chat conflict separately from Google Calendar", () => {
    const plan = suggestOpenSlots({
      now,
      durationMin: 60,
      locus: "remote",
      personId: person,
      ranges: [
        {
          personId: person,
          personName: "Naresh",
          kind: "busy",
          source: "booked",
          start: at("2026-10-18T01:00:00Z"),
          end: at("2026-10-18T03:00:00Z"),
        },
      ],
      preferred: [at("2026-10-18T01:00:00Z")],
    });
    expect(plan.notes).toContain("Today 6:00 PM conflicts with something already planned in this chat until 8:00 PM.");
  });

  test("reads a spoken time and avoids repeating the same list", () => {
    expect(resolveSpokenTime("I want to go on 5pm", now)?.toISOString()).toBe("2026-10-18T00:00:00.000Z");
    const sundayMorning = at("2026-10-18T17:00:00Z");
    const teeth = fixedEvent("I have to brush my teeth at 10pm", sundayMorning);
    expect(teeth?.title).toBe("Brush my teeth");
    expect(teeth?.start.toISOString()).toBe("2026-10-19T05:00:00.000Z");
    expect(teeth?.durationMin).toBe(60);
    expect(fixedEvent("when can I brush my teeth at 10pm", sundayMorning)).toBeNull();
    expect(fixedEvent("I'm free at 10pm", sundayMorning)).toBeNull();
    expect(fixedEvent("let's play overwatch at 8pm", sundayMorning)?.title).toBe("Overwatch");
    const list = "Pick a time for Basketball:\n1. Today 6:00 PM\n2. Today 7:30 PM\nReply with a number.";
    expect(decideOutgoing({ next: list, previous: list, latestUser: "when am I free?" })).toBeNull();
    expect(decideOutgoing({ next: list, previous: list, latestUser: "what?" })).toBe(`Here they are again:\n${list}`);
    const withConflict = `Today 5:00 PM conflicts with your Google Calendar until 6:00 PM.\n${list}`;
    expect(decideOutgoing({ next: withConflict, previous: list, latestUser: "5pm" })).toBe(
      "Today 5:00 PM conflicts with your Google Calendar until 6:00 PM.",
    );
  });

  test("suggests Wednesday instead of repeating today and tomorrow", () => {
    const sunday = at("2026-10-18T17:00:00Z");
    const request = "I want to go to a library on Wednesday. When can I go";
    const window = searchWindow(request, sunday);
    expect(ymd(window.earliest)).toBe("2026-10-21");
    expect(ymd(window.latest)).toBe("2026-10-21");
    const plan = suggestOpenSlots({
      now: sunday,
      durationMin: 60,
      locus: "in_person",
      personId: person,
      ranges: [
        google("2026-10-19T00:00:00Z", "2026-10-19T01:00:00Z"),
        google("2026-10-20T00:00:00Z", "2026-10-20T00:50:00Z"),
      ],
      preferred: [at("2026-10-19T00:00:00Z"), at("2026-10-20T00:00:00Z")],
      earliest: window.earliest,
      latest: window.latest,
      windowLabel: window.label,
    });
    expect(plan.slots.length).toBeGreaterThanOrEqual(3);
    expect(plan.slots.every((slot) => ymd(slot.start) === "2026-10-21")).toBe(true);
    expect(plan.notes.join(" ")).not.toMatch(/Today|Tomorrow/);
    expect(plan.slots).toHaveLength(3);
    expect(plan.slots[0]?.label.startsWith("Wed")).toBe(true);
    const offer = formatOffer({
      title: "Library visit",
      slots: plan.slots,
      notes: ["Wed, Oct 21 5:00 PM conflicts with your Google Calendar until 6:00 PM."],
      connectUrl: null,
      overrideWhen: "Wed, Oct 21 5:00 PM",
    });
    expect(offer).toContain('reply "override" to replace the existing event and book Library visit at Wed, Oct 21 5:00 PM.');
    expect(pollChoices(plan.slots, "Wed, Oct 21 5:00 PM")).toEqual([
      ...plan.slots.map((slot) => slot.label),
      "Override",
    ]);
    expect(pollPreface({
      notes: ["Wed, Oct 21 5:00 PM conflicts with your Google Calendar until 6:00 PM."],
      connectUrl: null,
      overrideWhen: "Wed, Oct 21 5:00 PM",
    })).toContain("Override replaces the existing event at Wed, Oct 21 5:00 PM.");
    expect(isOverride("override")).toBe(true);
    expect(isOverride("2")).toBe(false);
    expect(resolveSpokenTime("Wednesday at 5pm", sunday)?.toISOString()).toBe("2026-10-22T00:00:00.000Z");
  });

  test("spreads a before-Friday request across the days in between", () => {
    const sunday = at("2026-10-18T17:00:00Z");
    const request = "i need to find a book for my research paper at library sometime before Friday";
    const window = searchWindow(request, sunday);
    expect(window.label).toBe("before Friday");
    expect(ymd(window.latest)).toBe("2026-10-23");
    const plan = suggestOpenSlots({
      now: sunday,
      durationMin: 60,
      locus: "in_person",
      personId: person,
      ranges: [google("2026-10-23T20:00:00Z", "2026-10-23T21:20:00Z")],
      earliest: window.earliest,
      latest: window.latest,
      windowLabel: window.label,
    });
    const days = new Set(plan.slots.map((slot) => ymd(slot.start)));
    expect(plan.slots).toHaveLength(3);
    expect(days.size).toBe(3);
    expect(plan.slots.every((slot) => ymd(slot.start) < "2026-10-23")).toBe(true);
  });

  test("offers other days when the requested day is full and keeps the conflict", () => {
    const sunday = at("2026-10-18T17:00:00Z");
    const window = searchWindow("I want to go on Wednesday", sunday);
    const plan = suggestOpenSlots({
      now: sunday,
      durationMin: 60,
      locus: "in_person",
      personId: person,
      ranges: [google("2026-10-21T16:00:00Z", "2026-10-22T04:00:00Z")],
      preferred: [at("2026-10-21T21:00:00Z")],
      earliest: window.earliest,
      latest: window.latest,
      windowLabel: window.label,
    });
    expect(plan.slots).toHaveLength(3);
    expect(plan.slots.every((slot) => ymd(slot.start) !== "2026-10-21")).toBe(true);
    expect(new Set(plan.slots.map((slot) => ymd(slot.start))).size).toBe(3);
    expect(plan.notes.some((note) => note.includes("conflicts with your Google Calendar"))).toBe(true);
    expect(plan.notes.some((note) => note.includes("is full"))).toBe(true);
  });
});
