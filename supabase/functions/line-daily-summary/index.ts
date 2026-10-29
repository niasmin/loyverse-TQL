// Sends a daily sales summary card to LINE through the Messaging API.
// The card stands on its own so it can be forwarded to people who have no
// access to the dashboard. Called nightly by pg_cron (see migrations);
// refreshes Loyverse data first.
//
// Secrets: LINE_CHANNEL_ACCESS_TOKEN, LINE_TO (the owner's LINE user id).
// Also sent to every active group in loyverse.line_targets; the owner's own chat
// is skipped when loyverse.sync_state.send_to_owner is 'false'.
// Auth: the caller must send `x-sync-key` matching loyverse.sync_state.sync_key.
// Body (optional): {"date": "YYYY-MM-DD"} to summarise another day; default is today in Bangkok.
import postgres from "npm:postgres@3.4.5";

const sql = postgres(Deno.env.get("SUPABASE_DB_URL")!, { prepare: false, max: 1 });

const PAYMENT_NAMES: Record<string, string> = { Cash: "เงินสด" };
const STORE = "Tranquila"; // used when Loyverse returns no store name
const C = { ink: "#17201F", sub: "#5B6866", line: "#E3EBE9", accent: "#0F766E", up: "#15803D", down: "#B91C1C" };

const baht = (n: number, dec = 2) =>
  "฿" + n.toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: dec });
const thDate = (day: string, opts: Intl.DateTimeFormatOptions) =>
  new Date(day + "T00:00:00Z").toLocaleDateString("th-TH", { ...opts, timeZone: "UTC" });
const cleanName = (s: string) => s.replace(/\s+/g, " ").trim();

type Summary = {
  store: string; day: string; sales: number; bills: number; refunds: number;
  lastWeek: number; monthSales: number; monthBills: number;
  pays: { method: string; amount: number }[];
  items: { item: string; qty: number; sales: number }[];
  peakHour: number | null;
};

async function load(day: string): Promise<Summary> {
  const [s] = await sql`
    select
      coalesce(sum(net_money) filter (where local_date = ${day}::date), 0)::float as sales,
      count(*) filter (where local_date = ${day}::date and receipt_type = 'SALE')::int as bills,
      count(*) filter (where local_date = ${day}::date and receipt_type = 'REFUND')::int as refunds,
      coalesce(sum(net_money) filter (where local_date = ${day}::date - 7), 0)::float as last_week,
      coalesce(sum(net_money) filter (where local_date between date_trunc('month', ${day}::date)::date and ${day}::date), 0)::float as month_sales,
      count(*) filter (where local_date between date_trunc('month', ${day}::date)::date and ${day}::date and receipt_type = 'SALE')::int as month_bills,
      (select string_agg(name, ', ' order by name) from loyverse.stores) as store
    from loyverse.receipt_sales`;
  const pays = await sql`
    select coalesce(p->>'name', 'ไม่ระบุ') as method,
      sum(case when receipt_type = 'REFUND' then -(p->>'money_amount')::numeric else (p->>'money_amount')::numeric end)::float as amount
    from loyverse.receipt_sales, jsonb_array_elements(payments) p
    where cancelled_at is null and local_date = ${day}::date
    group by 1 order by amount desc`;
  const items = await sql`
    select item, sum(qty)::float as qty, sum(sales)::float as sales
    from loyverse.line_sales where local_date = ${day}::date
    group by item order by sales desc, item limit 3`;
  const [peak] = await sql`
    select local_hour from loyverse.receipt_sales where local_date = ${day}::date
    group by 1 order by sum(net_money) desc limit 1`;
  return {
    store: s.store ?? STORE, day, sales: s.sales, bills: s.bills, refunds: s.refunds,
    lastWeek: s.last_week, monthSales: s.month_sales, monthBills: s.month_bills,
    pays: pays.map((p) => ({ method: PAYMENT_NAMES[p.method] ?? p.method, amount: p.amount })),
    items: items.map((i) => ({ item: cleanName(i.item), qty: i.qty, sales: i.sales })),
    peakHour: peak?.local_hour ?? null,
  };
}

const text = (t: string, o: Record<string, unknown> = {}) => ({ type: "text", text: t, wrap: true, color: C.ink, size: "sm", ...o });
const row = (left: string, right: string, o: Record<string, unknown> = {}) => ({
  type: "box", layout: "horizontal", spacing: "md",
  contents: [text(left, { flex: 5, color: C.sub, ...o }), text(right, { flex: 4, align: "end", ...o })],
});
const section = (title: string, contents: unknown[]) => ({
  type: "box", layout: "vertical", spacing: "xs", margin: "lg",
  contents: [text(title, { weight: "bold", size: "sm" }), ...contents],
});

function comparison(s: Summary): { label: string; color: string } | null {
  if (s.lastWeek <= 0 || s.sales <= 0) return null;
  const diff = s.sales - s.lastWeek;
  const pct = Math.abs(diff / s.lastWeek * 100).toFixed(1);
  const weekday = thDate(s.day, { weekday: "long" });
  return {
    label: `${diff >= 0 ? "▲ มากกว่า" : "▼ น้อยกว่า"}${weekday}ที่แล้ว ${pct}% (${weekday}ที่แล้ว ${baht(s.lastWeek, 0)})`,
    color: diff >= 0 ? C.up : C.down,
  };
}

function card(s: Summary) {
  const fullDate = thDate(s.day, { weekday: "long", day: "numeric", month: "long", year: "numeric" });
  const monthName = thDate(s.day, { month: "long" });
  const dayOfMonth = Number(s.day.slice(8, 10));
  const cmp = comparison(s);
  const body: unknown[] = [];

  if (s.bills === 0 && s.sales === 0) {
    body.push(text("วันนี้ไม่มีบิลขาย", { size: "md", margin: "md" }));
  } else {
    body.push(
      text("ยอดขายวันนี้", { color: C.sub, size: "xs", margin: "md" }),
      text(baht(s.sales), { size: "3xl", weight: "bold", color: C.accent }),
      text(`${s.bills.toLocaleString("en-US")} บิล · เฉลี่ยบิลละ ${baht(s.bills ? s.sales / s.bills : 0)}`, { color: C.sub }),
    );
    if (cmp) body.push(text(cmp.label, { color: cmp.color, size: "xs", margin: "sm" }));
    body.push({ type: "separator", margin: "lg", color: C.line });

    if (s.pays.length) {
      body.push(section("รับเงินผ่าน", s.pays.map((p) =>
        row(p.method, `${baht(p.amount)} (${s.sales ? Math.round(p.amount / s.sales * 100) : 0}%)`))));
    }
    if (s.items.length) {
      body.push(section("ขายดีวันนี้", s.items.map((it, i) =>
        row(`${i + 1}. ${it.item}`, `${it.qty.toLocaleString("en-US")} ชิ้น · ${baht(it.sales, 0)}`))));
    }
    if (s.peakHour !== null) {
      const h = String(s.peakHour).padStart(2, "0");
      body.push(section("ช่วงที่ขายดีที่สุด", [text(`${h}:00–${h}:59 น.`, { color: C.sub })]));
    }
    if (s.refunds > 0) body.push(section("คืนเงิน", [text(`${s.refunds} บิล (หักออกจากยอดแล้ว)`, { color: C.sub })]));
  }

  body.push(
    { type: "separator", margin: "lg", color: C.line },
    section(`ยอดสะสมเดือน${monthName} (1–${dayOfMonth})`, [
      row("ยอดขาย", baht(s.monthSales)),
      row("จำนวนบิล", `${s.monthBills.toLocaleString("en-US")} บิล`),
    ]),
  );

  return {
    type: "bubble",
    size: "mega",
    header: {
      type: "box", layout: "vertical", paddingBottom: "sm",
      contents: [
        text(`${s.store} · สรุปยอดขายประจำวัน`, { weight: "bold", size: "md" }),
        text(fullDate, { color: C.sub, size: "xs" }),
      ],
    },
    body: { type: "box", layout: "vertical", paddingTop: "none", contents: body },
    footer: {
      type: "box", layout: "vertical",
      contents: [text("ยอดขายสุทธิ หักคืนเงินแล้ว ไม่นับบิลยกเลิก · ข้อมูลจากระบบ Loyverse ของร้าน", { size: "xxs", color: C.sub })],
    },
  };
}

// Plain-text version: shown in notifications and chat lists, and by LINE versions without card support.
function altText(s: Summary): string {
  const date = thDate(s.day, { weekday: "short", day: "numeric", month: "short" });
  if (s.bills === 0 && s.sales === 0) return `${s.store} ${date}: ไม่มีบิลขาย`;
  return `${s.store} ${date}: ยอดขาย ${baht(s.sales)} (${s.bills} บิล)`.slice(0, 400);
}

Deno.serve(async (req) => {
  const [state] = await sql`select value from loyverse.sync_state where key = 'sync_key'`;
  const key = req.headers.get("x-sync-key");
  if (!key || key !== state?.value) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }

  const token = Deno.env.get("LINE_CHANNEL_ACCESS_TOKEN");
  const to = Deno.env.get("LINE_TO");
  if (!token || !to) {
    return Response.json({ ok: false, error: "LINE_CHANNEL_ACCESS_TOKEN or LINE_TO is not set" }, { status: 500 });
  }

  const body = await req.json().catch(() => ({})) as { date?: string };
  const [{ today }] = await sql`select to_char((now() at time zone 'Asia/Bangkok')::date, 'YYYY-MM-DD') as today`;
  const day = body.date && /^\d{4}-\d{2}-\d{2}$/.test(body.date) ? body.date : today;

  // pick up the last bills of the day before summarising
  const syncUrl = new URL("/functions/v1/loyverse-sync", Deno.env.get("SUPABASE_URL")!);
  await fetch(syncUrl, { method: "POST", headers: { "x-sync-key": key } }).catch(() => undefined);

  const summary = await load(day);
  const messages = [{ type: "flex", altText: altText(summary), contents: card(summary) }];
  // every group the owner switched on (see line-webhook), plus the owner's own chat
  // unless loyverse.sync_state.send_to_owner is 'false'
  const groups = await sql`select id from loyverse.line_targets where active order by joined_at`;
  const [owner] = await sql`select value from loyverse.sync_state where key = 'send_to_owner'`;
  const targets = [...(owner?.value === "false" ? [] : [to]), ...groups.map((g) => g.id as string)];
  const failed: { to: string; status: number; error: string }[] = [];
  for (const target of targets) {
    const res = await fetch("https://api.line.me/v2/bot/message/push", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ to: target, messages }),
    });
    if (!res.ok) failed.push({ to: target, status: res.status, error: await res.text() });
  }
  if (failed.length) {
    return Response.json({ ok: false, day, sent: targets.length - failed.length, failed }, { status: 502 });
  }
  return Response.json({ ok: true, day, sent: targets.length });
});
