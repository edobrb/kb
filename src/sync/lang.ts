/** Cheap Italian/English detector based on function words. Returns "it", "en" or "und". */

const IT = ["il", "la", "di", "che", "e", "per", "non", "una", "un", "del", "della", "con", "sono", "è", "gli", "le", "nel", "nella", "dei", "delle", "anche", "come", "questo", "viene", "essere"];
const EN = ["the", "and", "of", "to", "is", "in", "for", "with", "that", "are", "this", "on", "be", "as", "by", "from", "it", "an", "or", "can", "will", "which", "not", "has"];

const itSet = new Set(IT);
const enSet = new Set(EN);

export function detectLang(text: string, minWords = 8, minRatio = 1.5): "it" | "en" | "und" {
  const cleaned = text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`[^`]*`/g, " ")
    .replace(/https?:\/\/\S+/g, " ")
    .toLowerCase();
  let it = 0;
  let en = 0;
  for (const w of cleaned.split(/[^a-zàèéìòù']+/)) {
    if (!w) continue;
    if (itSet.has(w)) it++;
    else if (enSet.has(w)) en++;
  }
  if (it + en < minWords) return "und";
  if (it >= en * minRatio) return "it";
  if (en >= it * minRatio) return "en";
  return "und";
}
