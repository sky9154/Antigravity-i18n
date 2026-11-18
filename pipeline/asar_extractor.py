from __future__ import annotations

from dataclasses import dataclass
import json
from pathlib import Path
import re
import struct

from .text_filters import (
  HEX_COLOR_RE, decode_js_escapes, is_candidate_ui_text, normalize_template_placeholders
)


PROP_VALUE_RE = re.compile(
  r"""(?P<key>label|title|message|detail|placeholder|tooltip|text|description|header|subtitle|confirmText|cancelText)\s*:\s*(?P<quote>['"])(?P<val>(?:\\.|[^\\])*?)(?P=quote)"""
)

BUTTONS_ARRAY_RE = re.compile(r"""buttons\s*:\s*\[([^\]]{1,240})\]""")
QUOTED_ITEM_RE = re.compile(r"""(['"])((?:\\.|[^\\])*?)\1""")
STATUS_CALL_RE = re.compile(r"""setStatus\(\s*(['"`])([^'"`]{2,120})\1\s*\)""")
HTML_TEXT_RE = re.compile(r">([A-Za-z][^<>\r\n]{1,180})<")


@dataclass
class AsarEntry:
  path: str
  offset: int
  size: int


def read_asar_entries(asar_path: Path) -> tuple[int, list[AsarEntry]]:
  with asar_path.open("rb") as f:
    f.seek(4)
    header_payload_size = struct.unpack("<I", f.read(4))[0]
    f.seek(12)
    json_len = struct.unpack("<I", f.read(4))[0]
    header = json.loads(f.read(json_len).decode("utf-8"))

  data_start = 8 + header_payload_size
  entries: list[AsarEntry] = []

  def walk(node: dict, prefix: str = "") -> None:
    if "files" in node:
      for name, child in node["files"].items():
        next_path = f"{prefix}/{name}" if prefix else name
        walk(child, next_path)
      return

    if not prefix.startswith("node_modules/") and "offset" in node:
      entries.append(AsarEntry(path=prefix, offset=int(node["offset"]), size=int(node["size"])))

  walk(header)
  return data_start, entries


def is_asar_patched(asar_path: Path) -> bool:
  data_start, entries = read_asar_entries(asar_path)
  main_entry = next((entry for entry in entries if entry.path == "dist/main.js"), None)
  if main_entry is None:
    raise ValueError(f"dist/main.js not found in {asar_path}")

  with asar_path.open("rb") as f:
    f.seek(data_start + main_entry.offset)
    head = f.read(min(main_entry.size, 512)).decode("utf-8", errors="replace")

  return "AGY_I18N_PATCHED" in head or "AGY_ZHTW_PATCHED" in head


def should_scan_html(entry_path: str, content: str) -> bool:
  if entry_path.endswith(".html"):
    return True

  lower = content.lower()
  if "<html" in lower or "<div" in lower:
    return True

  return any(tag in entry_path for tag in ("Html", "Page", "Overlay", "Splash", "Prompt"))


def extract_html_texts(content: str) -> list[str]:
  found: list[str] = []

  for match in HTML_TEXT_RE.finditer(content):
    normalized = normalize_template_placeholders(match.group(1))
    text = re.sub(r"\s+", " ", normalized).strip()

    if "{" in text and not re.search(r"\{\d+\}", text):
      continue

    if not is_candidate_ui_text(text):
      continue

    if text.startswith(("function", "return ", "const ", "let ", "var ")):
      continue

    found.append(text)

  return list(dict.fromkeys(found))


def extract_asar_extras(content: str) -> list[str]:
  extras: list[str] = []

  for btn_match in BUTTONS_ARRAY_RE.finditer(content):
    for item_match in QUOTED_ITEM_RE.finditer(btn_match.group(1)):
      text = decode_js_escapes(item_match.group(2)).strip()
      if is_candidate_ui_text(text):
        extras.append(text)

  for status_match in STATUS_CALL_RE.finditer(content):
    text = normalize_template_placeholders(status_match.group(2)).strip()
    if is_candidate_ui_text(text):
      extras.append(text)

  return list(dict.fromkeys(extras))


def extract_asar_strings(asar_path: Path) -> dict:
  data_start, entries = read_asar_entries(asar_path)
  prop_strings: dict[str, list[dict]] = {}
  html_strings: dict[str, list[str]] = {}
  extra_strings: dict[str, list[str]] = {}

  with asar_path.open("rb") as f:
    for entry in entries:
      if not entry.path.endswith((".js", ".html")):
        continue

      f.seek(data_start + entry.offset)
      content = f.read(entry.size).decode("utf-8", errors="replace")

      for match in PROP_VALUE_RE.finditer(content):
        val = decode_js_escapes(match.group("val")).strip()
        if is_candidate_ui_text(val) and not HEX_COLOR_RE.match(val):
          prop_strings.setdefault(entry.path, []).append({"key": match.group("key"), "text": val})

      extras = extract_asar_extras(content)
      if extras:
        extra_strings[entry.path] = extras

      if should_scan_html(entry.path, content):
        html_texts = extract_html_texts(content)
        if html_texts:
          html_strings[entry.path] = html_texts

  return {
    "prop_strings": prop_strings,
    "html_strings": html_strings,
    "extra_strings": extra_strings
  }
