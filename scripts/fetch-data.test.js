// Run with: npm test   (no network, no API keys needed)
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildBlsMetrics, buildLmaMetrics, buildSchoolMetrics, indexSeries, lausSeriesId, merge, resolveCensusVars, sanityCheck } from './fetch-data.js';

const obs = (year, period, value) => ({ year, period, value: String(value), footnotes: [{}] });

// Minimal BLS payload: one month + six annual averages for every series.
function blsFixture({ fultonEmployed = 2353 } = {}) {
  const annual = (vals) => vals.map((v, i) => obs(String(2020 + i), 'M13', v));
  const county = (fips, [rate, un, emp, lf]) => ({
    [lausSeriesId(fips, '03')]: [obs('2026', 'M07', rate), obs('2026', 'M06', rate), ...annual([5, 5, 5, 5, 5, 5])],
    [lausSeriesId(fips, '04')]: [obs('2026', 'M07', un)],
    [lausSeriesId(fips, '05')]: [obs('2026', 'M07', emp)],
    [lausSeriesId(fips, '06')]: [obs('2026', 'M07', lf), obs('2025', 'M10', '-')],
  });
  return {
    ...county('21075', [6.0, 151, fultonEmployed, 2504]),
    ...county('21105', [5.9, 108, 1715, 1823]),
    LAUST210000000000003: annual([6.5, 4.4, 4.0, 4.2, 4.8, 4.6]),
    LNU04000000: annual([8.1, 5.3, 3.6, 3.6, 4.0, 4.3]),
  };
}

test('series IDs match the published BLS format', () => {
  assert.equal(lausSeriesId('21075', '03'), 'LAUCN210750000000003');
  assert.equal(lausSeriesId('21105', '06'), 'LAUCN211050000000006');
});

test('indexSeries skips BLS "-" placeholders', () => {
  assert.deepEqual(Object.keys(indexSeries([obs('2025', 'M10', '-'), obs('2025', 'M09', 5)])), ['2025-09']);
});

test('builds latest month and six annual averages', () => {
  const m = buildBlsMetrics(blsFixture());
  assert.equal(m['fulton.labor_force'].value, 2504);
  assert.equal(m['fulton.labor_force'].period, '2026-07');
  assert.equal(m['us.unemployment_rate_annual.2025'].value, 4.3);
  assert.equal(Object.keys(m).filter((k) => k.includes('_annual.')).length, 24);
  assert.deepEqual(sanityCheck(m), []);
});

test('sanity check rejects employed + unemployed != labor force', () => {
  const problems = sanityCheck(buildBlsMetrics(blsFixture({ fultonEmployed: 2000 })));
  assert.ok(problems.some((p) => p.startsWith('fulton: employed')));
});

test('sanity check rejects employed == unemployed (the live-site bug)', () => {
  const m = buildBlsMetrics(blsFixture());
  m['fulton.employed'].value = 151;
  assert.ok(sanityCheck(m).some((p) => p.includes('employed equals unemployed')));
});

test('sanity check rejects rate out of range and big labor-force swings', () => {
  const m = buildBlsMetrics(blsFixture());
  m['hickman.unemployment_rate'].value = 45;
  const problems = sanityCheck(m, { 'fulton.labor_force': { value: 9000 } });
  assert.ok(problems.some((p) => p.includes('outside 0–30')));
  assert.ok(problems.some((p) => p.includes('more than 50%')));
});

test('failed source keeps previous values, marked stale', () => {
  const previous = {
    'fulton.population': { value: 6000, dataset: 'census', stale: false },
    'fulton.labor_force': { value: 2400, dataset: 'bls', stale: false },
  };
  const fresh = { 'fulton.labor_force': { value: 2504, dataset: 'bls', stale: false } };
  const out = merge(previous, fresh, new Set(['census']));
  assert.equal(out['fulton.population'].stale, true);
  assert.equal(out['fulton.population'].value, 6000);
  assert.equal(out['fulton.labor_force'].value, 2504);
  assert.equal(out['fulton.labor_force'].stale, false);
});

test('labor market area rate comes from summed totals, not averaged rates', () => {
  const raw = {
    [lausSeriesId('21075', '06')]: [obs('2026', 'M07', 1000)],
    [lausSeriesId('21075', '04')]: [obs('2026', 'M07', 100)], // 10%
    [lausSeriesId('47131', '06')]: [obs('2026', 'M07', 9000)],
    [lausSeriesId('47131', '04')]: [obs('2026', 'M07', 180)], // 2%
  };
  const lma = { counties: [{ name: 'Fulton County', state: 'KY', fips: '21075' }, { name: 'Obion County', state: 'TN', fips: '47131' }] };
  const m = buildLmaMetrics(raw, lma);
  assert.equal(m['lma.unemployment_rate'].value, 2.8); // not (10 + 2) / 2 = 6
});

test('Census variables resolve by label and catch renumbering', () => {
  const base = {
    B01003_001E: { label: 'Estimate!!Total', concept: 'Total Population' },
    B01002_001E: { label: 'Estimate!!Median age --!!Total:' },
    B19013_001E: { label: 'Estimate!!Median household income in the past 12 months (in 2024 inflation-adjusted dollars)' },
    B19301_001E: { label: 'Estimate!!Per capita income in the past 12 months (in 2024 inflation-adjusted dollars)' },
    B25077_001E: { label: 'Estimate!!Median value (dollars)' },
    B17001_001E: { label: 'Estimate!!Total:', concept: 'Poverty Status in the Past 12 Months by Sex by Age' },
    B17001_002E: { label: 'Estimate!!Total:!!Income in the past 12 months below poverty level:' },
  };
  const p = 'Estimate!!Percent!!AGE BY EDUCATIONAL ATTAINMENT!!Population 25 years and over!!';
  const subject = {
    S1501_C02_009E: { label: `${p}High school graduate (includes equivalency)` },
    S1501_C02_014E: { label: `${p}High school graduate or higher` },
    S1501_C02_015E: { label: `${p}Bachelor's degree or higher` },
  };
  const vars = resolveCensusVars(base, subject);
  assert.equal(vars.pct_bachelors_or_higher.code, 'S1501_C02_015E');
  assert.equal(vars.pct_hs_or_higher.code, 'S1501_C02_014E');
  assert.throws(() => resolveCensusVars({ ...base, B25077_001E: { label: 'Estimate!!Something else' } }, subject), /no longer means/);
});

test('school year label and ratio', () => {
  const m = buildSchoolMetrics('hickman_county', { year: 2024, enrollment: 759, teachers_total_fte: 55 });
  assert.equal(m['schools.hickman_county.enrollment'].period, '2024-25');
  assert.equal(m['schools.hickman_county.student_teacher_ratio'].value, 13.8);
});
