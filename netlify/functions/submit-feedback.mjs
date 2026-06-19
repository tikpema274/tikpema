// submit-feedback.mjs — relay in-app feedback to a Discord channel.
//
// The Discord webhook URL is a server-side secret (DISCORD_FEEDBACK_WEBHOOK):
// it is read here and never shipped to the browser, so the channel can't be
// spammed by anyone who reads the bundle.
//
// Input (POST body): { thoughts, confusion, wouldReturn, handle, walletAddress }
//   - walletAddress is included when present so feedback from someone who
//     actually connected a wallet (and maybe bet) is distinguishable from a
//     plain browser.
// Output: { ok: true } on success, { error } otherwise.

import { json, parseBody } from "./_arc.mjs";

export async function handler(event) {
  if (event.httpMethod !== "POST") return json(405, { error: "POST only" });

  const webhook = process.env.DISCORD_FEEDBACK_WEBHOOK;
  if (!webhook) {
    // Misconfiguration, not a user error — fail gracefully without crashing.
    return json(500, { error: "Feedback is not configured (missing webhook)." });
  }

  const { thoughts, confusion, wouldReturn, handle, walletAddress } =
    parseBody(event);

  // Require at least one substantive field so empty submissions don't post.
  if (!thoughts?.trim() && !confusion?.trim()) {
    return json(400, { error: "Say at least a little — both fields are empty." });
  }

  // A readable Discord message with each field clearly labeled. Fall back to
  // "—" for anything the user left blank.
  const dash = (s) => (s?.trim() ? s.trim() : "—");
  const lines = [
    "**New Tikpema feedback**",
    `**What they thought:** ${dash(thoughts)}`,
    `**What confused them:** ${dash(confusion)}`,
    `**Would use again:** ${dash(wouldReturn)}`,
    `**Name:** ${dash(handle)}`,
    `**Wallet:** ${walletAddress?.trim() ? walletAddress.trim() : "not connected"}`,
  ];

  try {
    const res = await fetch(webhook, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: lines.join("\n") }),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      return json(502, {
        error: `Discord rejected the message (${res.status}).`,
        detail: detail.slice(0, 300),
      });
    }
    return json(200, { ok: true });
  } catch (e) {
    return json(500, { error: e.message });
  }
}
