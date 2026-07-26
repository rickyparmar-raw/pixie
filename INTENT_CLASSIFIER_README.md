# Intent-Based Auto-Reply System

## What it does
Pixie now automatically responds to questions in #pixl channel without requiring @mentions or name mentions, while staying silent for casual statements.

## How it works
Two-tier architecture:
1. **Fast intent classifier** (gemini-2.5-flash-lite via localhost) - classifies messages as HELP_NEEDED or CASUAL_CHAT
2. **Main answering flow** (existing grounded answer system) - only runs for HELP_NEEDED messages

## Configuration
Add to `.env`:
```env
INTENT_CLASSIFIER_API_KEY=***REMOVED***
INTENT_CLASSIFIER_MODEL=gc/gemini-2.5-flash-lite
INTENT_CLASSIFIER_BASE_URL=http://localhost:20128/v1
```

## Files modified
- **lib/intent.js** (new) - Intent classification logic
- **index.js** - Added intent check for #pixl channel messages

## Testing
Run `node test-intent.js` to verify classification:
- Questions → HELP_NEEDED (pixie responds)
- Casual statements → CASUAL_CHAT (pixie stays silent)

## Examples
**Responds to:**
- "when does pixl end bro"
- "how do i join"
- "whats the deadline"
- "where can i find the docs"

**Stays silent for:**
- "yo i love pixl"
- "nice work everyone"
- "gg everyone"
- "just shipped my project"
