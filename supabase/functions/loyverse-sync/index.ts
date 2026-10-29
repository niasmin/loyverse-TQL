// Pulls stores, payment types, employees and receipts from the Loyverse API into the
// `loyverse` schema. Called every 10 minutes by pg_cron (see migrations).
//
// Secrets: LOYVERSE_API_TOKEN (set in Supabase dashboard -> Edge Functions -> Secrets).
// Auth: the caller must send `x-sync-key` matching loyverse.sync_state.sync_key.
import postgres from "npm:postgres@3.4.5";

const API = "https://api.loyverse.com/v1.0";
const BACKFILL_DAYS = 90;
const TIME_BUDGET_MS = 110_000;

const sql = postgres(Deno.env.get("SUPABASE_DB_URL")!, { prepare: false, max: 1 });

type Json = Record<string, unknown>;

async function loyverse(path: string, params: Record<string, string> = {}): Promise<Json> {
  const token = Deno.env.get("LOYVERSE_API_TOKEN");
  if (!token) throw new Error("LOYVERSE_API_TOKEN is not set");
  const url = new URL(API + path);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);

  for (let attempt = 1; ; attempt++) {
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (res.status === 429 && attempt < 4) {
      const wait = Number(res.headers.get("retry-after") ?? attempt * 2);
      await new Promise((r) => setTimeout(r, wait * 1000));
      continue;
    }
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = (body as { errors?: { code?: string; details?: string }[] }).errors?.[0];
      const e = new Error(`Loyverse ${res.status} ${err?.code ?? ""}: ${err?.details ?? res.statusText}`);
      (e as Error & { code?: string }).code = err?.code;
      throw e;
    }
    return body as Json;
  }
}

async function getState(key: string): Promise<string | null> {
  const rows = await sql`select value from loyverse.sync_state where key = ${key}`;
  return rows[0]?.value ?? null;
}

async function setState(key: string, value: string | null) {
  await sql`
    insert into loyverse.sync_state (key, value, updated_at) values (${key}, ${value}, now())
    on conflict (key) do update set value = excluded.value, updated_at = now()`;
}

async function syncList(path: string, listKey: string, upsert: (rows: Json[]) => Promise<void>) {
  let cursor: string | undefined;
  do {
    const page = await loyverse(path, cursor ? { cursor } : {});
    await upsert((page[listKey] as Json[]) ?? []);
    cursor = (page.cursor as string) || undefined;
  } while (cursor);
}

async function syncReference() {
  await syncList("/stores", "stores", async (rows) => {
    for (const s of rows) {
      await sql`
        insert into loyverse.stores (id, name, raw, synced_at)
        values (${s.id as string}, ${(s.name as string) ?? ""}, ${sql.json(s)}, now())
        on conflict (id) do update set name = excluded.name, raw = excluded.raw, synced_at = now()`;
    }
  });
  await syncList("/payment_types", "payment_types", async (rows) => {
    for (const p of rows) {
      await sql`
        insert into loyverse.payment_types (id, name, type, raw, synced_at)
        values (${p.id as string}, ${(p.name as string) ?? ""}, ${(p.type as string) ?? null}, ${sql.json(p)}, now())
        on conflict (id) do update set name = excluded.name, type = excluded.type, raw = excluded.raw, synced_at = now()`;
    }
  });
  await syncList("/employees", "employees", async (rows) => {
    for (const e of rows) {
      await sql`
        insert into loyverse.employees (id, name, raw, synced_at)
        values (${e.id as string}, ${(e.name as string) ?? ""}, ${sql.json(e)}, now())
        on conflict (id) do update set name = excluded.name, raw = excluded.raw, synced_at = now()`;
    }
  });
}

async function upsertReceipts(rows: Json[]) {
  for (const r of rows) {
    await sql`
      insert into loyverse.receipts (
        receipt_number, receipt_type, store_id, employee_id, customer_id, receipt_date,
        updated_at, cancelled_at, total_money, total_discount, total_tax, line_items, payments, raw, synced_at
      ) values (
        ${r.receipt_number as string}, ${r.receipt_type as string}, ${(r.store_id as string) ?? null},
        ${(r.employee_id as string) ?? null}, ${(r.customer_id as string) ?? null},
        ${(r.receipt_date ?? r.created_at) as string}, ${(r.updated_at as string) ?? null},
        ${(r.cancelled_at as string) ?? null}, ${Number(r.total_money ?? 0)},
        ${Number(r.total_discount ?? 0)}, ${Number(r.total_tax ?? 0)},
        ${sql.json((r.line_items as Json[]) ?? [])}, ${sql.json((r.payments as Json[]) ?? [])},
        ${sql.json(r)}, now()
      )
      on conflict (receipt_number) do update set
        receipt_type = excluded.receipt_type, store_id = excluded.store_id,
        employee_id = excluded.employee_id, customer_id = excluded.customer_id,
        receipt_date = excluded.receipt_date, updated_at = excluded.updated_at,
        cancelled_at = excluded.cancelled_at, total_money = excluded.total_money,
        total_discount = excluded.total_discount, total_tax = excluded.total_tax,
        line_items = excluded.line_items, payments = excluded.payments,
        raw = excluded.raw, synced_at = now()`;
  }
}

// Receipts are fetched in windows by updated_at. The watermark only moves
// forward once a whole window is done; an unfinished window resumes from
// its saved cursor on the next run.
async function syncReceipts(deadline: number): Promise<{ count: number; done: boolean }> {
  let windowStart = await getState("receipts_window_start");
  let windowEnd = await getState("receipts_window_end");
  let cursor = await getState("receipts_cursor");

  if (!windowStart || !windowEnd) {
    const watermark = await getState("receipts_watermark");
    windowStart = watermark ?? new Date(Date.now() - BACKFILL_DAYS * 86_400_000).toISOString();
    windowEnd = new Date().toISOString();
    cursor = null;
    await setState("receipts_window_start", windowStart);
    await setState("receipts_window_end", windowEnd);
  }

  let count = 0;
  while (true) {
    let page: Json;
    try {
      page = await loyverse("/receipts", {
        updated_at_min: windowStart,
        updated_at_max: windowEnd,
        limit: "250",
        ...(cursor ? { cursor } : {}),
      });
    } catch (e) {
      if ((e as { code?: string }).code === "INVALID_CURSOR" && cursor) {
        cursor = null; // cursor expired: redo this window from the start (upserts are idempotent)
        await setState("receipts_cursor", null);
        continue;
      }
      throw e;
    }
    const rows = (page.receipts as Json[]) ?? [];
    await upsertReceipts(rows);
    count += rows.length;
    cursor = (page.cursor as string) || null;
    await setState("receipts_cursor", cursor);

    if (!cursor) {
      // overlap one minute so receipts updated at the boundary are never missed
      await setState("receipts_watermark", new Date(Date.parse(windowEnd) - 60_000).toISOString());
      await setState("receipts_window_start", null);
      await setState("receipts_window_end", null);
      return { count, done: true };
    }
    if (Date.now() > deadline) return { count, done: false };
  }
}

Deno.serve(async (req) => {
  const key = req.headers.get("x-sync-key");
  if (!key || key !== (await getState("sync_key"))) {
    return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 });
  }

  const deadline = Date.now() + TIME_BUDGET_MS;
  const [lock] = await sql`select pg_try_advisory_lock(hashtext('loyverse-sync')) as ok`;
  if (!lock.ok) return Response.json({ ok: true, skipped: "another sync is running" });

  const [log] = await sql`insert into loyverse.sync_log default values returning id`;
  try {
    await syncReference();
    const { count, done } = await syncReceipts(deadline);
    await sql`
      update loyverse.sync_log set finished_at = now(), receipts_upserted = ${count},
        status = ${done ? "ok" : "partial"} where id = ${log.id}`;
    return Response.json({ ok: true, receipts: count, done });
  } catch (e) {
    const message = (e as Error).message;
    await sql`update loyverse.sync_log set finished_at = now(), status = 'error', message = ${message} where id = ${log.id}`;
    return Response.json({ ok: false, error: message }, { status: 500 });
  } finally {
    await sql`select pg_advisory_unlock(hashtext('loyverse-sync'))`;
  }
});
