// LLM fallback for items no rule or listing data covers.
//  - It CLASSIFIES into our archetype table first (so a "Driver 10.5 deg" with no "golf" in the title
//    is still treated as a golf club) and only MEASURES when nothing fits.
//  - Output is validated in itemProfile.validateLLM and cached per normalized title.
const { archetypeHints } = require('./categories');

function buildSystemPrompt() {
  return `You help estimate how an eBay item should be packed for shipping. Return JSON only, with exactly these fields:
- archetype: the single best match from the list below, judged by what the item PHYSICALLY is even when the title lacks the usual keyword, or "none" if nothing fits
- lengthIn, widthIn, heightIn: dimensions in INCHES of ONE unit of the item itself, NOT a shipping box or its retail packaging unless that is how it is always sold
- weightOz: weight of ONE unit in OUNCES
- rigidity: "rigid" or "flexible" (flexible = clothing, bags, soft goods that fold and compress)
- fragility: "low", "med" or "high"
- stackFactor: 0.3-1.0, flexible goods only: how much extra thickness each additional unit adds when stacked (1.0 for rigid)
- pieces: how many pieces it breaks down into for shipping (1 unless a multi-piece item like a rod)
- confidence: 0-1, how sure you are
Never output zero or negative values. If unsure, give a typical estimate and lower the confidence.

Archetypes:
${archetypeHints().map(h => `- ${h}`).join('\n')}`;
}

function makeLLM({ openai, serperKey, timeoutMs = 12000 }) {
  if (!openai) return null;
  const system = buildSystemPrompt();

  async function webContext(query) {
    if (!serperKey) return '';
    try {
      const r = await fetch('https://google.serper.dev/search', {
        method: 'POST',
        headers: { 'X-API-KEY': serperKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({ q: `${query} dimensions length width height weight` }),
        signal: AbortSignal.timeout(3000)
      });
      if (!r.ok) return '';
      const data = await r.json();
      return (data.organic || []).map(i => i.snippet).filter(Boolean).slice(0, 6).join(' ').slice(0, 2500);
    } catch { return ''; }
  }

  return async function llm({ title, categoryPath, itemSpecifics }) {
    const context = await webContext(String(title || '').slice(0, 150));
    const res = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      response_format: { type: 'json_object' },
      temperature: 0,
      seed: 7,
      messages: [
        { role: 'system', content: system },
        {
          role: 'user',
          content: `Title: ${title}\nCategory: ${categoryPath || ''}\nSpecifics: ${JSON.stringify(itemSpecifics || {}).slice(0, 800)}\nWeb context: ${context}`
        }
      ]
    }, { timeout: timeoutMs });
    return JSON.parse(res.choices[0].message.content);
  };
}

module.exports = { makeLLM, buildSystemPrompt };
