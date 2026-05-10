// Threads (Meta) Graph API constants.
//
// Threads has its own host (graph.threads.net) and its own developer
// app — separate from the Facebook/Instagram Graph app on
// graph.facebook.com. Keep these constants separate from
// meta.constants.js so a Threads version bump never touches the
// Facebook/Instagram pipelines.
//
// API reference: https://developers.facebook.com/docs/threads/

import { env } from "../../config/env.js";

// API version is overridable via env so we can bump without a code
// release. Defaults to v1.0 — the version Meta documents as current
// for production usage at the time of writing.
export const THREADS_GRAPH_VERSION = env.THREADS_API_VERSION ?? "v1.0";

// Authorization is hosted at threads.net (the consumer-facing domain),
// not graph.threads.net. Token exchange + all data calls hit
// graph.threads.net.
export const THREADS_AUTH_HOST = "https://threads.net";
export const THREADS_GRAPH_HOST = "https://graph.threads.net";
export const THREADS_GRAPH_BASE = `${THREADS_GRAPH_HOST}/${THREADS_GRAPH_VERSION}`;

// Permissions Squadpitch requests from Meta for Threads. See
// docs/THREADS_SETUP.md for the per-scope justification we provide
// in the Meta App Review submission.
export const THREADS_SCOPES = [
  "threads_basic",
  "threads_content_publish",
  "threads_manage_insights",
  "threads_manage_replies",
  "threads_read_replies",
];
