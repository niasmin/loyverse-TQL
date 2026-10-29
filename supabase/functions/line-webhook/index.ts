// LINE webhook: tracks the groups the bot is in and lets the owner switch
// reports on or off for a group by typing a command inside it.
//
// Secrets: LINE_CHANNEL_SECRET (signature check), LINE_CHANNEL_ACCESS_TOKEN,
// LINE_TO (the owner's user id; only they can switch a group on).
import postgres from "npm:postgres@3.4.5";

const sql = postgres(Deno.env.get("SUPABASE_DB_URL")!, { prepare: false, max: 1 });
const ON = "เปิดรายงาน";
const OFF = "ปิดรายงาน";

async function validSignature(body: string, signature: string | null): Promise<boolean> {
  const secret = Deno.env.get("LINE_CHANNEL_SECRET");
  if (!secret || !signature) return false;
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body)));
  const expected = btoa(String.fromCharCode(...mac));
  if (expected.length !== signature.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ signature.charCodeAt(i);
  return diff === 0;
}

async function line(path: string, init: RequestInit = {}) {
  return fetch(`https://api.line.me/v2/bot${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${Deno.env.get("LINE_CHANNEL_ACCESS_TOKEN")}`, ...init.headers },
  });
}

const reply = (replyToken: string, text: string) =>
  line("/message/reply", { method: "POST", body: JSON.stringify({ replyToken, messages: [{ type: "text", text }] }) });

async function groupName(kind: string, id: string): Promise<string | null> {
  if (kind !== "group") return null;
  const res = await line(`/group/${id}/summary`);
  return res.ok ? ((await res.json()).groupName ?? null) : null;
}

type Event = {
  type: string;
  replyToken?: string;
  source: { type: string; groupId?: string; roomId?: string; userId?: string };
  message?: { type: string; text?: string };
};

async function handle(e: Event) {
  const kind = e.source.type;
  const id = e.source.groupId ?? e.source.roomId;
  if (!id || (kind !== "group" && kind !== "room")) return;

  if (e.type === "join") {
    const name = await groupName(kind, id);
    await sql`
      insert into loyverse.line_targets (id, kind, name) values (${id}, ${kind}, ${name})
      on conflict (id) do update set name = excluded.name, changed_at = now()`;
    if (e.replyToken) {
      await reply(e.replyToken, `สวัสดีครับ ถ้าต้องการให้ส่งสรุปยอดขายในกลุ่มนี้ ให้เจ้าของบัญชีพิมพ์ "${ON}"`);
    }
  } else if (e.type === "leave") {
    await sql`update loyverse.line_targets set active = false, changed_at = now() where id = ${id}`;
  } else if (e.type === "message" && e.message?.type === "text" && e.replyToken) {
    const text = (e.message.text ?? "").trim();
    if (text !== ON && text !== OFF) return;
    if (e.source.userId !== Deno.env.get("LINE_TO")) {
      await reply(e.replyToken, "คำสั่งนี้ใช้ได้เฉพาะเจ้าของบัญชีครับ");
      return;
    }
    const active = text === ON;
    const name = await groupName(kind, id);
    await sql`
      insert into loyverse.line_targets (id, kind, name, active) values (${id}, ${kind}, ${name}, ${active})
      on conflict (id) do update set active = excluded.active, name = coalesce(excluded.name, loyverse.line_targets.name), changed_at = now()`;
    await reply(e.replyToken, active
      ? "เปิดแล้วครับ กลุ่มนี้จะได้รับสรุปยอดขายทุกคืน 23:05 และรายงานรายเดือนทุกวันที่ 1"
      : "ปิดแล้วครับ กลุ่มนี้จะไม่ได้รับรายงานอีก");
  }
}

Deno.serve(async (req) => {
  const body = await req.text();
  if (!(await validSignature(body, req.headers.get("x-line-signature")))) {
    return new Response("invalid signature", { status: 401 });
  }
  const { events = [] } = JSON.parse(body) as { events?: Event[] };
  for (const e of events) {
    try {
      await handle(e);
    } catch (err) {
      console.error("event failed", e.type, (err as Error).message);
    }
  }
  return new Response("ok");
});
