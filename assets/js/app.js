// Renders data/data.json into the page. No dependencies.
(() => {
  'use strict';

  const COUNTIES = [
    { key: 'fulton', name: 'Fulton County' },
    { key: 'hickman', name: 'Hickman County' },
  ];
  const DISTRICTS = [
    { key: 'fulton_county', name: 'Fulton County Schools', county: 'Fulton' },
    { key: 'fulton_independent', name: 'Fulton Independent Schools', county: 'Fulton' },
    { key: 'hickman_county', name: 'Hickman County Schools', county: 'Hickman' },
  ];
  // Validated categorical palette (fixed order; see README "Chart colors").
  const SERIES = [
    { key: 'fulton', name: 'Fulton Co.', color: '#2f5fb3' },
    { key: 'hickman', name: 'Hickman Co.', color: '#e0303c' },
    { key: 'kentucky', name: 'Kentucky', color: '#16998a' },
    { key: 'us', name: 'U.S.', color: '#c27c0e', dash: '6 4' },
  ];
  const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

  let data = { metrics: {} };
  const M = (k) => data.metrics[k];

  // ------------------------------------------------------------ formatting

  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

  function fmt(m) {
    if (!m) return '—';
    const v = m.value;
    switch (m.unit) {
      case 'percent': return `${v.toFixed(1)}%`;
      case 'dollars': return `$${Math.round(v).toLocaleString('en-US')}`;
      case 'years': return v.toFixed(1);
      case 'ratio': return v.toFixed(1);
      case 'fte': return v.toLocaleString('en-US', { maximumFractionDigits: 1 });
      default: return Math.round(v).toLocaleString('en-US');
    }
  }

  function fmtPeriod(p) {
    let m;
    if ((m = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(p))) return `${MONTHS[+m[2] - 1]} ${m[1]}`;
    if ((m = /^(\d{4})-(\d{4})$/.exec(p))) return `${m[1]}–${m[2]}`;
    return p;
  }
  const schoolYear = (p) => p.replace('-', '–');

  // A value cell, visibly marked when stale.
  function cell(m) {
    if (!m) return '<span class="na">Not available</span>';
    const tag = m.stale ? ' <span class="stale-tag" title="Could not be refreshed from the source at the last update; showing the last good value.">Not updated</span>' : '';
    return `<span class="${m.stale ? 'stale' : ''}">${esc(fmt(m))}</span>${tag}`;
  }

  // "As of" line: every distinct source + period among the metrics shown.
  function asOf(metrics, extra = '') {
    const seen = new Map();
    for (const m of metrics.filter(Boolean)) {
      if (!seen.has(m.source)) seen.set(m.source, { source: m.source, url: m.source_url, periods: new Set(), notes: new Set(), stale: false });
      const e = seen.get(m.source);
      e.periods.add(m.period);
      if (m.unit === 'students' || m.unit === 'fte' || m.unit === 'ratio') e.school = true;
      if (m.note === 'preliminary') e.notes.add('preliminary');
      if (m.stale) e.stale = true;
    }
    if (!seen.size) return '';
    const periodText = (e) => {
      const ps = [...e.periods].sort();
      if (e.school) return `${ps.map(schoolYear).join(' and ')} school year${ps.length > 1 ? 's' : ''}`;
      // A run of annual periods collapses to a range: 2020–2025.
      if (ps.length > 1 && ps.every((p) => /^\d{4}$/.test(p))) return `${ps[0]}–${ps[ps.length - 1]}`;
      return ps.map(fmtPeriod).join(', ');
    };
    const parts = [...seen.values()].map((e) =>
      `<a href="${esc(e.url)}">${esc(e.source)}</a>${e.source.includes(periodText(e)) ? '' : `, ${esc(periodText(e))}`}${e.notes.size ? ` (${[...e.notes].join(', ')})` : ''}${e.stale ? ' <span class="stale-tag">Not updated</span>' : ''}`);
    return `<p class="asof"><span class="asof-label">Source:</span> ${parts.join('; ')}.${extra ? ` ${extra}` : ''}</p>`;
  }

  // ------------------------------------------------------------ tables + CSV

  // rows: [{ label, cells: [metric | string] }]; csv: [{ geo, measure, m }]
  function table({ id, caption, head, rows, csv, csvName }) {
    const thead = `<tr>${head.map((h, i) => `<th scope="col"${i ? ' class="num"' : ''}>${esc(h)}</th>`).join('')}</tr>`;
    const tbody = rows.map((r) =>
      `<tr><th scope="row">${esc(r.label)}${r.sub ? `<span class="sub">${esc(r.sub)}</span>` : ''}</th>${r.cells.map((c) => `<td class="num">${typeof c === 'string' ? esc(c) : cell(c)}</td>`).join('')}</tr>`).join('');
    csvStore[id] = { rows: csv, name: csvName };
    return `<div class="table-block">
      <div class="table-scroll"><table id="${id}">
        <caption>${esc(caption)}</caption>
        <thead>${thead}</thead><tbody>${tbody}</tbody>
      </table></div>
      <button type="button" class="btn-csv" data-csv="${id}">Download CSV</button>
    </div>`;
  }

  const csvStore = {};
  const csvField = (v) => (/[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));

  function downloadCsv(id) {
    const { rows, name } = csvStore[id];
    const header = ['Geography', 'Measure', 'Value', 'Unit', 'Period', 'Source', 'Source URL', 'Stale'];
    const lines = [header, ...rows.filter((r) => r.m).map(({ geo, measure, m }) =>
      [geo, measure, m.value, m.unit, m.period, m.source, m.source_url, m.stale ? 'yes' : 'no'])];
    const blob = new Blob([`${lines.map((l) => l.map(csvField).join(',')).join('\r\n')}\r\n`], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${name}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  // Build rows × counties table data from a list of [measureKey, label].
  function countyTable(id, caption, measures, csvName) {
    const rows = measures.map(([k, label]) => ({ label, cells: COUNTIES.map((c) => M(`${c.key}.${k}`)) }));
    const csv = measures.flatMap(([k, label]) => COUNTIES.map((c) => ({ geo: `${c.name}, KY`, measure: label, m: M(`${c.key}.${k}`) })));
    return {
      html: table({ id, caption, head: ['', ...COUNTIES.map((c) => c.name)], rows, csv, csvName }),
      metrics: csv.map((r) => r.m),
    };
  }

  const empty = '<p class="na">These figures are not available yet. Check back after the next monthly update, or contact us for current numbers.</p>';

  // ------------------------------------------------------------ sections

  function renderWorkforce() {
    const cards = COUNTIES.map((c) => {
      const lf = M(`${c.key}.labor_force`);
      const rate = M(`${c.key}.unemployment_rate`);
      if (!lf && !rate) return '';
      return `<div class="card">
        <h3>${esc(c.name)}</h3>
        <dl>
          <div><dt>Labor force</dt><dd>${cell(lf)}</dd></div>
          <div><dt>Unemployment rate</dt><dd>${cell(rate)}</dd></div>
        </dl>
        ${lf ? `<p class="card-period">${esc(fmtPeriod(lf.period))}${lf.note === 'preliminary' ? ', preliminary' : ''}</p>` : ''}
      </div>`;
    }).join('');
    if (!cards) return empty;
    const t = countyTable('t-workforce', 'Labor force, latest month', [
      ['labor_force', 'Labor force'],
      ['employed', 'Employed'],
      ['unemployed', 'Unemployed'],
      ['unemployment_rate', 'Unemployment rate'],
    ], 'fulton-hickman-labor-force');
    return `<div class="cards">${cards}</div>${t.html}${asOf(t.metrics, 'Not seasonally adjusted. By place of residence.')}`;
  }

  function historyYears() {
    const years = new Set();
    for (const k of Object.keys(data.metrics)) {
      const m = /^fulton\.unemployment_rate_annual\.(\d{4})$/.exec(k);
      if (m) years.add(m[1]);
    }
    return [...years].sort();
  }

  function renderHistory() {
    const years = historyYears();
    if (!years.length) return empty;
    const get = (s, y) => M(`${s}.unemployment_rate_annual.${y}`);
    const rows = years.map((y) => ({ label: y, cells: SERIES.map((s) => get(s.key, y)) }));
    const geoName = { fulton: 'Fulton County, KY', hickman: 'Hickman County, KY', kentucky: 'Kentucky', us: 'United States' };
    const csv = years.flatMap((y) => SERIES.map((s) => ({ geo: geoName[s.key], measure: 'Unemployment rate, annual average', m: get(s.key, y) })));
    const html = table({
      id: 't-history',
      caption: 'Unemployment rate, annual average',
      head: ['Year', 'Fulton Co.', 'Hickman Co.', 'Kentucky', 'U.S.'],
      rows,
      csv,
      csvName: 'unemployment-rate-annual',
    });
    return `${chart(years, get)}${html}${asOf(csv.map((r) => r.m), 'Annual averages, not seasonally adjusted.')}`;
  }

  function renderRegion() {
    const lf = M('lma.labor_force');
    if (!lf) return null;
    const rows = [
      { label: 'Labor force', cells: [lf] },
      { label: 'Unemployed', cells: [M('lma.unemployed')] },
      { label: 'Unemployment rate', cells: [M('lma.unemployment_rate')] },
    ];
    const csv = [['labor_force', 'Labor force'], ['unemployed', 'Unemployed'], ['unemployment_rate', 'Unemployment rate']]
      .map(([k, label]) => ({ geo: 'Labor market area', measure: label, m: M(`lma.${k}`) }));
    return `<p>${esc(lf.note || '')}. The rate is calculated from the combined totals.</p>
      ${table({ id: 't-region', caption: 'Labor market area, latest month', head: ['', 'Labor market area'], rows, csv, csvName: 'labor-market-area' })}
      ${asOf(csv.map((r) => r.m), 'Not seasonally adjusted.')}`;
  }

  function renderDemographics() {
    const t = countyTable('t-demographics', 'Population, income, housing, and education', [
      ['population', 'Population'],
      ['median_age', 'Median age (years)'],
      ['median_household_income', 'Median household income'],
      ['per_capita_income', 'Per capita income'],
      ['poverty_rate', 'Persons below poverty level'],
      ['median_home_value', 'Median value, owner-occupied home'],
      ['pct_hs_or_higher', 'High school graduate or higher (age 25+)'],
      ['pct_bachelors_or_higher', "Bachelor's degree or higher (age 25+)"],
    ], 'fulton-hickman-demographics');
    if (!t.metrics.some(Boolean)) return empty;
    return `${t.html}${asOf(t.metrics, 'Five-year estimates describe the whole period, not a single year. Dollar figures are inflation-adjusted to the final year.')}`;
  }

  function renderSchools() {
    const get = (d, k) => M(`schools.${d.key}.${k}`);
    if (!DISTRICTS.some((d) => get(d, 'enrollment'))) return empty;
    const rows = DISTRICTS.map((d) => {
      const e = get(d, 'enrollment');
      return { label: d.name.replace(/ Schools$/, ''), sub: e ? `${schoolYear(e.period)} school year` : '', cells: [e, get(d, 'teachers_fte'), get(d, 'student_teacher_ratio')] };
    });
    const csv = DISTRICTS.flatMap((d) => [
      ['enrollment', 'Enrollment'], ['teachers_fte', 'Teachers (FTE)'], ['student_teacher_ratio', 'Students per teacher'],
    ].map(([k, label]) => ({ geo: `${d.name} (${d.county} County, KY)`, measure: label, m: get(d, k) })));
    const html = table({
      id: 't-schools',
      caption: 'Public school districts',
      head: ['District', 'Students enrolled', 'Teachers (FTE)', 'Students per teacher'],
      rows,
      csv,
      csvName: 'school-districts',
    });
    return `${html}${asOf(csv.map((r) => r.m), 'Students per teacher is enrollment divided by full-time-equivalent teachers.')}`;
  }

  // ------------------------------------------------------------ chart

  const SVGNS = 'http://www.w3.org/2000/svg';

  function chart(years, get) {
    // Draw at the real on-screen width so 12px text stays 12px on phones.
    const avail = document.querySelector('[data-render="history"]')?.clientWidth || 640;
    const W = Math.round(Math.max(300, Math.min(640, avail)));
    const H = W < 500 ? 240 : 300;
    const pad = { t: 16, r: 108, b: 32, l: 36 };
    const vals = years.flatMap((y) => SERIES.map((s) => get(s.key, y)?.value)).filter((v) => v != null);
    if (!vals.length) return '';
    const yMax = Math.max(2, Math.ceil(Math.max(...vals) / 2) * 2);
    const x = (i) => pad.l + (years.length === 1 ? 0 : (i * (W - pad.l - pad.r)) / (years.length - 1));
    const y = (v) => pad.t + (1 - v / yMax) * (H - pad.t - pad.b);

    let grid = '';
    for (let v = 0; v <= yMax; v += yMax > 8 ? 4 : 2) {
      grid += `<line class="grid${v === 0 ? ' base' : ''}" x1="${pad.l}" x2="${W - pad.r}" y1="${y(v)}" y2="${y(v)}"/>
        <text class="tick" x="${pad.l - 8}" y="${y(v) + 4}" text-anchor="end">${v}%</text>`;
    }
    const xTicks = years.map((yr, i) => `<text class="tick" x="${x(i)}" y="${H - 10}" text-anchor="middle">${yr}</text>`).join('');

    const lines = SERIES.map((s) => {
      const pts = years.map((yr, i) => [x(i), get(s.key, yr)?.value]).filter(([, v]) => v != null);
      if (!pts.length) return '';
      const d = pts.map(([px, v], i) => `${i ? 'L' : 'M'}${px.toFixed(1)},${y(v).toFixed(1)}`).join('');
      const dots = pts.map(([px, v]) => `<circle cx="${px}" cy="${y(v)}" r="4" fill="${s.color}"/>`).join('');
      return `<g class="series"><path d="${d}" stroke="${s.color}"${s.dash ? ` stroke-dasharray="${s.dash}"` : ''}/>${dots}</g>`;
    }).join('');

    // Direct labels at the line ends, nudged apart so they never collide.
    const last = years.length - 1;
    const labels = SERIES.map((s) => ({ s, v: get(s.key, years[last])?.value }))
      .filter((l) => l.v != null)
      .map((l) => ({ ...l, ly: y(l.v) }))
      .sort((a, b) => a.ly - b.ly);
    for (let i = 1; i < labels.length; i++) labels[i].ly = Math.max(labels[i].ly, labels[i - 1].ly + 15);
    const overflow = labels.length ? labels[labels.length - 1].ly - (H - pad.b) : 0;
    if (overflow > 0) labels.forEach((l) => (l.ly -= overflow));
    const endLabels = labels.map((l) => `<text class="end-label" x="${x(last) + 10}" y="${l.ly + 4}">${esc(l.s.name)} ${l.v.toFixed(1)}%</text>`).join('');

    const first = years[0], lastYr = years[last];
    const summary = SERIES.map((s) => {
      const a = get(s.key, first)?.value, b = get(s.key, lastYr)?.value;
      return a != null && b != null ? `${s.name} ${a.toFixed(1)}% in ${first} and ${b.toFixed(1)}% in ${lastYr}` : '';
    }).filter(Boolean).join('; ');

    const legend = SERIES.map((s) => `<li><svg width="22" height="10" aria-hidden="true"><line x1="1" x2="21" y1="5" y2="5" stroke="${s.color}" stroke-width="2.5"${s.dash ? ` stroke-dasharray="4 3"` : ''}/></svg>${esc(s.name)}</li>`).join('');

    return `<figure class="chart" data-years='${esc(JSON.stringify(years))}' data-w="${W}" data-l="${pad.l}" data-r="${pad.r}">
      <ul class="legend" aria-hidden="true">${legend}</ul>
      <div class="chart-box">
        <svg class="plot" viewBox="0 0 ${W} ${H}" role="img" aria-labelledby="chart-title chart-desc" preserveAspectRatio="xMidYMid meet">
          <title id="chart-title">Annual unemployment rate, ${first}–${lastYr}</title>
          <desc id="chart-desc">Line chart. ${esc(summary)}. Every value is in the table below.</desc>
          ${grid}${xTicks}
          <line class="crosshair" x1="0" x2="0" y1="${pad.t}" y2="${H - pad.b}" visibility="hidden"/>
          ${lines}${endLabels}
          <rect class="hit" x="${pad.l - 20}" y="0" width="${W - pad.l - pad.r + 40}" height="${H}" fill="transparent"/>
        </svg>
        <div class="tooltip" role="presentation" hidden></div>
      </div>
      <figcaption>Annual average unemployment rate. Values in the table below.</figcaption>
    </figure>`;
  }

  function wireChart(root, get) {
    const fig = root.querySelector('figure.chart');
    if (!fig) return;
    const years = JSON.parse(fig.dataset.years);
    const svg = fig.querySelector('svg.plot');
    const tip = fig.querySelector('.tooltip');
    const cross = svg.querySelector('.crosshair');
    const hit = svg.querySelector('.hit');
    const W = +fig.dataset.w, padL = +fig.dataset.l, padR = +fig.dataset.r;
    const xAt = (i) => padL + (years.length === 1 ? 0 : (i * (W - padL - padR)) / (years.length - 1));

    const show = (clientX) => {
      const pt = svg.createSVGPoint();
      pt.x = clientX;
      const sx = pt.matrixTransform(svg.getScreenCTM().inverse()).x;
      let i = Math.round(((sx - padL) / (W - padL - padR)) * (years.length - 1));
      i = Math.max(0, Math.min(years.length - 1, i));
      cross.setAttribute('x1', xAt(i));
      cross.setAttribute('x2', xAt(i));
      cross.setAttribute('visibility', 'visible');
      tip.innerHTML = `<strong>${years[i]}</strong>${SERIES.map((s) => {
        const m = get(s.key, years[i]);
        return `<span><i style="background:${s.color}"></i>${esc(s.name)}<b>${m ? `${m.value.toFixed(1)}%` : '—'}</b></span>`;
      }).join('')}`;
      tip.hidden = false;
      const box = fig.querySelector('.chart-box').getBoundingClientRect();
      const px = (xAt(i) / W) * box.width;
      const left = px + tip.offsetWidth + 16 > box.width ? px - tip.offsetWidth - 12 : px + 12;
      tip.style.left = `${Math.max(0, left)}px`;
    };
    const hide = () => {
      tip.hidden = true;
      cross.setAttribute('visibility', 'hidden');
    };
    hit.addEventListener('pointermove', (e) => show(e.clientX));
    hit.addEventListener('pointerdown', (e) => show(e.clientX));
    hit.addEventListener('pointerleave', hide);
  }

  // ------------------------------------------------------------ render

  function render() {
    const sections = {
      workforce: renderWorkforce,
      history: renderHistory,
      region: renderRegion,
      demographics: renderDemographics,
      schools: renderSchools,
    };
    for (const [name, fn] of Object.entries(sections)) {
      const el = document.querySelector(`[data-render="${name}"]`);
      const html = fn();
      if (name === 'region') {
        // Shown only once the county list is confirmed and data exists.
        document.getElementById('region').hidden = !html;
        document.getElementById('toc-region').hidden = !html;
      }
      el.innerHTML = html || '';
    }
    wireChart(document.querySelector('[data-render="history"]'), (s, y) => M(`${s}.unemployment_rate_annual.${y}`));

    const updated = document.getElementById('updated');
    if (data.generated) {
      const d = new Date(data.generated);
      updated.textContent = `Data last refreshed ${d.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' })}.`;
    }
    const acs = M('fulton.population');
    document.getElementById('acs-vintage').textContent = acs ? `, ${fmtPeriod(acs.period)}` : '';
  }

  async function load() {
    try {
      const res = await fetch('data/data.json', { cache: 'no-cache' });
      if (!res.ok) throw new Error(res.status);
      data = await res.json();
      data.metrics = data.metrics || {};
    } catch {
      data = { metrics: {} };
    }
    render();
  }

  document.addEventListener('click', (e) => {
    const b = e.target.closest('[data-csv]');
    if (b) downloadCsv(b.dataset.csv);
  });

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
    // The worker revalidates data.json in the background; re-render if it changed.
    navigator.serviceWorker.addEventListener('message', (e) => {
      if (e.data?.type === 'data-updated') load();
    });
  }

  window.addEventListener('beforeprint', () => {
    document.querySelector('.site-footer').dataset.printed = new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
  });

  // Redraw the chart when the available width changes (rotation, resize).
  let lastWidth = 0;
  window.addEventListener('resize', () => {
    const w = document.querySelector('[data-render="history"]')?.clientWidth || 0;
    if (Math.abs(w - lastWidth) < 24) return;
    lastWidth = w;
    clearTimeout(window.__chartTimer);
    window.__chartTimer = setTimeout(render, 150);
  });

  load();
})();
