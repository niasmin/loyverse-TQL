# Loyverse — Tranquila

ระบบรายงานยอดขายของ Tranquila จาก Loyverse ใช้รูปแบบเดียวกับ
[loyverse-buildup](https://github.com/niasmin/loyverse-buildup) (มากิน มาม่า)
แต่แยกข้อมูล บัญชี Loyverse และบอท LINE เป็นของ Tranquila เอง

## มีอะไรบ้าง

| ส่วน | ทำอะไร |
| --- | --- |
| `supabase/functions/loyverse-sync` | ดึงสาขา ช่องทางชำระเงิน พนักงาน และบิลจาก Loyverse มาเก็บใน schema `loyverse` ทุก 10 นาที (ครั้งแรกย้อนหลัง 90 วัน) |
| `supabase/functions/line-daily-summary` | ส่งการ์ดสรุปยอดขายประจำวันเข้า LINE ทุกคืน 23:05 |
| `supabase/functions/line-webhook` | จำกลุ่ม LINE ที่บอทถูกเชิญเข้า เจ้าของพิมพ์ `เปิดรายงาน` / `ปิดรายงาน` ในกลุ่มเพื่อเปิดหรือปิดการส่งรายงาน |
| `supabase/functions/report-data` | ส่งตัวเลขของช่วงวันที่ที่ขอ ให้รายงานรายเดือนใช้ |
| `supabase/functions/line-send-report` | อัปโหลด PDF และรูปหน้ารายงานไปที่ bucket `reports` แล้วส่งลิงก์เข้า LINE |
| `scripts/sales-report` + `.github/workflows/monthly-report.yml` | ทุกวันที่ 1 เวลา 08:23 สร้างรายงาน PDF ของเดือนที่แล้วแล้วส่งเข้า LINE (สั่งรันเองเลือกช่วงวันที่ได้) |
| `dashboard/` | หน้าแดชบอร์ดยอดขายและ SQL ที่ใช้ (ใช้ผ่าน Supabase connector ใน claude.ai) |

ยอดขายทั้งหมดคือยอดสุทธิ หักบิลคืนเงินแล้ว ไม่นับบิลที่ยกเลิก เวลาเป็นเวลาไทย

## ติดตั้ง

ใช้ Supabase project แยกของ Tranquila (ไม่ใช้ร่วมกับของมากิน มาม่า เพราะ schema และชื่อฟังก์ชันเหมือนกัน)

1. สร้าง Supabase project ใหม่ แล้วรัน migration ใน `supabase/migrations` ตามลำดับ

   ```bash
   supabase link --project-ref <project-ref>
   ```

   ```bash
   supabase db push
   ```

2. Deploy Edge Functions (`supabase/config.toml` ปิดการตรวจ JWT ไว้แล้ว
   เพราะทุกฟังก์ชันตรวจสิทธิ์ด้วย header `x-sync-key` หรือลายเซ็นของ LINE แทน)

   ```bash
   supabase functions deploy
   ```

3. ตั้ง Secrets ของ Edge Functions (Dashboard → Edge Functions → Secrets)

   | ชื่อ | ค่า |
   | --- | --- |
   | `LOYVERSE_API_TOKEN` | Access token จาก Loyverse หลังร้านของ Tranquila (Settings → Access tokens) |
   | `LINE_CHANNEL_ACCESS_TOKEN` | Channel access token ของบอท LINE ของ Tranquila |
   | `LINE_CHANNEL_SECRET` | Channel secret ของบอทเดียวกัน |
   | `LINE_TO` | LINE user id ของเจ้าของ |

4. บอกที่อยู่ฟังก์ชันให้ cron (ถ้ายังไม่ตั้ง cron จะไม่ทำงาน)

   ```sql
   insert into loyverse.sync_state (key, value)
   values ('functions_url', 'https://<project-ref>.supabase.co/functions/v1');
   ```

5. ตั้ง Webhook URL ของบอทใน LINE Developers เป็น
   `https://<project-ref>.supabase.co/functions/v1/line-webhook` แล้วเปิด "Use webhook"
   และ "Allow bot to join group chats"

6. ตั้ง GitHub Actions secrets ของ repo นี้สำหรับรายงานรายเดือน

   | ชื่อ | ค่า |
   | --- | --- |
   | `SUPABASE_URL` | `https://<project-ref>.supabase.co` |
   | `LOYVERSE_SYNC_KEY` | ผลของ `select value from loyverse.sync_state where key = 'sync_key'` |

## ใช้งาน

- **ส่งรายงานเข้ากลุ่ม LINE:** เชิญบอทเข้ากลุ่ม แล้วเจ้าของพิมพ์ `เปิดรายงาน` ในกลุ่มนั้น
  พิมพ์ `ปิดรายงาน` เพื่อหยุด
- **ไม่ส่งเข้าแชทส่วนตัวของเจ้าของ (ส่งเฉพาะกลุ่ม):**

  ```sql
  insert into loyverse.sync_state (key, value) values ('send_to_owner', 'false')
  on conflict (key) do update set value = excluded.value;
  ```

- **รายงานของช่วงวันที่อื่น:** GitHub → Actions → Monthly sales report → Run workflow แล้วใส่วันที่เริ่มและวันที่สิ้นสุด
- **สรุปรายวันของวันอื่น:** เรียก `line-daily-summary` พร้อม body `{"date": "YYYY-MM-DD"}`
- **กำไรขั้นต้น** คิดจากต้นทุนที่ตั้งไว้ใน Loyverse สินค้าที่ยังไม่มีต้นทุนจะแสดงในแดชบอร์ดหัวข้อ "สินค้าที่ยังไม่มีต้นทุน"

Log ของ workflow ไม่พิมพ์ตัวเลขยอดขาย และรายงานที่สร้างไม่ถูกเก็บใน git
