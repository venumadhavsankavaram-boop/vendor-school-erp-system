# School Onboarding Runbook

The full path from a filled-in `website-builder.html` form to a live school on Render + Neon — every check, in order, with the exact values this toolkit expects. Work through it top to bottom for each new school you onboard.

A live, checkbox-tracking version of this same runbook is also published at: https://claude.ai/code/artifact/f51f40cf-e868-4f4f-aa9b-a797eac1bef5 (progress saves per-browser there). This file is the durable copy that lives in the repo so it's never lost track of.

---

## 00 — Pre-flight checks

*Before you open `website-builder.html` for this school.*

> **Why this matters:** A real onboarded school once ran for a while with no `WEBSITE_ORIGIN` set — the ERP just kept its hardcoded fallback colours forever, silently. The deploy-zip and `.env`-block tools close most of that gap, but only if you actually reach the steps that use them.

- [ ] You're opening the `website-builder.html` that's inside your `vendor-school-erp-system` repo folder — not one of the older copies in Downloads. (Your Downloads folder has several — `website-builder_1.html` through `_10.html` — from past sessions. Only the repo copy has the deploy-zip and fleet-registration features.)
- [ ] vendor-dashboard is redeployed and reachable at `vendor-school-erp-system.onrender.com`, and you can log in.
- [ ] Decided: is this school **Temporary/Trial** or **Permanent**? (A status you set by hand in vendor-dashboard — a business decision, not something the system detects.)
- [ ] Decided: Plan type and billing (Selected Modules / All Modules / All Modules + Website, billing amount and cycle) — set later in the Add School form, but worth knowing now.
- [ ] Checked your Render account has room for two more services (one Static Site for the website, one Web Service for the ERP) on your current plan. Free-tier web services spin down after 15 minutes idle and take up to ~50s to wake on the next request — decide if that's acceptable for this school at launch, or if the ERP service needs a paid instance type.
- [ ] Checked your Neon account has room for one more project — each school gets its own, never shared.
- [ ] The school has approved final content: name spelling, logo file, the four brand colours, address, phone, admissions wording, leadership names/photos. Changing any of this after launch means re-running the builder and redeploying both the website and the ERP theme — not a quick edit.
- [ ] Decided whether this school takes online fee payments (Razorpay) and/or has a biometric attendance device — or whether both wait until later. *(optional, can add anytime)*

---

## 01 — Reserve names & predict URLs

*Before filling in the website builder.*

A Render service's URL is just `https://<service-name>.onrender.com` — fixed the moment you name it. Deciding names now means you can put the ERP's real URL into the website builder before the ERP exists.

| What | Naming pattern | Example |
|---|---|---|
| School slug | lowercase, hyphenated | `sunrise-public` |
| Website GitHub repo | `<slug>-website` | `sunrise-public-website` |
| Website Render URL | `https://<slug>-website.onrender.com` | `https://sunrise-public-website.onrender.com` |
| ERP GitHub repo | `<slug>-erp` | `sunrise-public-erp` |
| ERP Render URL | `https://<slug>-erp.onrender.com` | `https://sunrise-public-erp.onrender.com` |

- [ ] Chosen a school slug and written down both predicted URLs above.
- [ ] Created the two empty GitHub repos (`<slug>-website`, `<slug>-erp`) so they're ready to push into later. *(Skip this if you have the GitHub CLI — `gh repo create <name> --private --source=. --remote=origin --push`, run from inside the already-populated folder, creates the repo and pushes in one step. See Phase 05.)*

> **If a name is already taken:** Render will refuse it and hand you a slightly different URL. Update your notes immediately so every later step uses the real one — a mismatched `WEBSITE_ORIGIN` or ERP URL fails closed (CORS blocks the call) rather than loudly, so it's easy to miss.

---

## 02 — Build the website

*`website-builder.html`*

- [ ] Filled in every section: identity, colours, Design Style + Hero Pattern, hero/welcome, history, academics, facilities, leadership, testimonials, admissions, contact.
- [ ] The ERP URL field is set to the **predicted** ERP URL from Phase 1, not left blank.
- [ ] The yellow "still needs attention" checklist box at the top is empty.
- [ ] Clicked **Save Content (.json)** and kept the file — this is your only editable backup of everything you just typed.
- [ ] Clicked **Download Website** → got this school's `index.html`.
- [ ] In the Colour Palette section, clicked **Download theme.json**.

---

## 03 — Deploy the website

*GitHub + Render Static Site*

- [ ] Pushed `index.html` and `theme.json` to the `<slug>-website` repo, same folder structure your other school-website repos use.
- [ ] Created a Render **Static Site** from that repo, named exactly the slug you predicted in Phase 1.
- [ ] Publish directory points at wherever `index.html` actually landed (repo root, or a `public/` folder — whichever matches what you pushed).
- [ ] Deploy finished, and the real URL matches your Phase 1 prediction exactly.
- [ ] Added the CORS header: Settings → Headers → Path `/theme.json`, Name `Access-Control-Allow-Origin`, Value `*`. (Without this, the ERP's automatic colour sync can't read this file from a different origin.)

---

## 04 — Create the database

*Neon*

- [ ] Created a brand-new Neon Postgres project for this school — never shared with another school.
- [ ] Copied its connection string somewhere safe — this is the one value nothing in this toolkit can generate for you.

---

## 05 — Build the ERP deploy package

*`website-builder.html` — one zip, no merging*

> **What the zip is now:** The **⬇ Download complete ERP repo (.zip)** button produces the *entire* `<slug>-erp` repo — `server.js`, `package.json`, `vendor-reporting.js`, `vendor-support-login.js`, `biometric-bridge/`, and a `public/` folder already carrying this school's colours, logo-based launch icons, and `manifest.json`. There's no separate `erp-template/` folder to copy or merge by hand any more — the zip *is* the repo. (If you're on an older copy of `website-builder.html` that still says "erp-template deploy package," update to the current one — this is the one thing that changed shape.)

- [ ] In website-builder.html's Colour Palette section, clicked **⬇ Download complete ERP repo (.zip)**.
- [ ] Extracted it into a **brand-new, empty** folder named `<slug>-erp` — not into an existing repo folder.
- [ ] Read `README-DEPLOY.txt` from the zip — it recaps every remaining step below, specific to this school's export.
- [ ] Pushed it to GitHub — pick one:
  - **A) Easiest:** run the `deploy.ps1` script bundled in the zip — `.\deploy.ps1 -RepoName "<slug>-erp"`. It runs `git init/add/commit` for you, then (if the GitHub CLI is installed and logged in) creates the repo and pushes, all in one step.
  - **B) By hand:** `git init && git add . && git commit -m "Initial ERP for <school>"`, then `gh repo create <slug>-erp --private --source=. --remote=origin --push`.
  - **C) Fully manual (no GitHub CLI):** after the `git init/add/commit` above, create an empty repo at github.com/new (no README/.gitignore/license), then `git remote add origin <url>`, `git branch -M main`, `git push -u origin main`.

---

## 06 — Deploy the ERP

*Render Web Service*

- [ ] Created a Render **Web Service** from the `<slug>-erp` repo, named exactly the slug you predicted in Phase 1.
- [ ] Environment: Node. Build command `npm install`. Start command `npm start`.
- [ ] Real deployed URL matches your Phase 1 prediction — and matches the ERP URL you typed into the website builder in Phase 2.
- [ ] Not deploying environment variables yet — that's Phase 7, once vendor-dashboard has issued this school's API key.

---

## 07 — Register in vendor-dashboard & complete the `.env`

*`website-builder.html` → vendor-dashboard → Render environment*

- [ ] Back in website-builder.html's Colour Palette section, clicked **🔗 Register this school in vendor-dashboard**.
- [ ] Reviewed the pre-filled Add School form (name, ERP URL, website URL, contact email/phone) and clicked Save.
- [ ] Copied the generated **.env block** that appears next to the new API key.
- [ ] Filled in the one placeholder the block can't generate: `DATABASE_URL`, from Phase 4.
- [ ] Pasted the completed block into the ERP's Render service → Environment tab, and saved (this triggers a redeploy).

| Variable | Where it comes from |
|---|---|
| `DATABASE_URL` | Neon, Phase 4 — the only one you type in by hand |
| `WEBSITE_ORIGIN` | Auto-filled from this school's website URL |
| `VENDOR_DASHBOARD_URL` | Auto-filled — your dashboard's own address |
| `VENDOR_SCHOOL_ID` | Auto-filled — issued the moment you saved in step 2 above |
| `VENDOR_API_KEY` | Auto-filled — same moment as the school ID |
| `RAZORPAY_KEY_ID` / `RAZORPAY_KEY_SECRET` | Commented placeholder — only if this school takes online payments |
| `BIOMETRIC_API_KEY` | Commented placeholder — only if a device is set up (Phase 9) |

---

## 08 — First boot & verification

*Right after the Render redeploy from Phase 7 finishes.*

- [ ] Opened the ERP's deploy log and found the one-time `admin` password it prints on first boot.
- [ ] Signed in with it, immediately set a real password, and saved the recovery code (Users & Roles).
- [ ] Confirmed the login screen and sidebar are actually themed in this school's colours, not the generic default — proof `WEBSITE_ORIGIN` and the theme-sync fetch are both working.
- [ ] Back in vendor-dashboard's Schools tab, this school's health dot has gone from "never reported" to online, within a few minutes.
- [ ] On the live website, submitted a test admission enquiry and confirmed it reaches the ERP (no CORS error in the browser console).
- [ ] Notice board and photo gallery sections on the website show live (even if empty) rather than a broken/error state.

---

## 09 — Optional integrations

*Skip if not needed yet.*

- [ ] **Online payments** — set `RAZORPAY_KEY_ID` and `RAZORPAY_KEY_SECRET` from this school's own Razorpay account, redeploy, confirm the "💳 Pay Online" button appears on the Fees tab.
- [ ] **Biometric attendance** — set `BIOMETRIC_API_KEY`, then walk the school through `erp-template/biometric-bridge/README.md` to get the bridge agent running on an office PC on the same local network as the device.
- [ ] **Support Login** needs no extra setup for a school built from the current `erp-template` — `vendor-reporting.js` and `vendor-support-login.js` are already copied in and wired to `server.js`; the three `VENDOR_*` variables from Phase 7 are all it needs. Confirmed by clicking **Support Login** on this school in vendor-dashboard and landing in its ERP as Vendor Support.

---

## 10 — Go-live QA & handover

- [ ] Checked the website on an actual phone, not just a resized browser window — this is how most parents will open it.
- [ ] Logged into the ERP as each role the school will actually use (Admin at minimum; Teacher/Parent/Student if you have test accounts) and clicked through their main screens.
- [ ] If free-tier Render: told the school the first visit after a quiet period can take up to ~50 seconds to wake up — so it isn't reported back to you as "broken."
- [ ] Gave the school office the admin login and pointed them to School Profile (for logo/address) and Communications (for the notice board and gallery) — the parts they'll update themselves.
- [ ] Set this school's status (Temporary/Trial vs Permanent) and, if billing, raised its first invoice in vendor-dashboard's Billing tab.
- [ ] Filed away the saved `<school>-content.json` from Phase 2 somewhere you'll find it next time this school's content changes.

---

*Checklist state in the [live artifact version](https://claude.ai/code/artifact/f51f40cf-e868-4f4f-aa9b-a797eac1bef5) saves to whatever browser has it open — it isn't shared across devices. This file is the durable, version-controlled copy: check it back in whenever a phase's steps change.*
