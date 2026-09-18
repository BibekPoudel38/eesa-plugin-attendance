# Attendance — what it is and how it behaves

Chups, 17 Sep 2026. This is the product as built and running, not a proposal. Written
because the rules are decided here, not in the code: anyone changing attendance should
be able to read this page and know what a number on a timesheet means.

## What it is for

A restaurant needs to know who worked and for how long, without anybody remembering to
do anything. Every earlier version of this failed in the same way: a person forgot to
tap, or tapped the wrong thing, and their pay was wrong. Jeeva's week in September is
the case that decided the design — he tapped "Check out" while still at work on four of
five days, and about nine hours went unrecorded.

So: **the phone decides the times, and nobody can move them.** The only thing a person
adds is why.

## Who uses it

- **Staff** (all on iPhones today). They open Attendance to see where they stand and to
  say why they came in or went out. They never check in or out by hand.
- **Managers/admins.** They see who is in, the week's timesheets, and can fix a day's
  times with the phone's own evidence.

## How the hours are decided

1. The phone checks a person in when they arrive at a work zone and out when they leave.
   These times are the record and no one on the staff side can change them.
2. Each check-in means **Work** and each check-out means **Going home**, unless the
   person says otherwise. Saying the default again stores nothing, so a reason on record
   is always a change.
3. Two reasons change the hours:
   - **Outside work** on a check-out: the time away counts, until the phone sees them
     back. If they never come back that day, the hours stop when they left.
   - **Not for work** on a check-in: that visit is not counted, and the person shows as
     "On site", not "At work".
   Any other reason, typed by the person, is a note for the manager and changes nothing.
4. A reason can be added or changed for today and yesterday only. Changing one
   recalculates that day.
5. Rules that predate this and still hold:
   - A finished stretch shorter than **10 minutes** does not count.
   - A shift left open longer than **12 hours** counts nothing and is flagged
     "No check-out" for a manager to fix.
   - Repeat arrivals the OS fires while somebody is already inside change nothing.
   - A departure the phone reports while a person is away on an errand is kept as
     evidence, not as a second punch.
   - Times and days are always the restaurant's clock and calendar, never the phone's.

## What staff see

- **Home:** a small attendance icon beside "Hi <name>". Its dot is green while they are
  checked in. No banners, no greeting, no date.
- **Arriving:** a pop-up notification. Nothing appears on the home screen.
- **Attendance** (the icon opens it):
  - Where they stand: "Checked in, since 9:45 AM · Chups Anaheim", or "Checked out,
    left at 5:10 PM", with one row under it — *Reason for coming in* or *Reason for
    going out* — showing the default until they change it.
  - Today, Yesterday and This Week.
  - This Week / Last Week / This Month / Custom, with the iPhone's calendar.
  - The days behind them; tapping a day lists every check-in and check-out with its
    zone mark and its reason. Today's and yesterday's can still be changed.
- The page is the same one the website serves, so nothing is duplicated.

## What managers see

The same page as staff, with four tabs:

- **Today:** at work · out for work · not in; who is here now, with since when, the zone
  and the reason; everyone else folded away; what needs the manager — days to fix and
  phones not recording — only when there is something; and the team's hours this week.
- **Staff:** everyone, searchable. A person's page shows where they stand, whether their
  phone can record, today / yesterday / this week, the same filters and calendar, and
  every check-in and check-out with its zone and reason, with **Fix times** (and Undo).
  The week grid for payroll sits beside the list.
- **Mine:** their own attendance, exactly as staff see theirs.
- **Setup:** work zones, pay rates, working hours.
- **Roles are Eesa's:** who is an admin and who is staff is set only in
  Eesa AI → Management → Attendance. The attendance page shows it and cannot change it.
- **Summaries instead of alerts:** one summary in the morning, and "timesheets ready" on
  Monday. No push per punch, and no approving a day at a time.

## Zones

A workspace can have several zones (Chups Anaheim and Skoruz Office today). Every entry
in the logs carries its zone, with one colour per zone, so a day spent at two places
reads at a glance. The colour follows the zone's **name**, because editing a zone creates
a new one with the same name.

## What it deliberately does not do

- No check-in or check-out button for staff, anywhere.
- No approval of each day; no manager answering "is X here?" per arrival.
- No editing of times by staff — only managers fix times, and it is recorded.
- No NFC, no CSV export, no shift templates in the daily path (unused).
- No Android automatic check-in while every staff phone is an iPhone.

## How it is built

- **Attendance plugin** (Express + Postgres), deployed on Railway, serves both the API
  the phone calls and the page staff and managers use.
- **The iPhone app** registers the geofences, records punches in the background, shows
  the arrival notification, and opens the page. It holds no attendance screens of its own.
- **Eesa backend** provides the roster and each person's attendance role, and reports
  whether a phone is set up to record hours.

## Open items

- Build 87 of the app (version 1.33.1) is uploaded to App Store Connect and needs
  submitting for review; until then staff reach the page from the side menu.
- Automatic punches carry no reason unless somebody sets one. Asking from the arrival
  notification itself would need an app release.
- Android has no automatic check-in.
