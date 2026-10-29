// Sends a report to LINE: page images inline plus a download link for the PDF.
// LINE's Messaging API has no file message, so files go to the private `reports`
// storage bucket and LINE gets signed URLs.
//
// Secrets: LINE_CHANNEL_ACCESS_TOKEN, LINE_TO (the owner's LINE user id).
// Also sent to every active group in loyverse.line_targets; the owner's own chat
// is skipped when loyverse.sync_state.send_to_owner is 'false'.
// Auth: the caller must send `x-sync-key` matching loyverse.sync_state.sync_key.
// Body: multipart form with `title`, `pdf` (one file), `page` (page images, in order)
// and matching `preview` images (small JPEGs, at most 1 MB each).
import postgres from "npm:postgres@3.4.5";
import { createClient } from "npm:@supabase/supabase-js@2.45.4";

const sql = postgres(Deno.env.get("SUPABASE_DB_URL")!, { prepare: false, max: 1 });
const storage = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!).storage;

const PDF_LINK_DAYS = 30;
const IMAGE_LINK_DAYS = 365;

async function upload(folder: string, file: File): Promise<string> {
  const path = `${folder}/${file.name}`;
  const { error } = await storage.from("reports").upload(path, file, { contentType: file.type, upsert: true });
  if (error) throw new Error(`upload ${path}: ${error.message}`);
  return path;
}

async function signedUrl(path: string, days: number): Promise<string> {
  const { data, error } = await storage.from("reports").createSignedUrl(path, days * 86_400);
  if (error || !data) throw new Error(`sign ${path}: ${error?.message}`);
  return data.signedUrl;
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

  try {
    const form = await req.formData();
    const title = String(form.get("title") ?? "รายงาน");
    const pdf = form.get("pdf") as File | null;
    const pages = form.getAll("page") as File[];
    const previews = form.getAll("preview") as File[];
    if (!pdf || pages.length === 0 || pages.length !== previews.length || pages.length > 3) {
      return Response.json({ ok: false, error: "need one pdf and 1-3 page/preview pairs" }, { status: 400 });
    }

    const folder = pdf.name.replace(/\.pdf$/i, "");
    const pdfUrl = await signedUrl(await upload(folder, pdf), PDF_LINK_DAYS);
    const images = [];
    for (let i = 0; i < pages.length; i++) {
      images.push({
        type: "image",
        originalContentUrl: await signedUrl(await upload(folder, pages[i]), IMAGE_LINK_DAYS),
        previewImageUrl: await signedUrl(await upload(folder, previews[i]), IMAGE_LINK_DAYS),
      });
    }

    const text = `📄 ${title}\n\nดาวน์โหลด PDF (ลิงก์ใช้ได้ ${PDF_LINK_DAYS} วัน):\n${pdfUrl}`;
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
        body: JSON.stringify({ to: target, messages: [{ type: "text", text }, ...images] }),
      });
      if (!res.ok) failed.push({ to: target, status: res.status, error: await res.text() });
    }
    if (failed.length) {
      return Response.json({ ok: false, sent: targets.length - failed.length, failed }, { status: 502 });
    }
    return Response.json({ ok: true, pages: pages.length, sent: targets.length });
  } catch (e) {
    return Response.json({ ok: false, error: (e as Error).message }, { status: 500 });
  }
});
