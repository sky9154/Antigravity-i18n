from __future__ import annotations

import json
from pathlib import Path
import re

from .constants import (
  NON_UI_PREFIXES, TAILWIND_EXACT_TOKENS, TAILWIND_PREFIXES, TECH_DEBUG_SUBSTRINGS,
  TECH_NOISE_PATTERNS
)


TEMPLATE_EXPR_RE = re.compile(r"\$\{[^}]+\}")
HEX_COLOR_RE = re.compile(r"^#[0-9A-Fa-f]{3,8}$")

CSS_FUNC_RE = re.compile(
  r"(?:linear-gradient|radial-gradient|conic-gradient|color-mix|var\(--|cubic-bezier|prefers-reduced-motion|rgba?\(|hsla?\(|calc\(|minmax\()",
  re.I
)

SVG_OR_GEO_RE = re.compile(
  r"^(?:(?:min|max|clamp)\(\{0\},\s*\{1\}\)|[MLQCZHVSAmlqczhvsa](?=[\s\d{])[^A-Za-z]*)$"
)


def read_json(path: Path) -> dict:
  raw = path.read_text(encoding="utf-8")
  try:
    data = json.loads(raw)
  except json.JSONDecodeError as error:
    raise ValueError(f"Invalid JSON in {path}: {error}") from error

  if not isinstance(data, dict):
    raise ValueError(f"Expected JSON object in {path}, got {type(data).__name__}")

  return data


def decode_js_escapes(raw: str) -> str:
  if "\\" not in raw:
    return raw

  return (
    raw.replace(r"\/", "/").replace(r"\'", "'").replace(r'\"', '"').replace(r"\n", "\n").replace(
      r"\t", "\t"
    ).replace(r"\r", "\r").replace(r"\\", "\\")
  )


def normalize_template_placeholders(text: str) -> str:
  index = 0

  def replace_expr(_match: re.Match) -> str:
    nonlocal index
    token = f"{{{index}}}"
    index += 1
    return token

  return TEMPLATE_EXPR_RE.sub(replace_expr, text)


def is_candidate_ui_text(text: str) -> bool:
  s = text.strip()
  if len(s) < 2 or len(s) > 450 or not re.search(r"[A-Za-z]", s):
    return False

  if s.lower().startswith(NON_UI_PREFIXES):
    return False

  if any(pat.match(s) for pat in TECH_NOISE_PATTERNS):
    return False

  if " " not in s and re.match(r"^[A-Za-z][A-Za-z0-9_]*$", s):
    if re.search(r"[a-z][A-Z]", s) or "_" in s:
      return False

  return True


def is_english_sentence_or_label(text: str) -> bool:
  if not is_candidate_ui_text(text):
    return False

  s = text.strip()
  if " " not in s:
    return bool(re.match(r"^[A-Z][a-z]{2,24}(?:[.!?…]|\\u2026)*$", s))

  if s.count("{") > 2 or s.count(";") > 1 or "=>" in s or "function(" in s:
    return False

  if s.startswith(("SELECT ", "INSERT ", "UPDATE ", "DELETE ", "CREATE TABLE ")):
    return False

  return bool(re.match(r"^[A-Za-z0-9\"'(]", s))


def is_css_or_tailwind(text: str) -> bool:
  if CSS_FUNC_RE.search(text) or HEX_COLOR_RE.match(text):
    return True

  if re.search(r"\d+(?:px|rem|em|ms|vh|vw)\b", text) and not re.search(r"[.!?]$", text):
    if "px " in text or "ms " in text or text.endswith(("px", "rem", "em", "vh", "vw")):
      return True

  tokens = text.split()
  if not tokens:
    return False

  tw_hits = 0
  for tok in tokens:
    clean_tok = tok.strip(",;:")
    if clean_tok in TAILWIND_EXACT_TOKENS or clean_tok.startswith(TAILWIND_PREFIXES):
      tw_hits += 1
    elif "[" in clean_tok and "]" in clean_tok and ("-" in clean_tok or ":" in clean_tok):
      tw_hits += 1

  if len(tokens) == 1:
    return tw_hits == 1

  return (tw_hits / len(tokens)) >= 0.4


def has_unbalanced_fragment(text: str) -> bool:
  s = text.strip()

  if s.endswith(("\\", "(", "`", "'")) and not s.endswith(")'"):
    return True

  if s.startswith(("'", "`", ") ", "] ", "} ", ", ")):
    return True

  if s.count("(") != s.count(")") and (s.endswith("(") or s.startswith("(")):
    return True

  return False


def is_clean_ui_string(text: str, icon_blacklist: set[str]) -> bool:
  s = text.strip()
  if not s or s in icon_blacklist:
    return False

  if is_css_or_tailwind(s) or SVG_OR_GEO_RE.match(s) or has_unbalanced_fragment(s):
    return False

  if any(sub in s for sub in TECH_DEBUG_SUBSTRINGS):
    return False

  without_placeholders = re.sub(r"\{\d+\}", " ", s)
  if not re.search(r"[A-Za-z]{2,}", without_placeholders):
    return False

  if re.match(r"^(?:YYYY|MM|DD|HH|mm|ss|UTC|GMT|ISO)[-:/\s\w]*$", s):
    return False

  return True
