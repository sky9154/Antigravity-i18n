import type { CompiledPattern } from "./types";


const PLACEHOLDER_RE = /\{(\d+)\}/g;
const UNICODE_ESCAPE_RE = /\\u([0-9a-fA-F]{4})/g;
const SURROGATE_PAIR_RE = /\\u(d[89ab][0-9a-fA-F]{2})\\u(d[c-f][0-9a-fA-F]{2})/gi;
const COMPACT_TIME_PATTERN_RE = /^(?:\{\d+\}(?:mo|[smhdwy]))(?:\s+\{\d+\}(?:mo|[smhdwy]))*$/;

const AMBIGUOUS_PATTERNS = new Set([
  "{0} and {1}",
  "{0}, and {1}",
  "{0}, {1}, and {2}",
  "{0}, from {1}",
  "on {0}",
  "this {0}",
  "{0} at {1}",
  "{0} of {1}"
]);

const TRANSLATABLE_SLOT_PATTERNS = new Set([
  "{0} {1} changed",
  "{0} {1} added",
  "{0} {1} deleted",
  "This {0} is managed by the",
  "Settings for conversations outside of {0}.",
  "Ran {0}",
  "ran {0}",
  "edited {0}",
  "Explored {0}",
  "explored {0}",
  "Searched {0}",
  "Read {0}",
  "No {0} yet",
  "Worked for {0}"
]);


export interface ExactLookup {
  exact: Map<string, string>;
  lower: Map<string, string>;
}


export function unescapeJsonLiterals(input: string): string {
  const withPairs = input.replace(SURROGATE_PAIR_RE, (_m, hi: string, lo: string) => {
    const codeHi = parseInt(hi, 16);
    const codeLo = parseInt(lo, 16);
    return String.fromCharCode(codeHi, codeLo);
  });

  return withPairs.replace(UNICODE_ESCAPE_RE, (_m, hex: string) => {
    return String.fromCharCode(parseInt(hex, 16));
  });
}


function escapeRegex(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}


export function normalizeExactMap(raw: Record<string, string>): ExactLookup {
  const exact = new Map<string, string>();
  const lower = new Map<string, string>();

  for (const [key, value] of Object.entries(raw)) {
    if (!value) {
      continue;
    }

    const decoded = unescapeJsonLiterals(key);
    exact.set(decoded, value);
    if (decoded !== key) {
      exact.set(key, value);
    }

    if (decoded.includes(" ")) {
      const lowerKey = decoded.toLowerCase();
      if (!lower.has(lowerKey)) {
        lower.set(lowerKey, value);
      }
    }
  }

  return { exact, lower };
}


export function compilePatterns(raw: Record<string, string>): CompiledPattern[] {
  const compiled: CompiledPattern[] = [];

  for (const [rawKey, template] of Object.entries(raw)) {
    if (!template || AMBIGUOUS_PATTERNS.has(rawKey)) {
      continue;
    }

    const key = unescapeJsonLiterals(rawKey);
    const isCompactTime = COMPACT_TIME_PATTERN_RE.test(key);
    const slots: number[] = [];
    let regexBody = "";
    let lastIndex = 0;
    let staticLength = 0;

    PLACEHOLDER_RE.lastIndex = 0;
    let match: RegExpExecArray | null;

    while ((match = PLACEHOLDER_RE.exec(key)) !== null) {
      const staticPart = key.slice(lastIndex, match.index);
      staticLength += staticPart.length;
      regexBody += escapeRegex(staticPart);

      const slotIndex = Number(match[1]);
      slots.push(slotIndex);

      const prevChar = match.index > 0 ? key[match.index - 1] : "";
      const isPluralSuffix = slotIndex > 0 && /[A-Za-z]/.test(prevChar);
      if (isCompactTime) {
        regexBody += "(\\d+)";
      } else {
        regexBody += isPluralSuffix ? "(s|es)?" : "(.+?)";
      }

      lastIndex = PLACEHOLDER_RE.lastIndex;
    }

    const tail = key.slice(lastIndex);
    staticLength += tail.length;
    regexBody += escapeRegex(tail);

    if (slots.length === 0 || (!isCompactTime && staticLength < 3)) {
      continue;
    }

    if (tail.length === 0 && regexBody.endsWith("(.+?)")) {
      regexBody = regexBody.slice(0, -5) + "(.+)";
    }

    compiled.push({
      rawKey: key,
      regex: new RegExp(`^${regexBody}$`),
      slots,
      template,
      weight: staticLength
    });
  }

  compiled.sort((a, b) => b.weight - a.weight);
  return compiled;
}


function lookupExact(trimmed: string, dict: ExactLookup): string | undefined {
  const direct = dict.exact.get(trimmed);
  if (direct) {
    return direct;
  }

  if (trimmed.includes(" ")) {
    return dict.lower.get(trimmed.toLowerCase());
  }

  return undefined;
}


function isUnmappedEnglishPhrase(value: string): boolean {
  const trimmed = value.trim();
  if (/[\\/]/.test(trimmed) || /^[^\s]+\.[A-Za-z0-9]{1,6}$/.test(trimmed)) {
    return false;
  }

  const words = trimmed.split(/\s+/);
  const alphaWords = words.filter((w) => /[A-Za-z]{2,}/.test(w));
  return alphaWords.length >= 3;
}


function translateSinglePhrase(
  trimmed: string,
  dict: ExactLookup,
  patterns: CompiledPattern[],
  allowNested = true
): string | null {
  const exactHit = lookupExact(trimmed, dict);
  if (exactHit) {
    return exactHit;
  }

  if (trimmed.length > 320) {
    return null;
  }

  for (const pattern of patterns) {
    const match = pattern.regex.exec(trimmed);
    if (!match) {
      continue;
    }

    const slotValues = new Map<number, string>();
    let rejectedByPhraseGuard = false;

    const allowSlotTranslation = TRANSLATABLE_SLOT_PATTERNS.has(pattern.rawKey);

    for (let i = 0; i < pattern.slots.length; i += 1) {
      const captured = match[i + 1] ?? "";
      let translatedSlot: string | undefined;
      if (allowSlotTranslation && captured && captured.length <= 40) {
        const trimmedSlot = captured.trim();
        translatedSlot = allowNested
          ? (translateSinglePhrase(trimmedSlot, dict, patterns, false) ?? undefined)
          : lookupExact(trimmedSlot, dict);
      }

      if (pattern.weight <= 12 && !translatedSlot && isUnmappedEnglishPhrase(captured)) {
        rejectedByPhraseGuard = true;
        break;
      }

      slotValues.set(pattern.slots[i], translatedSlot ?? captured);
    }

    if (rejectedByPhraseGuard) {
      continue;
    }

    return pattern.template.replace(PLACEHOLDER_RE, (_m, idxStr: string) => {
      return slotValues.get(Number(idxStr)) ?? "";
    });
  }

  return null;
}


export function translateWithDict(
  rawText: string,
  dict: ExactLookup,
  patterns: CompiledPattern[]
): string | null {
  const trimmed = rawText.trim();
  if (!trimmed || !/[A-Za-z]/.test(trimmed)) {
    return null;
  }

  const single = translateSinglePhrase(trimmed, dict, patterns);
  if (single) {
    return preserveEdgeWhitespace(rawText, single);
  }

  if (trimmed.includes(", ") && /^(?:Explored|Ran|Edited)\b/.test(trimmed)) {
    const parts = trimmed.split(", ");
    if (parts.length <= 3) {
      const translatedParts = parts.map((part) => translateSinglePhrase(part, dict, patterns));
      if (translatedParts.every((part) => part !== null)) {
        const joiner = /[\u4e00-\u9fff\u3040-\u30ff]/.test(translatedParts[0]) ? "\u3001" : ", ";
        return preserveEdgeWhitespace(rawText, translatedParts.join(joiner));
      }
    }
  }

  return null;
}


function preserveEdgeWhitespace(source: string, translated: string): string {
  const leading = /^\s*/.exec(source)?.[0] ?? "";
  const trailing = /\s*$/.exec(source)?.[0] ?? "";
  return `${leading}${translated}${trailing}`;
}
