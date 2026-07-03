// POST /api/job-submit { jobId, question }  (synchronous auth front door)
//
// Netlify `-background` functions return 202 BEFORE the handler runs, so a gate
// inside job-submit-background can block the spend but can't return 401 to the
// caller. This thin synchronous endpoint authenticates the user FIRST (real
// 401 on failure), then fires the background research+submit worker with an
// internal token. The browser calls this; job-submit-background is now
// server-to-server only.
import { json, parseBody } from "./_arc.mjs";
import { requireSession, internalToken } from "./_auth.mjs";

export async function handler(event) {
  if (event.httpMethod !== "POST") return json(405, { error: "POST only" });

  // Auth gate — reject anonymous callers before any work is triggered.
  const session = requireSession(event);
  if (!session) return json(401, { error: "Authentication required" });

  const { jobId, question } = parseBody(event);
  if (!jobId) return json(400, { error: "jobId required" });

  // Trigger the background worker (internal-authenticated). Awaiting the fetch
  // only waits for Netlify's 202 ack, not the 15-min research run.
  const base =
    process.env.DEPLOY_URL ||
    `${event.headers["x-forwarded-proto"] || "https"}://${event.headers.host}`;
  try {
    await fetch(`${base}/.netlify/functions/job-submit-background`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-internal-token": internalToken(),
      },
      body: JSON.stringify({ jobId, question }),
    });
  } catch (e) {
    return json(502, { error: `could not start research worker: ${e.message}` });
  }

  return json(202, { accepted: true, jobId });
}
