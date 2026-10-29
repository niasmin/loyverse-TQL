WITH d AS (SELECT (now() AT TIME ZONE 'Asia/Bangkok')::date AS t, (now() AT TIME ZONE 'Asia/Bangkok')::time AS tod),
s AS (SELECT r.local_date, r.net_money, r.receipt_type, r.receipt_date FROM loyverse.receipt_sales r),
a AS (
  SELECT t,
    coalesce(sum(net_money) FILTER (WHERE local_date = t), 0) AS today_sales,
    count(*) FILTER (WHERE local_date = t AND receipt_type = 'SALE') AS today_bills,
    coalesce(sum(net_money) FILTER (WHERE local_date = t - 7 AND (receipt_date AT TIME ZONE 'Asia/Bangkok')::time <= tod), 0) AS today_base,
    coalesce(sum(net_money) FILTER (WHERE local_date = t - 1), 0) AS yesterday_sales,
    count(*) FILTER (WHERE local_date = t - 1 AND receipt_type = 'SALE') AS yesterday_bills,
    coalesce(sum(net_money) FILTER (WHERE local_date = t - 8), 0) AS yesterday_base,
    coalesce(sum(net_money) FILTER (WHERE local_date > t - 7), 0) AS week_sales,
    count(*) FILTER (WHERE local_date > t - 7 AND receipt_type = 'SALE') AS week_bills,
    coalesce(sum(net_money) FILTER (WHERE local_date > t - 14 AND local_date <= t - 7), 0) AS week_base,
    coalesce(sum(net_money) FILTER (WHERE local_date >= date_trunc('month', t)::date), 0) AS month_sales,
    count(*) FILTER (WHERE local_date >= date_trunc('month', t)::date AND receipt_type = 'SALE') AS month_bills,
    coalesce(sum(net_money) FILTER (WHERE local_date >= (date_trunc('month', t) - interval '1 month')::date AND local_date <= (t - interval '1 month')::date), 0) AS month_base,
    max(receipt_date) AS last_receipt
  FROM s CROSS JOIN d GROUP BY t
)
SELECT
  today_sales::float AS today_sales, today_bills, round(CASE WHEN today_base <= 0 OR today_base * 20 < today_sales THEN NULL ELSE (today_sales - today_base) / today_base END, 4)::float AS today_change,
  yesterday_sales::float AS yesterday_sales, yesterday_bills, round(CASE WHEN yesterday_base <= 0 OR yesterday_base * 20 < yesterday_sales THEN NULL ELSE (yesterday_sales - yesterday_base) / yesterday_base END, 4)::float AS yesterday_change,
  week_sales::float AS week_sales, week_bills, round(CASE WHEN week_base <= 0 OR week_base * 20 < week_sales THEN NULL ELSE (week_sales - week_base) / week_base END, 4)::float AS week_change,
  round(week_sales / nullif(week_bills, 0), 2)::float AS week_avg_bill,
  month_sales::float AS month_sales, month_bills, round(CASE WHEN month_base <= 0 OR month_base * 20 < month_sales THEN NULL ELSE (month_sales - month_base) / month_base END, 4)::float AS month_change,
  to_char(last_receipt AT TIME ZONE 'Asia/Bangkok', 'YYYY-MM-DD HH24:MI') AS last_receipt_at,
  (SELECT to_char(max(finished_at) AT TIME ZONE 'Asia/Bangkok', 'YYYY-MM-DD HH24:MI') FROM loyverse.sync_log WHERE status IN ('ok', 'partial')) AS last_sync_at,
  (SELECT string_agg(name, ', ' ORDER BY name) FROM loyverse.stores) AS store_names,
  to_char(t, 'YYYY-MM-DD') AS today
FROM a
