WITH d AS (SELECT (now() AT TIME ZONE 'Asia/Bangkok')::date AS t),
r AS (SELECT coalesce(CAST({{start}} AS date), d.t - 29) AS d0, coalesce(CAST({{end}} AS date), d.t) AS d1 FROM d)
SELECT l.item, sum(l.qty)::float AS qty, sum(l.sales)::float AS sales,
  CASE WHEN bool_and(l.cost_known) THEN round(sum(l.sales - l.cost), 2)::float END AS profit,
  CASE WHEN bool_and(l.cost_known) THEN round(sum(l.sales - l.cost) / nullif(sum(l.sales), 0), 4)::float END AS margin
FROM loyverse.line_sales l CROSS JOIN r WHERE l.local_date BETWEEN r.d0 AND r.d1
GROUP BY l.item ORDER BY sales DESC, l.item LIMIT 15
