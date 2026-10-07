// Gemini prompts. Built from config so no reader- or city-specific text lives
// in code. URLs are deliberately NOT given to the model: Google News links are
// long base64 blobs the model corrupts when copying. It cites {{N}} instead,
// and substituteLinks puts the exact URL back afterwards.

const HTML_RULE =
  "- Formatting: ONLY these Telegram HTML tags: <b>bold</b>, <i>italic</i>, <a href=\"URL\">link text</a>. " +
  "No Markdown, no other tags. Escape < > & in plain text as &lt; &gt; &amp;.";

export function localPrompt({ local, output, newsList, noneToken }) {
  const geography = local.nearby.length
    ? `- Geography. For events, culture, construction, transport and city-council decisions, ${local.name} and the surrounding area (${local.nearby.join(", ")}) qualify. For crime, accidents and incidents — ONLY ${local.name} itself.`
    : `- Geography. Only stories about ${local.name} itself qualify.`;
  const skip = local.skipTopics.map((t) => `- Drop entirely: ${t}.`).join("\n");

  return `You are the editor of a local news column about ${local.name}.

TASK: from the list below pick 2-4 stories that matter to someone living in ${local.name} and format a Telegram block, written in ${output.language}.

SELECTION RULES:
${geography}
${skip ? `${skip}\n` : ""}- Drop items that landed in the results by mistake: shop flyers and promotions, national news that merely mentions ${local.name}, country-wide statistics, news about other cities and regions.
- If a story has an event date, include it.
- If nothing qualifies, output exactly one word: ${noneToken}

FORMAT:
- First line: <b>${local.header}</b>
- Each story: 1-2 sentences in your own words, ending with the story's number from the list in double curly braces: {{N}}. Never write URLs yourself.
${HTML_RULE}
- No introductions or explanations — only the block itself.

NEWS:
${newsList}`;
}

export function digestPrompt({ persona, output, today, newsList, exclusionRule = "" }) {
  return `You are the editor of a personal news digest.

READER PROFILE:
${persona.trim()}

TASK: from the news list below build a digest in ${output.language} to be sent to Telegram.

RULES:
- Pick the 8-16 stories that matter most to this reader, drop the rest.
- Group them by topic (for example: ${output.topics}). Do not show empty groups.
${exclusionRule}\
- Each story: 1-2 sentences in your own words, ending with the story's number from the list in double curly braces: {{N}}. Never write URLs yourself — only {{N}}; the program inserts the link.
- Collapse duplicates of the same story from different sources into one; if you merged several, list all their numbers separated by spaces: {{3}} {{17}}.
${HTML_RULE}
- Start the digest with the line: <b>${output.title} — ${today}</b>
- No introductions, explanations or questions — only the digest itself.

NEWS:
${newsList}`;
}
