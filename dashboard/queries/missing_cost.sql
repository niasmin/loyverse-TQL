WITH d AS (SELECT (now() AT TIME ZONE 'Asia/Bangkok')::date AS t),
r AS (SELECT coalesce(CAST({{start}} AS date), d.t - 29) AS d0, coalesce(CAST({{end}} AS date), d.t) AS d1 FROM d)
SELECT l.item, sum(l.qty)::float AS qty, sum(l.sales)::float AS sales
FROM loyverse.line_sales l CROSS JOIN r WHERE l.local_date BETWEEN r.d0 AND r.d1
GROUP BY l.item HAVING NOT bool_or(l.cost_known) ORDER BY sales DESC, l.item LIMIT 20
