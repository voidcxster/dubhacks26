import { authUrl, exchangeCode, ics, primaryEmail, readState } from "./calendar.ts";
import { getEvent, saveGoogleConnection } from "./db.ts";
import { env } from "./env.ts";

export function startServer(): void {
  const url = new URL(env.publicBaseUrl);
  const port = Number(url.port || (url.protocol === "https:" ? 443 : 80));
  Bun.serve({
    port,
    hostname: "0.0.0.0",
    async fetch(request) {
      const path = new URL(request.url).pathname;
      if (path === "/health") return new Response("ok");
      if (path.startsWith("/auth/google")) return redirectToGoogle(request);
      if (path === "/oauth/callback") return callback(request);
      const eventMatch = path.match(/^\/events\/([0-9a-f-]+)\.ics$/);
      if (eventMatch?.[1]) return calendarFile(eventMatch[1]);
      return new Response("Not found", { status: 404 });
    },
  });
  console.log(`oauth listening on ${env.publicBaseUrl}`);
}

function redirectToGoogle(request: Request): Response {
  const personId = readState(new URL(request.url).searchParams.get("state") ?? "");
  if (!personId) return new Response("That connect link expired.", { status: 400 });
  return Response.redirect(authUrl(personId), 302);
}

async function callback(request: Request): Promise<Response> {
  const query = new URL(request.url).searchParams;
  const code = query.get("code");
  const personId = readState(query.get("state") ?? "");
  if (!code || !personId) return new Response("Missing Google authorization.", { status: 400 });
  try {
    const tokens = await exchangeCode(code);
    const email = await primaryEmail(tokens.accessToken);
    await saveGoogleConnection(personId, tokens.refreshToken, email);
    return new Response("Calendar connected. You can return to Messages.");
  } catch (error) {
    const message = error instanceof Error ? error.message : "Google connection failed";
    return new Response(message, { status: 400 });
  }
}

async function calendarFile(id: string): Promise<Response> {
  const event = await getEvent(id);
  if (!event) return new Response("Event not found", { status: 404 });
  return new Response(ics(event.title, new Date(event.start_at), new Date(event.end_at), id), {
    headers: { "content-type": "text/calendar; charset=utf-8" },
  });
}
