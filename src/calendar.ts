import { createHmac, timingSafeEqual } from "node:crypto";
import { env, oauthRedirectUri } from "./env.ts";
import { googleUtc, icsStamp } from "./time.ts";

const scopes = [
  "https://www.googleapis.com/auth/calendar.freebusy",
  "https://www.googleapis.com/auth/calendar.events",
].join(" ");

export function signState(personId: string): string {
  const body = Buffer.from(JSON.stringify({ personId, exp: Date.now() + 60 * 60_000 })).toString("base64url");
  const sig = createHmac("sha256", env.projectSecret).update(body).digest("base64url");
  return `${body}.${sig}`;
}

export function readState(state: string): string | null {
  const [body, sig] = state.split(".");
  if (!body || !sig) return null;
  const expected = createHmac("sha256", env.projectSecret).update(body).digest("base64url");
  const left = Buffer.from(sig);
  const right = Buffer.from(expected);
  if (left.length !== right.length || !timingSafeEqual(left, right)) return null;
  const parsed = JSON.parse(Buffer.from(body, "base64url").toString()) as { personId?: string; exp?: number };
  if (!parsed.personId || !parsed.exp || parsed.exp < Date.now()) return null;
  return parsed.personId;
}

export function authUrl(personId: string): string {
  const params = new URLSearchParams({
    client_id: env.googleClientId,
    redirect_uri: oauthRedirectUri,
    response_type: "code",
    scope: scopes,
    access_type: "offline",
    prompt: "consent",
    state: signState(personId),
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params}`;
}

export async function exchangeCode(code: string): Promise<{ refreshToken: string; accessToken: string }> {
  const body = new URLSearchParams({
    code,
    client_id: env.googleClientId,
    client_secret: env.googleClientSecret,
    redirect_uri: oauthRedirectUri,
    grant_type: "authorization_code",
  });
  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
  const json = await response.json() as { refresh_token?: string; access_token?: string; error?: string };
  if (!response.ok || !json.refresh_token || !json.access_token) {
    throw new Error(json.error || "Google did not return a refresh token");
  }
  return { refreshToken: json.refresh_token, accessToken: json.access_token };
}

const tokens = new Map<string, { token: string; exp: number }>();

export async function accessToken(personId: string, refreshToken: string): Promise<string> {
  const cached = tokens.get(personId);
  if (cached && cached.exp > Date.now() + 30_000) return cached.token;
  const body = new URLSearchParams({
    client_id: env.googleClientId,
    client_secret: env.googleClientSecret,
    refresh_token: refreshToken,
    grant_type: "refresh_token",
  });
  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
  const json = await response.json() as { access_token?: string; expires_in?: number; error?: string };
  if (!response.ok || !json.access_token) throw new Error(json.error || "Google token refresh failed");
  tokens.set(personId, { token: json.access_token, exp: Date.now() + (json.expires_in ?? 3000) * 1000 });
  return json.access_token;
}

export async function primaryEmail(token: string): Promise<string | null> {
  const response = await fetch("https://www.googleapis.com/calendar/v3/calendars/primary", {
    headers: { authorization: `Bearer ${token}` },
  });
  if (!response.ok) return null;
  const json = await response.json() as { id?: string };
  return json.id ?? null;
}

export async function freeBusy(token: string, start: Date, end: Date): Promise<{ start: Date; end: Date }[]> {
  const response = await fetch("https://www.googleapis.com/calendar/v3/freeBusy", {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      timeMin: start.toISOString(),
      timeMax: end.toISOString(),
      items: [{ id: "primary" }],
    }),
  });
  if (!response.ok) return [];
  const json = await response.json() as {
    calendars?: { primary?: { busy?: { start: string; end: string }[] } };
  };
  return (json.calendars?.primary?.busy ?? []).map((block) => ({
    start: new Date(block.start),
    end: new Date(block.end),
  }));
}

export async function insertEvent(input: {
  token: string;
  title: string;
  start: Date;
  end: Date;
  attendees: string[];
}): Promise<{ id: string; htmlLink: string } | null> {
  const response = await fetch("https://www.googleapis.com/calendar/v3/calendars/primary/events", {
    method: "POST",
    headers: {
      authorization: `Bearer ${input.token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      summary: input.title,
      start: { dateTime: input.start.toISOString(), timeZone: env.timezone },
      end: { dateTime: input.end.toISOString(), timeZone: env.timezone },
      attendees: input.attendees.map((email) => ({ email })),
    }),
  });
  if (!response.ok) return null;
  const json = await response.json() as { id?: string; htmlLink?: string };
  if (!json.id || !json.htmlLink) return null;
  return { id: json.id, htmlLink: json.htmlLink };
}

export function templateUrl(title: string, start: Date, end: Date): string {
  const params = new URLSearchParams({
    action: "TEMPLATE",
    text: title,
    dates: `${googleUtc(start)}/${googleUtc(end)}`,
  });
  return `https://calendar.google.com/calendar/render?${params}`;
}

export function ics(title: string, start: Date, end: Date, id: string): string {
  const stamp = icsStamp(new Date());
  return [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//secretary//EN",
    "BEGIN:VEVENT",
    `UID:${id}@secretary`,
    `DTSTAMP:${stamp}`,
    `DTSTART:${icsStamp(start)}`,
    `DTEND:${icsStamp(end)}`,
    `SUMMARY:${title.replaceAll("\n", " ")}`,
    "END:VEVENT",
    "END:VCALENDAR",
    "",
  ].join("\r\n");
}
