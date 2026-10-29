WITH d AS (SELECT (now() AT TIME ZONE 'Asia/Bangkok')::date AS t),
r AS (SELECT coalesce(CAST({{start}} AS date), d.t - 29) AS d0, coalesce(CAST({{end}} AS date), d.t) AS d1 FROM d),
p AS (
  SELECT coalesce(pm->>'name', 'ไม่ระบุ') AS method,
    sum(CASE WHEN s.receipt_type = 'REFUND' THEN -(pm->>'money_amount')::numeric ELSE (pm->>'money_amount')::numeric END) AS amount,
    count(DISTINCT s.receipt_number) AS bills
  FROM loyverse.receipt_sales s CROSS JOIN r CROSS JOIN jsonb_array_elements(s.payments) pm
  WHERE s.cancelled_at IS NULL AND s.local_date BETWEEN r.d0 AND r.d1
  GROUP BY 1
)
SELECT method, amount::float AS amount, bills, round(amount / nullif(sum(amount) OVER (), 0), 4)::float AS share
FROM p ORDER BY amount DESC
