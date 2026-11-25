# CampusFest Attendee Growth Center

The command center for the CampusFest attendee campaign: funnel analytics with a snapshot "time machine", campaign verdicts, a budget simulator, a task board, data editing, and an AI growth analyst that answers from the live data and only acts after you confirm.

Full write-up (research, calculations, design, limitations): see [`../README.md`](../README.md).

```bash
npm install
cp .env.example .env     # optional: GEMINI_API_KEY from https://aistudio.google.com/apikey
npm start                # http://localhost:3000
npm test                 # 33 checks
```

| Path | What it is |
|---|---|
| `server.js` | Express API and static frontend |
| `lib/loader.js` | Reads the workbook; Excel dates → IST strings (timezone-independent) |
| `lib/engine.js` | All metrics: dedup, external-only, verified visits, status as of a date, diagnosis, verdicts, simulator, query layer |
| `lib/actions.js` | Writes: tasks, campaign status, initiatives, data edits, copilot proposals and confirmation |
| `lib/copilot.js` | Gemini function-calling loop, 12 tools, data dictionary, offline analyst fallback |
| `lib/store.js` | JSON persistence with atomic writes; seeds tasks and initiatives |
| `public/` | Single-page UI (vanilla JS + Chart.js) |
| `tests/run-tests.js` | Automated checks, including a mocked Gemini round trip |
| `data/Attendee Dataset.xlsx` | The original dataset, never modified. *Reset* restores the app from it. |
