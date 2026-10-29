"""Builds the Thai sales report HTML from report-data JSON.

Usage: build.py DATA_JSON OUT_HTML [PREV_JSON]

DATA_JSON is the answer of the report-data Edge Function for the report's
range; PREV_JSON (optional) is the same for the period before, for comparison.
"""
import datetime
import html
import json
import os
import sys

FONT_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'fonts')
TH_MONTH = ['มกราคม', 'กุมภาพันธ์', 'มีนาคม', 'เมษายน', 'พฤษภาคม', 'มิถุนายน',
            'กรกฎาคม', 'สิงหาคม', 'กันยายน', 'ตุลาคม', 'พฤศจิกายน', 'ธันวาคม']
TH_M = ['ม.ค.', 'ก.พ.', 'มี.ค.', 'เม.ย.', 'พ.ค.', 'มิ.ย.', 'ก.ค.', 'ส.ค.', 'ก.ย.', 'ต.ค.', 'พ.ย.', 'ธ.ค.']
TH_D = ['จ.', 'อ.', 'พ.', 'พฤ.', 'ศ.', 'ส.', 'อา.']
TH_DL = ['จันทร์', 'อังคาร', 'พุธ', 'พฤหัสบดี', 'ศุกร์', 'เสาร์', 'อาทิตย์']
PAYMENT_NAMES = {'Cash': 'เงินสด (Cash)'}

STORE = 'Tranquila'  # used when Loyverse returns no store name
ACC, BAR, INK, GRID, SUB = '#0f766e', '#93c9c0', '#17201f', '#e3ebe9', '#5b6866'


def dt(s):
    return datetime.date.fromisoformat(s)


def thdate(s, year=True):
    x = dt(s)
    return f'{x.day} {TH_M[x.month - 1]}' + (f' {x.year + 543}' if year else '')


def baht(v, dec=2):
    s = f'{v:,.{dec}f}'
    if dec and s.endswith('.00'):
        s = s[:-3]
    return '฿' + s


def esc(s):
    return html.escape(str(s))


def pct(part, whole):
    return part / whole * 100 if whole else 0


def bars(rows, w, h, label, value, highlight, fmt_y=lambda v: f'{v / 1000:g}k' if v >= 1000 else str(int(v))):
    left, bottom, top = 34, 20, 8
    vmax = max([value(r) for r in rows] + [0]) or 1
    step = next(s for s in (100, 200, 500, 1000, 2000, 4000, 5000, 10000, 20000, 50000, 100000) if vmax / s <= 6)
    ymax = (int(vmax // step) + 1) * step
    bw = (w - left - 4) / max(1, len(rows))
    y = lambda v: top + (h - top - bottom) * (1 - v / ymax)
    out = [f'<svg viewBox="0 0 {w} {h}" width="100%" xmlns="http://www.w3.org/2000/svg">']
    t = 0
    while t <= ymax:
        out.append(f'<line x1="{left}" x2="{w - 4}" y1="{y(t):.1f}" y2="{y(t):.1f}" stroke="{GRID}" stroke-width="0.6"/>')
        out.append(f'<text x="{left - 5}" y="{y(t) + 3:.1f}" font-size="7.5" text-anchor="end" fill="{SUB}">{fmt_y(t)}</text>')
        t += step
    for i, r in enumerate(rows):
        x = left + i * bw + bw * 0.15
        v = value(r)
        if v > 0:
            out.append(f'<rect x="{x:.1f}" y="{y(v):.1f}" width="{bw * 0.7:.1f}" height="{y(0) - y(v):.1f}" rx="1.5" '
                       f'fill="{ACC if highlight(r) else BAR}"/>')
        text = label(r)
        if text:
            out.append(f'<text x="{x + bw * 0.35:.1f}" y="{h - 6}" font-size="7.5" text-anchor="middle" fill="{SUB}">{esc(text)}</text>')
    out.append('</svg>')
    return ''.join(out)


def build(d, prev=None):
    S, P = d['summary'], d['profit']
    daily, hourly = d['daily'], d['hourly']
    start, end = d['start'], d['end']
    s0, s1 = dt(start), dt(end)
    whole_month = s0.day == 1 and (s1 + datetime.timedelta(days=1)).day == 1 and s0.month == s1.month
    period = f'ประจำเดือน{TH_MONTH[s0.month - 1]} {s0.year + 543}' if whole_month else f'{thdate(start)} – {thdate(end)}'
    ndays = len(daily)

    sales, bills = S['sales'], S['bills']
    avg_bill = sales / bills if bills else 0
    avg_day = sales / S['days_open'] if S['days_open'] else 0
    gross = sales + S['refund_money']
    best = max(daily, key=lambda r: r[1]) if daily else None

    wk = {i: [] for i in range(7)}
    for day, v, _ in daily:
        if v > 0:
            wk[dt(day).weekday()].append(v)
    wkavg = [(i, sum(v) / len(v) if v else 0, len(v)) for i, v in wk.items()]
    open_wd = [w for w in wkavg if w[2] >= 2]
    best_wd = max(open_wd, key=lambda x: x[1]) if open_wd else None
    low_wd = min(open_wd, key=lambda x: x[1]) if open_wd else None
    closed_wd = [TH_DL[i] for i, _, n in wkavg if n == 0]
    low_days = [r for r in daily if 0 < r[1] < avg_day * 0.25]

    peak_hours = sorted(hourly, key=lambda r: -r[1])[:4]
    peak = sum(r[1] for r in peak_hours)
    quiet = min((r for r in hourly if r[1] > 0 and min(h[0] for h in peak_hours) > r[0] > hourly[0][0]),
                key=lambda r: r[1], default=None) if hourly else None

    payments = [(PAYMENT_NAMES.get(m, m), a, b) for m, a, b in d['payments']]
    items = d['items']
    known = P['known_sales']
    gp = known - P['known_cost']

    findings = []
    if S['days_open']:
        line = f'เปิดขาย {S["days_open"]} วันจาก {ndays} วัน เฉลี่ยวันละ <b>{baht(avg_day, 0)}</b>'
        if closed_wd:
            line += f' ไม่มีขายวัน{"/".join(closed_wd)}'
        findings.append(line)
    # skip the comparison while the earlier period is mostly before the shop had data
    if prev and prev['summary']['sales'] > 0 and prev['summary']['days_open'] * 2 >= S['days_open']:
        ps = prev['summary']['sales']
        ch = pct(sales - ps, ps)
        findings.append(f'ยอดขาย<b>{"เพิ่มขึ้น" if ch >= 0 else "ลดลง"} {abs(ch):.1f}%</b> เทียบกับช่วงก่อนหน้า '
                        f'({thdate(prev["start"], False)} – {thdate(prev["end"])}: {baht(ps, 0)})')
    if hourly and sales:
        hrs = sorted(r[0] for r in peak_hours)
        line = f'4 ชั่วโมงที่ขายดีที่สุด ({", ".join(f"{h:02d}:00" for h in hrs)}) ทำยอด <b>{pct(peak, sales):.0f}%</b> ของทั้งช่วง'
        if quiet:
            line += f' ส่วน {quiet[0]:02d}:00 เงียบที่สุดระหว่างวัน'
        findings.append(line)
    if best_wd and low_wd and best_wd != low_wd:
        findings.append(f'วัน<b>{TH_DL[best_wd[0]]}</b>ขายดีที่สุด เฉลี่ย {baht(best_wd[1], 0)}/วัน '
                        f'วัน{TH_DL[low_wd[0]]}ต่ำสุด เฉลี่ย {baht(low_wd[1], 0)}/วัน')
    if best and best[1] > 0:
        line = f'วันที่ขายดีที่สุดคือ <b>{thdate(best[0])}</b> {baht(best[1], 0)} ({best[2]} บิล)'
        if low_days:
            line += ' · วันที่ยอดต่ำผิดปกติ: ' + ', '.join(f'{thdate(r[0], False)} ({baht(r[1], 0)})' for r in low_days)
        findings.append(line)
    if payments and sales:
        findings.append(f'ช่องทางที่ใช้มากที่สุดคือ <b>{esc(payments[0][0])} {pct(payments[0][1], sales):.0f}%</b> ของยอดขาย')
    if items and sales:
        top3 = items[:3]
        findings.append(f'สินค้าขายดี 3 อันดับแรกรวม {baht(sum(i[2] for i in top3), 0)} '
                        f'({pct(sum(i[2] for i in top3), sales):.0f}% ของยอดขาย): ' + ', '.join(esc(i[0]) for i in top3))

    first_label = {daily[0][0]} if daily else set()
    daily_svg = bars(daily, 520, 150,
                     lambda r: thdate(r[0], False) if dt(r[0]).weekday() == 0 or r[0] in first_label else '',
                     lambda r: r[1], lambda r: best is not None and r[0] == best[0])
    hour_svg = bars(hourly, 250, 130, lambda r: f'{r[0]:02d}', lambda r: r[1],
                    lambda r: r[0] in {h[0] for h in peak_hours})
    wd_svg = bars(wkavg, 250, 130, lambda r: TH_D[r[0]], lambda r: r[1],
                  lambda r: best_wd is not None and r[0] == best_wd[0])

    item_rows = ''.join(
        f'<tr><td class="n">{i + 1}</td><td>{esc(it[0])}</td><td class="r">{it[1]:,.0f}</td><td class="r">{baht(it[2])}</td>'
        f'<td class="r">{pct(it[2], sales):.1f}%</td>'
        f'<td class="r">{baht(it[3]) if it[3] is not None else "<span class=m>ไม่มีต้นทุน</span>"}</td>'
        f'<td class="r">{f"{pct(it[3], it[2]):.0f}%" if it[3] is not None and it[2] else "–"}</td></tr>'
        for i, it in enumerate(items))
    top15 = sum(it[2] for it in items)
    pay_rows = ''.join(
        f'<div class="pay"><div class="payh"><span>{esc(m)}</span><span>{baht(a)} · {pct(a, sales):.1f}% · {b:,} บิล</span></div>'
        f'<div class="track"><div class="fill" style="width:{max(0, pct(a, sales)):.1f}%;background:{ACC if i == 0 else BAR}"></div></div></div>'
        for i, (m, a, b) in enumerate(payments))
    employees = d.get('employees') or []
    if len(employees) > 1:
        emp_block = ('<div class="card"><h2>ยอดขายตามพนักงาน</h2><table><thead><tr><th>พนักงาน</th><th class="r">ยอดขาย</th>'
                     '<th class="r">บิล</th><th class="r">สัดส่วน</th></tr></thead><tbody>'
                     + ''.join(f'<tr><td>{esc(n)}</td><td class="r">{baht(v)}</td><td class="r">{b:,}</td>'
                               f'<td class="r">{pct(v, sales):.1f}%</td></tr>' for n, v, b in employees)
                     + '</tbody></table></div>')
        emp_note = ''
    else:
        emp_block = ''
        emp_note = (f'<li>ทุกบิลบันทึกโดยพนักงานชื่อ "{esc(employees[0][0])}" คนเดียว จึงไม่ได้แยกยอดตามพนักงาน</li>'
                    if employees else '')

    css = f'''
@font-face {{ font-family: Sarabun; src: url("file://{FONT_DIR}/Sarabun-Regular.ttf"); font-weight: 400; }}
@font-face {{ font-family: Sarabun; src: url("file://{FONT_DIR}/Sarabun-SemiBold.ttf"); font-weight: 600; }}
@page {{ size: A4; margin: 14mm; }}
* {{ box-sizing: border-box; }}
body {{ font-family: Sarabun, sans-serif; color: {INK}; font-size: 10pt; line-height: 1.45; margin: 0; }}
h1 {{ font-size: 20pt; margin: 0; font-weight: 600; }}
h2 {{ font-size: 12pt; margin: 0 0 4px; font-weight: 600; }}
.sub {{ color: {SUB}; font-size: 9.5pt; }}
.head {{ display: flex; justify-content: space-between; align-items: flex-end; border-bottom: 2px solid {INK}; padding-bottom: 8px; margin-bottom: 12px; }}
.kpis {{ display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px; margin-bottom: 12px; }}
.kpi {{ border: 1px solid {GRID}; border-radius: 6px; padding: 8px 10px; }}
.kpi .l {{ font-size: 8.5pt; color: {SUB}; }}
.kpi .v {{ font-size: 16pt; font-weight: 600; font-variant-numeric: tabular-nums; line-height: 1.2; }}
.kpi .s {{ font-size: 8pt; color: {SUB}; }}
.card {{ border: 1px solid {GRID}; border-radius: 6px; padding: 10px 12px; margin-bottom: 10px; break-inside: avoid; }}
.note {{ font-size: 8.5pt; color: {SUB}; margin: 0 0 4px; }}
.two {{ display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }}
ul.f {{ margin: 4px 0 0; padding-left: 16px; }} ul.f li {{ margin-bottom: 3px; }}
table {{ width: 100%; border-collapse: collapse; font-size: 9pt; font-variant-numeric: tabular-nums; }}
th {{ text-align: left; font-weight: 600; font-size: 8.5pt; color: {SUB}; border-bottom: 1px solid {INK}; padding: 3px 4px; }}
td {{ padding: 3px 4px; border-bottom: 1px solid {GRID}; }}
.r {{ text-align: right; white-space: nowrap; }} th.r {{ text-align: right; }}
.n {{ color: {SUB}; width: 18px; }} .m {{ color: #b54708; font-size: 8pt; }}
.pay {{ margin-bottom: 8px; }} .payh {{ display: flex; justify-content: space-between; font-size: 9.5pt; }}
.track {{ height: 8px; background: {GRID}; border-radius: 4px; overflow: hidden; }} .fill {{ height: 100%; border-radius: 4px; }}
.page2 {{ break-before: page; }}
.foot {{ font-size: 8pt; color: {SUB}; border-top: 1px solid {GRID}; padding-top: 6px; margin-top: 8px; }}
'''
    body = f'''
<div class="head"><div><h1>รายงานยอดขาย {esc(d["store"] or STORE)}</h1>
<div class="sub">{period + " · " if whole_month else ""}{thdate(start)} – {thdate(end)} · {ndays} วัน · เวลาไทย</div></div>
<div class="sub" style="text-align:right">ข้อมูลจาก Loyverse<br>ซิงก์ล่าสุด {thdate(d["synced"][:10]) + " " + d["synced"][11:] + " น." if d.get("synced") else "–"}</div></div>

<div class="kpis">
 <div class="kpi"><div class="l">ยอดขายสุทธิ</div><div class="v">{baht(sales)}</div><div class="s">หักคืนเงินแล้ว</div></div>
 <div class="kpi"><div class="l">บิลขาย</div><div class="v">{bills:,}</div><div class="s">คืนเงิน {S["refunds"]} บิล ({baht(S["refund_money"], 0)})</div></div>
 <div class="kpi"><div class="l">เฉลี่ยต่อบิล</div><div class="v">{baht(avg_bill)}</div><div class="s">ยอดสุทธิ ÷ บิลขาย</div></div>
 <div class="kpi"><div class="l">เฉลี่ยต่อวันที่เปิด</div><div class="v">{baht(avg_day, 0)}</div><div class="s">เปิดขาย {S["days_open"]} วัน</div></div>
</div>

<div class="card"><h2>ยอดขายรายวัน</h2><p class="note">แท่งสีเข้มคือวันที่ขายดีที่สุด · ป้ายใต้แกนคือวันจันทร์ของแต่ละสัปดาห์</p>{daily_svg}</div>
<div class="card"><h2>ข้อสังเกตสำคัญ</h2><ul class="f">{"".join(f"<li>{x}</li>" for x in findings) or "<li>ไม่มีบิลขายในช่วงนี้</li>"}</ul></div>
<div class="two">
 <div class="card"><h2>ยอดขายตามชั่วโมง</h2><p class="note">ยอดรวมทั้งช่วง · สีเข้ม = 4 ชั่วโมงที่ขายดีที่สุด</p>{hour_svg}</div>
 <div class="card"><h2>ยอดเฉลี่ยตามวันในสัปดาห์</h2><p class="note">เฉลี่ยเฉพาะวันที่เปิดขาย</p>{wd_svg}</div>
</div>

<div class="page2">
<div class="card"><h2>สินค้าขายดี {len(items)} อันดับ</h2>
<p class="note">รวม {baht(top15, 0)} หรือ {pct(top15, sales):.0f}% ของยอดขาย จากสินค้าที่ขายได้ทั้งหมด {d["item_count"]} รายการ · กำไรคิดจากต้นทุนที่ตั้งไว้ใน Loyverse</p>
<table><thead><tr><th></th><th>สินค้า</th><th class="r">จำนวน</th><th class="r">ยอดขาย</th><th class="r">สัดส่วน</th><th class="r">กำไรขั้นต้น</th><th class="r">% กำไร</th></tr></thead><tbody>{item_rows}</tbody></table></div>
<div class="two">
 <div class="card"><h2>ช่องทางชำระเงิน</h2><p class="note">ยอดรับเงินสุทธิหลังคืนเงิน</p>{pay_rows}</div>
 <div class="card"><h2>กำไรขั้นต้น</h2><p class="note">คิดได้เฉพาะสินค้าที่มีต้นทุนใน Loyverse</p>
  <table><tbody>
   <tr><td>ยอดขายสินค้าที่มีต้นทุน</td><td class="r">{baht(known)}</td></tr>
   <tr><td>ต้นทุนสินค้า</td><td class="r">{baht(P["known_cost"])}</td></tr>
   <tr><td><b>กำไรขั้นต้น</b></td><td class="r"><b>{baht(gp)}</b></td></tr>
   <tr><td>อัตรากำไร</td><td class="r">{pct(gp, known):.1f}%</td></tr>
  </tbody></table>
  <p class="note" style="margin-top:6px">ยอดขายที่มีข้อมูลต้นทุนคิดเป็น <b>{pct(known, P["line_sales"]):.0f}%</b> ของทั้งหมด ส่วนที่เหลือยังไม่ได้ใส่ต้นทุนใน Loyverse จึงยังไม่ใช่กำไรของทั้งร้าน</p>
 </div>
</div>
{emp_block}
<div class="card"><h2>หมายเหตุข้อมูล</h2><ul class="f" style="font-size:9pt">
 <li>ยอดขายสุทธิ = ยอดบิลขาย − ยอดบิลคืนเงิน ไม่นับบิลที่ยกเลิก ยอดก่อนหักคืนเงิน {baht(gross)} คืนเงิน {pct(S["refund_money"], gross):.1f}%</li>
 {emp_note}
 <li>บิลล่าสุดในช่วงนี้: {thdate(d["last_receipt"][:10]) + " " + d["last_receipt"][11:] + " น." if d.get("last_receipt") else "–"}</li>
</ul></div>
<div class="foot">รายงานสร้างอัตโนมัติจากข้อมูลในระบบ Loyverse ของร้าน · ยอดขายสุทธิหักคืนเงินแล้ว</div>
</div>'''
    title = f'รายงานยอดขาย {d["store"] or STORE} {period}'
    page = (f'<!doctype html><html lang="th"><head><meta charset="utf-8"><title>{esc(title)}</title>'
            f'<style>{css}</style></head><body>{body}</body></html>')
    return page, title


if __name__ == '__main__':
    data = json.load(open(sys.argv[1], encoding='utf-8'))
    prev = json.load(open(sys.argv[3], encoding='utf-8')) if len(sys.argv) > 3 else None
    page, title = build(data, prev)
    open(sys.argv[2], 'w', encoding='utf-8').write(page)
    print(title)
