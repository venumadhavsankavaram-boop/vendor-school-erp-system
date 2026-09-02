# Vendor-School-ERP System

A standalone toolkit for turning the school ERP + website template into a
product you can hand off to multiple schools, and for keeping track of
every school you've onboarded. This is a separate project from any single
school's deployment (like the Raghavan ERP / website) — nothing here is
wired into those repos, and nothing in those repos depends on this.

Three independent pieces:

```
vendor-school-erp-system/
├── website-template/index.html   The public website, content-driven (SITE_CONTENT)
├── website-builder.html          Local tool: fill in a school's content, download the finished site
├── vendor-dashboard/             Deployable service: your fleet overview (schools, status, errors)
└── reporting-client/             Optional snippet a school's ERP can use to report into the dashboard
```

---

## 1. Website Builder — onboarding a new school

`website-builder.html` is a single file you open directly in a browser
(double-click it, or drag it into a browser tab — no server, no install,
nothing is uploaded anywhere). It has every customizable field the school
website supports:

- School name, logo, tagline/motto, district & state
- Colour palette (4 pickers — every button, icon, and heading follows these)
- Hero banner text and stats (established year, grade levels, sections, etc.)
- Welcome section badge, text, and photo
- Our History (founding story and milestones — write this yourself, it's
  the one section that's genuinely per-school narrative content)
- Academics (grade levels & sections, as a repeatable list)
- Academic Vision (icon + title cards, pick from a 21-icon library)
- Facilities (icon + title + description cards)
- Leadership team (name, role, qualification, email, photo — repeatable)
- Admissions form wording
- Contact details and the embedded map (just type an address — no API key needed)
- The ERP URL this website should talk to

A live preview updates as you type. When you're happy with it, click
**Download Website** — you get a single, complete, ready-to-deploy
`index.html` for that school. Deploy it exactly the way the current school
website is deployed (a static/Node site on Render, or wherever you host).

Two extra buttons: **Save Content (.json)** exports everything you've
entered as a small JSON file — keep one per school so you can reopen it
later with **Import Saved Content** and keep editing (e.g. when a school
wants their motto or leadership team updated).

Notice board and photo gallery are **not** part of the builder — those
already flow live from the school's own ERP (Communications → Website
Gallery, and the notice board), so a school updates those themselves
without ever touching this tool.

---

## 2. Website Template — how it works

`website-template/index.html` is the file the builder starts from and
edits. You generally shouldn't need to open it, but if you ever want to
add a new field:

- All customizable content lives in one `SITE_CONTENT` object near the top
  of the first `<script>` block, between the `/* SITE_CONTENT_START */`
  and `/* SITE_CONTENT_END */` comments. The builder tool finds these two
  markers and swaps out everything between them — don't remove or rename
  them.
- A `renderSiteContent()` function reads that object and fills in the page
  on load (headings, repeatable cards, colours via CSS custom properties,
  etc).
- After that, `applySchoolInfoToSite()` (unchanged from before) still runs
  and can live-override name/logo/tagline/address/phone/email from the
  ERP's own School Profile screen — so a school can keep those few fields
  current without going back to the builder.

If you add a field to `SITE_CONTENT`, add the matching bit of markup/ids in
the HTML and a line in `renderSiteContent()`, then add the matching field
to `FORM_SCHEMA` in `website-builder.html` (and to `defaultContent()`
there too) — then re-run the embed step below.

**Re-embedding the template into the builder** (only needed if you edit
`website-template/index.html` itself): the builder keeps its own full copy
of the template as a JSON string so it never needs network access. Rebuild
it with:

```bash
node -e "
const fs = require('fs');
const template = fs.readFileSync('website-template/index.html', 'utf-8');
let builder = fs.readFileSync('website-builder.html', 'utf-8');
const marker = 'const TEMPLATE_HTML = ';
const startIdx = builder.indexOf(marker);
const afterMarker = startIdx + marker.length;
const endIdx = builder.indexOf(';\n\n/* =========================================================================\n   DEFAULT CONTENT', afterMarker);
let jsonStr = JSON.stringify(template).replace(/<\/script/gi, '<\\\\/script');
builder = builder.slice(0, startIdx) + marker + jsonStr + builder.slice(endIdx);
fs.writeFileSync('website-builder.html', builder);
console.log('done');
"
```

(The `<\/script` escaping matters — without it, a literal `</script>` tag
anywhere inside the embedded template would break the builder page itself.)

---

## 3. Vendor Dashboard — your fleet overview

`vendor-dashboard/` is a small, separate deployable service (its own
database, its own login) — this is where **you** log in to see every
school you've onboarded: how many, which are still temporary/trial vs.
permanent, which are online right now, and recent errors.

### Deploying it

Same shape as the ERP: a Node/Express service backed by Postgres.

1. Create a new Neon (or any Postgres) database and a new Render Web
   Service (or similar host) pointed at this `vendor-dashboard/` folder.
2. Set the `DATABASE_URL` environment variable to that database's
   connection string.
3. Deploy. On first boot it creates its own tables and prints a one-time
   admin username/password to the service's logs:

   ```
   First run: created the default vendor admin account.
     Username: admin
     Password: <random>
   ```

   Sign in with that once. (There's no in-app "change password" screen
   yet — if you want one, or a way to add more vendor-team logins, that's
   a natural next addition.)

### Using it

- **+ Add School** — name, ERP URL, website URL, status (Temporary/Trial
  or Permanent), onboarded date, notes. Saving issues an **API key** for
  that school — shown right there, with a Copy button. This is what goes
  into that school's `VENDOR_API_KEY` (see the reporting client below).
- The schools table shows a live health dot (online / idle / offline /
  never reported) based on how recently that school's server last sent a
  heartbeat, plus a 24-hour error count.
- Click **Errors** on any school to see its recent error reports
  (message + stack trace).
- Click **Edit** to update details, re-view or **regenerate** that
  school's API key (old key stops working immediately — update the
  school's env var if you rotate it), or delete the school from the
  registry.
- The dashboard auto-refreshes every 30 seconds while open.

"Temporary" vs. "Permanent" is a status **you** set — it's a business
decision (trial vs. paid/live), not something the system can detect on
its own.

---

## 4. Reporting Client — wiring a school in

`reporting-client/vendor-reporting.js` is a small, **optional** file a
school's ERP `server.js` can import to report its status to your
dashboard. It's entirely opt-in per deployment and fails silently — a
school you haven't configured, or whose report can't reach the dashboard
(asleep, offline, whatever), is completely unaffected either way.

**To wire up a school:**

1. Copy `vendor-reporting.js` into that school's project, next to
   `server.js`.
2. Near the top of that school's `server.js`, after the other imports:

   ```js
   import { startVendorReporting, reportVendorError } from './vendor-reporting.js';
   startVendorReporting();
   ```

3. (Optional, recommended) In an existing `catch` block — e.g. the main
   resource handler's — add a line alongside the existing
   `console.error(...)`:

   ```js
   } catch (err) {
     console.error('save error:', err);
     reportVendorError(err, { route: req.path });
   }
   ```

4. In that school's hosting environment, set three environment variables
   (from the dashboard's Add/Edit School screen):

   ```
   VENDOR_DASHBOARD_URL = https://your-vendor-dashboard.onrender.com
   VENDOR_SCHOOL_ID     = sch_xxxxxxxx
   VENDOR_API_KEY       = xxxxxxxxxxxx
   ```

Leaving those three unset (the default, for any school you haven't
onboarded into the dashboard) means this file does nothing at all — no
network calls, no log noise.

It sends a heartbeat every 5 minutes (with basic info: uptime, Node
version), and reports errors (deduplicated — the same error message won't
be re-sent more than once every 5 minutes, so a repeating failure doesn't
flood the dashboard).

---

## What's intentionally out of scope for this first pass

- **Vendor login management** — one seeded admin account; no in-app way
  yet to add teammates or change the password. Worth adding if more than
  one person needs dashboard access.
- **Automatic online/offline alerts** (email/SMS when a school goes
  offline) — the dashboard shows status when you look at it, but doesn't
  yet proactively notify you.
- **Retroactively wiring up already-deployed schools** — the reporting
  client needs to be added to each school's `server.js` and redeployed;
  it can't be turned on remotely for a school that doesn't have it yet.
