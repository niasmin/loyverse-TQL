-- The jobs call this project's Edge Functions. Set the URL once after deploying:
--   insert into loyverse.sync_state (key, value)
--   values ('functions_url', 'https://<project-ref>.supabase.co/functions/v1');
-- Until it is set the jobs do nothing.

-- loyverse-sync every 10 minutes
select cron.schedule(
  'loyverse-sync',
  '*/10 * * * *',
  $$
  select net.http_post(
    url := (select value from loyverse.sync_state where key = 'functions_url') || '/loyverse-sync',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-sync-key', (select value from loyverse.sync_state where key = 'sync_key')
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 150000
  )
  where exists (select 1 from loyverse.sync_state where key = 'functions_url' and value is not null);
  $$
);

-- line-daily-summary at 23:05 Asia/Bangkok = 16:05 UTC
select cron.schedule(
  'line-daily-summary',
  '5 16 * * *',
  $$
  select net.http_post(
    url := (select value from loyverse.sync_state where key = 'functions_url') || '/line-daily-summary',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-sync-key', (select value from loyverse.sync_state where key = 'sync_key')
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 150000
  )
  where exists (select 1 from loyverse.sync_state where key = 'functions_url' and value is not null);
  $$
);
