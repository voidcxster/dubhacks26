import { describe, expect, test } from "bun:test";
import { buildCandidates, type Member, type Range } from "./slots.ts";

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
