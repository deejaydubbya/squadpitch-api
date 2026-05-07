// Sentry must be initialized before Express, http, or https are
// imported anywhere in the process — otherwise @sentry/node v8's auto
// instrumentation can't hook the request lifecycle and traces drop.
//
// The recommended v8 pattern is to load this file via --import so it
// runs before server.js starts pulling in Express:
//
//   node --import ./instrument.js server.js
//
// Both `npm start` and `npm run dev` are wired this way. ESM top-level
// await ensures Sentry.init() has finished by the time server.js runs.
//
// This file is a thin wrapper around lib/sentry.js — the actual init,
// DSN gating, and error handler wiring still live there. Centralizing
// behavior keeps tests deterministic (they call initSentry directly).

import { initSentry } from "./lib/sentry.js";

await initSentry();
