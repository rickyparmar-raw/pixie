# Live YSWS — Pixie Support Knowledge Base

**Program key:** `live-ysws`  
**Program ownership:** Live YSWS only  
**As of:** 2026-09-13  
**Primary public channel:** `#live-ysws` (`C0BU006CTS6`)  
**Organizer / primary authority:** Sebastian Hernandez / `plastuchino` (`U087BHR98AX`)  
**Official site:** https://live.hackclub.com/  
**Official repository:** https://github.com/hackclub/live  
**Stream:** https://www.twitch.tv/plastuchino

> Curated Live YSWS support knowledge for Pixie. This is not a raw Slack dump. It combines current official site/repository behavior with current organizer guidance and recurring support questions, while excluding chatter, jokes, participant guesses, stale shop snapshots, and unrelated YSWS rules.

---

# 1. Hard program-isolation rule

This knowledge belongs to **Live YSWS only**.

For a Live YSWS question, Pixie may retrieve:

- current Live YSWS site/runtime
- official `hackclub/live` repository
- current Live YSWS Slack guidance
- direct statements from Sebastian / `plastuchino`
- current verified Live reviewers/helpers when the organizer has not answered
- explicitly approved generic Hack Club knowledge that is truly program-neutral

Pixie must **never** answer a Live question using Pixl, Hardwire, Twisted, Jame Gam, Back to Basics, Atlantis, or another YSWS's eligibility, AI, funding, review, fulfillment, shop, or submission rules.

Correct retrieval path:

`Live request -> resolve live-ysws -> retrieve only Live-owned evidence -> validate ownership -> answer if grounded -> otherwise fail closed`

Do not retrieve globally and filter afterward.

---

# 2. Source authority and freshness

When Live sources conflict, use:

1. Current deployed `live.hackclub.com` behavior
2. Current official `hackclub/live` source matching deployed behavior
3. Newest direct Sebastian statement
4. Current reviewer/helper guidance
5. Older organizer statements
6. Participant discussion only as context

Freshness matters especially for:

- stream multiplier
- timer/end time
- shop inventory
- shop prices
- grants
- fulfillment
- review queue
- review ETA
- bugs

A newer official source overrides older Slack statements.

---

# 3. Critical current conflict: 10 minutes, not 20

**Current rule: every approved hour adds 10 minutes to the stream.**

This is supported by:

- current `#live-ysws` channel topic
- current official Live landing page
- current official landing-page FAQ
- current timer/site copy

Older Live messages and at least one stale dashboard display still reference **20 minutes**. Those are stale and must not override the current landing page/topic/FAQ.

Canonical Pixie answer:

> Each approved hour currently adds **10 minutes** to the Live YSWS stream.

If the current site changes later, the newer official value wins.

---

# 4. What Live YSWS is

Live YSWS is a Hack Club program built around a livestream timer.

Participants:

1. build a real technical project
2. track/document their work
3. submit it
4. have it reviewed
5. receive approved hours
6. extend Sebastian's livestream with those approved hours
7. use Live's current shop/grant system for rewards

Current core mechanic:

- software and hardware are both allowed
- **1 approved hour = 10 stream minutes**
- approved work extends the timer

---

# 5. Eligibility

Current official Live site FAQ says anyone **13–18** can submit.

Canonical rule:

- eligible ages: **13 through 18**
- birthday/address come from verified Hack Club identity in the current submission system

Known organizer edge case:

- Sebastian told a participant about to turn 19 that if they **submit before turning 19**, they can still get rewarded

Do not overgeneralize this edge case. Escalate unusual age/submission timing cases.

---

# 6. Identity and shipping information

The current platform sources these fields from verified Hack Club identity rather than editable submission inputs:

- birthday
- address
- city
- state/province
- country
- ZIP/postal code

The form displays them read-only.

If identity/shipping data is wrong, the user should fix the authoritative Hack Club account data instead of entering fake values in Live.

---

# 7. Software and hardware are both supported

Live supports:

- software
- hardware

Examples can include websites, games, tools, bots, firmware, PCBs, CAD, embedded systems, custom keyboards, and other technical projects.

Acceptance still depends on real work and credible evidence.

---

# 8. Fully CAD projects are allowed

This is a confirmed Live-specific fact.

Sebastian directly said:

> fully cad is fine

In another case involving a custom keyboard built in CAD/Onshape with no coding yet, Sebastian said to submit it as a **hardware project**.

Canonical answer:

> Yes. Fully CAD projects can be submitted to Live as hardware, assuming the work is substantive and properly evidenced.

Do not tell users hardware requires coding.

---

# 9. Submission tracks

The current platform has two tracks:

- `software`
- `hardware`

The server changes tracking requirements based on track.

## Software

Required tracking field:

- selected **Hackatime project**

## Hardware

Required tracking fields:

- **Lapse link**
- **hours spent**, entered as a positive number

---

# 10. Common required submission fields

Current official form/server validation requires:

- Code URL
- Playable URL
- Description
- Screenshot on first submission

Additional tracking depends on track.

Software:

- Hackatime project required

Hardware:

- Lapse link required
- hours spent required

On resubmission, the form asks:

> What changed since last time?

Do not invent extra universal required fields unless the current form changes.

---

# 11. Software time tracking

For software, the current Live platform expects a selected **Hackatime project**.

Canonical guidance:

- use Hackatime for code/software work
- make sure the correct project is being tracked
- select that project when submitting
- do not fabricate or manually inflate time

The current UI is designed around one selected Hackatime project.

If one real project has been split across multiple Hackatime names/machines:

- do not promise an automatic merge
- describe the split in the submission/project description
- preserve evidence
- ask a helper if the form cannot represent it correctly

Multiple-Hackatime-project support has been a recurring user request, so treat it as a workflow limitation rather than inventing a feature.

---

# 12. Lapse for software

The current validator requires Hackatime for software.

The form also has an optional field:

> Lapse Link(s) (comma-separated)

Therefore:

- Hackatime is the required primary tracker for normal software
- Lapse can be added where useful
- do not claim Lapse is universally mandatory for software

---

# 13. Hardware time tracking

For hardware, the current platform requires:

- a Lapse link
- hours spent

Strong hardware evidence can include:

- Lapse
- journal
- CAD/design files
- PCB files
- firmware where relevant
- photos
- repository/source files
- a clear description

Do not encourage unsupported self-reported hours.

---

# 14. Journal-only hardware risks deflation

Sebastian has repeatedly said:

- hardware can be journaled
- journal-only hardware can be deflated
- not using Lapse can force deflation
- **Lapse + journal** is much stronger evidence

Canonical answer:

> For hardware, use Lapse if you can. Journal-only work may still provide evidence, but it is more likely to have hours deflated. Lapse plus a good journal is much stronger.

Do not invent a fixed deflation percentage.

---

# 15. Journaling guidance

Sebastian shared this journaling guide as a reference he likes:

https://fallout.hackclub.com/docs/project-resources/good-journaling

Good journals explain real work such as:

- what changed
- what was built
- what broke
- how it was fixed
- technical/design decisions
- progress
- evidence/screenshots
- what remains

Do not encourage padded or fabricated journals.

---

# 16. Multiple Lapse links are allowed

Another confirmed Live-specific fact.

Sebastian answered a hardware submission question:

> you can do comma seperated for lapse url

Canonical answer:

> Yes. Put multiple Lapse links in the field as **comma-separated URLs**.

The current software form independently labels its optional field `Lapse Link(s) (comma-separated)`.

---

# 17. Code URL and Playable URL

The current Live form requires both:

- Code URL
- Playable URL

For typical software:

- Code URL should point to source/repository
- Playable URL should let the reviewer use/see/run the project where practical

For hardware, Sebastian explicitly said:

> playable could be the same as your code url depending on your project

So a hardware project without a separate playable web experience may use the same relevant project/repository URL when appropriate.

Never invent a fake playable link.

---

# 18. Screenshot

The first submission requires a screenshot/image.

On resubmission, the existing screenshot can be retained if the user does not upload a replacement.

The screenshot should represent the real project.

---

# 19. Old projects

Older/existing projects are not automatically banned.

Sebastian's direct guidance:

> you can reship something as long as you made significant changes to the original shipped thing. this could be adding new features, etc. your original time wont count tho

Canonical answer:

> You can continue/reship an older project if you've made significant new changes. Only the new work should count; the old already-shipped time does not.

---

# 20. Double dipping

Do not reward the same unchanged work twice.

Sebastian has described unchanged already-shipped work with no meaningful new contribution as a likely:

> plain old double dip

Use this distinction:

- same project + meaningful new work -> potentially okay
- same already-rewarded work + no meaningful new work -> not okay
- unclear prior reward status -> escalate

Do not borrow another YSWS's double-dip policy wording.

---

# 21. Resubmissions

The platform supports update/resubmission flow.

When resubmitting:

1. actually make the requested changes
2. update source/demo/evidence as needed
3. explain what changed
4. do not simply resubmit unchanged work

---

# 22. Hardware funding

Live has hardware funding.

Sebastian has said:

> if you create a hardware project, you can use the hardware funding to fund the project itself

and:

> hardware grant is only to fund a hardware project

Canonical interpretation:

- hardware funding should fund legitimate project hardware
- it should be tied to a Live hardware project
- it is not general-purpose spending money

For unusual exact purchases, check current rules or escalate.

---

# 23. Design-stage hardware and funding

Sebastian has indicated users may need to ship at least the design to Live for hardware funding.

This is compatible with fully CAD/design-stage submissions.

Safe answer:

> Live can support design-stage hardware/CAD work, and hardware funding should be tied to a project you're actually submitting to Live.

---

# 24. Shop and rewards are dynamic

Do not freeze the entire Live shop into evergreen policy.

Dynamic data includes:

- item list
- hour price
- dollar/grant value
- upgrade options
- region availability
- fulfillment method
- stock

For exact current prices use:

https://live.hackclub.com/shop

Historical Slack price tables are not permanent policy.

---

# 25. Reward rates can change

Live has actively changed/repriced rewards.

When someone asks:

> How many hours for item X?

use the current live shop.

Do not calculate from a stale screenshot or old Slack thread.

---

# 26. Upgrade grants

Sebastian has stated:

- upgrade grants exist
- they can cover extra cost on an upgraded reward
- upgrade grants are intended to help move to a better/more expensive item

Because the shop is dynamic, explain the concept but verify exact current values live.

Safe answer:

> Upgrade grants can cover an upgrade/extra cost on Live rewards, but check the current shop for the exact amount and current eligibility.

---

# 27. Reimbursements / merchant failures

Sebastian said that if a grant card does not work for a merchant, he may be willing to handle reimbursement.

This is **case-specific**, not an automatic universal promise.

Therefore:

- do not promise reimbursement
- leave card/merchant failures to Sebastian/a human
- collect relevant purchase context

---

# 28. Customs and local purchasing

For some high-value rewards, Sebastian has discussed grant/local-purchase flows because international customs can be bad.

Do not turn this into:

> Live always pays customs.

Safe behavior:

- some rewards may be grant-based so users can buy locally
- fulfillment depends on item/region
- never promise customs coverage
- escalate order/import issues

---

# 29. Stream timer and program end

Live does not behave like a simple fixed-date YSWS.

Sebastian has said:

- Live has launched
- approved/submitted work extends the timer
- it keeps going while people keep shipping

Current official site copy says:

> keep shipping = stream neva ends

Canonical behavior:

- use the **current site timer** for remaining time
- approved work extends the stream
- do not treat participant guesses such as “September 30” as a guaranteed hard deadline
- Twitch being temporarily offline does not mean the program has ended

---

# 30. Current status: launched

Live is launched and accepts submissions.

Do not describe it as prelaunch based on stale text.

---

# 31. Review queue and ETA

Review speed is dynamic.

Sebastian has at different points said:

- he was reviewing around 1–2 projects/day
- he planned larger batches
- he wanted to review some projects live on stream
- the queue grew larger than expected
- he was seeking more reviewers

These are snapshots, not an SLA.

Canonical answer:

> Review time varies with the queue. There is no reliable fixed review ETA in the current Live knowledge base.

Do not promise a specific day, queue position, or duration.

---

# 32. Approved hours can be lower than tracked hours

Reviewers may approve fewer hours than raw tracking/self-reported time.

Possible reasons include:

- weak evidence
- journal-only hardware tracking
- missing Lapse proof
- low-quality output relative to claimed time
- old/non-new time
- duplicated work
- unclear contribution

Do not promise every tracked hour is automatically rewarded.

---

# 33. Quality matters

Live has a casual presentation, but that does not make all claimed time automatically valid.

Sebastian has explicitly discussed deflation for weakly evidenced/low-quality projects.

Do not say:

> If Hackatime/Lapse says 20 hours, all 20 are guaranteed.

---

# 34. Tutorials

Current reviewer/helper guidance in the Live channel says tutorial-based projects should not be a 1:1 copy and should be heavily changed.

Safe answer:

> Using a tutorial to learn is okay, but the shipped project should show meaningful original work rather than being a straight copy.

For originality disputes, escalate.

---

# 35. AI policy

As of this snapshot, there is **not enough clear, authoritative Live-specific evidence to invent a universal AI-use percentage or detailed policy**.

Therefore Pixie must not borrow:

- Jame Gam AI rules
- Pixl AI rules
- another program's percentage
- another YSWS's ban/allowance language

Safe response:

> I don't have a current authoritative Live-specific AI-use rule strong enough to give you a percentage. A Live helper/Sebastian should confirm the current policy.

Fail closed until a clear Live-specific source is added.

---

# 36. Multiple Hackatime projects for one project

The current software form selects one Hackatime project.

If one real project is split across multiple Hackatime project names/machines:

- do not discard genuine work
- do not invent a merge feature
- explain the split in the project description
- preserve evidence
- ask a human if needed

---

# 37. Lapse capture problems

If Lapse captures only part of a hardware/CAD session:

- do not fabricate missing time
- preserve the valid Lapse session
- add a truthful journal
- preserve design/source changes and other evidence
- ask a helper about materially under-recorded time

Never advise editing/faking timestamps.

---

# 38. Useful project evidence

Depending on project type, useful evidence may include:

- repository/source
- demo/playable URL
- CAD/design files
- screenshots
- Lapse
- Hackatime
- journals
- project description
- commit/project history
- firmware/PCB files where relevant

---

# 39. Typical software submission flow

1. build a real software project
2. track coding with Hackatime
3. connect/login through Live
4. choose Software
5. select the correct Hackatime project
6. provide Code URL
7. provide Playable URL
8. provide Description
9. optionally add comma-separated Lapse links
10. upload Screenshot
11. submit
12. wait for review
13. fix/resubmit if needed

---

# 40. Typical hardware submission flow

1. design/build a real hardware project
2. use Lapse for hardware/CAD work
3. journal as additional evidence
4. choose Hardware
5. provide Lapse link(s)
6. enter hours honestly
7. provide Code/Project URL
8. provide Playable URL; it may be the same relevant project URL when appropriate
9. provide Description
10. upload Screenshot
11. submit
12. wait for review
13. fix/resubmit if needed

---

# 41. Quick answers

## Can I submit fully CAD?

Yes. Sebastian explicitly said fully CAD is fine. Submit it as hardware and provide strong evidence, preferably Lapse + journal.

## Can I include multiple Lapse links?

Yes. Put them in the Lapse field as comma-separated URLs.

## What do I put as playable URL for hardware?

Sebastian has said it can be the same as the code/project URL depending on the hardware project.

## How much does one approved hour add?

**10 minutes.**

## Who can submit?

Current site: **ages 13–18**.

## Can I continue an old project?

Yes, if you make significant new changes. Only new work counts; unchanged already-rewarded work should not be rewarded again.

## Can I journal hardware instead of Lapse?

Journal-only hardware may be deflated. Lapse + journal is much stronger.

## How do I track software?

Hackatime; select the correct Hackatime project on submission.

## How do I track hardware/CAD?

Lapse + clear evidence/journaling. Current hardware form requires a Lapse link and hours spent.

---

# 42. Twitch offline vs program ended

Twitch being temporarily offline does not necessarily mean Live has ended.

The official mechanic is based on the timer/deadline and accumulated approved work.

Use the current site timer rather than Twitch's momentary online status.

---

# 43. Submitted vs approved hours

The current official language centers on **approved hours**.

Safe model:

- user submits work
- review determines approved hours
- approved hours contribute to the official stream-time mechanic

Do not turn transient implementation bugs/display behavior into policy.

---

# 44. Shop exact-value questions

For questions such as:

- How many hours is the laptop?
- Is headphone X still in the shop?
- What does the AI grant cost?
- Can I buy two monitor grants?
- How much is hardware funding?

prefer the current live shop.

Do not answer from an old Slack snapshot if current data is available.

---

# 45. Exact hardware purchase questions

General rule:

> Hardware funding is meant to fund the Live hardware project.

But exact purchases may depend on:

- project relevance
- current funding amount
- current shop/grant rules
- organizer/reviewer judgment

Escalate unusual items.

---

# 46. Fulfillment questions

Pixie must never invent:

- tracking number
- delivery date
- order status
- reimbursement approval
- vendor
- customs charge
- grant-card status

These need live/account-specific data or a human.

---

# 47. Personal review questions

For questions like:

- Why did I get only 2 of 7 hours?
- Why was I rejected?
- Can you approve me?
- Why is my project pending?
- Why did my grant fail?

Pixie may explain general policy but should leave the actual account/project decision to a reviewer.

---

# 48. Authoritative source set

## Official Live sources

- https://live.hackclub.com/
- https://live.hackclub.com/dashboard
- https://live.hackclub.com/shop
- https://github.com/hackclub/live
- https://github.com/hackclub/live/blob/master/app/page.tsx
- https://github.com/hackclub/live/blob/master/src/lib/submission.ts
- https://github.com/hackclub/live/blob/master/app/components/dashboard/SubmissionForm.tsx

## Slack

- https://hackclub.slack.com/archives/C0BU006CTS6

## Useful organizer evidence

Fully CAD:
- https://hackclub.enterprise.slack.com/archives/C0BU006CTS6/p1788539082958459

Multiple Lapse URLs / playable URL:
- https://hackclub.enterprise.slack.com/archives/C0BU006CTS6/p1788901953710009?thread_ts=1788901297.835669&cid=C0BU006CTS6

Lapse + journal:
- https://hackclub.enterprise.slack.com/archives/C0BU006CTS6/p1788794923849509?thread_ts=1788794499.782799&cid=C0BU006CTS6

No-Lapse deflation:
- https://hackclub.enterprise.slack.com/archives/C0BU006CTS6/p1788539136604669

Hardware journal-only warning:
- https://hackclub.enterprise.slack.com/archives/C0BU006CTS6/p1788349830609149?thread_ts=1788349830.609149&cid=C0BU006CTS6

Age edge case:
- https://hackclub.enterprise.slack.com/archives/C0BU006CTS6/p1788446353821339?thread_ts=1788446329.287739&cid=C0BU006CTS6

Reshipping significant new work:
- https://hackclub.enterprise.slack.com/archives/C0BU006CTS6/p1788373024507119?thread_ts=1788373024.507119&cid=C0BU006CTS6

Double-dip warning:
- https://hackclub.enterprise.slack.com/archives/C0BU006CTS6/p1788707569669539?thread_ts=1788707316.926329&cid=C0BU006CTS6

Launched/submissions extend timer:
- https://hackclub.enterprise.slack.com/archives/C0BU006CTS6/p1788289383634579

Shipping keeps Live going:
- https://hackclub.enterprise.slack.com/archives/C0BU006CTS6/p1788289890080719

Hardware funding:
- https://hackclub.enterprise.slack.com/archives/C0BU006CTS6/p1788446232979399?thread_ts=1788446156.030319&cid=C0BU006CTS6

Review throughput snapshot:
- https://hackclub.enterprise.slack.com/archives/C0BU006CTS6/p1788706833876779?thread_ts=1788706769.003829&cid=C0BU006CTS6

---

# 49. Freshness/conflict table

| Topic | Stale/unsafe claim | Current behavior |
|---|---|---|
| Stream multiplier | 20 min/hour | **10 min per approved hour** |
| Channel purpose | still says 20m | channel topic + current site say 10m |
| Old dashboard display | one old code path references 20 | current landing/FAQ say 10 |
| End date | Sept 30 / participant guesses | use current timer; shipping extends it |
| CAD | hardware must be physically built first | fully CAD is allowed |
| Hardware tracking | journal alone has no downside | journal-only may be deflated; Lapse + journal stronger |
| Multiple Lapse links | unsupported | comma-separated URLs are allowed |
| Old project | automatically banned | significant new work may be reshipped; old time does not count |
| Already rewarded work | submit unchanged again | double dipping is not okay |
| Review ETA | fixed number of days | no reliable fixed SLA |
| Shop prices | historical Slack values | live shop/current code |
| AI policy | copy another YSWS | fail closed until Live-specific authority exists |

---

# 50. Questions Pixie should answer confidently

Pixie should be able to answer:

- What is Live YSWS?
- Who can submit? (13–18)
- Is Live launched?
- How much time does one approved hour add? (10 minutes)
- Can I submit software? (yes)
- Can I submit hardware? (yes)
- Can I submit fully CAD? (yes)
- How do I track software? (Hackatime)
- How do I track hardware? (Lapse + evidence)
- Can I include multiple Lapse links? (yes, comma-separated)
- What do I use for a hardware playable URL?
- Does hardware funding exist?
- Can I continue an old project?
- Does old already-rewarded time count again? (no)
- Can I reship after significant changes? (yes)
- Is there a fixed review ETA? (no)
- Should I trust an old 20m rate? (no)

---

# 51. Questions Pixie should escalate

Escalate when needed:

- exact order/tracking status
- exact fulfillment date
- exact current shop price when live data is unavailable
- customs/import promises
- reimbursement approval
- exact review date
- exact queue position
- why one project was deflated
- review appeals
- fraud/ban decisions
- disputed Hackatime/Lapse time
- unusual hardware purchase eligibility
- age edge cases
- current AI-use policy
- multi-Hackatime-project handling
- broken/missing Lapse sessions
- identity/address account problems

---

# 52. Do-not-hallucinate list

Never invent:

- 20 minutes/hour as the current rate
- a fixed end date
- a guaranteed review ETA
- queue position
- tracking number
- delivery date
- customs coverage
- reimbursement approval
- fixed shop inventory
- stale reward prices
- numeric AI percentage
- another YSWS's AI policy
- another YSWS's funding rules
- a nonexistent Hackatime merge feature
- missing Lapse time
- approved hours before review
- a reviewer decision

---

# 53. Retrieval aliases

Useful Live search terms:

- Live / Live YSWS / livestream / stream
- Sebastian / plastuchino / Seb
- approved hour / stream minute / multiplier
- 10 minutes / 10m
- software / hardware
- CAD / Onshape / EasyEDA / KiCad / PCB
- Hackatime
- Lapse / timelapse
- journal / devlog
- Code URL / Playable URL
- screenshot
- old project / reship / update ship
- double dip
- hardware grant / hardware funding
- upgrade grant
- shop / reward / prize
- review / approved hours / deflation
- age / 13 / 18 / turning 19
- timer / deadline / end
- multiple Lapse links
- multiple Hackatime projects

---

# 54. Recommended ingestion metadata

```yaml
programId: live-ysws
programKey: live-ysws
sourceType: curated-support-kb
sourceName: Live YSWS Pixie Knowledge Base
channelId: C0BU006CTS6
ownerUserId: U087BHR98AX
asOf: 2026-09-13
```

For the current private test environment:

```yaml
runtimeScope: draft
namespace: draft:live-ysws
```

For a future approved production deployment:

```yaml
runtimeScope: production
namespace: live-ysws
```

Never mark this file as global/shared YSWS knowledge.

---

# 55. Retrieval/citation ownership requirements

Before generation:

- retrieve only `live-ysws` sources
- assert source ownership
- reject foreign program IDs
- do not pass foreign YSWS chunks to the model

After generation:

- validate every citation belongs to Live or approved generic knowledge
- discard/fail closed if a foreign program citation appears
- never cite Pixl/Hardwire/Twisted/Jame as evidence for Live policy

Cache keys should include:

- workspace
- runtime scope
- program ID / draft program ID
- normalized query

---

# 56. Recommended Pixie source composition

Do **not** replace existing Live website/repo sources with this file.

Pixie should retrieve from both:

1. current Live site/repository sources
2. this curated Markdown KB

The site/repo is strongest for:

- current multiplier
- current submission fields
- current UI
- live shop
- timer
- implementation

This KB is strongest for:

- organizer clarifications
- CAD support
- Lapse policy
- journaling/deflation
- multiple Lapse syntax
- old-project/reship rules
- escalation behavior

---

# 57. Maintenance checklist

When refreshing:

1. check current `live.hackclub.com`
2. check current `hackclub/live`
3. scan current `#live-ysws`
4. prioritize newest Sebastian guidance
5. verify multiplier
6. verify age rule
7. verify software/hardware form fields
8. verify Lapse/Hackatime behavior
9. verify shop/grants
10. verify timer/end behavior
11. update known bugs
12. do not freeze old shop prices
13. keep ownership `live-ysws`
14. preserve cross-YSWS isolation
15. keep private Pixie sandbox messages out of authority ranking

---

# 58. Why this KB exists

The private Live Pixie sandbox previously knew:

- 10 minutes per approved hour

but failed closed on confirmed same-program facts such as:

- fully CAD projects are allowed
- multiple Lapse URLs are allowed

Those facts are explicitly included here with Live-owned provenance.

A correct Live retrieval should answer all three without reaching into another YSWS.

---

# 59. Final behavioral invariant

For a Live support question:

**Resolve Live -> retrieve Live-owned site/repo + this Live-owned KB -> validate ownership -> answer only if grounded -> otherwise escalate.**

Never:

- borrow another YSWS's rules
- use stale 20m/hour text over current 10m
- invent shop values
- invent a review SLA
- invent account/order state
- invent AI policy
- reward old duplicate work
- fabricate missing tracking evidence

## Highest-value regression checks

1. `In Live YSWS, how much time does one approved hour add?`
   - expected: **10 minutes**

2. `Are fully CAD hardware projects allowed in Live YSWS?`
   - expected: **Yes; fully CAD is allowed, submit as hardware**

3. `Can I include multiple Lapse links in one Live YSWS submission?`
   - expected: **Yes; comma-separated URLs**

4. `What are the current Hardwire tiers?`
   - expected in Live context: **fail closed / no Hardwire policy answer**

5. `What are the Twisted pathways?`
   - expected in Live context: **fail closed / no Twisted policy answer**
