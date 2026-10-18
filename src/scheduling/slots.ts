import { addMinutes, clock, localParts, optionLabel, ZONE } from "../time.ts";

export type Range = {
  personId: string;
  personName: string;
  start: Date;
  end: Date;
  kind: "free" | "busy";
  point?: boolean;
  open?: boolean;
  source: "chat" | "google" | "booked";
};

export type Member = {
  id: string;
  name: string;
  calendarConnected: boolean;
};

export type SlotOption = {
  start: Date;
  end: Date;
  label: string;
  yes: number;
  unknown: number;
};

export type SlotPlan = {
  options: SlotOption[];
  notes: string[];
};

function overlaps(start: Date, end: Date, range: Range): boolean {
  return start < range.end && end > range.start;
}

function blockedUntil(ranges: Range[], start: Date, end: Date, bufferMin: number): Range | null {
  let culprit: Range | null = null;
  let until = 0;
  for (const range of ranges) {
    const blockEnd = addMinutes(range.end, bufferMin);
    if (start < blockEnd && end > range.start) {
      if (blockEnd.getTime() > until) {
        until = blockEnd.getTime();
        culprit = range;
      }
    }
  }
  return culprit;
}

function covers(free: Range, start: Date): boolean {
  if (free.open) return free.start <= start && free.end > start;
  return Math.abs(free.start.getTime() - start.getTime()) < 60_000;
}

function classify(
  member: Member,
  start: Date,
  end: Date,
  free: Range[],
  busy: Range[],
  bufferMin: number,
): "yes" | "no" | "unknown" {
  const mine = busy.filter((range) => range.personId === member.id);
  if (blockedUntil(mine, start, end, bufferMin)) return "no";
  const stated = free.filter((range) => range.personId === member.id);
  if (stated.some((range) => covers(range, start))) return "yes";
  if (member.calendarConnected) return "yes";
  return "unknown";
}

function ceil30(date: Date): Date {
  const step = 30 * 60_000;
  return new Date(Math.ceil(date.getTime() / step) * step);
}

export function buildCandidates(input: {
  now: Date;
  zone?: string;
  durationMin: number;
  locus: "in_person" | "remote";
  members: Member[];
  ranges: Range[];
}): SlotPlan {
  const zone = input.zone ?? "America/Los_Angeles";
  const bufferMin = input.locus === "in_person" ? 30 : 0;
  const durationMin = input.durationMin;
  const free = input.ranges.filter((range) => range.kind === "free" && range.end > range.start);
  const chatBusy = input.ranges.filter((range) => range.kind === "busy" && range.source === "chat");
  const external = input.ranges.filter((range) => range.kind === "busy" && range.source !== "chat");
  const hard = [...chatBusy, ...external];
  const notes = new Set<string>();
  const anchors = new Map<number, Date>();

  const rememberBlock = (block: Range | null) => {
    if (!block || block.source !== "google") return;
    notes.add(`${block.personName} is busy until ${optionLabel(block.end, input.now, zone).replace(/^Today |^Tomorrow /, "")}`);
  };

  for (const point of free.filter((range) => range.point)) {
    const end = addMinutes(point.start, durationMin);
    const block = blockedUntil(external, point.start, end, bufferMin);
    if (block) {
      rememberBlock(block);
      continue;
    }
    anchors.set(point.start.getTime(), point.start);
  }

  for (const window of free.filter((range) => range.open && !range.point)) {
    let cursor = window.start;
    let produced = 0;
    let guard = 0;
    while (produced < 2 && guard < 48 && addMinutes(cursor, durationMin) <= window.end) {
      guard += 1;
      const end = addMinutes(cursor, durationMin);
      const block = blockedUntil(hard, cursor, end, bufferMin);
      if (block) {
        rememberBlock(block);
        const next = ceil30(addMinutes(block.end, bufferMin));
        cursor = next.getTime() <= cursor.getTime() ? addMinutes(cursor, 30) : next;
        continue;
      }
      anchors.set(cursor.getTime(), cursor);
      produced += 1;
      cursor = addMinutes(cursor, 30);
    }
  }

  const options = [...anchors.values()]
    .sort((a, b) => a.getTime() - b.getTime())
    .slice(0, 4)
    .map((start) => {
      const end = addMinutes(start, durationMin);
      let yes = 0;
      let unknown = 0;
      for (const member of input.members) {
        const status = classify(member, start, end, free, hard, bufferMin);
        if (status === "yes") yes += 1;
        if (status === "unknown") unknown += 1;
      }
      const count = unknown > 0 ? `${yes}, others unknown` : `${yes} ${yes === 1 ? "person" : "people"}`;
      return {
        start,
        end,
        yes,
        unknown,
        label: `${optionLabel(start, input.now, zone)} (${count})`,
      };
    });

  if (input.locus === "in_person") {
    for (const member of input.members) {
      if (!member.calendarConnected) notes.add(`${member.name}'s calendar isn't connected`);
    }
  }

  return { options, notes: [...notes] };
}

function withinDay(start: Date, end: Date, zone: string): boolean {
  const opens = localParts(start, zone);
  const closes = localParts(end, zone);
  if (opens.hour < 9) return false;
  if (ymdKey(end, zone) !== ymdKey(start, zone)) return false;
  return closes.hour < 21 || (closes.hour === 21 && closes.minute === 0);
}

function ymdKey(date: Date, zone: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: zone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

export function suggestOpenSlots(input: {
  now: Date;
  zone?: string;
  durationMin: number;
  locus: "in_person" | "remote";
  personId: string;
  ranges: Range[];
  preferred?: Date[];
  earliest?: Date;
  latest?: Date;
}): { slots: SlotOption[]; notes: string[] } {
  const zone = input.zone ?? ZONE;
  const bufferMin = input.locus === "in_person" ? 30 : 0;
  const earliest = input.earliest ?? input.now;
  const latest = input.latest ?? addMinutes(input.now, 48 * 60);
  const mine = input.ranges.filter((range) => range.personId === input.personId);
  const busy = mine.filter((range) => range.kind === "busy");
  const opens = mine.filter((range) => range.kind === "free" && range.open && !range.point);
  const notes = new Set<string>();

  const fits = (start: Date): boolean => {
    if (start.getTime() < input.now.getTime() - 5 * 60_000) return false;
    if (start < earliest) return false;
    const end = addMinutes(start, input.durationMin);
    if (end > latest) return false;
    if (!withinDay(start, end, zone)) return false;
    if (opens.length > 0 && !opens.some((range) => range.start <= start && range.end >= end)) return false;
    return !blockedUntil(busy, start, end, bufferMin);
  };

  const preferred = (input.preferred ?? []).filter((start) => {
    if (fits(start)) return true;
    if (start >= input.now && blockedUntil(busy, start, addMinutes(start, input.durationMin), bufferMin)) {
      notes.add(`${optionLabel(start, input.now, zone)} overlaps your calendar.`);
    }
    return false;
  });

  const grid: Date[] = [];
  for (let cursor = ceil30(input.now), guard = 0; guard < 96 && cursor < latest; guard += 1) {
    if (fits(cursor)) grid.push(cursor);
    cursor = addMinutes(cursor, 30);
  }

  const pool = [...preferred, ...grid];
  const chosen: Date[] = [];
  const take = (gapMin: number) => {
    for (const start of pool) {
      if (chosen.length >= 6) return;
      const crowded = chosen.some((have) => Math.abs(have.getTime() - start.getTime()) < gapMin * 60_000);
      if (crowded) continue;
      chosen.push(start);
    }
  };
  take(90);
  if (chosen.length < 3) take(30);
  chosen.sort((a, b) => a.getTime() - b.getTime());

  const first = chosen[0];
  if (first) {
    const covering = busy
      .filter((range) => range.source !== "chat" && range.end > input.now && range.start <= first)
      .sort((a, b) => b.end.getTime() - a.end.getTime())[0];
    if (covering) notes.add(`You're busy until ${clock(covering.end, zone)}.`);
  } else {
    notes.add("Your calendar has no open block long enough through tomorrow evening.");
  }

  return {
    notes: [...notes],
    slots: chosen.map((start) => ({
      start,
      end: addMinutes(start, input.durationMin),
      yes: 1,
      unknown: 0,
      label: optionLabel(start, input.now, zone),
    })),
  };
}

const ordinals = ["first", "second", "third", "fourth", "fifth", "sixth"];

export function pickSlot(text: string, slots: { label: string; start: Date }[], zone = ZONE): number | null {
  const indexOnly = text.trim().match(/^(?:option\s*)?([1-6])$/i);
  if (indexOnly) {
    const index = Number(indexOnly[1]) - 1;
    return slots[index] ? index : null;
  }
  const word = text.toLowerCase().match(/\b(first|second|third|fourth|fifth|sixth)\b/);
  if (word) {
    const index = ordinals.indexOf(word[1] ?? "");
    return slots[index] ? index : null;
  }
  const clockMatch = text.match(/\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b/i);
  if (!clockMatch) return null;
  let hour = Number(clockMatch[1]);
  const minute = Number(clockMatch[2] ?? "0");
  const mer = clockMatch[3]?.toLowerCase();
  if (hour > 12 || minute > 59) return null;
  if (mer === "pm" && hour < 12) hour += 12;
  if (mer === "am" && hour === 12) hour = 0;
  const hits = slots.flatMap((slot, index) => {
    const parts = localParts(slot.start, zone);
    const sameMinute = parts.minute === minute;
    const sameHour = mer ? parts.hour === hour : parts.hour === hour || parts.hour === hour + 12;
    if (!sameMinute || !sameHour) return [];
    if (/\btomorrow\b/i.test(text) && !slot.label.startsWith("Tomorrow")) return [];
    if (/\b(today|tonight)\b/i.test(text) && !slot.label.startsWith("Today") && slot.label !== "Right now") return [];
    return [index];
  });
  return hits.length === 1 ? hits[0]! : null;
}
