-- 14B-2 night interruption state.
-- Run in Supabase SQL editor before enabling the live night interruption flow.
-- If world_sleep_state_cheng.status has a check constraint, extend it to allow:
--   interrupted_awake

create table if not exists world_night_interruptions_cheng (
  id uuid primary key default gen_random_uuid(),
  sleep_session_id text not null,
  event_type text not null check (event_type in ('dream_wake', 'morning_erection')),
  status text not null default 'scheduled' check (status in ('scheduled', 'triggered', 'resolved', 'cancelled')),
  phase text,
  scheduled_world_time text,
  scheduled_minute integer,
  triggered_world_time text,
  triggered_at timestamptz,
  dream_id uuid,
  dream_type text,
  recall_level text,
  recalled_content text,
  body_intensity text check (body_intensity is null or body_intensity in ('mild', 'obvious', 'strong')),
  sleep_depth text check (sleep_depth is null or sleep_depth in ('light', 'drowsy', 'heavy')),
  minutes_to_alarm integer,
  user_presence_snapshot jsonb,
  cheng_location_snapshot text,
  user_location_snapshot text,
  user_sleeping boolean,
  decision text,
  sleepiness_value integer check (sleepiness_value is null or (sleepiness_value >= 0 and sleepiness_value <= 100)),
  arousal_value integer check (arousal_value is null or (arousal_value >= 0 and arousal_value <= 100)),
  direct_round integer not null default 0,
  direct_total_rounds integer,
  last_decay_at timestamptz,
  resolved_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists world_night_interruptions_one_live
  on world_night_interruptions_cheng (sleep_session_id)
  where status in ('triggered', 'resolved');

create unique index if not exists world_night_interruptions_one_scheduled
  on world_night_interruptions_cheng (sleep_session_id)
  where status = 'scheduled';

alter table world_night_interruptions_cheng enable row level security;

drop policy if exists night_interruptions_select on world_night_interruptions_cheng;
create policy night_interruptions_select on world_night_interruptions_cheng
  for select using (true);

drop policy if exists night_interruptions_insert on world_night_interruptions_cheng;
create policy night_interruptions_insert on world_night_interruptions_cheng
  for insert with check (true);

drop policy if exists night_interruptions_update on world_night_interruptions_cheng;
create policy night_interruptions_update on world_night_interruptions_cheng
  for update using (true) with check (true);
