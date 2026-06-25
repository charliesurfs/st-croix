const SYSTEM_PROMPT = `You are a tactful trip-planning mediator for a family trip to St. Croix (Aug 19-26, 2026). You are given one family member's (Dad's, the trip leader's) private free-text notes about how he envisions the trip, plus the list of trip days and the candidate activities with the GROUP'S AVERAGE interest rating (1-5) for each. Your job: (1) propose a day-by-day "spine" - a high-level theme/area for each day that reflects Dad's vision, mapped onto the real dates. (2) Summarize in plain language what you heard from his notes. (3) Tactfully flag any activities that Dad seems to want but that the group rated low (groupAvg <= 2), so he's aware before he commits - phrase these as gentle heads-ups, never as criticism, and refer only to the group average, never to individuals. Do NOT invent constraints Dad didn't state. Do NOT schedule specific activities into specific time slots - only propose the day-level shape. Return ONLY the JSON object specified, no other text.`;

const OUTPUT_SHAPE = {
  summary: "<2-4 sentence plain-language 'here's what I heard from your notes'>",
  spine: [
    { date: "2026-08-19", theme: "<short label e.g. 'West side / Frederiksted'>", rationale: "<one line why>" }
  ],
  flags: [
    { activity: "<title>", groupAvg: 1.4, note: "<tactful heads-up that the group rated this low>" }
  ]
};

async function readJsonBody(req) {
  if (req.body && typeof req.body === "object") return req.body;
  if (typeof req.body === "string" && req.body.trim()) return JSON.parse(req.body);

  const chunks = [];
  for await (const chunk of req) chunks.push(typeof chunk === "string" ? chunk : chunk.toString("utf8"));
  const raw = chunks.join("").trim();
  if (!raw) return {};
  return JSON.parse(raw);
}

function extractAnthropicText(payload) {
  if (!payload || !Array.isArray(payload.content)) return "";
  return payload.content
    .filter((entry) => entry && entry.type === "text" && typeof entry.text === "string")
    .map((entry) => entry.text)
    .join("\n")
    .trim();
}

function parseModelJson(rawText) {
  const direct = tryParseJson(rawText);
  if (direct.ok) return direct.value;

  const unfenced = rawText
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
  const stripped = tryParseJson(unfenced);
  if (stripped.ok) return stripped.value;

  const chunk = extractJsonChunk(unfenced);
  const nested = tryParseJson(chunk);
  if (nested.ok) return nested.value;

  throw new Error("parse_failed");
}

function tryParseJson(value) {
  if (!value) return { ok: false };
  try {
    return { ok: true, value: JSON.parse(value) };
  } catch {
    return { ok: false };
  }
}

function extractJsonChunk(text) {
  const start = text.indexOf("{");
  if (start < 0) return text;

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < text.length; i += 1) {
    const char = text[i];

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === "\"") {
        inString = false;
      }
      continue;
    }

    if (char === "\"") {
      inString = true;
      continue;
    }
    if (char === "{") depth += 1;
    if (char === "}") {
      depth -= 1;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }

  return text;
}

function safeAnthropicError(status, payload) {
  const message = payload?.error?.message || payload?.message || "Anthropic request failed.";
  return {
    error: "Anthropic request failed.",
    detail: message,
    status
  };
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed. Use POST." });
  }

  try {
    const body = await readJsonBody(req);
    const dadNote = typeof body?.dadNote === "string" ? body.dadNote.trim() : "";
    const days = Array.isArray(body?.days) ? body.days : [];
    const activities = Array.isArray(body?.activities) ? body.activities : [];

    if (!dadNote) {
      return res.status(400).json({ error: "dadNote is required." });
    }

    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      return res.status(500).json({ error: "Anthropic API key is not configured." });
    }

    const anthropicResponse = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json"
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 1500,
        system: SYSTEM_PROMPT,
        messages: [
          {
            role: "user",
            content: `Use this input to build the response.\n\nDad note:\n${dadNote}\n\nTrip days:\n${JSON.stringify(days, null, 2)}\n\nCandidate activities with group-average interest:\n${JSON.stringify(activities, null, 2)}\n\nReturn only valid JSON with this exact shape:\n${JSON.stringify(OUTPUT_SHAPE, null, 2)}`
          }
        ]
      })
    });

    const responseJson = await anthropicResponse.json().catch(() => null);
    if (!anthropicResponse.ok) {
      return res.status(502).json(safeAnthropicError(anthropicResponse.status, responseJson));
    }

    const rawText = extractAnthropicText(responseJson);

    try {
      const parsed = parseModelJson(rawText);
      return res.status(200).json(parsed);
    } catch {
      return res.status(502).json({
        error: "Could not parse model JSON.",
        rawText
      });
    }
  } catch (error) {
    if (error instanceof SyntaxError) {
      return res.status(400).json({ error: "Invalid JSON body." });
    }

    return res.status(502).json({
      error: "Failed to generate a proposal."
    });
  }
}
