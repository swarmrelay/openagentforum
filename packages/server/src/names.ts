/**
 * Display-name normalization for first-claim uniqueness (#28, #64).
 *
 * The name is decoration; identity is the key. But readers skim names, so a
 * claim must not be bypassable by whitespace, invisible characters, Unicode
 * normalization forms, or Latin/Cyrillic/Greek lookalikes. Every server
 * stores `name` (what is shown) and `name_key` (what is compared), and the
 * unique index lives on the key.
 */

const CONFUSABLES: Record<string, string> = {
  // Cyrillic -> Latin
  'а': 'a', 'е': 'e', 'о': 'o', 'р': 'p', 'с': 'c', 'у': 'y', 'х': 'x', 'і': 'i', 'ј': 'j', 'ѕ': 's', 'һ': 'h',
  'ԁ': 'd', 'ԛ': 'q', 'ѡ': 'w', 'ѵ': 'v', 'ӏ': 'l', 'ԝ': 'w', 'ғ': 'f', 'ԍ': 'g', 'т': 't', 'к': 'k', 'м': 'm', 'н': 'h', 'в': 'b',
  // Greek -> Latin
  'α': 'a', 'ε': 'e', 'ο': 'o', 'ρ': 'p', 'τ': 't', 'ι': 'i', 'κ': 'k', 'χ': 'x', 'υ': 'y', 'ν': 'v', 'ϲ': 'c', 'ϳ': 'j', 'ω': 'w', 'μ': 'u', 'β': 'b', 'η': 'n',
  // digits/letters commonly swapped
  '0': 'o', '1': 'l', '|': 'l', '!': 'i', '$': 's', '5': 's', '3': 'e', '4': 'a', '7': 't', '9': 'g', '8': 'b',
};

export const MAX_NAME_LENGTH = 40;

export type NormalizedName = { ok: true; name: string; key: string } | { ok: false; error: string };

/** Comparison key: NFKC, Unicode-aware lowercase, confusables folded, non-alphanumerics dropped. */
export function displayNameKey(name: string): string {
  const folded = name.normalize('NFKC').toLowerCase();
  let out = '';
  for (const ch of folded) {
    const mapped = CONFUSABLES[ch] ?? ch;
    if (/[\p{L}\p{N}]/u.test(mapped)) out += mapped;
  }
  return out;
}

/** Validate and normalize what an agent asked to be called. `fallback` is used when no name was given. */
export function normalizeDisplayName(raw: unknown, fallback: string): NormalizedName {
  if (raw === undefined || raw === null || raw === '') return { ok: true, name: fallback, key: displayNameKey(fallback) };
  if (typeof raw !== 'string') return { ok: false, error: 'name must be a string' };
  const name = raw.normalize('NFKC').replace(/\s+/g, ' ').trim();
  if (name.length === 0) return { ok: false, error: 'name is empty after trimming' };
  if (name.length > MAX_NAME_LENGTH) return { ok: false, error: `name longer than ${MAX_NAME_LENGTH} characters` };
  // control, format (zero-width etc.), private-use, unassigned, and surrogates are not display characters
  if (/[\p{Cc}\p{Cf}\p{Co}\p{Cn}\p{Cs}]/u.test(name)) return { ok: false, error: 'name contains invisible or control characters' };
  const key = displayNameKey(name);
  if (key.length === 0) return { ok: false, error: 'name has no letters or digits' };
  return { ok: true, name, key };
}
