WITH d AS (SELECT (now() AT TIME ZONE 'Asia/Bangkok')::date AS t),
r AS (SELECT coalesce(CAST({{start}} AS date), d.t - 29) AS d0, coalesce(CAST({{end}} AS date), d.t) AS d1 FROM d),
e AS (SELECT s.employee_name AS employee, sum(s.net_money) AS sales, count(*) FILTER (WHERE s.receipt_type = 'SALE') AS bills,
    count(*) FILTER (WHERE s.receipt_type = 'REFUND') AS refunds
  FROM loyverse.receipt_sales s CROSS JOIN r WHERE s.local_date BETWEEN r.d0 AND r.d1 GROUP BY 1)
SELECT employee, sales::float AS sales, bills, refunds, round(sales / nullif(bills, 0), 2)::float AS avg_bill,
  round(sales / nullif(sum(sales) OVER (), 0), 4)::float AS share
FROM e ORDER BY sales DESC, employee
