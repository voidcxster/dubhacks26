export const ZONE = "America/Los_Angeles";

export function addMinutes(date: Date, minutes: number): Date {
  return new Date(date.getTime() + minutes * 60_000);
}

export function ymd(date: Date, zone = ZONE): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: zone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

function shiftYmd(day: string, days: number): string {
  const [year, month, date] = day.split("-").map(Number);
  const shifted = new Date(Date.UTC(year!, (month ?? 1) - 1, (date ?? 1) + days));
  return shifted.toISOString().slice(0, 10);
}

export function localParts(date: Date, zone = ZONE): { hour: number; minute: number } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: zone,
    hourCycle: "h23",
    hour: "2-digit",
    minute: "2-digit",
  }).formatToParts(date);
  const read = (type: string) => Number(parts.find((part) => part.type === type)?.value ?? "0");
  const hour = read("hour");
  return { hour: hour === 24 ? 0 : hour, minute: read("minute") };
}

export function clock(date: Date, zone = ZONE): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: zone,
    hour: "numeric",
    minute: "2-digit",
  })
    .format(date)
    .replace(/\u202f/g, " ");
}

export function dayLabel(start: Date, now: Date, zone = ZONE): string {
  const startDay = ymd(start, zone);
  const today = ymd(now, zone);
  if (startDay === today) return "Today";
  if (startDay === shiftYmd(today, 1)) return "Tomorrow";
  return new Intl.DateTimeFormat("en-US", {
    timeZone: zone,
    weekday: "short",
    month: "short",
    day: "numeric",
  }).format(start);
}

export function optionLabel(start: Date, now: Date, zone = ZONE): string {
  const deltaMin = (start.getTime() - now.getTime()) / 60_000;
  if (deltaMin >= -5 && deltaMin <= 15) return "Right now";
  return `${dayLabel(start, now, zone)} ${clock(start, zone)}`;
}

export function googleUtc(date: Date): string {
  return date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

export function icsStamp(date: Date): string {
  return googleUtc(date);
}
