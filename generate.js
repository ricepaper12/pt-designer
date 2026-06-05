// ───────────────────────────────────────────────────────────────────────────
//  netlify/functions/generate.js  —  backend for the SBAC PT DESIGNER (teacher)
//
//  Netlify version of the generator. Like the coach's function, the config.path
//  line makes it answer at /api/generate, so the designer page works unchanged.
//
//  TEACHER TOOL: this returns full answer keys, so deploy it on its OWN site
//  (separate from the student coach) and don't share the URL with students.
//
//  TO RUN:
//   1. Keep this file at  netlify/functions/generate.js  (next to index.html).
//   2. Netlify → Site configuration → Environment variables:
//          ANTHROPIC_API_KEY = sk-ant-...   (scope must include Functions)
//      You can reuse the same key as the coach site.
//   3. Deploy.
// ───────────────────────────────────────────────────────────────────────────

export const config = { path: "/api/generate" };

const GENERATE_SYSTEM = `You are an expert Algebra 1 assessment designer who writes Smarter Balanced (SBAC) style performance tasks. Given a standard/topic, a real-world context, and a desired length, produce a complete, classroom-ready performance task.

A strong SBAC-style performance task:
- Opens with a coherent real-world scenario using realistic numbers.
- Has parts that ESCALATE: early parts establish understanding; later parts require modeling, multi-step problem solving, and a written justification or critique.
- Targets the named standard authentically — not a single skill dressed up as a story.
- Is fully solvable with Algebra 1 mathematics.

Return ONLY a JSON object — no markdown, no code fences, no text before or after — with exactly this shape:
{
 "title": string,
 "standard": string,
 "scenario": string,
 "parts": [ { "label": string, "prompt": string, "claim": string } ],
 "rubric": [ { "points": string, "descriptor": string } ],
 "exemplar": string,
 "misconceptions": [ string ]
}
Rules for fields:
- "claim" is one of: "Concepts & Procedures", "Problem Solving", "Modeling & Data Analysis", "Communicating Reasoning".
- "rubric" is a holistic scale (e.g. 4 down to 0) whose descriptors reference the parts.
- "exemplar" is a worked answer key FOR THE TEACHER with key numeric results; begin it with "VERIFY: " and a one-line reminder for the teacher to check the math, since generated arithmetic can contain errors.
- "misconceptions" lists 3-5 common student errors on THIS task (these can be loaded into the PT coach).
Keep it grade-appropriate, specific, and fresh. Be concise enough that the whole packet is complete and not cut off.`;

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
        model: "claude-sonnet-4-6",   // quality matters more than cost for authoring
        max_tokens: 2000,
        system: GENERATE_SYSTEM,
        messages: [{ role: "user", content: ask }]
      })
    });
    const data = await r.json();
    if (data.error) return json({ error: data.error.message || "Anthropic error" }, 502);
    const reply = (data.content || []).filter(b => b.type === "text").map(b => b.text).join("\n").trim();
    return json({ reply });   // reply is a JSON string; the page parses it
  } catch (err) {
    return json({ error: "Could not reach the generator service." }, 500);
  }
};
