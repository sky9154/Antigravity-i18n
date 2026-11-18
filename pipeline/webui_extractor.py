from __future__ import annotations

from collections import Counter
import io
import json
from pathlib import Path
import re
import struct
import zipfile

from .constants import ICON_PROP_KEYS, UI_PROP_KEYS
from .text_filters import (
  decode_js_escapes, is_candidate_ui_text, is_english_sentence_or_label,
  normalize_template_placeholders
)


BASE_CONFIG_UI_KEYS = (
  "agy-onboarding-personas",
  "project-4k-mode-copy",
  "third-party-tools-disclaimer-text"
)


def find_webui_zip_from_bytes(data: bytes) -> zipfile.ZipFile:
  pos = 0

  while True:
    eocd = data.find(b"PK\x05\x06", pos)
    if eocd == -1:
      break

    pos = eocd + 4
    if eocd + 22 > len(data):
      continue

    cd_size, cd_offset = struct.unpack_from("<II", data, eocd + 12)
    comment_len = struct.unpack_from("<H", data, eocd + 20)[0]
    end_pos = eocd + 22 + comment_len
    archive_start = eocd - cd_size - cd_offset

    if archive_start < 0 or end_pos > len(data):
      continue

    try:
      zf = zipfile.ZipFile(io.BytesIO(data[archive_start:end_pos]))
      names = zf.namelist()
      if "index.html" in names and "main.js" in names:
        return zf
    except zipfile.BadZipFile:
      continue

  raise RuntimeError(
    "Embedded ZIP containing index.html and main.js was not found in language_server.exe."
  )


def find_webui_zip(ls_path: Path) -> zipfile.ZipFile:
  return find_webui_zip_from_bytes(ls_path.read_bytes())


def extract_props_and_icons(main_js: str) -> tuple[dict[str, Counter], Counter]:
  prop_hits: dict[str, Counter] = {}
  icon_names = Counter()

  key_group = "|".join(re.escape(k) for k in sorted(UI_PROP_KEYS | ICON_PROP_KEYS))
  prop_pattern = re.compile(
    rf"""(?:^|[,{{\s])(?:"(?P<qkey>{key_group})"|\[['"](?P<bkey>{key_group})['"]\]|(?P<ikey>{key_group}))\s*:\s*(?P<quote>["'])(?P<val>(?:\\.|[^\\])*?)(?P=quote)"""
  )

  for match in prop_pattern.finditer(main_js):
    key = match.group("qkey") or match.group("bkey") or match.group("ikey")
    val = decode_js_escapes(match.group("val")).strip()

    if key in ICON_PROP_KEYS:
      if re.match(r"^[a-z0-9_]+$", val):
        icon_names[val] += 1
      continue

    if key == "emptyMessagePlural":
      if re.match(r"^[A-Za-z][a-z\s]{1,40}$", val):
        prop_hits.setdefault(key, Counter())[val] += 1
      continue

    if is_candidate_ui_text(val):
      prop_hits.setdefault(key, Counter())[val] += 1

  default_param_re = re.compile(
    rf"""\b(?P<dkey>{key_group})\s*:\s*[A-Za-z_$][\w$]*\s*=\s*"(?P<dval>(?:\\.|[^"\\\r\n]){{2,200}})["]"""
  )

  for match in default_param_re.finditer(main_js):
    key = match.group("dkey")
    if key in ICON_PROP_KEYS:
      continue
    val = decode_js_escapes(match.group("dval")).strip()
    if is_candidate_ui_text(val):
      prop_hits.setdefault(key, Counter())[val] += 1

  ternary_prop_re = re.compile(
    r"""\b(?P<tkey>label|title|description|placeholder|message|tooltip|subtitle|text)\s*:\s*[^,;{}\r\n"']{1,60}\?\s*"(?P<v1>(?:\\.|[^"\\\r\n]){2,350})"\s*:\s*(?:"(?P<v2>(?:\\.|[^"\\\r\n]){2,350})"\s*[,}])?"""
  )

  for match in ternary_prop_re.finditer(main_js):
    key = match.group("tkey")
    for branch in ("v1", "v2"):
      raw_branch = match.group(branch)
      if not raw_branch:
        continue
      val = decode_js_escapes(raw_branch).strip()
      if is_candidate_ui_text(val):
        prop_hits.setdefault(key, Counter())[val] += 1

  noun_counter = prop_hits.setdefault("noun", Counter())
  for m in re.finditer(r'\b(?:lowercase|lowercasePlural)\s*:\s*"(?P<val>[a-z]{2,24})"', main_js):
    noun_counter[m.group("val")] += 1

  for m in re.finditer(r'===\s*1\s*\?\s*"(?P<s1>[a-z]{2,20})"\s*:\s*"(?P<s2>[a-z]{2,20})"', main_js):
    noun_counter[m.group("s1")] += 1
    noun_counter[m.group("s2")] += 1

  for m in re.finditer(r'Fragment\s*,\s*null\s*,\s*"\s+(?P<word>[a-z]{3,20})\s+"', main_js):
    noun_counter[m.group("word")] += 1

  for m in re.finditer(r'\.lowercase\s*,\s*"(?P<val>\s+[a-z][a-z\s]{4,40})"', main_js):
    noun_counter[m.group("val").strip()] += 1

  suffix_counter = prop_hits.setdefault("suffix", Counter())
  for m in re.finditer(r',\s*"(?P<val>%\s+[a-z]{2,16})"', main_js):
    suffix_counter[m.group("val")] += 1

  label_counter = prop_hits.setdefault("label", Counter())
  for m in re.finditer(r'\b(?:daily|weekly)\s*:\s*"(?P<val>[A-Z][A-Za-z\s]{2,40})"', main_js):
    label_counter[m.group("val")] += 1

  icon_comp_re = re.compile(
    r"""createElement\([^,]+,\s*\{[^{}]{0,120}\bname\s*:\s*(?P<quote>["'])(?P<val>[a-z0-9_]+)(?P=quote)"""
  )

  for match in icon_comp_re.finditer(main_js):
    icon_names[match.group("val")] += 1

  return prop_hits, icon_names


def extract_jsx_children(main_js: str, icon_names: Counter) -> Counter:
  jsx_children = Counter()
  ce_child_re = re.compile(
    r"""createElement\([^;]{1,600}?,\s*(?P<quote>["'])(?P<val>(?:\\.|[^\\"']){2,350})(?P=quote)\s*[,)]"""
  )
  null_child_re = re.compile(
    r"""(?:[,(]\s*(?:null|\{[^{};]{0,300}\})\s*,\s*)"(?P<val>(?:\\.|[^"\\\r\n]){2,350})"(?=\s*[,)])"""
  )
  callback_child_re = re.compile(
    r"""\}\},\s*"(?P<val>[A-Z][A-Za-z0-9\s.,!?…\\u0-9()-]{2,80})"(?=\s*[,)])"""
  )
  or_fallback_re = re.compile(
    r"""\|\|\s*"(?P<val>[A-Z][^"\\\r\n]{2,120})["]"""
  )
  placeholder_pair_re = re.compile(
    r"""\|\|\s*"(?P<p1>[A-Z][^"\\\r\n]{2,100})"\s*\+\s*\([^?:]{1,30}\?\s*"(?P<p2>[^"\\\r\n]{2,60})"\s*:\s*""\)"""
  )
  pascal_map_re = re.compile(
    r"""[{,]\s*[A-Z][A-Za-z0-9]{1,30}\s*:\s*"(?P<val>[A-Z][A-Za-z0-9\s]{2,40})["]"""
  )
  sibling_tail_re = re.compile(
    r"""," ",\s*"(?P<val>[A-Za-z][^"\\\r\n]{4,180}\.)"(?=\s*[,)])"""
  )
  ternary_expr_re = re.compile(
    r"""\?\s*"(?P<v1>(?:\\.|[^"\\\r\n]){2,220})"\s*:\s*(?:"(?P<v2>(?:\\.|[^"\\\r\n]){2,220})["]|`)"""
  )
  kebab_map_re = re.compile(
    r"""[{,]\s*"[a-z]+(?:-[a-z0-9]+){1,4}"\s*:\s*"(?P<val>(?:\\.|[^"\\\r\n]){3,180})["]"""
  )
  switch_return_re = re.compile(
    r"""\breturn\s*"(?P<val>[A-Z][A-Za-z0-9\s.,!?…'()-]{2,80})"\s*[;}]"""
  )
  string_pair_re = re.compile(
    r"""\[\s*"(?P<a1>[A-Z][A-Za-z0-9\s.,!?…'()-]{2,80})"\s*,\s*"(?P<a2>[A-Z][A-Za-z0-9\s.,!?…'()-]{2,80})"\s*\]"""
  )

  def add_val(raw_val: str) -> None:
    val = decode_js_escapes(raw_val).strip()
    if is_english_sentence_or_label(val) and val not in icon_names:
      jsx_children[val] += 1

  for match in ce_child_re.finditer(main_js):
    add_val(match.group("val"))

  for match in null_child_re.finditer(main_js):
    add_val(match.group("val"))

  for match in ternary_expr_re.finditer(main_js):
    add_val(match.group("v1"))
    if match.group("v2"):
      add_val(match.group("v2"))

  for match in kebab_map_re.finditer(main_js):
    add_val(match.group("val"))

  for match in switch_return_re.finditer(main_js):
    add_val(match.group("val"))

  for match in string_pair_re.finditer(main_js):
    add_val(match.group("a1"))
    add_val(match.group("a2"))

  for match in callback_child_re.finditer(main_js):
    add_val(match.group("val"))

  for match in or_fallback_re.finditer(main_js):
    add_val(match.group("val"))

  for match in placeholder_pair_re.finditer(main_js):
    combined = f"{decode_js_escapes(match.group('p1'))}{decode_js_escapes(match.group('p2'))}".strip()
    if is_english_sentence_or_label(combined) and combined not in icon_names:
      jsx_children[combined] += 1

  for match in pascal_map_re.finditer(main_js):
    add_val(match.group("val"))

  for match in sibling_tail_re.finditer(main_js):
    add_val(match.group("val"))

  if re.search(r'`Delete \$\{[^}]+\}`', main_js):
    for m in re.finditer(r'\bcapitalized\s*:\s*"(?P<cap>[A-Z][a-z]{2,24})"', main_js):
      add_val(f"Delete {m.group('cap')}")

  for m in re.finditer(r'[{,]\s*14\s*:\s*"(?P<val>Unavailable)"', main_js):
    add_val(m.group("val"))

  return jsx_children


def extract_templates(main_js: str) -> Counter:
  template_hits = Counter()
  tpl_re = re.compile(r"""`([^`\\]{0,200}\$\{[^`]{1,120}[^`\\]{0,120})`""")
  ternary_tpl_re = re.compile(
    r"""`\$\{[^}`]*\?\s*"(?P<p1>[A-Za-z]{2,20})"\s*:\s*"(?P<p2>[A-Za-z]{2,20})"\}\s+\$\{[^}`]+\}`"""
  )
  jsx_concat_re = re.compile(
    r"""[,(]\s*"(?P<prefix>[A-Za-z][A-Za-z0-9\s,'-]{0,40}\s)"\s*,\s*[A-Za-z_$][\w$.?()]{1,40}\s*,\s*"(?P<suffix>\s[A-Za-z][^"\\\r\n]{0,40})"\s*[,)]"""
  )
  plus_concat_re = re.compile(
    r"""[,:{(]\s*"(?P<prefix>[A-Z][A-Za-z0-9\s,'-]{2,60}\s)"\s*\+\s*[A-Za-z_$][\w$.?()]{1,40}(?=\s*[,)}])"""
  )
  skip_tokens = ("http://", "https://", "px", "rgb(", "var(--", "\n  ", "import ", "export ")

  for match in tpl_re.finditer(main_js):
    raw_tpl = match.group(0)[1:-1]
    if "${" not in raw_tpl or any(tok in raw_tpl for tok in skip_tokens):
      continue

    normalized = normalize_template_placeholders(raw_tpl).strip()
    probe = normalized.replace("{0}", "item").replace("{1}", "item")
    if is_english_sentence_or_label(probe):
      template_hits[normalized] += 1

  for match in ternary_tpl_re.finditer(main_js):
    for p in (match.group("p1"), match.group("p2")):
      candidate = f"{p} {{0}}"
      if is_english_sentence_or_label(candidate.replace("{0}", "item")):
        template_hits[candidate] += 1

  for _match in re.finditer(r',\s*"%\s+left"', main_js):
    template_hits["{0}% left"] += 1

  for match in jsx_concat_re.finditer(main_js):
    combined = f"{match.group('prefix')}{{0}}{match.group('suffix')}".strip()
    probe = combined.replace("{0}", "item")
    if is_english_sentence_or_label(probe):
      template_hits[combined] += 1

  for match in plus_concat_re.finditer(main_js):
    combined = f"{match.group('prefix')}{{0}}".strip()
    probe = combined.replace("{0}", "item")
    if is_english_sentence_or_label(probe):
      template_hits[combined] += 1

  rel_time_re = re.compile(
    r'hour:"(?P<hour>[a-z]+)",day:"(?P<day>[a-z]+)",week:"(?P<week>[a-z]+)",month:"(?P<month>[a-z]+)",year:"(?P<year>[a-z]+)",minute:"(?P<minute>[a-z]+)".{0,240}`\$\{[^}`]+\}\s+ago`'
  )
  rel_match = rel_time_re.search(main_js)
  if rel_match:
    for abbr in rel_match.groupdict().values():
      template_hits[f"{{0}}{abbr} ago"] += 1

  if re.search(r"`Resets in \$\{", main_js):
    template_hits["Resets in {0}"] += 1

  return template_hits


def extract_embedded_base_config(ls_bytes: bytes, prop_hits: dict[str, Counter]) -> None:
  anchor = ls_bytes.find(b'"agy-featured-plugins"')
  if anchor < 0:
    return

  start = ls_bytes.rfind(b"\n{\n", max(0, anchor - 2000), anchor)
  if start < 0:
    start = ls_bytes.rfind(b"{", max(0, anchor - 500), anchor)
  if start < 0:
    return

  raw_slice = ls_bytes[start:min(len(ls_bytes), start + 120000)].decode("utf-8", errors="replace")
  try:
    cfg, _ = json.JSONDecoder().raw_decode(raw_slice.lstrip())
  except json.JSONDecodeError:
    return

  base = cfg.get("base")
  if not isinstance(base, dict):
    return

  target_counter = prop_hits.setdefault("config", Counter())

  def record(text: str) -> None:
    s = text.strip()
    if is_candidate_ui_text(s):
      target_counter[s] += 1

  def walk_node(node: object, include_fields: tuple[str, ...]) -> None:
    if isinstance(node, dict):
      for k, v in node.items():
        if isinstance(v, str) and k in include_fields:
          if "{privacyPolicyLink}" in v:
            prefix = v.split("{privacyPolicyLink}", 1)[0].strip()
            record(prefix)
          elif "{" not in v:
            record(v)
        else:
          walk_node(v, include_fields)
    elif isinstance(node, list):
      for item in node:
        walk_node(item, include_fields)

  for key in BASE_CONFIG_UI_KEYS:
    raw_val = base.get(key)
    if not isinstance(raw_val, str):
      continue
    try:
      parsed = json.loads(raw_val)
    except json.JSONDecodeError:
      continue

    if key == "agy-onboarding-personas":
      walk_node(parsed, ("displayName", "description", "label"))
    elif key == "project-4k-mode-copy":
      walk_node(parsed, ("title", "description"))
    elif key == "third-party-tools-disclaimer-text":
      walk_node(parsed, ("default", "marketplace"))


def extract_webui_strings(ls_path: Path) -> dict:
  ls_bytes = ls_path.read_bytes()
  zf = find_webui_zip_from_bytes(ls_bytes)
  main_js = zf.read("main.js").decode("utf-8", errors="replace")

  prop_hits, icon_names = extract_props_and_icons(main_js)
  extract_embedded_base_config(ls_bytes, prop_hits)
  jsx_children = extract_jsx_children(main_js, icon_names)
  template_hits = extract_templates(main_js)

  return {
    "prop_hits": {
      k: dict(v.most_common())
      for k, v in sorted(prop_hits.items())
    },
    "jsx_children": dict(jsx_children.most_common()),
    "template_hits": dict(template_hits.most_common()),
    "icon_names": dict(icon_names.most_common())
  }
