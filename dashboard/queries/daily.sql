WITH d AS (SELECT (now() AT TIME ZONE 'Asia/Bangkok')::date AS t),
days AS (SELECT gs::date AS day FROM d, generate_series(t - 59, t, interval '1 day') gs)
SELECT to_char(days.day, 'YYYY-MM-DD') AS day,
  coalesce(sum(s.net_money), 0)::float AS sales,
  count(s.receipt_number) FILTER (WHERE s.receipt_type = 'SALE') AS bills
FROM days LEFT JOIN loyverse.receipt_sales s ON s.local_date = days.day
GROUP BY days.day ORDER BY days.day
