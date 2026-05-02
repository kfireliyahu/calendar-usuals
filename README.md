# Weekly Life Pool - Chrome Extension

A planning layer for Google Calendar that lets you drag activities from a predefined pool into your weekly schedule.

## Project Structure

```
weekly-life-pool/
├── src/
│   ├── content.tsx          # Main sidebar component
│   ├── content.css          # Sidebar styling
│   ├── background.ts        # Background service worker (API calls)
│   └── components/
│       └── PoolSidebar.tsx   # Pool UI component
├── manifest.json            # Chrome extension config
├── package.json
├── tsconfig.json
└── vite.config.ts           # Build configuration
```

## Setup & Running

### 1. Install Dependencies
```bash
npm install
```

### 2. Build the Extension
```bash
npm run build
```

This creates a `dist/` folder with the compiled files.

### 3. Load in Chrome
1. Open `chrome://extensions`
2. Enable "Developer mode" (top right)
3. Click "Load unpacked"
4. Select the `dist/` folder

### 4. Watch Mode (for development)
```bash
npm run watch
```

This rebuilds automatically when you change files.

### 5. Test
- Go to https://calendar.google.com
- You should see a "Weekly Pool" sidebar on the left
- Try adding items and dragging them

## Next Steps

### TODO:
- [ ] Set up Google OAuth (Calendar API authentication)
- [ ] Implement drag-and-drop to create events on the calendar
- [ ] Detect which time slot user drops item into
- [ ] Call Google Calendar API to create the event
- [ ] Add visual feedback when event is created
- [ ] Handle edge cases (errors, duplicate items, etc.)

### Key Features to Build:
1. **Detect calendar time slots** - Figure out which day/time user is dragging to
2. **Create events via API** - Make actual Google Calendar events
3. **Drag-and-drop interaction** - Make the UX smooth
4. **Settings/persistence** - Save pool items to Chrome storage

## Notes

- The sidebar currently loads a sample pool (Social, Food, Health)
- Items are saved to Chrome's local storage
- The background worker is set up for API calls but not integrated yet
- Next phase: wire up the Google Calendar API for actual event creation

## Useful Links

- [Chrome Extension API](https://developer.chrome.com/docs/extensions/)
- [Google Calendar API](https://developers.google.com/calendar/api)
- [React TypeScript](https://react-typescript-cheatsheet.netlify.app/)
