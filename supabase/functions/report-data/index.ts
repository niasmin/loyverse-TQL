// Returns the figures for a sales report over a date range (Bangkok dates).
// Used by the monthly report workflow (.github/workflows/monthly-report.yml).
//
// Auth: the caller must send `x-sync-key` matching loyverse.sync_state.sync_key.
// Query: ?start=YYYY-MM-DD&end=YYYY-MM-DD (inclusive).
import postgres from "npm:postgres@3.4.5";

const sql = postgres(Deno.env.get("SUPABASE_DB_URL")!, { prepare: false, max: 1 });
const DATE = /^\d{4}-\d{2}-\d{2}$/;

Deno.serve(async (req) => {
  const [state] = await sql`select value from loyverse.sync_state where key = 'sync_key'`;
  const key = req.headers.get("x-sync-key");
  if (!key || key !== state?.value) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }
  const url = new URL(req.url);
  const start = url.searchParams.get("start") ?? "";
  const end = url.searchParams.get("end") ?? "";
  if (!DATE.test(start) || !DATE.test(end) || start > end) {
    return Response.json({ error: "start and end must be YYYY-MM-DD with start <= end" }, { status: 400 });
  }

  const [row] = await sql`
    with s as (select * from loyverse.receipt_sales where local_date between ${start}::date and ${end}::date),
    l as (select * from loyverse.line_sales where local_date between ${start}::date and ${end}::date)
    select json_build_object(
      'start', ${start}::text, 'end', ${end}::text,
      'store', (select string_agg(name, ', ' order by name) from loyverse.stores),
      'summary', (select json_build_object(
          'sales', coalesce(sum(net_money), 0)::float,
          'bills', count(*) filter (where receipt_type = 'SALE'),
          'refunds', count(*) filter (where receipt_type = 'REFUND'),
          'refund_money', coalesce(-sum(net_money) filter (where receipt_type = 'REFUND'), 0)::float,
          'days_open', count(distinct local_date) filter (where receipt_type = 'SALE')) from s),
      'profit', (select json_build_object(
          'known_sales', coalesce(sum(sales) filter (where cost_known), 0)::float,
          'known_cost', coalesce(sum(cost) filter (where cost_known), 0)::float,
          'line_sales', coalesce(sum(sales), 0)::float) from l),
      'daily', (select json_agg(json_build_array(to_char(g, 'YYYY-MM-DD'),
          coalesce((select sum(net_money) from s where local_date = g::date), 0)::float,
          (select count(*) from s where local_date = g::date and receipt_type = 'SALE')) order by g)
        from generate_series(${start}::date, ${end}::date, interval '1 day') g),
      'hourly', (select coalesce(json_agg(json_build_array(local_hour, v, b) order by local_hour), '[]')
        from (select local_hour, sum(net_money)::float v, count(*) filter (where receipt_type = 'SALE') b from s group by 1) h),
      'payments', (select coalesce(json_agg(json_build_array(m, a, b) order by a desc), '[]')
        from (select coalesce(p->>'name', 'ไม่ระบุ') m,
                sum(case when receipt_type = 'REFUND' then -1 else 1 end * (p->>'money_amount')::numeric)::float a,
                count(distinct receipt_number) b
              from s, jsonb_array_elements(payments) p where cancelled_at is null group by 1) q),
      'items', (select coalesce(json_agg(json_build_array(item, qty, sales, profit) order by sales desc), '[]')
        from (select regexp_replace(trim(item), '[[:space:]]+', ' ', 'g') item, sum(qty)::float qty, sum(sales)::float sales,
                case when bool_and(cost_known) then sum(sales - cost)::float end profit
              from l group by 1 order by 3 desc limit 15) x),
      'item_count', (select count(distinct item) from l),
      'employees', (select coalesce(json_agg(json_build_array(employee_name, v, b) order by v desc), '[]')
        from (select employee_name, sum(net_money)::float v, count(*) filter (where receipt_type = 'SALE') b from s group by 1) e),
      'synced', (select to_char(max(finished_at) at time zone 'Asia/Bangkok', 'YYYY-MM-DD HH24:MI') from loyverse.sync_log where status = 'ok'),
      'last_receipt', (select to_char(max(receipt_date) at time zone 'Asia/Bangkok', 'YYYY-MM-DD HH24:MI') from s)
    ) as report`;
  return Response.json(row.report);
});
