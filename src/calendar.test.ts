import { describe, expect, test } from "bun:test";
import { busyBlocksFromEvents, overlappingEventIds } from "./calendar.ts";

describe("google calendar refresh", () => {
  test("drops a deleted event and keeps the ones still on the calendar", () => {
    const blocks = busyBlocksFromEvents([
      {
        status: "confirmed",
        start: { dateTime: "2026-10-21T16:00:00.000Z" },
        end: { dateTime: "2026-10-21T17:00:00.000Z" },
      },
      {
        status: "cancelled",
        start: { dateTime: "2026-10-21T20:00:00.000Z" },
        end: { dateTime: "2026-10-21T21:00:00.000Z" },
      },
    ]);
    expect(blocks).toEqual([
      { start: new Date("2026-10-21T16:00:00.000Z"), end: new Date("2026-10-21T17:00:00.000Z") },
    ]);
  });

  test("selects the calendar event that overlaps a new booking", () => {
    const ids = overlappingEventIds([
      {
        id: "old",
        status: "confirmed",
        start: { dateTime: "2026-10-21T16:00:00.000Z" },
        end: { dateTime: "2026-10-21T17:00:00.000Z" },
      },
      {
        id: "later",
        status: "confirmed",
        start: { dateTime: "2026-10-21T20:00:00.000Z" },
        end: { dateTime: "2026-10-21T21:00:00.000Z" },
      },
    ], new Date("2026-10-21T16:30:00.000Z"), new Date("2026-10-21T17:30:00.000Z"));
    expect(ids).toEqual(["old"]);
  });
});
