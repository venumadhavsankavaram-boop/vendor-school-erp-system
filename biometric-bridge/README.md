# Biometric Attendance Bridge

This is a small helper program, **not part of the ERP website itself**. It
runs on an ordinary office PC at the school and quietly copies punch
records from the school's biometric fingerprint/RFID attendance machine
into the ERP, on a schedule, in the background.

## Why this exists at all

The ERP lives on the internet (on Render). The biometric device lives on
the school's own office network, behind their router/Wi-Fi, with no public
address — the same reason you can't visit a school's office printer from
your home computer. There is no way for the ERP, sitting out on the
internet, to reach into the school's private network and pull data from
the device directly.

The fix is this bridge: a small program that runs *inside* the school's
own network (on a PC that's already there — usually the office/admin
computer), where it *can* see the device. It reads new punches from the
device and pushes them out to the ERP, the same direction any normal web
request goes — no router settings, no port forwarding, nothing to
configure on the school's internet connection.

**This is entirely optional.** A school with no biometric device, or one
that doesn't want this integration yet, needs none of this — just leave
`BIOMETRIC_API_KEY` unset on that school's ERP and the whole Biometric
Sync tab stays hidden. Nothing else about their setup is affected.

## What you need before starting

1. A Windows or Linux PC in the school office that is **left on** and
   **connected to the same network** as the biometric device (Wi-Fi or
   Ethernet — either is fine, as long as it's the same local network).
2. [Node.js](https://nodejs.org) installed on that PC (the free "LTS"
   download — a one-time install, a few clicks).
3. The device's IP address on that network. This is usually visible on the
   device's own screen/menu (commonly under something like *Menu → Comm →
   Ethernet*), or you can ask whoever installed the device. It looks like
   `192.168.1.201`.
4. This school's ERP web address (the `https://something.onrender.com`
   link their ERP is deployed at).
5. A `BIOMETRIC_API_KEY` value — make up any long random string (e.g.
   `openssl rand -hex 16` on Mac/Linux, or just mash the keyboard for 20+
   characters) and set it as an environment variable on **that school's
   Render service**. Whatever string you choose there is the exact same
   string you'll put in this bridge's `.env` file in step 3 below — they
   must match exactly, or the ERP will reject every punch with "invalid
   API key."

## Setup, step by step

1. Copy this whole `biometric-bridge` folder onto the school's office PC
   (a USB drive, a zip download, however is convenient — it doesn't need
   to be a git checkout).

2. Open a terminal/command prompt in that folder and run:
   ```
   npm install
   ```
   This downloads the two small libraries the bridge needs. It only needs
   to be done once.

3. Copy `.env.example` to a new file named `.env` in the same folder, and
   fill in the blanks:
   - `DEVICE_IP` — the device's IP address from step 3 above.
   - `DEVICE_SERIAL` — any short label for this device, e.g. `MainGate`.
   - `ERP_URL` — this school's ERP web address.
   - `BIOMETRIC_API_KEY` — the exact same string you set on Render.

   Leave `DEVICE_PORT` and `POLL_INTERVAL_MINUTES` at their defaults
   unless you have a specific reason to change them.

4. **Test the connection first**, before doing anything else:
   ```
   npm run test-connection
   ```
   This only *reads* from the device and prints what it found — it does
   not send anything to the ERP yet, so it's safe to run as many times as
   you need while getting things right. If it fails, double check the PC
   really is on the same network as the device, and that `DEVICE_IP` is
   correct. If it connects but the sample records printed don't look like
   punches at all, that device/firmware may report its data a little
   differently than expected — see the comment above `normalizeRecord()`
   in `sync.js` for what to adjust.

5. Once the test looks right, do a real one-time sync to make sure
   punches actually arrive in the ERP:
   ```
   npm run once
   ```
   Then open the school's ERP → Staff → Attendance → **Biometric Sync**
   tab and confirm the punches show up there.

6. For ongoing, automatic syncing, you have two options:
   - **Simplest — leave a terminal window running:**
     ```
     npm start
     ```
     This keeps running and re-checks the device every
     `POLL_INTERVAL_MINUTES` (5 by default) until you close it. Fine for
     a quick trial, but it stops if the PC restarts or the window is
     closed.
   - **Recommended for real use — schedule it:** set up Windows Task
     Scheduler (or `cron` on Linux) to run `npm run once` in this folder
     automatically every few minutes. This way it keeps working even
     after the PC restarts, without anyone needing to leave a window
     open. Ask if you'd like exact steps for the school's specific
     operating system.

## Which devices this works with

This bridge speaks the network protocol used by ZKTeco-family biometric
terminals — by far the most common type of budget/mid-range fingerprint
attendance device sold in India, including many machines sold under the
eSSL, ZKTeco, Realtime, and Mantra brand names. Almost all of them listen
on network port `4370` by default. If a school's device is a different
brand entirely and this doesn't connect, it may need a different bridge —
ask before assuming it can't be integrated.

## What this does and doesn't do

- It only **reads** attendance logs from the device — it never writes
  anything to the device, and never changes any of its settings.
- It only sends **new** punches since the last successful sync each time
  it runs, so it's safe to run as often as you like without creating
  duplicate records.
- If the ERP is briefly unreachable (school's internet is down, Render is
  restarting, etc.), the bridge simply tries again next cycle — nothing is
  lost, nothing is marked as sent until the ERP actually confirms it
  received it.
- It only affects **staff** attendance. A punch only turns into an
  attendance record once that staff member's **Biometric ID** field
  (Staff → edit a staff member → Professional tab) is filled in with
  their device enrollment number — until then, the punch still shows up
  in the Biometric Sync tab as "Unmapped" so you can see it arrived, but
  it won't mark anyone present. It never overwrites attendance someone
  already marked by hand for the same staff member and day — whichever
  was recorded first (by a person, or by this bridge) stands; the other
  is simply never written.
