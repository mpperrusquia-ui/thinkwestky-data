# Fulton & Hickman County Data Page

A one-page website that shows current workforce and community figures for
Fulton County and Hickman County, Kentucky. It is run by the Fulton-Hickman
Counties Economic Development Partnership (EDP) and linked from
[thinkwestky.org](https://thinkwestky.org/).

It exists because hand-typed figures on the main site went years out of date.
Here, a scheduled job pulls the numbers from federal sources once a month,
checks them, and saves them. Nobody retypes anything. Every figure on the page
shows where it came from and what period it covers.

It can be installed as an app on a phone ("Add to Home Screen") and works offline.

- **Live URL:** `https://data.thinkwestky.org` *(fill in once DNS is set up; until then the `*.pages.dev` URL from Cloudflare)*
- **Hosting:** Cloudflare Pages (free), deploys automatically from this GitHub repository
- **Cost:** $0. No server, no database, no paid services.

---

## Accounts and access

The code lives on the GitHub account `mpperrusquia-ui`, which maintains the
project. Hosting and API-key accounts should use an EDP-controlled email address,
such as `director@thinkwestky.org`, so the EDP can always reach the live site.

| What | Where | Account holder | Notes |
|---|---|---|---|
| Code + monthly job | GitHub, [`github.com/mpperrusquia-ui/thinkwestky-data`](https://github.com/mpperrusquia-ui/thinkwestky-data) | `mpperrusquia-ui` | Holds the code, the refresh schedule, and the API keys (as secrets) |
| Hosting | Cloudflare Pages, `dash.cloudflare.com` | _fill in_ | Connected to the GitHub repo; redeploys on every commit |
| DNS for `data.thinkwestky.org` | Wherever thinkwestky.org's DNS is managed | _fill in_ | One CNAME record pointing at the Pages URL |
| BLS API key | [data.bls.gov/registrationEngine](https://data.bls.gov/registrationEngine/) | _fill in_ | Free. Key is emailed to the registering address |
| Census API key | [api.census.gov/data/key_signup.html](https://api.census.gov/data/key_signup.html) | _fill in_ | Free. Key is emailed to the registering address |

To get access: the repo owner (`mpperrusquia-ui`) invites you as a collaborator
(repo → Settings → Collaborators). Cloudflare access is under Manage Account → Members.

---

## How it works

```
                  5th of each month (GitHub Actions)
BLS, Census,  ──► scripts/fetch-data.js ──► checks ──► data/data.json ──► commit
Urban/NCES                                                     │
                                                               ▼
                                          Cloudflare Pages redeploys the site
                                                               │
                                                               ▼
                                   index.html reads data/data.json in the browser
```

- The browser only ever reads `data/data.json`. API keys never reach the browser.
- If a federal API is down, the page keeps working with last month's file.

### Files

| File | What it is |
|---|---|
| `index.html` | The page |
| `assets/js/app.js` | Turns `data.json` into tables, the chart, and the CSV downloads |
| `assets/css/style.css` | Styling for screen and print |
| `data/data.json` | **Generated. Don't edit by hand.** Every number the page shows |
| `data/sites.json` | Hand-maintained industrial site details, kept for the future site-profile phase. Not shown on the page yet |
| `config/labor-market-area.json` | County list for the regional labor market area (see below) |
| `scripts/fetch-data.js` | The monthly data pull |
| `scripts/fetch-data.test.js` | Tests for the checks (`npm test`) |
| `scripts/make-icons.js` | Regenerates the app icons |
| `.github/workflows/refresh.yml` | The monthly schedule |
| `sw.js`, `manifest.webmanifest` | Offline and install support |

---

## What's automated and what isn't

| Figure | Source | Updated |
|---|---|---|
| Labor force, employed, unemployed, unemployment rate (county, latest month) | BLS Local Area Unemployment Statistics | Automatically, monthly |
| Unemployment rate annual averages (county, Kentucky, U.S.) | BLS LAUS | Automatically, monthly |
| Population, age, income, poverty, home value, education | Census American Community Survey 5-year | Automatically; the data itself changes once a year (December) |
| School enrollment and teachers | NCES Common Core of Data, via the Urban Institute | Automatically; the data changes about once a year |
| Regional labor market area | BLS LAUS | **Not shown yet.** Waiting on the county list (below) |
| Contact details, section text | `index.html` | By hand |
| Industrial sites | `data/sites.json` | By hand (not yet displayed) |

BLS publishes county figures for a given month about two months later, so the
page in September shows July. The newest month is labeled "preliminary" and
BLS revises it the following month. The refresh picks up the revision automatically.

---

## The monthly refresh

Runs at 12:00 UTC on the 5th of each month. You can also run it any time:
GitHub → **Actions** → **Refresh data** → **Run workflow**.

What it does:

1. Fetches every source.
2. If a source fails, it **keeps that source's previous values and marks them
   stale**. The page shows those with a yellow **Not updated** tag. It never
   writes a blank, a zero, or a guess.
3. Checks the numbers before saving. It fails the run if:
   - an unemployment rate is outside 0–30%
   - a county's labor force moved more than 50% from last month
   - employed + unemployed doesn't equal labor force, or employed equals unemployed
   - the published rate doesn't match unemployed ÷ labor force
   - a Census variable code no longer means what we expect
4. Commits `data/data.json` only if something changed.
5. On any problem, opens a GitHub issue labeled `refresh-failure`, or adds a
   comment to the open one.

### When the refresh fails

You'll see an open issue titled **Data refresh failed** in the repo's Issues
tab. GitHub also emails repo watchers. The issue links to the run log.

| Symptom in the log | Likely cause | Fix |
|---|---|---|
| `BLS_API_KEY ... not set` | Secret missing or renamed | Add the secret (see "Rotating a key") |
| `BLS: REQUEST_NOT_PROCESSED` / daily threshold | Key expired or over quota | Re-register the key; re-run tomorrow |
| `redirected to .../missing_key.html` | Census key missing or invalid | Replace the Census key |
| `Census: ... no longer means ...` or `expected one S1501 variable` | Census renumbered or relabeled a variable in a new vintage | Update the matching entry in `CENSUS_VARS` in `scripts/fetch-data.js`. Look up the new code in `https://api.census.gov/data/<year>/acs/acs5/variables.json` (or `/subject/variables.json`) |
| `Series does not exist` | BLS changed a series ID (rare) | Check the ID at [data.bls.gov](https://data.bls.gov/dataQuery/find) |
| `Schools: ...` or timeouts on `educationdata.urban.org` | The Urban Institute API is slow or down | Usually fine on re-run. If the API is retired, see "If the schools API goes away" |
| `Sanity check failed` | A number looked wrong | Read the listed problem. Don't loosen the check without understanding why it tripped |

Once the fix is in, run the workflow manually and close the issue.

A stale value is fine. A wrong value is not. That's why the checks fail the
run instead of publishing something that looks plausible.

---

## Rotating an API key

1. Register for a new key (links in the accounts table). The key arrives by email.
2. GitHub → repo → **Settings** → **Secrets and variables** → **Actions**.
3. Edit `BLS_API_KEY` or `CENSUS_API_KEY` and paste the new value.
4. **Actions** → **Refresh data** → **Run workflow** to confirm it works.

Keys are never stored in the code. For running locally, copy `.env.example` to
`.env` and fill it in. `.env` is excluded from git.

---

## Changing the page

### Add or change a figure

1. **Get the data:** add the series ID or variable to `scripts/fetch-data.js`.
   - BLS county series: `LAUCN` + 5-digit county FIPS + `00000000` + measure
     (`03` rate, `04` unemployed, `05` employed, `06` labor force), e.g. `LAUCN210750000000006`.
   - Census: add an entry to `CENSUS_VARS` with the code **and the exact label
     text** from `variables.json`. The label check catches Census renumbering.
2. **Show it:** add a row in the matching `render…` function in `assets/js/app.js`.
   Each row is `['metric_name', 'Label shown on page']`.
3. Run `npm test`, then run the refresh (locally with a `.env`, or via Actions).
4. **Bump `VERSION` in `sw.js`** (e.g. `v1` → `v2`) whenever you change
   `index.html`, CSS, or JS. Otherwise people with the app installed keep the old version.

Each value in `data.json` looks like this. Every number carries its own source:

```json
"fulton.unemployment_rate": {
  "value": 6.0,
  "unit": "percent",
  "period": "2026-07",
  "source": "U.S. Bureau of Labor Statistics, Local Area Unemployment Statistics",
  "source_url": "https://www.bls.gov/lau/",
  "stale": false,
  "dataset": "bls",
  "series": "LAUCN210750000000003",
  "note": "preliminary"
}
```

### Contact details

Edit the contact section and the blue call-to-action box in `index.html`.

### Chart colors

Series colors (Fulton blue, Hickman red, Kentucky teal, U.S. gold dashed) were
checked for color-blind separation and contrast. If you change them, keep the
four clearly distinct and keep the U.S. line dashed.

---

## Regional labor market area (not live yet)

The old site cited a "Local Workforce Area" of Fulton, Hickman, and five
bordering Kentucky and Tennessee counties, but never named the five. We won't
guess, because a regional total built on the wrong counties is exactly the error
this project exists to prevent.

To turn it on, once the **West Kentucky Workforce Board** confirms the list:

1. Edit `config/labor-market-area.json`:
   ```json
   {
     "confirmed": true,
     "confirmed_by": "Name, West Kentucky Workforce Board",
     "confirmed_on": "2026-10-15",
     "counties": [
       { "name": "Fulton County", "state": "KY", "fips": "21075" },
       { "name": "Hickman County", "state": "KY", "fips": "21105" }
     ]
   }
   ```
   (Add all seven counties. FIPS codes are listed at census.gov.)
2. Run the refresh. The section appears automatically. Labor force and
   unemployed are summed across the counties, and the rate is calculated from
   those totals, not by averaging county rates.

---

## If the schools API goes away

School figures come from the Urban Institute's free Education Data API, which
repackages federal NCES data. If it's retired, the refresh keeps the last values
(marked stale) and opens an issue. The fallback is to maintain the three
districts by hand in a JSON file with an explicit `as_of` date. NCES district
IDs: Fulton County `2102100`, Fulton Independent `2102070`, Hickman County `2102790`.

---

## Deployment

### Cloudflare Pages (first-time setup)

1. Create the GitHub repo under the EDP's account and push this code.
2. Add repository secrets `BLS_API_KEY` and `CENSUS_API_KEY`.
3. Run **Actions → Refresh data** once to fill in `data/data.json`.
4. Cloudflare → **Workers & Pages** → **Create** → **Pages** → connect the GitHub repo.
   Build command: *(none)*. Output directory: `/`.
5. **Custom domains** → add `data.thinkwestky.org`, then add the CNAME record
   Cloudflare shows you at thinkwestky.org's DNS provider.
6. Add a menu link on thinkwestky.org (YOOtheme menu) pointing to the new address.
   Don't embed it in an iframe; iframes behave poorly on phones.

GitHub Pages works too (Settings → Pages → deploy from `main`, root folder).

### Run it locally

```
npm test                 # checks, no keys needed
cp .env.example .env     # then paste in both keys
npm run refresh          # rewrites data/data.json
npm run serve            # http://localhost:8080
```

Node 20 or newer. No `npm install` needed; there are no dependencies.

---

## Out of scope (v1)

Site profile PDF generator (planned next, built on this data), drive-time labor
shed maps, incentive calculators, and any changes to the WordPress site.
