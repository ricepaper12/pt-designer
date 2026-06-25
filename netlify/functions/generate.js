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
- VISUALS: Standards about reading a graph or table (e.g. F-IF.4, F-IF.6) REQUIRE a "figure". For ANY item that asks the student to read or interpret a graph or table, you MUST include a "figure" object, and write the stem so the student READS the figure — do NOT spell the coordinates, vertex, or intercepts out in the stem text (that defeats the point). The figure MUST be consistent with the answer key. Never write "the graph", "shown", "the table", etc. without including the figure.
- BREVITY IS REQUIRED so the full set fits in one response: each stem one sentence; each rationale one short clause; no extra prose or restating. Output only the JSON.
Return ONLY a JSON object: {"lesson":string,"items":[{"type":"multiple_choice|multiple_select|numeric|expression|tech_enhanced|short_cr","claim":string,"dok":string,"stem":string,"options":[string],"answer":string,"rationale":string,"figure":figure-or-omitted}]}
Omit "options" for non-choice items. Omit "figure" only when the item truly needs no visual. To keep figures accurate, give DEFINING FEATURES, not hand-computed curve points — the app draws the curve. A figure is ONE of:
  line   -> {"type":"line","xLabel":string,"yLabel":string,"points":[[x,y],...]}  (2+ points; for a straight line just give the two endpoints)
  parabola -> {"type":"parabola","xLabel":string,"yLabel":string,"vertex":[h,k],"xIntercepts":[r1,r2]}  (use for ANY quadratic; give the vertex and the two x-intercepts)
  scatter/bar -> {"type":"scatter"|"bar","xLabel":string,"yLabel":string,"points":[[x,y],...]}
  table  -> {"type":"table","columns":[string,...],"rows":[[cell,...],...]}
Examples:  {"type":"line","xLabel":"Month","yLabel":"Dollars","points":[[0,500],[12,2300]]}  |  {"type":"parabola","xLabel":"Month","yLabel":"Dollars","vertex":[4,3000],"xIntercepts":[1,7]}
"answer" is the key (e.g. "B", "x = 2, 4", "(x-3)^2+2", or a short expected response).`;

const PT_SYSTEM =
`You are an expert Algebra 2 SBAC performance-task designer. Produce one classroom-ready performance task: a realistic scenario with parts that ESCALATE (understand -> model -> solve -> justify), targeting the standard, solvable with Algebra 2.
Return ONLY a JSON object: {"title":string,"standard":string,"scenario":string,"parts":[{"label":string,"prompt":string,"claim":string}],"rubric":[{"points":string,"descriptor":string}],"exemplar":string,"misconceptions":[string]}
"exemplar" is a teacher key; START it with "VERIFY: " and a reminder to check the math. Be concise so it's complete.`;

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } });

// One place to call the model. Prefill forces clean JSON with no preamble.
async function callAnthropic(model, system, user, max_tokens, prefill) {
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": process.env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01"
    },
    body: JSON.stringify({
      model, max_tokens, system,
      messages: prefill
        ? [{ role: "user", content: user }, { role: "assistant", content: prefill }]
        : [{ role: "user", content: user }]
    })
  });
  const data = await r.json();
  if (data.error) throw new Error(data.error.message || "Anthropic error");
  return (data.content || []).filter(b => b.type === "text").map(b => b.text).join("");
}

// Focused second pass: for each graph item, a strong model designs the figure,
// then treats THAT figure as ground truth and re-derives the correct answer from it —
// so the picture, the question, and the key all agree.
// Accuracy lever: set FIGURE_MODEL to "claude-opus-4-8" for the most capable reasoning
// (best for a colleague-facing showcase). It is slower — if your Netlify plan caps
// function runtime at 10s it may occasionally time out (the on-screen banner will say so);
// raising the function timeout to 26s in netlify.toml removes that risk. Sonnet is the
// safe default that already fixes the common shape/key mistakes.
const FIGURE_MODEL = "claude-sonnet-4-6";

const FIGURE_SYSTEM =
`You complete graph-based math items so the PICTURE, the QUESTION, and the KEY all agree. For EACH item, reason in three steps, then output JSON.
STEP 1 — Shape the question demands. Read the stem/options and decide what the graph must look like for the intended answer to be right. Match the wording exactly:
  • "increasing throughout" / "always rising" = a line or curve with NO turning point (do NOT use a parabola).
  • "maximum" / "stops increasing and starts decreasing" / "highest then falls" = a DOWNWARD parabola (the turning point is a MAX).
  • "minimum" / "stops decreasing and starts increasing" / "lowest then rises" = an UPWARD parabola (the turning point is a MIN).
STEP 2 — Draw it realistically. "domain" = the real x-range named (e.g. "over 10 days" -> [0,10]); the graph shows ONLY that range. Values must make sense: a COST, PRICE, or BILL is NEVER negative — keep it >= 0 across the whole domain; a PROFIT or BALANCE MAY be negative (a loss/deficit). Use defining features, never hand-computed points.
STEP 3 — Read the key OFF your own figure. Test EVERY option one at a time against the figure you drew, over its domain, and put in "answer" ONLY the options that are genuinely true. Never include an option your own graph makes false (e.g. do NOT mark "increasing throughout" true when your graph has a maximum). A feature counts only if it is visible inside the domain. Rewrite the rationale to match.
Output ONLY a JSON array, one object per item IN ORDER: {"figure":<figure-or-null>,"answer":<key>,"rationale":<one short clause>}.
A figure is ONE of:
  {"type":"line","xLabel":S,"yLabel":S,"domain":[a,b],"points":[[x,y],...]}
  {"type":"parabola","xLabel":S,"yLabel":S,"domain":[a,b],"vertex":[h,k],"xIntercepts":[r1,r2]}   // when the curve crosses zero IN view
  {"type":"parabola","xLabel":S,"yLabel":S,"domain":[a,b],"vertex":[h,k],"through":[x,y]}          // when it never crosses zero (e.g. a positive-only cost): give one other point it passes through
  {"type":"scatter"|"bar","xLabel":S,"yLabel":S,"domain":[a,b],"points":[[x,y],...]}
  {"type":"table","columns":[S,...],"rows":[[c,...],...]}
Worked example — stem "A production cost decreases then increases; at what month is it lowest?": cost is U-shaped (a MIN) and must stay positive, so use an upward parabola with a "through" point:
  {"figure":{"type":"parabola","xLabel":"Month","yLabel":"Cost ($)","domain":[0,6],"vertex":[3,200],"through":[0,800]},"answer":"3","rationale":"U-shaped cost with its minimum at month 3; cost stays positive."}
Output only the JSON array.`;

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
    const out = await callAnthropic("claude-haiku-4-5-20251001", system, ask, isCat ? 3600 : 2000, "{");
    const cand = "{" + out;
    const start = cand.indexOf("{"), end = cand.lastIndexOf("}");
    let parsed;
    try { parsed = JSON.parse(cand.slice(start, end + 1)); }
    catch (e) { return json({ error: "The draft came back incomplete — please draft again." }); }

    if (isCat && Array.isArray(parsed.items)) {
      const refsVisual = s => /\b(graph|diagram|figure|chart|plot|table)\b|shown below|pictured|below show/i.test(s || "");
      const hasFigure = f => f && f.type && (
        (Array.isArray(f.points) && f.points.length) ||
        (Array.isArray(f.rows) && f.rows.length) ||
        (f.type === "parabola" && Array.isArray(f.vertex))
      );
      for (const it of parsed.items) it.figureMissing = refsVisual(it.stem) && !hasFigure(it.figure);

      // Second pass: design the figure AND re-derive the key from it, consistently.
      const need = parsed.items.filter(it => it.figureMissing);
      if (need.length) {
        const list = need.map((it, i) =>
          `${i + 1}. STEM: ${it.stem}\n   OPTIONS: ${(it.options || []).join("  |  ") || "(not multiple choice)"}\n   PROPOSED ANSWER: ${it.answer}`
        ).join("\n");
        const userMsg = `Standard: ${standard}\nItems (return EXACTLY ${need.length} objects, one per item, in order):\n${list}`;

        const runFigurePass = async (model) => {
          const out = await callAnthropic(model, FIGURE_SYSTEM, userMsg, 4096, "");  // no prefill (some models reject it)
          const cleaned = out.replace(/```json|```/g, "");
          const arr = JSON.parse(cleaned.slice(cleaned.indexOf("["), cleaned.lastIndexOf("]") + 1));
          let filled = 0;
          need.forEach((it, i) => {
            const r = arr[i];
            if (r && r.figure && r.figure.type) {
              it.figure = r.figure;
              if (r.answer) it.answer = r.answer;          // key now matches the drawn figure
              if (r.rationale) it.rationale = r.rationale;
              it.figureMissing = !hasFigure(it.figure);
              filled++;
            }
          });
          return filled;
        };

        // Try Sonnet (best reasoning); if it errors or under-fills, retry once on fast Haiku.
        try {
          let filled = await runFigurePass(FIGURE_MODEL);
          if (filled < need.length) filled = Math.max(filled, await runFigurePass("claude-haiku-4-5-20251001"));
          const still = parsed.items.filter(it => it.figureMissing).length;
          if (still) parsed._figNote = `figure step filled ${filled} of ${need.length}; ${still} still missing — re-draft`;
        } catch (e) {
          // Surface WHY so it is diagnosable instead of silently blank.
          const m = String((e && e.message) || e);
          const why = /429|rate/i.test(m) ? "rate limit — wait ~1 min and re-draft"
                    : /tim(e|ed) ?out|abort/i.test(m) ? "the figure step timed out — re-draft"
                    : /JSON|Unexpected|parse/i.test(m) ? "the figure data came back malformed — re-draft"
                    : m.slice(0, 90);
          parsed._figNote = "figures didn't generate: " + why;
        }
      }
    }
    return json({ reply: JSON.stringify(parsed) });   // clean JSON for the page
  } catch (err) {
    return json({ error: "Could not reach the generator service." });
  }
};
