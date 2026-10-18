import { addMinutes, clock, dayLabel, localParts, optionLabel, shiftDay, weekdayIndex, ymd, zonedDate, ZONE } from "../time.ts";

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
  windowLabel?: string;
  expanded?: boolean;
}): { slots: SlotOption[]; notes: string[]; windowLabel: string } {
  const zone = input.zone ?? ZONE;
  const bufferMin = input.locus === "in_person" ? 30 : 0;
  const earliest = input.earliest ?? input.now;
  const latest = input.latest ?? addMinutes(input.now, 48 * 60);
  const windowLabel = input.windowLabel ?? "through tomorrow evening";
  const mine = input.ranges.filter((range) => range.personId === input.personId);
  const busy = mine.filter((range) => range.kind === "busy");
  const opens = mine.filter((range) => range.kind === "free" && range.open && !range.point && range.end > earliest && range.start < latest);
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
    const block = blockedUntil(busy, start, addMinutes(start, input.durationMin), bufferMin);
    if (start >= earliest && start < latest && block) notes.add(conflictNote(block, start, input.now, zone));
    return false;
  });

  const grid: Date[] = [];
  let cursor = ceil30(earliest > input.now ? earliest : input.now);
  for (let guard = 0; guard < 14 * 48 && cursor < latest; guard += 1) {
    if (fits(cursor)) grid.push(cursor);
    cursor = addMinutes(cursor, 30);
  }

  const pool = [...preferred, ...grid];
  const chosen = spreadChoices(pool, zone);
  if (chosen.length === 0 && !input.expanded && ymdKey(earliest, zone) === ymdKey(latest, zone)) {
    const widened = suggestOpenSlots({
      ...input,
      earliest: input.now,
      latest: addMinutes(latest, 4 * 24 * 60),
      preferred: [],
      expanded: true,
      windowLabel: "another day",
    });
    notes.add(`${windowLabel} is full, so these are other days.`);
    for (const note of widened.notes) notes.add(note);
    return { notes: [...notes], windowLabel, slots: widened.slots };
  }

  const first = chosen[0];
  if (first) {
    const covering = busy
      .filter((range) => range.source !== "chat" && range.end > earliest && range.start < latest && range.start <= first)
      .sort((a, b) => b.end.getTime() - a.end.getTime())[0];
    if (covering && covering.end <= first) notes.add(`You're busy until ${clock(covering.end, zone)}.`);
  }

  return {
    notes: [...notes],
    windowLabel,
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

export function conflictNote(range: Range, start: Date, now: Date, zone = ZONE): string {
  const when = optionLabel(start, now, zone);
  const until = clock(range.end, zone);
  if (range.source === "google") return `${when} conflicts with your Google Calendar until ${until}.`;
  return `${when} conflicts with something already planned in this chat until ${until}.`;
}

const weekdays = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

export function searchWindow(text: string, now: Date, zone = ZONE): {
  earliest: Date;
  latest: Date;
  label: string;
  named: boolean;
} {
  const dayAt = (offset: number, hour: number, minute = 0) => zonedDate(shiftDay(now, offset, zone), hour, minute, zone);
  const inDays = text.match(/\bin\s+(\d+)\s+days?\b/i);
  const bounded = text.toLowerCase().match(/\b(before|by|until|through)\s+(sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/);
  const weekday = text.toLowerCase().match(/\b(sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/);
  if (bounded) {
    const target = weekdays.indexOf(bounded[2] ?? "");
    const current = weekdayIndex(now, zone);
    const offset = (target - current + 7) % 7;
    const includeDay = bounded[1] !== "before";
    if (!includeDay && offset === 0) {
      return { earliest: now, latest: dayAt(0, 21), label: "today", named: true };
    }
    const latest = includeDay ? dayAt(offset, 21) : dayAt(offset, 9);
    const name = (bounded[2] ?? "").slice(0, 1).toUpperCase() + (bounded[2] ?? "").slice(1);
    return {
      earliest: now,
      latest,
      label: includeDay ? `through ${name}` : `before ${name}`,
      named: true,
    };
  }
  if (inDays) {
    const offset = Number(inDays[1]);
    const earliest = dayAt(offset, 9);
    return { earliest, latest: dayAt(offset, 21), label: dayLabel(earliest, now, zone), named: true };
  }
  if (weekday) {
    const target = weekdays.indexOf(weekday[1] ?? "");
    const current = weekdayIndex(now, zone);
    let offset = (target - current + 7) % 7;
    if (offset === 0 && new RegExp(`\\bnext\\s+${weekday[1]}\\b`, "i").test(text)) offset = 7;
    const earliest = offset === 0 ? now : dayAt(offset, 9);
    return { earliest, latest: dayAt(offset, 21), label: offset === 0 ? "today" : dayLabel(earliest, now, zone), named: true };
  }
  if (/\bnext week\b/i.test(text)) {
    const current = weekdayIndex(now, zone);
    const monday = ((1 - current + 7) % 7) || 7;
    const earliest = dayAt(monday, 9);
    return { earliest, latest: dayAt(monday + 6, 21), label: "next week", named: true };
  }
  if (/\btomorrow\b/i.test(text)) {
    const earliest = dayAt(1, 9);
    return { earliest, latest: dayAt(1, 21), label: "tomorrow", named: true };
  }
  if (/\b(today|tonight)\b/i.test(text)) {
    return { earliest: now, latest: dayAt(0, 21), label: "today", named: true };
  }
  return { earliest: now, latest: addMinutes(now, 48 * 60), label: "through tomorrow evening", named: false };
}

export function formatOffer(input: {
  title: string;
  slots: { label: string }[];
  notes: string[];
  connectUrl: string | null;
  windowLabel?: string;
  overrideWhen?: string | null;
}): string {
  const conflicts = input.notes.filter((note) => note.includes("conflicts with"));
  const other = input.notes.filter((note) => !note.includes("conflicts with"));
  const windowLabel = input.windowLabel ?? "through tomorrow evening";
  const lines = [...conflicts];
  if (input.slots.length === 0) {
    const span = windowLabel.startsWith("through") ? windowLabel : `on ${windowLabel}`;
    lines.push(`No open time left for ${input.title} ${span}.`);
  } else {
    lines.push(`Pick a time for ${input.title}:`);
    lines.push(...input.slots.map((slot, index) => `${index + 1}. ${slot.label}`));
  }
  if (input.overrideWhen) {
    lines.push(`Reply with a number, or reply "override" to replace the existing event and book ${input.title} at ${input.overrideWhen}.`);
  } else if (input.slots.length > 0) {
    lines.push("Reply with a number.");
  }
  lines.push(...other);
  if (input.connectUrl) lines.push(`Connect Google Calendar to include the rest of your schedule: ${input.connectUrl}`);
  return lines.join("\n");
}

export function resolveSpokenTime(text: string, now: Date, zone = ZONE): Date | null {
  const match = text.match(/\b(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/i);
  if (!match) return null;
  let hour = Number(match[1]);
  const minute = Number(match[2] ?? "0");
  const mer = match[3]?.toLowerCase();
  if (hour > 12 || minute > 59 || minute % 30 !== 0) return null;
  if (mer === "pm" && hour < 12) hour += 12;
  if (mer === "am" && hour === 12) hour = 0;
  const window = searchWindow(text, now, zone);
  let cursor = ceil30(window.earliest > now ? window.earliest : now);
  for (let guard = 0; guard < 14 * 48 && cursor < window.latest; guard += 1) {
    const parts = localParts(cursor, zone);
    if (parts.hour === hour && parts.minute === minute && cursor >= now) return cursor;
    cursor = addMinutes(cursor, 30);
  }
  return null;
}

function nearestAfternoon(starts: Date[], zone: string): Date {
  const target = 14 * 60;
  return [...starts].sort((a, b) => {
    const left = localParts(a, zone);
    const right = localParts(b, zone);
    return Math.abs(left.hour * 60 + left.minute - target) - Math.abs(right.hour * 60 + right.minute - target);
  })[0]!;
}

function spreadChoices(pool: Date[], zone: string): Date[] {
  const unique = [...new Map(pool.map((start) => [start.getTime(), start])).values()]
    .sort((a, b) => a.getTime() - b.getTime());
  const byDay = new Map<string, Date[]>();
  for (const start of unique) {
    const key = ymdKey(start, zone);
    byDay.set(key, [...(byDay.get(key) ?? []), start]);
  }
  const days = [...byDay.keys()];
  const chosen: Date[] = [];
  if (days.length >= 2) {
    const count = Math.min(3, days.length);
    const picked = new Set<string>();
    for (let index = 0; index < count; index += 1) {
      const day = days[Math.round(index * (days.length - 1) / Math.max(count - 1, 1))]!;
      if (picked.has(day)) continue;
      picked.add(day);
      const starts = byDay.get(day);
      if (starts?.[0]) chosen.push(nearestAfternoon(starts, zone));
    }
  }
  const take = (gapMin: number) => {
    for (const start of unique) {
      if (chosen.length >= 3) return;
      if (chosen.some((have) => Math.abs(have.getTime() - start.getTime()) < gapMin * 60_000)) continue;
      chosen.push(start);
    }
  };
  take(90);
  if (chosen.length < 3) take(30);
  return chosen.sort((a, b) => a.getTime() - b.getTime());
}

function numberedLines(text: string): string {
  return [...text.matchAll(/^\d+\. .+$/gm)].map((match) => match[0]).join("\n");
}

export function isOverride(text: string): boolean {
  return /^(?:override|replace(?:\s+it)?|yes,?\s+replace|delete the old(?: one)?)\b[.!]*$/i.test(text.trim());
}

export function isConfusion(text: string): boolean {
  return /^(?:what|huh|wait|sorry|again|repeat|confused|which)(?:\s+one|\s+do you mean)?[.?!]*$|^i don'?t (?:understand|get it)[.?!]*$|^\?+$/i.test(text.trim());
}

export function decideOutgoing(input: {
  next: string | null;
  previous: string | null;
  latestUser: string;
}): string | null {
  if (!input.next) return null;
  const previousSlots = input.previous ? numberedLines(input.previous) : "";
  const nextSlots = numberedLines(input.next);
  const sameList = previousSlots.length > 0 && previousSlots === nextSlots;
  if (!sameList) return input.next;
  if (isConfusion(input.latestUser)) return `Here they are again:\n${input.next}`;
  const conflicts = input.next.split("\n").filter((line) => line.includes("conflicts with") && !input.previous!.includes(line));
  if (conflicts.length > 0) return conflicts.join("\n");
  return null;
}
