from __future__ import annotations

import json
import os
from collections import Counter
from pathlib import Path
import re

from .constants import (
  EXTENSION_EXACT_KEYS, EXTENSION_NATIVE_KEYS, EXTENSION_PATTERN_KEYS, STANDARD_ELECTRON_MENUS
)
from .text_filters import is_clean_ui_string, read_json


def merge_existing_translations(
  existing: dict[str, str],
  keys: list[str],
  prune_stale: bool = False
) -> dict[str, str]:
  merged = {k: existing.get(k, "") if isinstance(existing.get(k), str) else "" for k in keys}

  if not prune_stale:
    for k, v in existing.items():
      if k not in merged and isinstance(v, str) and v.strip():
        merged[k] = v

  return merged


def build_native_keys(asar_raw: dict, icon_blacklist: set[str]) -> list[str]:
  seen: dict[str, None] = {label: None for label in STANDARD_ELECTRON_MENUS}

  for label in EXTENSION_NATIVE_KEYS:
    seen.setdefault(label, None)

  def add_item(text: str) -> None:
    s = text.strip()
    if is_clean_ui_string(s, icon_blacklist):
      seen.setdefault(s, None)

  for items in asar_raw.get("prop_strings", {}).values():
    for item in items:
      add_item(item["text"])

  for group_name in ("html_strings", "extra_strings"):
    for texts in asar_raw.get(group_name, {}).values():
      for text in texts:
        add_item(text)

  return list(seen.keys())


def build_exact_keys(webui_raw: dict, icon_blacklist: set[str]) -> list[str]:
  counts: Counter = Counter()

  for prop_name, items in webui_raw.get("prop_hits", {}).items():
    for text, count in items.items():
      s = text.strip()
      if prop_name in ("emptyMessagePlural", "noun", "suffix"):
        if re.match(r"^[A-Za-z%][A-Za-z\s]{1,40}$", s) and s not in icon_blacklist:
          counts[s] += count
        continue
      if is_clean_ui_string(s, icon_blacklist):
        counts[s] += count

  for text, count in webui_raw.get("jsx_children", {}).items():
    s = text.strip()
    if is_clean_ui_string(s, icon_blacklist):
      counts[s] += count

  for key in EXTENSION_EXACT_KEYS:
    counts.setdefault(key, 1)

  return [k for k, _ in sorted(counts.items(), key=lambda kv: (-kv[1], kv[0]))]


def build_pattern_keys(webui_raw: dict, icon_blacklist: set[str]) -> list[str]:
  keys: list[str] = []

  for text in webui_raw.get("template_hits", {}):
    s = text.strip()
    if is_clean_ui_string(s, icon_blacklist):
      keys.append(s)

  for key in EXTENSION_PATTERN_KEYS:
    if key not in keys:
      keys.append(key)

  return keys


def commit_json_batch(dict_dir: Path, outputs: dict[str, object]) -> None:
  dict_dir.mkdir(parents=True, exist_ok=True)
  pid = os.getpid()
  staged_paths: dict[str, Path] = {}
  backup_paths: dict[str, Path] = {}
  replaced_targets: list[str] = []

  try:
    for filename, payload in outputs.items():
      serialized = json.dumps(payload, ensure_ascii=False, indent=2) + "\n"
      stage_path = dict_dir / f".{filename}.tmp.{pid}"
      stage_path.write_text(serialized, encoding="utf-8")
      staged_paths[filename] = stage_path

    for filename, stage_path in staged_paths.items():
      target_path = dict_dir / filename
      if target_path.exists():
        bak_path = dict_dir / f".{filename}.bak.{pid}"
        target_path.replace(bak_path)
        backup_paths[filename] = bak_path
      stage_path.replace(target_path)
      replaced_targets.append(filename)

    for bak_path in backup_paths.values():
      bak_path.unlink(missing_ok=True)
  except OSError:
    for filename in reversed(replaced_targets):
      target_path = dict_dir / filename
      bak_path = backup_paths.get(filename)
      if bak_path and bak_path.exists():
        bak_path.replace(target_path)
      else:
        target_path.unlink(missing_ok=True)
    for stage_path in staged_paths.values():
      stage_path.unlink(missing_ok=True)
    raise


def build_dictionaries(
  dict_dir: Path,
  asar_raw: dict,
  webui_raw: dict,
  prune_stale: bool = False
) -> dict[str, int]:
  existing_native = read_json(dict_dir / "native.json") if (dict_dir / "native.json").exists() else {}
  existing_exact = (
    read_json(dict_dir / "webui-exact.json") if (dict_dir / "webui-exact.json").exists() else {}
  )
  existing_patterns = (
    read_json(dict_dir / "webui-patterns.json")
    if (dict_dir / "webui-patterns.json").exists()
    else {}
  )

  icons_map = webui_raw.get("icon_names", {})
  icon_blacklist = set(icons_map.keys())

  native_keys = build_native_keys(asar_raw, icon_blacklist)
  exact_keys = build_exact_keys(webui_raw, icon_blacklist)
  pattern_keys = build_pattern_keys(webui_raw, icon_blacklist)
  icon_keys = sorted(icons_map.keys())

  outputs: dict[str, object] = {
    "native.json": merge_existing_translations(existing_native, native_keys, prune_stale),
    "webui-exact.json": merge_existing_translations(existing_exact, exact_keys, prune_stale),
    "webui-patterns.json": merge_existing_translations(
      existing_patterns, pattern_keys, prune_stale
    ),
    "icons-ignore.json": icon_keys
  }
  commit_json_batch(dict_dir, outputs)

  return {
    "native": len(native_keys),
    "exact": len(exact_keys),
    "patterns": len(pattern_keys),
    "icons": len(icon_keys)
  }
