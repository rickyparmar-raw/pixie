# Screenshot Replacement Checklist

Current status: **Placeholder screenshots in use** (blue boxes with text)

Replace these with actual game/dashboard screenshots to complete the visual tutorial system.

## shop-purchase (4 screenshots needed)

- [ ] `01.webp` - Main game view with shop tab at bottom highlighted
- [ ] `02.webp` - Shop grid showing items for purchase
- [ ] `03.webp` - Item detail view with buy button
- [ ] `04.webp` - Inventory showing purchased item (or confirmation)

**Command to replace:**
```bash
bun scripts/optimize-screenshot.js ~/Desktop/shop-01.png shop-purchase/01.webp
```

## submit-project (5 screenshots needed)

- [ ] `01.webp` - Dashboard homepage (https://pixl.hackclub.com/)
- [ ] `02.webp` - "Submit Project" button location
- [ ] `03.webp` - Project submission form
- [ ] `04.webp` - Hackatime connection step
- [ ] `05.webp` - Submit button / confirmation

**Command to replace:**
```bash
bun scripts/optimize-screenshot.js ~/Desktop/submit-01.png submit-project/01.webp
```

## customize-character (3 screenshots needed)

- [ ] `01.webp` - Character menu location in game
- [ ] `02.webp` - Customization options (skin, hair, clothes, etc.)
- [ ] `03.webp` - Save button

**Command to replace:**
```bash
bun scripts/optimize-screenshot.js ~/Desktop/char-01.png customize-character/01.webp
```

## Testing

After replacing each guide's screenshots:

1. Start Pixie: `bun run start`
2. Test in Slack:
   - "how do i buy from the shop"
   - "how do i submit a project"
   - "how do i customize my character"
3. Verify screenshots display correctly and match the step descriptions
4. Complete the full guide flow to ensure all steps work

## Screenshot Guidelines

- **Resolution**: 900x900px max (script auto-resizes)
- **Format**: Any common format (PNG, JPG, WebP) → script converts to WebP
- **Content**: Show the relevant UI clearly, crop out unnecessary parts
- **Annotations**: Add arrows/highlights BEFORE optimizing if needed
- **Consistency**: Use same zoom level / UI state across related screenshots

## Notes

- The optimization script preserves aspect ratio and adds no enlargement
- WebP quality is set to 85 (good balance of size/quality)
- Slack caches images indefinitely after first load
- Screenshot URLs are public (no auth required) since they're shared in Slack anyway
