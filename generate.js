// ───────────────────────────────────────────────────────────────────────────
//  netlify/functions/generate.js  —  SBAC Item Designer backend (CAT + PT)
//
//  Branches on the {mode} the page sends: "cat" drafts a full CAT item set,
//  "pt" drafts a performance task. Both run on Haiku 4.5 (fast → reliable under
//  Netlify's function timeout), force clean JSON with a prefill, validate the
//  JSON on the server, and return it to the page. Teacher tool — keep private.
//
//  Env var (Site configuration → Environment variables, Functions scope):
//      ANTHROPIC_API_KEY = sk-ant-...
// ───────────────────────────────────────────────────────────────────────────

export const config = { path: "/api/generate" };

const CAT_SYSTEM =
`You are an expert Algebra 2 item writer creating Smarter Balanced (SBAC) style CAT items for ONE lesson.
Write this exact blueprint, escalating depth-of-knowledge: 2 multiple choice (one correct), 1 multiple select (2-3 correct), 2 numeric entry, 1 expression/equation entry, 1 technology-enhanced (a table-input, matching, or describe-a-graphing task MyOpenMath can deliver), 1 short constructed response (1-2 sentence reasoning).
Requirements:
- For multiple choice and multiple select, write distractors that each map to a SPECIFIC common misconception, and name the misconception in the rationale.
- Give the answer key for EVERY item.
- Tag each item with its SBAC claim (1-4) and DOK (1-3).
- Solvable with Algebra 2 math, grade-appropriate, realistic, fresh.
- VISUALS: If an item asks the student to read or interpret a graph, table, or diagram, you MUST include a "figure" object carrying the ACTUAL data, and that data MUST be consistent with the answer key. NEVER write "the graph below", "shown", "pictured", "the table", or similar unless that same item includes a "figure". If you cannot supply the data as a figure, instead put the needed numbers directly in the stem text and do not reference a picture.
- BREVITY IS REQUIRED so the full set fits in one response: each stem one sentence; each rationale one short clause; no extra prose or restating. Output only the JSON.
Return ONLY a JSON object: {"lesson":string,"items":[{"type":"multiple_choice|multiple_select|numeric|expression|tech_enhanced|short_cr","claim":string,"dok":string,"stem":string,"options":[string],"answer":string,"rationale":string,"figure":figure-or-omitted}]}
Omit "options" for non-choice items. Omit "figure" unless the item needs a visual. A figure is ONE of:
  graph -> {"type":"line"|"scatter"|"bar","xLabel":string,"yLabel":string,"points":[[x,y],...]}   (give enough points to show the key features the item asks about)
  table -> {"type":"table","columns":[string,...],"rows":[[cell,...],...]}
"answer" is the key (e.g. "B", "x = 2, 4", "(x-3)^2+2", or a short expected response).`;

const PT_SYSTEM =
`You are an expert Algebra 2 SBAC performance-task designer. Produce one classroom-ready performance task: a realistic scenario with parts that ESCALATE (understand -> model -> solve -> justify), targeting the standard, solvable with Algebra 2.
Return ONLY a JSON object: {"title":string,"standard":string,"scenario":string,"parts":[{"label":string,"prompt":string,"claim":string}],"rubric":[{"points":string,"descriptor":string}],"exemplar":string,"misconceptions":[string]}
"exemplar" is a teacher key; START it with "VERIFY: " and a reminder to check the math. Be concise so it's complete.`;

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } });

export default async (req) => {
  if (req.method !== "POST") return json({ error: "POST only" }, 405);

  let body;
  try { body = await req.json(); } catch { body = {}; }
  const { mode, standard, context, length } = body;
  if (!standard) return json({ error: "A standard or topic is required." }, 400);

  const isCat = mode === "cat";
  const system = isCat ? CAT_SYSTEM : PT_SYSTEM;
  const ask = isCat
    ? `Standard/topic: ${standard}\nReal-world context: ${context || "designer's choice"}`
    : `Standard/topic: ${standard}\nReal-world context: ${context || "designer's choice"}\nLength: ${length || "standard (4-5 parts)"}`;

  try {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": process.env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01"
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",      // fast → reliable inside the function timeout
        max_tokens: isCat ? 3600 : 2000,
        system,
        messages: [
          { role: "user", content: ask },
          { role: "assistant", content: "{" }    // prefill → clean JSON, no preamble
        ]
      })
    });
    const data = await r.json();
    if (data.error) return json({ error: data.error.message || "Anthropic error" });

    const out = (data.content || []).filter(b => b.type === "text").map(b => b.text).join("");
    const cand = "{" + out;
    const start = cand.indexOf("{"), end = cand.lastIndexOf("}");
    let parsed;
    try { parsed = JSON.parse(cand.slice(start, end + 1)); }
    catch (e) { return json({ error: "The draft came back incomplete — please draft again." }); }

    // Completeness guard: flag any item that points at a visual but shipped no figure,
    // so the page can warn the teacher instead of presenting a broken item.
    if (isCat && Array.isArray(parsed.items)) {
      const refsVisual = s => /\b(graph|diagram|figure|chart|plot|table)\b|shown below|pictured|below show/i.test(s || "");
      const hasFigure = f => f && f.type && ((Array.isArray(f.points) && f.points.length) || (Array.isArray(f.rows) && f.rows.length));
      for (const it of parsed.items) it.figureMissing = refsVisual(it.stem) && !hasFigure(it.figure);
    }
    return json({ reply: JSON.stringify(parsed) });   // clean JSON for the page
  } catch (err) {
    return json({ error: "Could not reach the generator service." });
  }
};
