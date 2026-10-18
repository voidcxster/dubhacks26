import postgres from "postgres";
import { env } from "./env.ts";
import type { Range } from "./scheduling/slots.ts";

export const sql = postgres(env.databaseUrl, {
  ssl: "require",
  max: 5,
  idle_timeout: 20,
  connect_timeout: 10,
});

const schema = `
create extension if not exists btree_gist;

create table if not exists people (
  id uuid primary key default gen_random_uuid(),
  phone text unique not null,
  display_name text,
  timezone text not null default 'America/Los_Angeles',
  google_email text,
  google_refresh_token text,
  created_at timestamptz not null default now()
);

create table if not exists threads (
  id uuid primary key default gen_random_uuid(),
  photon_space_id text unique not null,
  title text,
  timezone text not null default 'America/Los_Angeles'
);

create table if not exists thread_members (
  thread_id uuid not null references threads(id) on delete cascade,
  person_id uuid not null references people(id) on delete cascade,
  primary key (thread_id, person_id)
);

create table if not exists messages (
  id uuid not null default gen_random_uuid(),
  thread_id uuid not null references threads(id) on delete cascade,
  person_id uuid references people(id),
  photon_message_id text,
  body text,
  sent_at timestamptz not null default now(),
  raw jsonb,
  primary key (id, sent_at)
);

create index if not exists messages_thread_sent on messages (thread_id, sent_at desc);

create table if not exists facts (
  id uuid primary key default gen_random_uuid(),
  thread_id uuid references threads(id) on delete cascade,
  person_id uuid references people(id),
  kind text not null,
  durability text not null check (durability in ('ephemeral', 'durable')),
  payload jsonb not null default '{}',
  valid_until timestamptz,
  created_at timestamptz not null default now()
);

create table if not exists plans (
  id uuid primary key default gen_random_uuid(),
  thread_id uuid not null references threads(id) on delete cascade,
  title text not null,
  status text not null,
  duration_minutes int not null,
  timezone text not null,
  locus text not null,
  poll_message_guid text,
  created_at timestamptz not null default now()
);

create table if not exists windows (
  id uuid primary key default gen_random_uuid(),
  person_id uuid references people(id),
  thread_id uuid references threads(id) on delete cascade,
  plan_id uuid references plans(id) on delete cascade,
  during tstzrange not null,
  kind text not null check (kind in ('free', 'busy')),
  source text not null check (source in ('chat', 'google', 'booked')),
  point boolean not null default false,
  open_ended boolean not null default false
);

create index if not exists windows_gist on windows using gist (person_id, during);

create table if not exists plan_options (
  id uuid primary key default gen_random_uuid(),
  plan_id uuid not null references plans(id) on delete cascade,
  option_identifier text,
  label text not null,
  start_at timestamptz not null,
  end_at timestamptz not null,
  stated_count int not null default 0
);

create table if not exists votes (
  plan_option_id uuid not null references plan_options(id) on delete cascade,
  person_id uuid not null references people(id),
  selected boolean not null,
  updated_at timestamptz not null default now(),
  primary key (plan_option_id, person_id)
);

create table if not exists events (
  id uuid primary key default gen_random_uuid(),
  plan_id uuid not null references plans(id) on delete cascade,
  title text not null,
  start_at timestamptz not null,
  end_at timestamptz not null,
  template_url text,
  google_event_id text,
  html_link text,
  owner_person_id uuid references people(id)
);
`;

export async function migrate(): Promise<void> {
  await sql.unsafe(schema);
  await sql`
    do $$ begin
      perform create_hypertable('messages', 'sent_at', if_not_exists => true);
    exception when others then
      raise notice 'hypertable skipped: %', sqlerrm;
    end $$;
  `;
}

export type Person = {
  id: string;
  phone: string;
  display_name: string | null;
  google_email: string | null;
  google_refresh_token: string | null;
};

export async function upsertPerson(phone: string, displayName?: string | null): Promise<Person> {
  const [row] = await sql<Person[]>`
    insert into people (phone, display_name)
    values (${phone}, ${displayName ?? null})
    on conflict (phone) do update set
      display_name = coalesce(excluded.display_name, people.display_name)
    returning id, phone, display_name, google_email, google_refresh_token
  `;
  if (!row) throw new Error(`Failed to upsert ${phone}`);
  return row;
}

export async function upsertThread(spaceId: string): Promise<{ id: string; timezone: string }> {
  const [row] = await sql<{ id: string; timezone: string }[]>`
    insert into threads (photon_space_id)
    values (${spaceId})
    on conflict (photon_space_id) do update set photon_space_id = excluded.photon_space_id
    returning id, timezone
  `;
  if (!row) throw new Error("Failed to upsert thread");
  return row;
}

export async function addMember(threadId: string, personId: string): Promise<void> {
  await sql`
    insert into thread_members (thread_id, person_id)
    values (${threadId}, ${personId})
    on conflict do nothing
  `;
}

export async function insertMessage(input: {
  threadId: string;
  personId: string | null;
  photonId: string;
  body: string;
  sentAt: Date;
}): Promise<void> {
  await sql`
    insert into messages (thread_id, person_id, photon_message_id, body, sent_at)
    values (${input.threadId}, ${input.personId}, ${input.photonId}, ${input.body}, ${input.sentAt})
  `;
}

export async function recentMessages(threadId: string): Promise<{ phone: string | null; body: string; sent_at: Date }[]> {
  return sql`
    select p.phone, m.body, m.sent_at
    from messages m
    left join people p on p.id = m.person_id
    where m.thread_id = ${threadId}
    order by m.sent_at desc
    limit 30
  `;
}

export async function recentSpeakerIds(threadId: string): Promise<string[]> {
  const rows = await sql<{ person_id: string }[]>`
    select distinct person_id
    from messages
    where thread_id = ${threadId}
      and person_id is not null
      and sent_at > now() - interval '30 minutes'
  `;
  return rows.map((row) => row.person_id);
}

export async function threadMembers(threadId: string): Promise<Person[]> {
  return sql<Person[]>`
    select p.id, p.phone, p.display_name, p.google_email, p.google_refresh_token
    from thread_members tm
    join people p on p.id = tm.person_id
    where tm.thread_id = ${threadId}
  `;
}

export async function recordWindow(input: {
  personId: string;
  threadId: string;
  start: Date;
  end: Date;
  kind: "free" | "busy";
  point: boolean;
  open: boolean;
}): Promise<void> {
  await sql`
    delete from windows
    where person_id = ${input.personId}
      and thread_id = ${input.threadId}
      and source = 'chat'
      and kind = ${input.kind}
      and during && tstzrange(${input.start}, ${input.end}, '[)')
  `;
  await sql`
    insert into windows (person_id, thread_id, during, kind, source, point, open_ended)
    values (
      ${input.personId},
      ${input.threadId},
      tstzrange(${input.start}, ${input.end}, '[)'),
      ${input.kind},
      'chat',
      ${input.point},
      ${input.open}
    )
  `;
}

export async function googleBackedEvents(personId: string): Promise<{ plan_id: string; google_event_id: string }[]> {
  return sql<{ plan_id: string; google_event_id: string }[]>`
    select plan_id, google_event_id
    from events
    where owner_person_id = ${personId}
      and google_event_id is not null
      and end_at > now() - interval '1 day'
  `;
}

export async function forgetOverlappingBusy(personId: string, start: Date, end: Date): Promise<void> {
  const plans = await sql<{ plan_id: string | null }[]>`
    select distinct plan_id
    from windows
    where person_id = ${personId}
      and source = 'booked'
      and plan_id is not null
      and during && tstzrange(${start}, ${end}, '[)')
  `;
  for (const plan of plans) {
    if (plan.plan_id) await forgetBooking(plan.plan_id);
  }
  await sql`
    delete from windows
    where person_id = ${personId}
      and kind = 'busy'
      and during && tstzrange(${start}, ${end}, '[)')
  `;
}

export async function retirePlan(planId: string): Promise<void> {
  await sql`update plans set status = 'replaced' where id = ${planId}`;
}

export async function forgetBooking(planId: string): Promise<void> {
  await sql`delete from windows where plan_id = ${planId} and source = 'booked'`;
  await sql`
    delete from facts
    where kind = 'booking'
      and payload->>'planId' = ${planId}
  `;
  await sql`update events set google_event_id = null where plan_id = ${planId}`;
}

export async function replaceGoogleBusy(personId: string, threadId: string, blocks: { start: Date; end: Date }[]): Promise<void> {
  await sql`delete from windows where person_id = ${personId} and source = 'google'`;
  for (const block of blocks) {
    await sql`
      insert into windows (person_id, thread_id, during, kind, source, point, open_ended)
      values (
        ${personId},
        ${threadId},
        tstzrange(${block.start}, ${block.end}, '[)'),
        'busy',
        'google',
        false,
        false
      )
    `;
  }
}

export async function loadRanges(threadId: string, personIds: string[]): Promise<Range[]> {
  if (personIds.length === 0) return [];
  const rows = await sql<{
    person_id: string;
    display_name: string | null;
    phone: string;
    kind: "free" | "busy";
    source: "chat" | "google" | "booked";
    point: boolean;
    open_ended: boolean;
    start_at: Date;
    end_at: Date;
  }[]>`
    select w.person_id, p.display_name, p.phone, w.kind, w.source, w.point, w.open_ended,
           lower(w.during) as start_at, upper(w.during) as end_at
    from windows w
    join people p on p.id = w.person_id
    where w.person_id in ${sql(personIds)}
      and (w.source in ('google', 'booked') or w.thread_id = ${threadId})
      and upper(w.during) > now() - interval '1 day'
  `;
  return rows.flatMap((row) => {
    if (!row.start_at || !row.end_at) return [];
    return [{
      personId: row.person_id,
      personName: row.display_name || row.phone,
      kind: row.kind,
      source: row.source,
      point: row.point,
      open: row.open_ended,
      start: new Date(row.start_at),
      end: new Date(row.end_at),
    }];
  });
}

export async function rememberFact(input: {
  threadId: string;
  personId: string | null;
  kind: string;
  durability: "ephemeral" | "durable";
  payload: unknown;
  validUntil: Date | null;
}): Promise<void> {
  await sql`
    insert into facts (thread_id, person_id, kind, durability, payload, valid_until)
    values (
      ${input.threadId},
      ${input.personId},
      ${input.kind},
      ${input.durability},
      ${sql.json(input.payload as postgres.JSONValue)},
      ${input.validUntil}
    )
  `;
}

export async function activeFacts(threadId: string): Promise<{ kind: string; payload: unknown; phone: string | null }[]> {
  return sql`
    select f.kind, f.payload, p.phone
    from facts f
    left join people p on p.id = f.person_id
    where f.thread_id = ${threadId}
      and (f.valid_until is null or f.valid_until > now())
    order by f.created_at desc
    limit 40
  `;
}

export type PlanRow = {
  id: string;
  title: string;
  status: string;
  duration_minutes: number;
  locus: string;
  poll_message_guid: string | null;
  thread_id: string;
};

export async function openPlan(threadId: string): Promise<PlanRow | null> {
  const [row] = await sql<PlanRow[]>`
    select id, title, status, duration_minutes, locus, poll_message_guid, thread_id
    from plans
    where thread_id = ${threadId} and status = 'proposed'
    order by created_at desc
    limit 1
  `;
  return row ?? null;
}

export async function createPlan(input: {
  threadId: string;
  title: string;
  durationMin: number;
  locus: string;
  options: { label: string; start: Date; end: Date; yes: number }[];
}): Promise<string> {
  const [plan] = await sql<{ id: string }[]>`
    insert into plans (thread_id, title, status, duration_minutes, timezone, locus)
    values (${input.threadId}, ${input.title}, 'proposed', ${input.durationMin}, 'America/Los_Angeles', ${input.locus})
    returning id
  `;
  if (!plan) throw new Error("Failed to create plan");
  for (const option of input.options) {
    await sql`
      insert into plan_options (plan_id, label, start_at, end_at, stated_count)
      values (${plan.id}, ${option.label}, ${option.start}, ${option.end}, ${option.yes})
    `;
  }
  return plan.id;
}

export async function getPlanOption(optionId: string): Promise<{
  id: string;
  plan_id: string;
  label: string;
  start_at: Date;
  end_at: Date;
} | null> {
  const [row] = await sql<{
    id: string;
    plan_id: string;
    label: string;
    start_at: Date;
    end_at: Date;
  }[]>`
    select id, plan_id, label, start_at, end_at
    from plan_options
    where id = ${optionId}
  `;
  return row ?? null;
}

export async function attachPoll(planId: string, guid: string | undefined, options: { title: string; optionIdentifier?: string }[]): Promise<void> {
  if (guid) {
    await sql`update plans set poll_message_guid = ${guid} where id = ${planId}`;
  }
  for (const option of options) {
    if (!option.optionIdentifier) continue;
    await sql`
      update plan_options
      set option_identifier = ${option.optionIdentifier}
      where plan_id = ${planId} and label = ${option.title}
    `;
  }
}

export async function findOption(input: {
  spaceId: string;
  pollGuid?: string;
  optionIdentifier?: string;
  label: string;
}): Promise<{ planId: string; optionId: string; threadId: string } | null> {
  const [row] = await sql<{ plan_id: string; option_id: string; thread_id: string }[]>`
    select p.id as plan_id, o.id as option_id, p.thread_id
    from plan_options o
    join plans p on p.id = o.plan_id
    join threads t on t.id = p.thread_id
    where t.photon_space_id = ${input.spaceId}
      and (
        (${input.optionIdentifier ?? null}::text is not null and o.option_identifier = ${input.optionIdentifier ?? null})
        or o.label = ${input.label}
        or (${input.pollGuid ?? null}::text is not null and p.poll_message_guid = ${input.pollGuid ?? null} and o.label = ${input.label})
      )
    order by p.created_at desc
    limit 1
  `;
  return row ? { planId: row.plan_id, optionId: row.option_id, threadId: row.thread_id } : null;
}

export async function recordVote(planId: string, optionId: string, personId: string, selected: boolean): Promise<void> {
  await sql`
    update votes v
    set selected = false, updated_at = now()
    from plan_options o
    where v.plan_option_id = o.id
      and o.plan_id = ${planId}
      and v.person_id = ${personId}
  `;
  await sql`
    insert into votes (plan_option_id, person_id, selected)
    values (${optionId}, ${personId}, ${selected})
    on conflict (plan_option_id, person_id) do update
      set selected = excluded.selected, updated_at = now()
  `;
}

export async function selectedVoters(planId: string): Promise<string[]> {
  const rows = await sql<{ person_id: string }[]>`
    select distinct v.person_id
    from votes v
    join plan_options o on o.id = v.plan_option_id
    where o.plan_id = ${planId} and v.selected = true
  `;
  return rows.map((row) => row.person_id);
}

export async function winningOption(planId: string): Promise<{
  id: string;
  label: string;
  start_at: Date;
  end_at: Date;
  stated_count: number;
  votes: number;
} | null> {
  const [row] = await sql<{
    id: string;
    label: string;
    start_at: Date;
    end_at: Date;
    stated_count: number;
    votes: number;
  }[]>`
    select o.id, o.label, o.start_at, o.end_at, o.stated_count,
           count(v.person_id) filter (where v.selected)::int as votes
    from plan_options o
    left join votes v on v.plan_option_id = o.id
    where o.plan_id = ${planId}
    group by o.id
    order by votes desc, o.stated_count desc, o.start_at asc
    limit 1
  `;
  if (!row || row.votes < 1) return null;
  return row;
}

export async function replaceProposed(threadId: string): Promise<void> {
  await sql`
    update plans set status = 'replaced'
    where thread_id = ${threadId} and status = 'proposed'
  `;
}

export async function latestProposal(threadId: string): Promise<{
  id: string;
  title: string;
  duration_minutes: number;
  locus: string;
  options: { id: string; label: string; start_at: Date; end_at: Date }[];
} | null> {
  const plan = await openPlan(threadId);
  if (!plan) return null;
  const options = await sql<{ id: string; label: string; start_at: Date; end_at: Date }[]>`
    select id, label, start_at, end_at
    from plan_options
    where plan_id = ${plan.id}
    order by case when label = 'Override' then 1 else 0 end, start_at
  `;
  return {
    id: plan.id,
    title: plan.title,
    duration_minutes: plan.duration_minutes,
    locus: plan.locus,
    options,
  };
}

export async function markBooked(planId: string): Promise<boolean> {
  const rows = await sql`
    update plans set status = 'booked'
    where id = ${planId} and status = 'proposed'
    returning id
  `;
  return rows.length > 0;
}

export async function saveEvent(input: {
  planId: string;
  title: string;
  start: Date;
  end: Date;
  templateUrl: string;
  googleEventId: string | null;
  htmlLink: string | null;
  ownerPersonId: string | null;
}): Promise<string> {
  const [row] = await sql<{ id: string }[]>`
    insert into events (plan_id, title, start_at, end_at, template_url, google_event_id, html_link, owner_person_id)
    values (
      ${input.planId},
      ${input.title},
      ${input.start},
      ${input.end},
      ${input.templateUrl},
      ${input.googleEventId},
      ${input.htmlLink},
      ${input.ownerPersonId}
    )
    returning id
  `;
  if (!row) throw new Error("Failed to save event");
  return row.id;
}

export async function rememberBooking(input: {
  threadId: string;
  planId: string;
  start: Date;
  end: Date;
  personIds: string[];
}): Promise<void> {
  for (const personId of input.personIds) {
    await sql`
      insert into windows (person_id, thread_id, plan_id, during, kind, source, point, open_ended)
      values (
        ${personId},
        ${input.threadId},
        ${input.planId},
        tstzrange(${input.start}, ${input.end}, '[)'),
        'busy',
        'booked',
        false,
        false
      )
    `;
  }
  await sql`
    insert into facts (thread_id, kind, durability, payload)
    values (
      ${input.threadId},
      'booking',
      'durable',
      ${sql.json({ planId: input.planId, start: input.start.toISOString(), end: input.end.toISOString() })}
    )
  `;
}

export async function getEvent(id: string): Promise<{
  title: string;
  start_at: Date;
  end_at: Date;
} | null> {
  const [row] = await sql<{ title: string; start_at: Date; end_at: Date }[]>`
    select title, start_at, end_at from events where id = ${id}
  `;
  return row ?? null;
}

export async function saveGoogleConnection(personId: string, refreshToken: string, email: string | null): Promise<void> {
  await sql`
    update people
    set google_refresh_token = ${refreshToken},
        google_email = coalesce(${email}, google_email)
    where id = ${personId}
  `;
}

export async function getPerson(id: string): Promise<Person | null> {
  const [row] = await sql<Person[]>`
    select id, phone, display_name, google_email, google_refresh_token
    from people where id = ${id}
  `;
  return row ?? null;
}

export async function getPlan(id: string): Promise<PlanRow | null> {
  const [row] = await sql<PlanRow[]>`
    select id, title, status, duration_minutes, locus, poll_message_guid, thread_id
    from plans where id = ${id}
  `;
  return row ?? null;
}

export async function yesVoters(optionId: string): Promise<string[]> {
  const rows = await sql<{ person_id: string }[]>`
    select person_id from votes where plan_option_id = ${optionId} and selected = true
  `;
  return rows.map((row) => row.person_id);
}
