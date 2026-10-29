WITH d AS (SELECT (now() AT TIME ZONE 'Asia/Bangkok')::date AS t),
r AS (SELECT coalesce(CAST({{start}} AS date), d.t - 29) AS d0, coalesce(CAST({{end}} AS date), d.t) AS d1 FROM d),
rs AS (SELECT coalesce(sum(s.net_money), 0) AS sales, count(*) FILTER (WHERE s.receipt_type = 'SALE') AS bills
  FROM loyverse.receipt_sales s CROSS JOIN r WHERE s.local_date BETWEEN r.d0 AND r.d1),
ls AS (SELECT coalesce(sum(l.sales) FILTER (WHERE l.cost_known), 0) AS known_sales,
    coalesce(sum(l.cost) FILTER (WHERE l.cost_known), 0) AS known_cost,
    coalesce(sum(l.sales), 0) AS line_sales
  FROM loyverse.line_sales l CROSS JOIN r WHERE l.local_date BETWEEN r.d0 AND r.d1)
SELECT to_char(r.d0, 'YYYY-MM-DD') AS start_date, to_char(r.d1, 'YYYY-MM-DD') AS end_date, (r.d1 - r.d0 + 1) AS days,
  rs.sales::float AS sales, rs.bills, round(rs.sales / nullif(rs.bills, 0), 2)::float AS avg_bill,
  round((known_sales - known_cost), 2)::float AS gross_profit,
  round((known_sales - known_cost) / nullif(known_sales, 0), 4)::float AS margin,
  round(known_sales / nullif(line_sales, 0), 4)::float AS cost_coverage
FROM r, rs, ls
