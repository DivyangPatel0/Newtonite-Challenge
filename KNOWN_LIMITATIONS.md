# Known Limitations

- **Polling instead of push.** The detail view refreshes every 12 seconds and on window focus. There's no WebSocket or SSE channel. For an internal tool with moderate concurrency this is fine, but users editing the same item simultaneously will see updates with a delay. I'd add a WebSocket channel per work item if this became a real pain point.

- **No rate limiting.** Any authenticated user can hit mutations as fast as they want. In production I'd add per-user rate limiting on write endpoints, probably in a Fastify hook with a sliding-window counter in Postgres (or Redis if it were available).

- **Simple password auth.** Passwords are bcrypt-hashed and sessions are JWT in httpOnly cookies with a 24-hour expiry. There's no password complexity enforcement, no account lockout after failed attempts, no refresh token rotation, and no OAuth/SSO. This is the simplest thing that works for a demo.

- **Single worker, no tuning.** The outbox worker is a single-process loop with a 2-second poll interval and batch size of 10. There's no LISTEN/NOTIFY for immediate wakeup, no horizontal scaling across workers, and no dead-letter alerting. Backoff maxes out at 5 attempts and then the event is marked failed with no recovery path. I'd want monitoring on the failed count in production.

- **FTS ranking is basic.** I weight title as 'A' and description as 'B' in the tsvector, but I don't use ts_rank for result ordering -- results are sorted by updated_at or priority, not by relevance. For a filtered list this is acceptable, but a dedicated search page should rank by relevance.

- **No attachments or file uploads.** Would need S3 or a local file store, a media table, and presigned URL handling. Straightforward but not in scope.

- **No email or webhook delivery.** The notifications table is populated but there's no delivery mechanism beyond reading them in the UI.

- **No bulk operations.** Can't batch-close, batch-reassign, or batch-transition. Each item mutation needs its own version check, which makes batch ops non-trivial to get right.

- **JWT contains user data that can go stale.** If a user's name or superadmin flag changes, the JWT still has the old values until they re-login. A production system should look up the user from the database on each request rather than trusting the token payload for anything beyond the user ID.

- **No input sanitization for XSS.** Work item titles and descriptions are rendered as text content (React handles this safely by default), but there's no server-side HTML sanitization. If the data were rendered in a non-React context (email templates, exports), this would be a problem.

- **Cursor pagination prevents page jumping.** Users can't go directly to "page 5" -- they have to load sequentially. This is the correct trade-off for consistency but slightly worse UX for browsing deep into a list.
