from __future__ import annotations

import argparse
import json
from pathlib import Path
import sys

from .asar_extractor import extract_asar_strings, is_asar_patched
from .constants import DEFAULT_APP_DIR
from .dict_builder import build_dictionaries
from .webui_extractor import extract_webui_strings


def resolve_clean_asar_source(app_dir: Path) -> Path:
  resources_dir = app_dir / "resources"
  asar_path = resources_dir / "app.asar"
  backup_path = resources_dir / "app.asar.bak"
  meta_path = resources_dir / "app.asar.bak.meta.json"
  ver_file = app_dir / "version"
  app_version = ver_file.read_text(encoding="utf-8").strip() if ver_file.exists() else None

  if not asar_path.exists():
    raise FileNotFoundError(f"app.asar not found: {asar_path}")

  if not is_asar_patched(asar_path):
    if backup_path.exists() and meta_path.exists() and app_version:
      try:
        meta = json.loads(meta_path.read_text(encoding="utf-8"))
        if meta.get("version") != app_version:
          print(
            f"[warn] Ignoring stale backup v{meta.get('version')}; using clean app.asar (v{app_version})."
          )
      except (OSError, json.JSONDecodeError):
        pass
    return asar_path

  if not backup_path.exists():
    raise RuntimeError(
      "app.asar is already patched and app.asar.bak is missing; cannot extract clean source."
    )

  if is_asar_patched(backup_path):
    raise RuntimeError(f"Backup {backup_path} is also patched; cannot extract clean source.")

  if meta_path.exists() and app_version:
    meta = json.loads(meta_path.read_text(encoding="utf-8"))
    bak_version = meta.get("version")
    if bak_version and bak_version != app_version:
      raise RuntimeError(
        f"Stale backup detected (backup v{bak_version} vs installed v{app_version}). "
        "Reinstall or restore a matching app.asar before running pipeline."
      )

  return backup_path


def read_locales_manifest(base_dir: Path) -> dict[str, str]:
  locales_path = base_dir / "locales.json"
  if not locales_path.exists():
    return {}

  try:
    raw = json.loads(locales_path.read_text(encoding="utf-8"))
  except (OSError, json.JSONDecodeError):
    return {}

  if not isinstance(raw, dict):
    return {}

  return {
    str(k).strip(): str(v).strip()
    for k, v in raw.items()
    if isinstance(k, str) and isinstance(v, str) and k.strip()
  }


def resolve_default_locale(base_dir: Path) -> str:
  for locale_id in read_locales_manifest(base_dir):
    if locale_id != "en":
      return locale_id

  if base_dir.exists():
    for entry in sorted(base_dir.iterdir()):
      if entry.is_dir() and (entry / "webui-exact.json").exists():
        return entry.name

  return "zh-TW"


def discover_locales(base_dir: Path) -> list[str]:
  found: list[str] = []
  seen: set[str] = {"en"}

  for locale_id in read_locales_manifest(base_dir):
    if locale_id not in seen:
      found.append(locale_id)
      seen.add(locale_id)

  if base_dir.exists():
    for entry in sorted(base_dir.iterdir()):
      if entry.is_dir() and entry.name not in seen and (entry / "webui-exact.json").exists():
        found.append(entry.name)
        seen.add(entry.name)

  return found or ["zh-TW"]


def register_locale_label(base_dir: Path, locale_id: str, label: str) -> None:
  base_dir.mkdir(parents=True, exist_ok=True)
  manifest = read_locales_manifest(base_dir)
  manifest[locale_id] = label.strip()
  locales_path = base_dir / "locales.json"
  locales_path.write_text(
    json.dumps(manifest, ensure_ascii=False, indent=2) + "\n",
    encoding="utf-8"
  )


def resolve_target_dirs(args: argparse.Namespace) -> list[Path]:
  if args.dict_dir is not None:
    return [args.dict_dir]

  base_dir: Path = args.base_dict_dir
  if args.all_locales:
    return [base_dir / loc for loc in discover_locales(base_dir)]

  locale_id = args.locale.strip() if args.locale else resolve_default_locale(base_dir)
  if locale_id == "en":
    raise ValueError("Cannot build dictionary for built-in source locale 'en'.")

  if args.label and args.label.strip():
    register_locale_label(base_dir, locale_id, args.label)

  return [base_dir / locale_id]


def main() -> int:
  parser = argparse.ArgumentParser(description="Antigravity 2.0 Desktop dictionary builder")
  parser.add_argument("--app-dir", type=Path, default=DEFAULT_APP_DIR)
  parser.add_argument("--base-dict-dir", type=Path, default=Path("dict"))
  parser.add_argument("--locale", type=str, default=None)
  parser.add_argument("--label", type=str, default=None)
  parser.add_argument("--all-locales", action="store_true")
  parser.add_argument("--dict-dir", type=Path, default=None)
  parser.add_argument(
    "--prune-stale",
    action="store_true",
    help="Drop existing translations whose keys are absent from this extraction"
  )
  args = parser.parse_args()

  target_dirs = resolve_target_dirs(args)
  asar_path = resolve_clean_asar_source(args.app_dir)
  ls_path = args.app_dir / "resources" / "bin" / "language_server.exe"

  print(f"[1/3] Extracting app.asar: {asar_path}")
  asar_raw = extract_asar_strings(asar_path)

  print(f"[2/3] Extracting embedded Web UI: {ls_path}")
  webui_raw = extract_webui_strings(ls_path)

  for target_dir in target_dirs:
    print(f"[3/3] Cleaning and writing dictionaries to {target_dir}...")
    stats = build_dictionaries(target_dir, asar_raw, webui_raw, prune_stale=args.prune_stale)
    print(
      f"Done ({target_dir})! native={stats['native']}, exact={stats['exact']}, "
      f"patterns={stats['patterns']}, icons={stats['icons']}"
    )

  return 0


if __name__ == "__main__":
  sys.exit(main())
