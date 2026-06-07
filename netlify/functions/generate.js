// ───────────────────────────────────────────────────────────────────────────
//  netlify/functions/generate.js  —  SBAC PT DESIGNER backend (HARDENED v2)
//
//  Reliability fixes vs v1:
//   • Uses Haiku 4.5 (fast) so generation finishes well inside Netlify's ~10s
//     function timeout — the main cause of intermittent failures.
//   • Prefills the reply with "{" so the model returns a clean JSON object with
//     no preamble or code fences.
//   • Validates/extracts the JSON on the server and returns guaranteed-clean
//     JSON to the page (or a friendly {error} it can retry).
//
//  Want higher-quality drafts later? Change the model to "claude-sonnet-4-6"
//  AND ask Netlify support to raise this site's function timeout to 26s, or
//  the occasional long Sonnet response will time out again.
// ───────────────────────────────────────────────────────────────────────────

export const config = { path: "/api/generate" };

const GENERATE_SYSTEM = `You are an expert Algebra 1 assessment designer who writes Smarter Balanced (SBAC) style performance tasks. Given a standard/topic, a real-world context, and a length, produce one classroom-ready performance task.

A strong task: opens with a realistic real-world scenario; has parts that ESCALATE (understand -> model -> multi-step problem solving -> written justification); targets the named standard authentically (not a skill drill); is solvable with Algebra 1.

Return a SINGLE JSON object with EXACTLY these fields and nothing else:
{
 "title": string,
 "standard": string,
 "scenario": string,
 "parts": [ { "label": string, "prompt": string, "claim": string } ],
 "rubric": [ { "points": string, "descriptor": string } ],
 "exemplar": string,
 "misconceptions": [ string ]
}
Field rules:
- "claim" is one of: "Concepts & Procedures", "Problem Solving", "Modeling & Data Analysis", "Communicating Reasoning".
- "rubric": a holistic scale (e.g. 4 down to 0), one short line per level, referencing the parts.
- "exemplar": a concise teacher answer key with the key numeric results; START it with "VERIFY: " plus a one-line reminder that generated arithmetic may contain errors.
- "misconceptions": 3-5 short common student errors on THIS task.

Be CONCISE to stay fast and complete: scenario under ~110 words; each part 1-2 sentences; keep the exemplar to key results. Grade-appropriate, specific, fresh. Output valid JSON only.`;

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } });

export default async (req) => {
  if (req.method !== "POST") return json({ error: "POST only" }, 405);

  let body;
  try { body = await req.json(); } catch { body = {}; }
  const { standard, context, length } = body;
  if (!standard) return json({ error: "A standard or topic is required." }, 400);

  const ask = `Standard/topic: ${standard}
Real-world context: ${context || "designer's choice"}
Length: ${length || "standard (4-5 parts)"}`;

  try {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": process.env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01"
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",   // fast → stays under the 10s function limit
        max_tokens: 1500,
        system: GENERATE_SYSTEM,
        messages: [
          { role: "user", content: ask },
          { role: "assistant", content: "{" }   // prefill → clean JSON, no preamble/fences
        ]
      })
    });
    const data = await r.json();
    if (data.error) return json({ error: data.error.message || "Anthropic error" });

    const out = (data.content || []).filter(b => b.type === "text").map(b => b.text).join("");
    const candidate = "{" + out;                    // re-add the prefilled brace
    const start = candidate.indexOf("{");
    const end = candidate.lastIndexOf("}");
    let parsed;
    try {
      parsed = JSON.parse(candidate.slice(start, end + 1));
    } catch (err) {
      return json({ error: "The draft came back incomplete — please draft again." });
    }
    return json({ reply: JSON.stringify(parsed) });  // guaranteed-clean JSON for the page
  } catch (err) {
    return json({ error: "Could not reach the generator service." });
  }
};
