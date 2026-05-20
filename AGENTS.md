# AGENTS.md

## Cursor Cloud specific instructions

### Overview

Forward Freedom Financial is a personal finance dashboard (React + Express). It has two runtime processes that both must run during development:

| Service | Command | Port | Notes |
|---------|---------|------|-------|
| Frontend (Vite + React) | `npm run dev:client` | 5173 | SPA with HMR |
| Backend (Express API) | `npm run dev:server` | 3001 | Plaid proxy, uses `node --watch` |

Both start together via `npm run dev` (uses `concurrently`).

### Key commands

- **Dev (both servers):** `npm run dev`
- **Lint:** `npm run lint` (ESLint — note: repo has pre-existing lint errors from React Compiler memoization rules)
- **Format check:** `npm run format:check` (Prettier — some files have pre-existing format issues)
- **Build:** `npm run build` (Vite production build)

### Gotchas

- The app works fully without Plaid API keys. It uses seed/demo data stored in `localStorage`. Plaid credentials (in `.env.local`) are only needed for live bank account linking.
- The backend persists Plaid tokens to `.plaid-store.json` (flat file, not a database).
- Vite proxies `/api` requests to the Express backend on port 3001 (configured in `vite.config.js`).
- There is no test framework or test suite in this repo.
- ESLint uses flat config (`eslint.config.js`) with React Compiler rules. Pre-existing errors relate to `react-hooks/preserve-manual-memoization` — these are in the repo already and not caused by agent changes.
