WITH d AS (SELECT (now() AT TIME ZONE 'Asia/Bangkok')::date AS t),
r AS (SELECT coalesce(CAST({{start}} AS date), d.t - 29) AS d0, coalesce(CAST({{end}} AS date), d.t) AS d1 FROM d),
hours AS (SELECT generate_series(0, 23) AS hour)
SELECT hours.hour, coalesce(sum(s.net_money), 0)::float AS sales,
  count(s.receipt_number) FILTER (WHERE s.receipt_type = 'SALE') AS bills
FROM hours CROSS JOIN r LEFT JOIN loyverse.receipt_sales s ON s.local_hour = hours.hour AND s.local_date BETWEEN r.d0 AND r.d1
GROUP BY hours.hour ORDER BY hours.hour
