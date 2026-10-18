import { addMinutes, optionLabel } from "../time.ts";

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
