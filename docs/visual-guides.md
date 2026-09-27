# Visual Tutorial System for Pixie

This document explains how the visual tutorial system works and how to add or update screenshot-enhanced guides.

## Overview

Pixie can now respond to how-to questions with step-by-step visual guides that include screenshots from the actual game/dashboard. This makes help instantly actionable and easier to follow.

**Current visual guides:**
- `shop-purchase` - How to buy items from the shop (4 steps)
- `submit-project` - How to submit a project (5 steps)
- `customize-character` - How to customize your character (3 steps)

**Existing text-only guides** (no changes needed):
- `next-region` - How to unlock the next region
- `git-setup` - Setting up Git and GitHub
- `hackatime` - Setting up Hackatime for time tracking

## How It Works

### Architecture

1. **Guide definitions** (`lib/guides.js`): Each guide has a `steps` array where each step can optionally include a `screenshot` field
2. **Screenshot storage** (`public/screenshots/{guide-slug}/{step}.webp`): Screenshots are served as static files via Express
3. **Block Kit rendering** (`lib/respond.js` + `lib/guides.js`): When a step has a screenshot, Pixie uses Slack Block Kit to display the image + text together
4. **Trigger keywords** (`GUIDE_TRIGGERS` in `lib/guides.js`): Keyword matching + LLM intent detection triggers the right guide

### User Experience

**Without screenshot:**
```
pixie: first open the shop tab at the bottom of the game
```

**With screenshot:**
```
[IMAGE: Screenshot showing shop tab location]
pixie: first open the shop tab at the bottom of the game

see the shop tab? (yes/no)
```

Users progress through guides by answering yes/no or describing what they see. Pixie uses LLM classification to advance steps, handle alternate paths, or exit the guide.

## Adding/Updating Screenshots

### Current Status

**⚠️ PLACEHOLDER SCREENSHOTS IN USE**

The system is fully functional, but the current screenshots are blue placeholders generated during implementation. They need to be replaced with actual screenshots from the game/dashboard.

### Replacing Placeholders with Real Screenshots

1. **Take screenshots** from the actual game or dashboard:
   - Use a consistent resolution (900x900px max after optimization)
   - Capture the relevant UI element clearly
   - Annotate if needed (arrows, highlights) before saving

2. **Optimize and place the screenshot:**
   ```bash
   cd apps/pixie
   bun scripts/optimize-screenshot.js ~/path/to/screenshot.png shop-purchase/01.webp
   ```
   This converts to WebP, resizes to 900x900px max (preserving aspect ratio), and saves to the correct location.

3. **Verify the URL works:**
   - Start Pixie: `bun run start`
   - Open in browser: `http://localhost:4100/screenshots/shop-purchase/01.webp`
   - Should display the screenshot

4. **Test in Slack:**
   - Message Pixie: "how do i buy from the shop"
   - Verify the screenshot appears in the thread
   - Progress through the guide to verify all steps

### Screenshots Needed

**shop-purchase** (4 screenshots):
- `01.webp`: Main game view with shop tab highlighted at bottom
- `02.webp`: Shop grid view showing available items
- `03.webp`: Item detail view with buy button
- `04.webp`: Confirmation or inventory view showing purchased item

**submit-project** (5 screenshots):
- `01.webp`: Dashboard homepage at https://pixl.hackclub.com/
- `02.webp`: "Submit Project" button location highlighted
- `03.webp`: Project submission form with fields visible
- `04.webp`: Hackatime connection step
- `05.webp`: Final submit button or confirmation screen

**customize-character** (3 screenshots):
- `01.webp`: Character menu location in game
- `02.webp`: Customization options (skin tone, hair, clothes, etc.)
- `03.webp`: Save button location

## Adding New Visual Guides

### Step 1: Take Screenshots

Capture 3-5 screenshots showing the key steps of the task. Save them with descriptive names.

### Step 2: Optimize Screenshots

```bash
cd apps/pixie
bun scripts/optimize-screenshot.js ~/Desktop/my-screenshot.png my-new-guide/01.webp
bun scripts/optimize-screenshot.js ~/Desktop/my-screenshot-2.png my-new-guide/02.webp
# ... etc
```

### Step 3: Add Guide Definition

Edit `lib/guides.js` and add your guide to the `GUIDES` object:

```javascript
const GUIDES = {
  // ... existing guides

  "my-new-guide": {
    name: "How to Do Something Cool",
    steps: [
  {
        message: "ok so first u gotta open the thing :yay:",
checkNext: "see it? (yes/no)",
        screenshot: "my-new-guide/01.webp",  // ← Add screenshot field
      },
      {
     message: "nice! now click the button",
        checkNext: "did it work? (yes/no)",
     screenshot: "my-new-guide/02.webp",
      },
      // ... more steps
    ],
    alternateSteps: {
      "can't find it": "it's in the top right corner next to the settings icon",
  "button is disabled": "u might need to complete the previous step first",
    },
  },
};
```

### Step 4: Add Trigger Keywords

Add an entry to `GUIDE_TRIGGERS` in `lib/guides.js`:

```javascript
const GUIDE_TRIGGERS = [
  // ... existing triggers

[
    "my-new-guide",
    {
      subject: [["something", "cool", "feature"]],  // Words that identify the topic
      hints: ["how", "use", "do", "start"],  // Action words
    },
  ],
];
```

**How triggers work:**
- `subject`: Synonym groups (user's message must contain at least one word from EACH group)
- `hints`: Action/context words that suggest they want a guide (fuzzy matched, typo-tolerant)
- If keyword matching is ambiguous, an LLM classifies the intent

### Step 5: Test

```bash
bun run start
```

In Slack:
1. Message Pixie with a trigger phrase: "how do i use the cool feature"
2. Verify the first screenshot appears
3. Progress through the guide: answer "yes" to each step
4. Test alternate paths: give an answer that matches an alternate step key
5. Test exit: type "quit" or "stop" mid-guide

## Technical Details

### File Structure

```
apps/pixie/
├── lib/
│   ├── guides.js   # Guide definitions + triggers + Block Kit builder
│   ├── respond.js          # Orchestration (calls guide system)
│   ├── config.js     # web.baseUrl for constructing URLs
│   └── web/
│    └── serve.js        # Express server + static file serving
├── public/
│   └── screenshots/
│       ├── shop-purchase/
│       │   ├── 01.webp
│       │   ├── 02.webp
│       │   ├── 03.webp
│       │   └── 04.webp
│       ├── submit-project/
││   └── ...
│       └── customize-character/
│           └── ...
└── scripts/
    └── optimize-screenshot.js  # Sharp-based image optimizer
```

### Code Flow

1. User sends message → `lib/respond.js` → `handleNewGuide()` or `handleActiveGuide()`
2. Guide system (`lib/guides.js`) returns `{ message, checkNext, screenshot }`
3. If `screenshot` is present, `buildGuideBlocks()` creates Slack Block Kit format
4. `client.chat.postMessage()` sends blocks (image + text) to Slack
5. Slack proxies and caches the image URL → fast subsequent loads

### Performance

- **Image serving**: <10ms (local filesystem, Bun is fast)
- **Slack image proxy**: ~100-200ms first load, then cached indefinitely by Slack
- **Block Kit rendering**: Same speed as plain text (same Slack API call)
- **Screenshot sizes**: 4-6KB per WebP image (Sharp optimization at quality 85)

### Backwards Compatibility

- Text-only guides still work (no `screenshot` field = no Block Kit, plain text response)
- Existing guides unaffected
- If a screenshot file is missing, Slack shows a broken image icon but text still displays

## Environment Variables

The web server needs to know its public URL to construct screenshot URLs:

```bash
# .env
PIXIE_WEB_BASE_URL=http://localhost:4100  # dev
# PIXIE_WEB_BASE_URL=https://pixie.yourdomain.com  # production
```

Defaults to `http://localhost:${PIXIE_WEB_PORT || 4100}` if not set.

## Troubleshooting

### Screenshots not showing in Slack

1. Check the bot logs for "Express server listening on port X"
2. Verify the screenshot URL in browser: `http://localhost:4100/screenshots/guide-slug/01.webp`
3. Check the guide definition has the correct `screenshot` path (relative to `public/screenshots/`)
4. Verify `config.web.baseUrl` is set correctly

### Guide not triggering

1. Check `GUIDE_TRIGGERS` has an entry for your guide ID
2. Test keyword matching: does the user's message contain the subject words?
3. Check the guide ID matches exactly between `GUIDES` and `GUIDE_TRIGGERS`

### Image too large / slow to load

- Re-optimize with the script: `bun scripts/optimize-screenshot.js input.png output.webp`
- Target: 50-150KB per screenshot (current average: 4-6KB for placeholders, real screenshots may be larger)
- Consider cropping to focus on the relevant UI element

## Future Enhancements

Potential improvements (not yet implemented):

- **Animated GIFs** for complex interactions (click → drag → drop)
- **Interactive hotspots** (click regions on the screenshot to advance)
- **Multi-language screenshots** (detect user's locale, serve localized images)
- **Screenshot versioning** (serve different images based on game version)
- **Analytics** (track which steps users get stuck on)

## Credits

Implemented 2026-08-14 as part of the Pixl YSWS program.
