# Vendor-School-ERP System

A standalone toolkit for turning the school ERP + website template into a
product you can hand off to multiple schools, and for keeping track of
every school you've onboarded. This is a separate project from any single
school's live deployment (like Raghavan EM High School's own ERP/website) —
nothing here is wired into those repos, and nothing in those repos depends
on this. `erp-template/` started life as a cleaned-up copy of Raghavan's
ERP code (school-specific names/URLs/sample data removed, everything
per-school made an environment variable or a runtime setting) — but it's a
one-way copy, not a live link: editing this template never touches
Raghavan's actual deployment, and vice versa.

Five independent pieces:

```
vendor-school-erp-system/
├── website-template/index.html   The public website, content-driven (SITE_CONTENT)
├── website-builder.html          Local tool: fill in a school's content, download the finished site
├── erp-template/                 The school ERP itself — deploy one fresh instance per school
│   ├── public/index.html           Frontend: login, dashboard, every module (single file, like the website)
│   ├── public/manifest.json, sw.js, icon-*.png   PWA installability (Add to Home Screen)
│   ├── server.js                   Express + Postgres backend — all secrets/URLs via env vars
│   ├── vendor-reporting.js,        Fleet reporting + Support Login — already wired into server.js,
│   │   vendor-support-login.js       just needs the VENDOR_* env vars once a school's in the dashboard
│   └── package.json
├── vendor-dashboard/             Deployable service: your fleet overview — schools, billing,
│                                  support queries, health/errors, and troubleshooting access
└── reporting-client/             Optional snippets a school's ERP can use to talk to the dashboard
    ├── vendor-reporting.js         heartbeat, error reports, and support queries
    └── vendor-support-login.js     accepts a vendor-issued troubleshooting login link
```

---

## 1. Website Builder — onboarding a new school

`website-builder.html` is a single file you open directly in a browser
(double-click it, or drag it into a browser tab — no server, no install,
nothing is uploaded anywhere). It has every customizable field the school
website supports:

- School name, logo, tagline/motto, district & state
- Colour palette (4 pickers — every button, icon, and heading follows these).
  Uploaded a logo already? Click **Use colours from the logo** in that
  section to have the builder sample the logo's own colours client-side
  (nothing is uploaded anywhere) and fill in a matching, vibrant 4-colour
  palette — you can still fine-tune any of the four afterwards.
- Design Style (one dropdown — Classic / Modern / Bold / Airy) — see below.
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

**A checklist keeps you from shipping unfilled fields.** A yellow box above
the form lists any of the handful of fields that would look obviously wrong
live — school name, tagline, district/state, address, footer tagline, ERP
URL, a leadership member still literally named "Leader Name", "Our History"
still showing its example story — whenever they still match the tool's
starting placeholder text. It updates as you type and disappears once
everything on it is filled in; each item is clickable and jumps straight to
that section. It's deliberately short — fields where the sensible default
is a legitimate choice (most admissions wording, facility descriptions)
aren't flagged, since only the fields that always look like a mistake if
left untouched are worth interrupting you about. This exists because
downloading before finishing a couple of fields is exactly the kind of easy
mistake a real onboarding run turned up.

**Uploaded photos are resized and compressed automatically.** Every image
you upload (logo, welcome photo, leadership photos) gets embedded into the
downloaded file as a data URI, so an unresized phone photo can add several
MB to the page. The builder now resizes to a sensible max dimension and
re-encodes before it's stored — a multi-MB phone photo typically shrinks by
95%+ with no visible quality loss at the size it's actually displayed —
without you having to think about it. A logo (or anything else) that needs
transparency is always kept as PNG, never flattened to JPEG; if resizing
would somehow make a file larger than the original (occasionally true for
a very simple, already tiny graphic), the original is kept instead — an
upload never gets bigger than what you put in.

**A live Mobile/Desktop toggle above the preview** narrows the preview pane
to a phone-width column so you can sanity-check how the site reads on a
phone — where most parents will actually open it — before downloading.

**The downloaded file now shows real content immediately, not just once its
JavaScript runs.** Previously, the *initial* HTML markup of every downloaded
site — before its own script had a chance to run — still contained the
template's generic placeholder text ("Your School Name", "Welcome to Your
School", "Your school address..."), with the real content only appearing
once a real browser executed `renderSiteContent()`. Invisible in practice
in a normal browser, but it has two real costs: a search engine or a
link-preview crawler that doesn't run JavaScript indexes the placeholder
text instead of the school's actual name and address, and any raw-HTML
inspection tool looks "broken" even on a perfectly working, correctly
deployed site (this is exactly the false alarm that played out during a
real onboarding session — a debugging tool that only reads raw HTML kept
reporting placeholder content on a site that was, by that point, actually
deploying correctly). **Download Website** now renders the finished file in
a hidden, disconnected iframe first — letting the template's own
`renderSiteContent()` do the actual work, so there's no second copy of that
rendering logic to maintain — and downloads the fully-rendered DOM instead
of the pre-render markup. The live ERP-fetched notice board and photo
gallery are untouched either way (they're always empty in the initial
markup regardless, filled in by their own fetch the moment a real visitor's
browser loads the page), so nothing about that live-refresh behaviour
changes. This never blocks or delays a download in practice — any failure,
or a slow/unreachable network fetching fonts, falls back to the previous
(un-baked) behaviour after a short timeout, so the button always produces a
file.

**Link previews and search snippets now show the school's own name and
description**, not generic template text: the exported page carries a meta
description plus Open Graph/Twitter title and description tags, kept in
sync with the hero/welcome text, and a browser-tab favicon generated from
the uploaded logo. (`og:image`/`twitter:image` are intentionally not set —
they'd need to point at a real hosted URL for WhatsApp/Facebook/etc. to
actually fetch them, and a data URI doesn't work for that; wiring up a real
hosted preview image is a reasonable future addition once these sites have
a stable place to host one.)

**Colour extraction, and why different logos now actually look different.**
"Use colours from the logo" samples the uploaded image on a `<canvas>`
client-side and derives a 4-colour palette from it. The first version of
this made many logos converge on similar-feeling palettes, for two reasons
that are both fixed now: it force-matched every extracted colour to the
closest of three *fixed* target hues and then clamped it into a narrow,
almost-identical tone per role; and when a logo didn't have four distinct
real colours (very common for subtle or black-and-white school crests), the
missing ones were synthesized from one fixed base hue with one fixed
rotation, so most low-colour logos landed on the exact same fallback
palette. The extractor now keeps each found colour's own hue, saturation,
and lightness (only widened into a usable range, never clamped to one
value), and — when it has to synthesize hues because a logo doesn't have
enough real colour — seeds that synthesis from a fingerprint of the logo's
own pixel bytes instead of a constant, so two different low-colour logos
still end up with two different palettes. If a logo really is 100%
transparent (a broken/blank file), the button still reports that plainly
and leaves the four pickers for manual entry.

**Design Style & Hero Pattern — making the site's structure vary too, not
just its colour.** A shared colour extractor still leaves every school on
the exact same layout, corner shapes, card borders, hero background, and
heading font — a real fix for "different logos, same-looking site" needed
both a better palette *and* a genuinely different structure to put it in.
The **Design Style** section (right after Colour Palette) has two
independent dropdowns that combine, so there's real headroom for a vendor
onboarding many schools to keep them looking distinct from each other:

  - **Style** — corner radii, card borders/shadows, section spacing, and
    heading font:
      - **Classic** — soft rounded cards with drop shadows, pill-shaped
        buttons, Baloo 2 headings.
      - **Modern** — sharp corners, top-accent-bordered cards with no
        shadow, Space Grotesk headings.
      - **Bold** — thick chunky borders, large rounded corners, Fraunces
        (serif) headings, tighter section spacing.
      - **Airy** — extra-rounded corners, lighter shadows, more section
        whitespace, Quicksand headings.
  - **Hero Pattern** — just the hero banner's own background (and, for
    Dark Band, its text colour) — completely independent of Style, so any
    of the 4 styles above pairs with any pattern below:
      - **Dotted** — the original soft dot-grid.
      - **Grid** — crisp graph-paper lines.
      - **Dark Band** — a dark gradient band with light hero text.
      - **Glow** — soft multi-colour radial blobs.
      - **Wave** — a tint capped by a curved shoreline.
      - **Confetti** — scattered multi-colour dots.
      - **Stripes** — bold diagonal ribbons.
      - **Solid** — flat, no decoration.

That's 4 × 8 = 32 structural combinations before colour even enters the
picture, and every one of them still reads the same four colours from the
Colour Palette section (`--navy`/`--gold`/`--magenta`/`--teal`, set by
`applyColors()`) — switching Style or Hero Pattern never touches colour.
So the fixes stack three ways: two schools can share a Style/Pattern and
still look distinct because their palettes differ (the colour-extraction
fix above), or share a palette and still look structurally distinct
because their Style/Pattern differ (this fix), or, most of the time now,
differ on all three at once. Both choices are stored as `theme.styleVariant`
and `theme.heroPattern` in the saved content (so they round-trip through
Save/Import) and applied at runtime by `applyStyleVariant()` /
`applyHeroPattern()` in the website template, via `data-style` and
`data-pattern` attributes on `<body>` — the same way colours are applied
by `applyColors()`. Nothing about either is baked into the static HTML at
download time, so re-opening a saved school's content and changing either
one later works exactly like changing a colour.

Notice board and photo gallery are **not** part of the builder — those
already flow live from the school's own ERP (Communications → Website
Gallery, and the notice board), so a school updates those themselves
without ever touching this tool.

**Carrying the same colours and background pattern into that school's ERP.**
The ERP's login screen and its sidebar/chrome (the rest of the admin
dashboard's own screens keep their fixed colours, since several of them
double as meaningful status colours in attendance/exams/etc.) read four CSS
variables reserved for this — `--login-accent`, `--login-accent-deep`,
`--login-accent-soft`, and `--login-accent-rgb` — near the top of the ERP's
`<style>` block. `--brand-navy`/`--brand-navy-deep` (sidebar background,
active nav/page states, avatar placeholders, etc.) are aliased straight to
these, so setting the four is enough to re-theme the login screen *and* the
rest of the app's chrome together. The login screen and sidebar also carry
the same soft dot-grid texture used behind the website's own hero and
facilities bands, tinted with `--login-accent-rgb`, so both surfaces read as
one product rather than a themed login bolted onto a generic dashboard.

**This is automatic, not something you hand-copy every time colours change**
— once it's set up. The mechanism is a small theme-sync script (search an
ERP's `<head>` for "AUTOMATIC WEBSITE THEME SYNC") that fetches
`theme.json` from the school's own website on every page load and computes
those four variables itself — same formula the website uses, both light
and dark mode. After the one-time setup below, updating colours for a
school that's already onboarded is just: change them in the builder →
**Download Website** → **Download theme.json** (Colour Palette section) →
upload both files to the website's repo, same commit as always. The ERP is
never opened or redeployed again for a colour change.

**Onboarding a brand-new school — use the full snippet, not a manual edit.**
The Colour Palette section's "Matching ERP theme" box has a field for that
school's website URL (fill it in once you know it — even a placeholder
value, revisited later, is fine) and a **📋 Copy full ERP snippet** button
below it. That snippet is a complete, self-contained `<style>` + `<script>`
block — today's colours already baked in as CSS, *and* the theme-sync
script already pointed at that school's URL — ready to paste as-is into
the new ERP's `<head>`. Paste it once, then just one Render setting
remains: on the **website's** Render Static Site → **Settings → Headers**,
add Path `/theme.json`, Name `Access-Control-Allow-Origin`, Value `*` (so
the ERP, a different origin, is allowed to read the file). Finally
download **theme.json** from the same section and upload it to the
website's repo alongside `index.html`.

This exists because the previous path — manually finding
`var WEBSITE_ORIGIN = '';` inside a specific ERP's minified-looking `<head>`
and hand-typing the URL in — is exactly the kind of single-line edit that's
easy to leave blank and forget, and it fails *silently*: with no
`WEBSITE_ORIGIN` set, the ERP just keeps its hardcoded fallback colours
forever, no error, nothing that looks broken at a glance. (This is
precisely what happened on a real onboarded school before this snippet
existed — worth a spot-check on any school onboarded before this button
was added: open that ERP's `<head>` and confirm `WEBSITE_ORIGIN` is
actually set to something.) Baking the URL into a copy-paste block removes
the chance to forget it.

If a school's ERP genuinely can't run the sync script at all, the box also
has a collapsed "paste the CSS in by hand instead" fallback with just the
four values as literal CSS (light + dark) — a one-off manual patch for
that edge case, not the normal path, and you'll need to redo it by hand
every time colours change.

**Deploy package & fleet registration — turning the manual steps above into
one click.** The same "Matching ERP theme" box now also has a **⬇ Download
erp-template deploy package (.zip)** button. It builds a complete,
ready-to-push `public/` folder for that school's ERP — `index.html` (this
builder's own embedded copy of `erp-template/public/index.html`, with that
school's four `--login-accent*` values already substituted in, so there's
no separate paste-the-snippet step), `sw.js`, a generated `manifest.json`,
all four launch icon PNGs, and a `README-DEPLOY.txt` walking through the
handful of steps a zip genuinely can't do for you (creating the Neon
database, setting the `/theme.json` CORS header on the website's Render
Static Site, and registering the school below). Unzip it over a fresh copy
of `erp-template/`'s `public/` folder and push like any other ERP code
change. Next to it, a **🔗 Register this school in vendor-dashboard**
button opens your Vendor Dashboard in a new tab with its **+ Add School**
form already pre-filled from what you've entered here (name, ERP URL,
website URL, contact email/phone) — see "Onboarding a new school's ERP"
below and Vendor Dashboard's Schools tab for what happens next. (Both
buttons work from whatever's currently filled in, so they're most useful
once the school's name, contact info, and at least a placeholder ERP/website
URL are in — nothing stops you from using them earlier and re-downloading
later once the real URLs are known.)

The login screen's logo (`loginLogoImg`) is no longer a manual code swap —
it now reads live from that school's own **Initial Setup → School Profile**
upload, same as the sidebar logo, so uploading a logo once in the ERP is
enough; nothing in the ERP's HTML needs hand-editing for a logo change.
`erp-template`'s baked-in *default* logo (shown for a split second before
that upload loads) is a neutral generic mark, not any specific school's real
logo — worth a spot-check on any ERP cut from this template before that fix
existed, since it briefly showed Raghavan's actual logo to every new school
until this was caught and corrected.

**Unique home-screen icon and launch/splash screen per school.** Every ERP
used to ship the exact same baked-in PWA icon regardless of which school it
belonged to — harmless with one school, confusing with several side by
side. The Colour Palette section's "Matching ERP theme" box (same place as
the colour-sync tools above) has a **⬇ Download launch icons +
manifest.json** button: it generates `icon-192.png`, `icon-512.png`, and
their maskable variants from that school's own uploaded logo composited on
its primary colour (client-side canvas, nothing uploaded anywhere), plus a
matching `manifest.json` with that school's name and theme colour. No logo
uploaded yet? It falls back to the school's own first initial instead of a
shared placeholder — never another school's identity. Replace the four PNGs
and `manifest.json` in that school's `erp-template/public/` folder with the
downloaded files, then redeploy — same push-to-GitHub flow as any other ERP
code change.

**"Best look" redesign — elevating the generated site itself, not just the
builder tool.** Beyond the Style/Pattern/colour system above, the template
was reworked against patterns from top-tier education websites (full-bleed
photography, confident typography, animated proof points, real voices,
persistent conversion paths) so every school benefits regardless of which
Style it's on:

  - **Photo hero pattern** — a 9th Hero Pattern option: a full-bleed campus
    photo behind the hero text with a dark gradient scrim, instead of a flat
    or decorative background. Needs its own upload — a new **Hero Background
    Photo** image field, right above the Hero Pattern dropdown — and if
    "Photo" is selected but nothing's uploaded yet, the site quietly falls
    back to the Glow pattern instead of showing an empty dark hero (so a
    half-finished school never looks broken; picking Photo again once a
    photo's uploaded restores it).
  - **Animated stat counters** — the hero's stat row (students, grade
    levels, etc.) counts up from 0 the moment it scrolls into view, once,
    on a real page load. The downloaded file is unaffected: counters only
    ever touch their displayed number at the instant they're actually
    observed on-screen, so the static file's initial text is always the
    real final value, never a placeholder.
  - **Testimonials ("Voices")** — a new content section, between Leadership
    and Admissions, for 3 short parent/student quotes (name, role, quote).
    Its own `FORM_SCHEMA` section in the builder, with the usual
    still-the-example-quotes checklist warning.
  - **Elevated header** — a proper **Enquire Now** button in the nav bar
    (previously defined in CSS but never actually used), and the header
    now condenses (slightly shorter, more opaque) once the page is
    scrolled, rather than sitting at full height the whole way down.
  - **Working mobile navigation** — the hamburger menu shown on narrow
    screens is now actually wired up (previously present in the stylesheet
    but with no markup or click handling at all, so mobile nav was
    completely inaccessible before this pass). Tapping it drops down the
    full nav list; tapping a link closes it again.
  - **Scroll-reveal micro-animations** — section headers and cards fade/lift
    in as they scroll into view. This is purely additive JavaScript
    (a `.reveal-visible` class an `IntersectionObserver` adds); a page with
    JavaScript disabled, or `prefers-reduced-motion` turned on, shows every
    section fully visible immediately, and the builder's own downloaded
    file is always captured in the fully-visible state too (never frozen
    mid-fade) — see `bakeStaticHtml()`'s `__BAKE_MODE__` flag.
  - **Back-to-top button and a mobile sticky "Enquire" bar** — both appear
    only after scrolling past the hero, so they don't clutter the first
    screen a visitor sees.

None of this changes what content exists or how it's structured in the
downloaded file for a no-JavaScript visitor or a search-engine crawler —
only how it's revealed to a real browser. All of it is orthogonal to Style
and Hero Pattern, so it applies the same way regardless of which
combination a school is using.

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

**Re-embedding the templates into the builder.** The builder keeps its own
full copies of both `website-template/index.html` (as `TEMPLATE_HTML`) and
`erp-template/public/index.html` + `sw.js` (as `ERP_TEMPLATE_HTML` /
`ERP_SW_JS`) as JSON strings, so it never needs network access and the
"Download erp-template deploy package" button above always has something
to substitute colours into. Whenever you edit any of those three source
files, re-embed **all** of them so the builder's copies don't drift out of
sync — `computeErpTemplateFile()` (which does the colour substitution for
the deploy zip) deliberately throws rather than silently substituting into
stale HTML if `erp-template/public/index.html`'s "PER-SCHOOL BRANDING"
block has moved or changed shape since the last re-embed, so this is
noisy-fail, not silent-drift — but re-embedding after every source edit is
still the right habit.

Only editing `website-template/index.html`? Re-run just that first block
below. Only `erp-template/`? Just the second. Changed both? Run both, in
either order.

```bash
node -e "
const fs = require('fs');
const template = fs.readFileSync('website-template/index.html', 'utf-8');
let builder = fs.readFileSync('website-builder.html', 'utf-8');
const marker = 'const TEMPLATE_HTML = ';
const startIdx = builder.indexOf(marker);
const afterMarker = startIdx + marker.length;
// The embedded JSON string can never contain a raw newline byte (JSON.stringify
// always escapes one as the two characters \\n), so the first \";\\n after the
// marker can only be this statement's own closing quote — safe regardless of
// what follows it in the file (DEFAULT CONTENT, the ERP block, or anything
// added later).
const quoteEnd = builder.indexOf('\";\n', afterMarker);
const endIdx = quoteEnd + 1; // index of the closing ';'
let jsonStr = JSON.stringify(template).replace(/<\/script/gi, '<\\\\/script');
builder = builder.slice(0, startIdx) + marker + jsonStr + builder.slice(endIdx);
fs.writeFileSync('website-builder.html', builder);
console.log('done: TEMPLATE_HTML');
"
```

```bash
node -e "
const fs = require('fs');
const erpHtml = fs.readFileSync('erp-template/public/index.html', 'utf-8');
const erpSw = fs.readFileSync('erp-template/public/sw.js', 'utf-8');
let builder = fs.readFileSync('website-builder.html', 'utf-8');
const htmlMarker = 'const ERP_TEMPLATE_HTML = ';
const htmlStart = builder.indexOf(htmlMarker);
const htmlAfter = htmlStart + htmlMarker.length;
const swMarker = 'const ERP_SW_JS = ';
const htmlEnd = builder.indexOf(';\n' + swMarker, htmlAfter);
const swStart = htmlEnd + 1 + swMarker.length;
const swQuoteEnd = builder.indexOf('\";\n', swStart);
const swEnd = swQuoteEnd + 1; // index of the closing ';'
const htmlJson = JSON.stringify(erpHtml).replace(/<\/script/gi, '<\\\\/script');
const swJson = JSON.stringify(erpSw).replace(/<\/script/gi, '<\\\\/script');
builder = builder.slice(0, htmlStart) + htmlMarker + htmlJson + ';\n' + swMarker + swJson + ';' + builder.slice(swEnd + 1);
fs.writeFileSync('website-builder.html', builder);
console.log('done: ERP_TEMPLATE_HTML + ERP_SW_JS');
"
```

(The `<\/script` escaping matters in both — without it, a literal
`</script>` tag anywhere inside an embedded template would break the
builder page itself. Both scripts were verified to round-trip
byte-for-byte against the current file — re-run against copies before
trusting a modified version of either.)

---

## 3. ERP Template — the school's admin/staff/parent portal

`erp-template/` is the other half of what a school gets, alongside its
website: the actual ERP — login, dashboard, attendance, fees, exams,
staff, admissions, and everything else a school runs day to day. Same
philosophy as `website-template/`: one shared codebase, deployed fresh per
school, with everything that varies between schools (name, logo, colours,
database, integrations) coming from *data* or *environment variables*,
never from a code edit.

**What's already dynamic, out of the box** — none of this needs touching
per school:
- School name, logo, address, and tagline — all read from a `school_info`
  database row at runtime (same pattern as `SITE_CONTENT` on the website),
  editable from inside the ERP itself (School Profile) once it's running.
- Colours and the login screen's background pattern — pulled live from the
  school's *own website* via the same "AUTOMATIC WEBSITE THEME SYNC"
  mechanism described under Website Template above (`theme.json` +
  `WEBSITE_ORIGIN`), so a colour change never means redeploying the ERP.
- Every export/download filename (Excel templates, student list, full
  JSON backup) is named after *this* school (`slugifySchoolName()` on the
  frontend, an equivalent lookup in `server.js`'s `/api/backup`) — never
  hardcoded to whichever school this template was last edited for.
- The first admin account: on a genuinely empty database, `server.js`
  creates a default `admin` user on first boot and prints a one-time
  password to the server's startup log (see it in Render's deploy logs) —
  no manual database setup needed before a new school can log in for the
  first time.

**What you set once per school**, all via environment variables on that
school's Render service (never a code edit to `index.html`/`server.js`):

| Variable | What it's for |
|---|---|
| `DATABASE_URL` | This school's own Neon Postgres connection string — a brand-new Neon project per school, never shared. |
| `WEBSITE_ORIGIN` | That school's public website URL (e.g. `https://<school>-website.onrender.com`) — enables the four endpoints the website calls directly (admission inquiries, gallery, notices, school info) and is what the CORS check allows. Leave unset and those calls simply fail closed rather than silently allowing the wrong origin. |
| `RAZORPAY_KEY_ID` / `RAZORPAY_KEY_SECRET` | That school's own Razorpay account, for the "Pay Online" fee flow. Fully optional, and a genuine per-school choice — some schools want to collect fees online, some don't (or aren't ready to yet). Set both and the Student/Parent Fees tab shows a "💳 Pay Online" button that opens Razorpay Checkout; leave either unset and the ERP detects that itself (`GET /api/payments/status`) and hides the button entirely in favor of a plain "please pay at the school office" note — never a button that leads to a dead end. Nothing else about the school's setup needs to change either way, and it can be added later by just setting the two variables and redeploying — no code edit. |
| `BIOMETRIC_API_KEY` | Turns on biometric attendance sync for schools that have a network-connected biometric device (fingerprint/RFID punch machine) in their office. Another genuine per-school choice — most schools won't set this. Set it and the Staff → Attendance area grows a "Biometric Sync" tab, and Staff records grow a "Biometric ID" field to map a staff member to their device enrollment number; leave it unset and the ERP hides all of that (`GET /api/biometric/status`) exactly like the payment flow above. Setting this variable is only half the job — see `erp-template/biometric-bridge/README.md` for the small always-on agent that has to run on a PC on the *same local network* as the device itself (the cloud ERP can't reach into a school's private LAN directly), which is where the matching key actually gets used. |
| `VENDOR_DASHBOARD_URL` / `VENDOR_SCHOOL_ID` / `VENDOR_API_KEY` | Connects this school to your Vendor Dashboard's fleet monitoring, error reporting, and Support Login (see Reporting Client below and Vendor Dashboard's Schools tab, which is where `VENDOR_SCHOOL_ID`/`VENDOR_API_KEY` come from). Optional — leave unset and the school just isn't visible in your dashboard yet; nothing else is affected. |

Unlike earlier per-school clones, `vendor-reporting.js` and
`vendor-support-login.js` are **already copied into `erp-template/` and
wired into `server.js`** — no per-school code edit needed for fleet
reporting or Support Login, just the three `VENDOR_*` environment
variables above once the school exists in your dashboard.

**Onboarding a new school's ERP — the short path, using the wizard:**
1. In `website-builder.html`, fill in the school's details (name, colours,
   logo, contact info, and — once known — its ERP and website URLs) same
   as always.
2. In the Colour Palette section's "Deploy package & fleet registration"
   box, click **⬇ Download erp-template deploy package (.zip)** — this is
   the themed `public/` folder (see "Deploy package & fleet registration"
   under Website Builder above). Unzip it over a copy of `erp-template/`'s
   `public/` folder in the school's own repo (e.g. `<school>-erp`) and push.
3. Click **🔗 Register this school in vendor-dashboard** — this opens your
   Vendor Dashboard with **+ Add School** already pre-filled from what you
   entered in step 1. Review it and click Save.
4. Vendor Dashboard now shows a **ready-to-paste `.env` block** right next
   to the API key it just issued — `WEBSITE_ORIGIN`, `VENDOR_DASHBOARD_URL`,
   `VENDOR_SCHOOL_ID`, and `VENDOR_API_KEY` all filled in, plus commented
   placeholders for `DATABASE_URL` and the optional `RAZORPAY_*` /
   `BIOMETRIC_API_KEY` variables. Copy it.
5. Create a new Neon Postgres project for this school and fill in
   `DATABASE_URL` in the copied block (this is the one value nothing here
   can generate for you — it doesn't exist until you create the database).
6. Create a new Render **Web Service** from the school's repo (Node,
   `npm start`) and paste the completed block into its Environment tab.
7. Deploy. On first boot the database schema is created automatically and
   a one-time `admin` password is printed to the deploy log — sign in with
   it, then immediately set a real password and save the recovery code
   (Users & Roles) as the login screen's first-run hint says. The
   dashboard should show this school's heartbeat within a few minutes.
8. If this school has a network-connected biometric attendance device and
   wants it integrated, set `BIOMETRIC_API_KEY` (already a commented line
   in the block from step 4 — just uncomment and fill it in) and walk them
   through `erp-template/biometric-bridge/README.md` to get the bridge
   agent running on an office PC — otherwise skip this entirely.

This collapses what used to be a handful of separate manual steps (copying
the theme snippet by hand, generating icons separately, registering in the
dashboard, then hand-typing three `VENDOR_*` values back into the ERP's
environment) into one pass through the builder plus the two things that
can never be automated away — creating the Neon database and pasting its
URL, and giving the dashboard a human review-and-save moment before a
school is added to your fleet. The older fully-manual path (copying
`erp-template/` by hand, pasting the theme snippet, adding the school
first and copying its `VENDOR_*` values back one at a time) still works
exactly as before if you'd rather do any of these steps individually.

**What's in the template today** beyond the modules already listed above:
a full visual pass on the login screen (icon-prefixed fields, a logo badge,
a "Secured sign-in" footer, subtle motion that respects
`prefers-reduced-motion`), a "Fee Collection — Last 6 Months" trend chart
on the dashboard (a dependency-free inline-SVG line chart, in the same
hand-drawn style as the existing donut/bar visuals, reading straight from
the `payments` data the ERP already tracks), and PWA installability
(`manifest.json` + `sw.js` + icon set) so staff and parents can install it
like an app. The service worker deliberately never caches `/api/*` — fee
and attendance data is always fetched live, never served stale from a
cache.

**Note on Raghavan EM High School specifically:** this template was cut
from Raghavan's own ERP code, but Raghavan's *live* deployment is
untouched by any of this — it keeps running exactly as it is, on its own
repo and database. This template is the starting point for the *next*
school onboarded, not a change to Raghavan's existing one. If you'd like
Raghavan's live deployment updated with the same login/dashboard/PWA
improvements, that's a separate, deliberate step (copying the relevant
changes into its actual repo) — ask any time.

---

## 4. Vendor Dashboard — your fleet overview

`vendor-dashboard/` is a small, separate deployable service (its own
database, its own login) — this is where **you** log in to run your whole
fleet of onboarded schools: who they are, what they owe you, what they've
asked for help with, whether they're online, and — when you need to
actually get into one and fix something — a way in.

The dashboard is organized into four tabs:

- **Overview** — summary cards (total/permanent/temporary schools, online
  now, errors in the last 24h, open support queries) plus a merged
  **Recent Activity** feed: the latest errors, support queries, and
  support-login events across every school, newest first.
- **Schools** — the fleet registry (below).
- **Billing** — every invoice you've raised, across every school.
- **Support** — every support query, across every school.

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

### Schools tab

- **+ Add School** — name, ERP URL, website URL, status (Temporary/Trial
  or Permanent), onboarded date, contact person (name/email/phone),
  billing plan/cycle/amount, and notes. Saving issues an **API key** for
  that school — shown right there, with a Copy button. This is what goes
  into that school's `VENDOR_API_KEY` (see the reporting client below) —
  the same key also secures that school's Support Login (see below), so
  there's only ever one key per school to track. Right below the key, a
  **ready-to-paste `.env` block** is generated at the same time —
  `WEBSITE_ORIGIN`, `VENDOR_DASHBOARD_URL`, `VENDOR_SCHOOL_ID`, and
  `VENDOR_API_KEY` already filled in from what you just entered, plus
  commented placeholders for `DATABASE_URL` and the optional
  `RAZORPAY_*`/`BIOMETRIC_API_KEY` variables — paste it straight into that
  school's Render environment once the two placeholders are filled in. The
  same block is regenerated (with a fresh key, if you just regenerated one)
  any time you reopen an already-onboarded school's **Edit** screen, so
  there's no need to have copied it correctly the first time.
- **Opening this page with `#addschool?name=...&erpUrl=...&websiteUrl=...
  &contactEmail=...&contactPhone=...` in the URL** (as built by
  `website-builder.html`'s **🔗 Register this school in vendor-dashboard**
  button — see Website Builder above) opens **+ Add School** already
  pre-filled from those params, so onboarding a school the builder was
  just used for is a review-and-save rather than a re-typing exercise.
  Nothing else about the form changes — it's still a normal save, and
  still the moment you decide this school belongs in your fleet.
- The schools table shows a live health dot (online / idle / offline /
  never reported) based on how recently that school's server last sent a
  heartbeat, a 24-hour error count, and a Billing column (amount + cycle,
  or "—" if that school isn't on a billing plan).
- Click **Errors** on any school to see its recent error reports
  (message + stack trace).
- Click **Edit** to update any of the above, re-view or **regenerate**
  that school's API key (old key stops working immediately — update the
  school's env var if you rotate it, including `vendor-support-login.js`
  if it's wired up), or delete the school from the registry.
- Click **Support Login** (shown once a school has an ERP URL on file) to
  open a temporary troubleshooting session in that school's ERP — see
  "Support Login" below.
- The dashboard auto-refreshes every 30 seconds while open.

"Temporary" vs. "Permanent" is a status **you** set — it's a business
decision (trial vs. paid/live), not something the system can detect on
its own.

### Billing tab

A simple invoice ledger, one row per bill raised: which school, what for,
how much, due when, and whether it's been paid.

- Summary cards: total **Outstanding**, **Overdue** (amount + count —
  computed live from due dates, not a status you set by hand), **Collected
  This Month**, and **Total Invoices**.
- **+ Add Invoice** — pick the school, a description, an amount, an
  optional due date, and a status (Pending/Paid/Cancelled — an invoice
  past its due date while still Pending shows as **Overdue**
  automatically, everywhere in the dashboard).
- **Mark Paid** on any pending invoice stamps it paid immediately, no
  need to open the edit form.
- Filter the table by school and/or status. Edit or delete any invoice
  from its **Edit** button.
- A school's `billing_plan` / `billing_amount` / `billing_cycle` (set from
  its Edit School screen) are just a quick-reference label on the Schools
  tab — they don't generate invoices automatically. Raising the actual
  invoice each cycle is a deliberate action here, by design: it's the
  moment you decide "yes, bill them now," not something that should
  happen silently on a timer.

### Support tab

Every inquiry or issue a school has raised with you, in one place —
whether you typed it in yourself after a phone call, or (once wired up)
a school's own ERP submitted it automatically.

- **+ Log Query** — pick the school, a subject, details, and a priority
  (Low/Normal/High). Use this for anything that came in outside the
  system: a call, an email, a WhatsApp message.
- Click **Open** on any query to see the full thread: the original
  message, every reply so far, and fields to add a new reply/internal
  note and change its status (Open → In Progress → Resolved/Closed) or
  priority. Replies are timestamped and attributed to whichever vendor
  admin wrote them.
- Filter by school and/or status. The **Support** tab in the nav shows a
  live count of open + in-progress queries.
- To have a school's own ERP submit queries here directly (e.g. from a
  "Contact Support" screen in the ERP), see `reportVendorQuery()` in the
  reporting client below — entirely optional, and queries you log
  yourself work exactly the same either way.

### Support Login — troubleshooting a school directly

Sometimes the fastest way to help a school is to just look at their ERP
yourself, logged in — without asking for their password, and without
them having to grant you a login. **Support Login** does that: a
one-time, 10-minute link that opens a school's ERP with a temporary
support session, generated fresh every time you click it.

1. From the **Schools** tab, click **Support Login** on any school that
   has an ERP URL on file.
2. Confirm the prompt — this opens a new browser tab at that school's ERP,
   signed in as a temporary "Vendor Support" session.
3. The link expires after 10 minutes and can only be used once each time
   you generate it; nothing to revoke afterward.
4. Every use is logged — who, which school, when — visible in the
   **Overview** tab's Recent Activity feed and via `GET
   /api/support-logins`. Because this is a genuinely sensitive
   capability (temporary admin-level access into a customer's live data),
   that audit trail is not optional and can't be turned off.

**This requires one-time setup per school**, same spirit as the
reporting client: install `reporting-client/vendor-support-login.js` in
that school's `server.js` (full instructions are in that file's own
header comment) and make sure `VENDOR_API_KEY` is set in that school's
environment — the same key already used for reporting, so there's
nothing new to provision. A school that hasn't had this set up yet simply
can't be Support-Logged-into: the button still works from the dashboard
side, but the link it opens won't do anything until the school's ERP
knows how to accept it.

---

## 5. Reporting Client — wiring a school in

`reporting-client/` has two small, **optional** files a school's ERP
`server.js` can import — `vendor-reporting.js` (heartbeat, errors,
support queries) and `vendor-support-login.js` (accepting a
troubleshooting login link, see "Support Login" above). Both are entirely
opt-in per deployment and fail silently — a school you haven't
configured, or whose report can't reach the dashboard (asleep, offline,
whatever), is completely unaffected either way.

**A school built from `erp-template/` already has both files copied in
and wired up in its `server.js`** — nothing to do here except set the
three `VENDOR_*` environment variables once that school exists in your
dashboard (see ERP Template above). The steps below are for wiring a
school's ERP that *didn't* start from the template — an older one-off
clone, or a codebase from before this template existed.

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
version), reports errors (deduplicated — the same error message won't be
re-sent more than once every 5 minutes, so a repeating failure doesn't
flood the dashboard), and — if that school's ERP calls it — can submit a
support query straight into your Support tab:

```js
import { reportVendorQuery } from './vendor-reporting.js';
reportVendorQuery('Cannot generate report cards', 'Getting a blank page for Class 10.', 'high');
```

For **Support Login** (letting you open this school's ERP for
troubleshooting from the dashboard), see `vendor-support-login.js` — its
own header comment has the exact route to add, and it reuses the same
`VENDOR_API_KEY` set up above, so there's no separate credential to wire
in step 4.

---

## What's intentionally out of scope for this first pass

- **Adding more vendor-team logins** — one seeded admin account, and that
  account can now update its own name/username and change its own
  password (Account button, top right). There's still no in-app way to
  invite a second person — worth adding once more than one of you needs
  dashboard access.
- **Automatic online/offline alerts** (email/SMS when a school goes
  offline) — the dashboard shows status when you look at it, but doesn't
  yet proactively notify you. The same is true of billing: nothing emails
  a school when an invoice is added or falls overdue — the Billing tab is
  where you check.
- **Retroactively wiring up already-deployed schools** — the reporting
  and support-login clients need to be added to each school's
  `server.js` and redeployed; neither can be turned on remotely for a
  school that doesn't have them yet.
- **Recurring/automatic invoicing** — a school's billing plan/amount/cycle
  is a reference label; raising each actual invoice in the Billing tab is
  a deliberate, manual action (see "Billing tab" above for why).
