#!/usr/bin/env node
// Monthly data pull for the thinkwestky data page.
//
// Reads BLS LAUS, Census ACS 5-year, and NCES CCD (via the Urban Institute
// Education Data API), validates every number, and rewrites data/data.json.
//
// Rules (see README.md):
//   - If a source fails, its previous values are kept and marked stale: true.
//   - If a sanity check fails, nothing is written and the run exits 1.
//   - data.json is only rewritten when a metric actually changed.
//
// Exit codes: 0 = all sources fresh, 1 = hard failure (nothing written),
//             2 = partial (written, but at least one source is stale).

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA_FILE = path.join(ROOT, 'data', 'data.json');
const LMA_FILE = path.join(ROOT, 'config', 'labor-market-area.json');

export const COUNTIES = {
  fulton: { name: 'Fulton County', fips: '21075' },
  hickman: { name: 'Hickman County', fips: '21105' },
};

// LAUS county series: LAUCN + 5-digit FIPS + 8 zeros + measure code.
// Measure codes: 03 rate, 04 unemployed, 05 employed, 06 labor force.
const MEASURES = {
  unemployment_rate: { code: '03', unit: 'percent' },
  unemployed: { code: '04', unit: 'persons' },
  employed: { code: '05', unit: 'persons' },
  labor_force: { code: '06', unit: 'persons' },
};

// Kentucky and U.S. rates, not seasonally adjusted to match the county series.
// BLS publishes annual averages as period M13 of these monthly series (requested
// with annualaverage: true); there is no separate "...A" annual series ID.
const KY_RATE_SERIES = 'LAUST210000000000003';
const US_RATE_SERIES = 'LNU04000000';

export const SCHOOL_DISTRICTS = {
  fulton_county: { name: 'Fulton County Schools', leaid: '2102100' },
  fulton_independent: { name: 'Fulton Independent Schools', leaid: '2102070' },
  hickman_county: { name: 'Hickman County Schools', leaid: '2102790' },
};

const BLS_SOURCE = 'U.S. Bureau of Labor Statistics, Local Area Unemployment Statistics';
const BLS_URL = 'https://www.bls.gov/lau/';
const CENSUS_URL = 'https://www.census.gov/programs-surveys/acs';
const SCHOOLS_SOURCE = 'NCES Common Core of Data, via Urban Institute Education Data Portal';
const SCHOOLS_URL = 'https://educationdata.urban.org/documentation/school-districts.html';

// Census variables are resolved by label, not trusted by code: Census
// renumbers subject-table columns between vintages. Each entry must match
// exactly one variable in that vintage's variables.json or the run fails.
export const CENSUS_VARS = {
  population: { table: 'base', code: 'B01003_001E', label: /^Estimate!!Total$/, concept: /^Total Population$/i, unit: 'persons' },
  median_age: { table: 'base', code: 'B01002_001E', label: /^Estimate!!Median age --!!Total:?$/, unit: 'years' },
  median_household_income: { table: 'base', code: 'B19013_001E', label: /^Estimate!!Median household income in the past 12 months/, unit: 'dollars' },
  per_capita_income: { table: 'base', code: 'B19301_001E', label: /^Estimate!!Per capita income in the past 12 months/, unit: 'dollars' },
  median_home_value: { table: 'base', code: 'B25077_001E', label: /^Estimate!!Median value \(dollars\)$/, unit: 'dollars' },
  poverty_universe: { table: 'base', code: 'B17001_001E', label: /^Estimate!!Total:?$/, concept: /^Poverty Status in the Past 12 Months by Sex by Age/i, helper: true },
  poverty_below: { table: 'base', code: 'B17001_002E', label: /^Estimate!!Total:?!!Income in the past 12 months below poverty level:?$/, helper: true },
  pct_hs_or_higher: { table: 'subject', group: 'S1501', label: /^Estimate!!Percent!!AGE BY EDUCATIONAL ATTAINMENT!!Population 25 years and over!!High school graduate or higher$/, unit: 'percent' },
  pct_bachelors_or_higher: { table: 'subject', group: 'S1501', label: /^Estimate!!Percent!!AGE BY EDUCATIONAL ATTAINMENT!!Population 25 years and over!!Bachelor's degree or higher$/, unit: 'percent' },
};

// ---------------------------------------------------------------- utilities

export function loadDotEnv(file = path.join(ROOT, '.env')) {
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (!m || process.env[m[1]]) continue;
    process.env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
  }
}

async function fetchJson(url, { method = 'GET', body, timeoutMs = 120_000, retries = 2 } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, {
        method,
        headers: {
          // Some APIs (educationdata.urban.org) reject Node's default "node" user agent.
          'User-Agent': USER_AGENT,
          ...(body && { 'Content-Type': 'application/json' }),
        },
        body: body ? JSON.stringify(body) : undefined,
        redirect: 'manual', // Census redirects to an HTML page on key errors
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (res.status >= 300 && res.status < 400) {
        throw new Error(`redirected to ${res.headers.get('location')} (usually a missing or invalid API key)`);
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (err) {
      lastErr = err;
      if (attempt < retries) await new Promise((r) => setTimeout(r, 5000 * (attempt + 1)));
    }
  }
  throw new Error(`${redact(url)}: ${lastErr.message}`);
}

const USER_AGENT = 'thinkwestky-data-refresh/1.0 (+https://github.com/mpperrusquia-ui/thinkwestky-data)';

const redact = (url) => url.replace(/([?&]key=)[^&]+/, '$1***');

const round = (n, d) => Math.round(n * 10 ** d) / 10 ** d;

function metric(value, unit, period, source, sourceUrl, dataset, extra = {}) {
  return { value, unit, period, source, source_url: sourceUrl, stale: false, dataset, ...extra };
}

// ---------------------------------------------------------------- BLS

export const lausSeriesId = (fips, code) => `LAUCN${fips}00000000${code}`;

async function fetchBls(seriesIds, apiKey, startYear, endYear) {
  const out = {};
  // v2 registered limit is 50 series per request.
  for (let i = 0; i < seriesIds.length; i += 50) {
    const j = await fetchJson('https://api.bls.gov/publicAPI/v2/timeseries/data/', {
      method: 'POST',
      body: {
        seriesid: seriesIds.slice(i, i + 50),
        startyear: String(startYear),
        endyear: String(endYear),
        annualaverage: true,
        registrationkey: apiKey,
      },
    });
    if (j.status !== 'REQUEST_SUCCEEDED') throw new Error(`BLS: ${j.status} ${(j.message || []).join('; ')}`);
    const missing = (j.message || []).filter((m) => /does not exist|No Data/i.test(m));
    if (missing.length) throw new Error(`BLS: ${missing.join('; ')}`);
    for (const s of j.Results.series) out[s.seriesID] = s.data;
  }
  return out;
}

// Index one series' observations as { 'YYYY-MM' | 'YYYY': {value, footnotes} },
// skipping BLS "-" placeholders (e.g. months not collected).
export function indexSeries(data = []) {
  const idx = {};
  for (const d of data) {
    const value = Number(d.value);
    if (d.value === '' || !Number.isFinite(value)) continue;
    const month = /^M(\d\d)$/.exec(d.period)?.[1];
    if (!month) continue;
    const key = month === '13' ? d.year : `${d.year}-${month}`;
    idx[key] = { value, footnotes: (d.footnotes || []).map((f) => f.text).filter(Boolean) };
  }
  return idx;
}

export function buildBlsMetrics(raw) {
  const metrics = {};
  const idx = Object.fromEntries(Object.entries(raw).map(([id, data]) => [id, indexSeries(data)]));

  // Latest month: the newest month present for all four measures of a county.
  for (const [key, county] of Object.entries(COUNTIES)) {
    const series = Object.fromEntries(
      Object.entries(MEASURES).map(([m, { code }]) => [m, idx[lausSeriesId(county.fips, code)] || {}]),
    );
    const months = Object.keys(series.labor_force).filter((p) => p.includes('-')).sort().reverse();
    const period = months.find((p) => Object.values(series).every((s) => s[p]));
    if (!period) throw new Error(`BLS: no complete month for ${county.name}`);
    for (const [m, { code, unit }] of Object.entries(MEASURES)) {
      const obs = series[m][period];
      const note = obs.footnotes.some((f) => /preliminary/i.test(f)) ? 'preliminary' : undefined;
      metrics[`${key}.${m}`] = metric(obs.value, unit, period, BLS_SOURCE, BLS_URL, 'bls', {
        series: lausSeriesId(county.fips, code),
        ...(note && { note }),
      });
    }
  }

  // Annual averages: the last 6 years where all four rate series have one.
  const rateSeries = {
    fulton: lausSeriesId(COUNTIES.fulton.fips, '03'),
    hickman: lausSeriesId(COUNTIES.hickman.fips, '03'),
    kentucky: KY_RATE_SERIES,
    us: US_RATE_SERIES,
  };
  const years = Object.keys(idx[rateSeries.fulton] || {})
    .filter((p) => /^\d{4}$/.test(p))
    .filter((y) => Object.values(rateSeries).every((id) => idx[id]?.[y]))
    .sort()
    .slice(-6);
  if (years.length < 6) throw new Error(`BLS: only ${years.length} complete annual averages available`);
  for (const [geo, id] of Object.entries(rateSeries)) {
    for (const y of years) {
      metrics[`${geo}.unemployment_rate_annual.${y}`] = metric(
        idx[id][y].value, 'percent', y, BLS_SOURCE, BLS_URL, 'bls', { series: id },
      );
    }
  }
  return metrics;
}

// Labor market area: summed counts across the confirmed county list, rate
// derived from the sums (never an average of county rates).
export function buildLmaMetrics(raw, lma) {
  const counties = lma.counties;
  const lf = counties.map((c) => indexSeries(raw[lausSeriesId(c.fips, '06')]));
  const un = counties.map((c) => indexSeries(raw[lausSeriesId(c.fips, '04')]));
  const months = Object.keys(lf[0]).filter((p) => p.includes('-')).sort().reverse();
  const period = months.find((p) => lf.every((s) => s[p]) && un.every((s) => s[p]));
  if (!period) throw new Error('BLS: no month with data for every labor market area county');
  const laborForce = lf.reduce((a, s) => a + s[period].value, 0);
  const unemployed = un.reduce((a, s) => a + s[period].value, 0);
  const note = `Sum of ${counties.map((c) => `${c.name}, ${c.state}`).join('; ')}`;
  const extra = { note };
  return {
    'lma.labor_force': metric(laborForce, 'persons', period, BLS_SOURCE, BLS_URL, 'bls_lma', extra),
    'lma.unemployed': metric(unemployed, 'persons', period, BLS_SOURCE, BLS_URL, 'bls_lma', extra),
    'lma.unemployment_rate': metric(round((unemployed / laborForce) * 100, 1), 'percent', period, BLS_SOURCE, BLS_URL, 'bls_lma', {
      note: `${note}. Rate derived from summed totals.`,
    }),
  };
}

// ---------------------------------------------------------------- Census

async function newestAcsVintage() {
  const catalog = await fetchJson('https://api.census.gov/data.json');
  const vintages = (name) =>
    new Set(catalog.dataset.filter((d) => d.c_dataset?.join('/') === name && d.c_vintage).map((d) => d.c_vintage));
  const base = vintages('acs/acs5');
  const subject = vintages('acs/acs5/subject');
  const both = [...base].filter((v) => subject.has(v)).sort((a, b) => b - a);
  if (!both.length) throw new Error('Census: could not find an ACS 5-year vintage');
  return both[0];
}

export function resolveCensusVars(baseVars, subjectVars) {
  const resolved = {};
  for (const [key, spec] of Object.entries(CENSUS_VARS)) {
    const vars = spec.table === 'base' ? baseVars : subjectVars;
    let code;
    if (spec.code) {
      const v = vars[spec.code];
      if (!v || !spec.label.test(v.label) || (spec.concept && !spec.concept.test(v.concept || ''))) {
        throw new Error(`Census: ${spec.code} no longer means "${key}" (label: ${v?.label ?? 'missing'})`);
      }
      code = spec.code;
    } else {
      const hits = Object.entries(vars).filter(
        ([c, v]) => c.startsWith(`${spec.group}_`) && c.endsWith('E') && spec.label.test(v.label),
      );
      if (hits.length !== 1) throw new Error(`Census: expected one ${spec.group} variable for "${key}", found ${hits.length}`);
      code = hits[0][0];
    }
    resolved[key] = { ...spec, code };
  }
  return resolved;
}

export function buildCensusMetrics(vintage, vars, baseRows, subjectRows) {
  const period = `${vintage - 4}-${vintage}`;
  const source = `U.S. Census Bureau, American Community Survey 5-Year Estimates, ${vintage - 4}–${vintage}`;
  const url = `https://api.census.gov/data/${vintage}/acs/acs5`;
  const table = (rows) => {
    const [header, ...data] = rows;
    return Object.fromEntries(data.map((r) => [r[header.indexOf('county')], Object.fromEntries(header.map((h, i) => [h, r[i]]))]));
  };
  const base = table(baseRows);
  const subject = table(subjectRows);
  const metrics = {};
  for (const [key, county] of Object.entries(COUNTIES)) {
    const countyCode = county.fips.slice(2);
    const val = (k) => {
      const v = vars[k];
      const raw = (v.table === 'base' ? base : subject)[countyCode]?.[v.code];
      const n = Number(raw);
      // Census uses large negative sentinels (e.g. -666666666) for "no estimate".
      if (raw == null || raw === '' || !Number.isFinite(n) || n < 0) {
        throw new Error(`Census: no usable value for ${v.code} in ${county.name} (${raw})`);
      }
      return n;
    };
    for (const [k, v] of Object.entries(vars)) {
      if (v.helper) continue;
      metrics[`${key}.${k}`] = metric(val(k), v.unit, period, source, url, 'census', { series: v.code });
    }
    metrics[`${key}.poverty_rate`] = metric(
      round((val('poverty_below') / val('poverty_universe')) * 100, 1), 'percent', period, source, url, 'census',
      { series: `${vars.poverty_below.code} / ${vars.poverty_universe.code}` },
    );
  }
  return metrics;
}

async function fetchCensus(apiKey) {
  const vintage = await newestAcsVintage();
  const root = `https://api.census.gov/data/${vintage}/acs/acs5`;
  const [baseVars, subjectVars] = await Promise.all([
    fetchJson(`${root}/variables.json`).then((j) => j.variables),
    fetchJson(`${root}/subject/variables.json`).then((j) => j.variables),
  ]);
  const vars = resolveCensusVars(baseVars, subjectVars);
  const codes = (t) => Object.values(vars).filter((v) => v.table === t).map((v) => v.code).join(',');
  const geo = `for=county:${Object.values(COUNTIES).map((c) => c.fips.slice(2)).join(',')}&in=state:21`;
  const [baseRows, subjectRows] = await Promise.all([
    fetchJson(`${root}?get=NAME,${codes('base')}&${geo}&key=${apiKey}`),
    fetchJson(`${root}/subject?get=NAME,${codes('subject')}&${geo}&key=${apiKey}`),
  ]);
  return buildCensusMetrics(Number(vintage), vars, baseRows, subjectRows);
}

// ---------------------------------------------------------------- Schools

// Urban's `year` is the fall of the school year (2024 = 2024–25).
export function buildSchoolMetrics(key, rec) {
  const period = `${rec.year}-${String((rec.year + 1) % 100).padStart(2, '0')}`;
  const m = (value, unit, series) =>
    metric(value, unit, period, SCHOOLS_SOURCE, SCHOOLS_URL, 'schools', { series });
  return {
    [`schools.${key}.enrollment`]: m(rec.enrollment, 'students', 'enrollment'),
    [`schools.${key}.teachers_fte`]: m(rec.teachers_total_fte, 'fte', 'teachers_total_fte'),
    [`schools.${key}.student_teacher_ratio`]: m(round(rec.enrollment / rec.teachers_total_fte, 1), 'ratio', 'enrollment / teachers_total_fte'),
  };
}

async function fetchSchools() {
  const metrics = {};
  const thisYear = new Date().getUTCFullYear();
  for (const [key, d] of Object.entries(SCHOOL_DISTRICTS)) {
    let rec;
    // The API is slow; query one district-year at a time, newest first.
    for (let y = thisYear; y >= thisYear - 5 && !rec; y--) {
      const j = await fetchJson(
        `https://educationdata.urban.org/api/v1/school-districts/ccd/directory/${y}/?leaid=${d.leaid}`,
        { timeoutMs: 300_000, retries: 1 },
      );
      // Urban codes missing values as negative numbers.
      rec = (j.results || []).find((r) => String(r.leaid) === d.leaid && r.enrollment > 0 && r.teachers_total_fte > 0);
    }
    if (!rec) throw new Error(`Schools: no enrollment/teacher data for ${d.name} in the last 6 years`);
    Object.assign(metrics, buildSchoolMetrics(key, rec));
  }
  return metrics;
}

// ---------------------------------------------------------------- validation

// Returns a list of problems. Any problem fails the run before writing.
export function sanityCheck(metrics, previous = {}) {
  const problems = [];
  const v = (k) => metrics[k]?.value;
  for (const [k, m] of Object.entries(metrics)) {
    if (typeof m.value !== 'number' || !Number.isFinite(m.value)) problems.push(`${k}: not a number (${m.value})`);
    if (!m.period || !m.source || !m.source_url) problems.push(`${k}: missing provenance`);
    if (/unemployment_rate/.test(k) && !(m.value >= 0 && m.value <= 30)) problems.push(`${k}: rate ${m.value} outside 0–30`);
    if (/^(population|median|per_capita)/.test(k.split('.')[1] || '') && !(m.value > 0)) problems.push(`${k}: must be positive (${m.value})`);
    if (m.unit === 'percent' && !(m.value >= 0 && m.value <= 100)) problems.push(`${k}: percent ${m.value} outside 0–100`);
    if (/student_teacher_ratio/.test(k) && !(m.value >= 3 && m.value <= 40)) problems.push(`${k}: ratio ${m.value} outside 3–40`);
  }
  for (const geo of [...Object.keys(COUNTIES), 'lma']) {
    const lf = v(`${geo}.labor_force`);
    if (lf == null) continue;
    const un = v(`${geo}.unemployed`);
    const emp = v(`${geo}.employed`);
    if (emp != null && emp + un !== lf) {
      problems.push(`${geo}: employed (${emp}) + unemployed (${un}) = ${emp + un}, not labor force (${lf})`);
    }
    if (emp != null && emp === un) problems.push(`${geo}: employed equals unemployed (${emp})`);
    const rate = v(`${geo}.unemployment_rate`);
    if (Math.abs((un / lf) * 100 - rate) > 0.051) {
      problems.push(`${geo}: published rate ${rate} does not match unemployed/labor force (${round((un / lf) * 100, 2)})`);
    }
    const prior = previous[`${geo}.labor_force`]?.value;
    if (prior && Math.abs(lf - prior) / prior > 0.5) {
      problems.push(`${geo}: labor force ${lf} is more than 50% away from prior value ${prior}`);
    }
  }
  return problems;
}

// ---------------------------------------------------------------- merge

// Fresh metrics replace everything from their dataset. For a failed dataset,
// the previous values are carried forward with stale: true.
export function merge(previous, fresh, failedDatasets) {
  const out = {};
  for (const [k, m] of Object.entries(previous)) {
    if (failedDatasets.has(m.dataset)) out[k] = { ...m, stale: true };
  }
  Object.assign(out, fresh);
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => a.localeCompare(b)));
}

// ---------------------------------------------------------------- main

async function main() {
  loadDotEnv();
  const missing = ['BLS_API_KEY', 'CENSUS_API_KEY'].filter((k) => !process.env[k]);
  if (missing.length) {
    console.error(`ERROR: ${missing.join(' and ')} ${missing.length > 1 ? 'are' : 'is'} not set.`);
    console.error('In GitHub Actions, add them as repository secrets. Locally, copy .env.example to .env and fill them in.');
    process.exit(1);
  }

  const previousFile = existsSync(DATA_FILE) ? JSON.parse(readFileSync(DATA_FILE, 'utf8')) : { metrics: {} };
  const previous = previousFile.metrics || {};
  const lma = existsSync(LMA_FILE) ? JSON.parse(readFileSync(LMA_FILE, 'utf8')) : { confirmed: false, counties: [] };
  const lmaEnabled = lma.confirmed === true && lma.counties?.length > 0;

  const fresh = {};
  const failed = new Set();
  const errors = [];
  const run = async (dataset, fn) => {
    try {
      Object.assign(fresh, await fn());
      console.log(`ok     ${dataset}`);
    } catch (err) {
      failed.add(dataset);
      errors.push(`${dataset}: ${err.message}`);
      console.error(`FAILED ${dataset}: ${err.message}`);
    }
  };

  const thisYear = new Date().getUTCFullYear();
  const countySeries = Object.values(COUNTIES).flatMap((c) =>
    Object.values(MEASURES).map((m) => lausSeriesId(c.fips, m.code)),
  );
  let blsRaw;
  await run('bls', async () => {
    blsRaw = await fetchBls([...countySeries, KY_RATE_SERIES, US_RATE_SERIES], process.env.BLS_API_KEY, thisYear - 8, thisYear);
    return buildBlsMetrics(blsRaw);
  });
  if (lmaEnabled) {
    await run('bls_lma', async () => {
      const ids = lma.counties.flatMap((c) => [lausSeriesId(c.fips, '06'), lausSeriesId(c.fips, '04')]);
      return buildLmaMetrics(await fetchBls(ids, process.env.BLS_API_KEY, thisYear - 1, thisYear), lma);
    });
  }
  await run('census', () => fetchCensus(process.env.CENSUS_API_KEY));
  await run('schools', fetchSchools);

  const metrics = merge(previous, fresh, failed);
  // Drop LMA figures entirely if the area is not (or no longer) confirmed.
  if (!lmaEnabled) for (const k of Object.keys(metrics)) if (k.startsWith('lma.')) delete metrics[k];

  const problems = sanityCheck(fresh, previous);
  if (problems.length) {
    console.error('\nSanity check failed. data.json was NOT written:');
    for (const p of problems) console.error(`  - ${p}`);
    process.exit(1);
  }

  if (JSON.stringify(metrics) === JSON.stringify(previous)) {
    console.log('\nNo changes; data.json left as is.');
  } else {
    const out = { generated: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'), metrics };
    writeFileSync(DATA_FILE, `${JSON.stringify(out, null, 2)}\n`);
    console.log(`\nWrote ${Object.keys(metrics).length} metrics to data/data.json`);
  }

  if (errors.length) {
    console.error(`\n${errors.length} source(s) failed; previous values kept and marked stale:`);
    for (const e of errors) console.error(`  - ${e}`);
    process.exit(2);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
