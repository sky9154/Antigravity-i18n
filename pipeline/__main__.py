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


def main() -> int:
  parser = argparse.ArgumentParser(description="Antigravity 2.0 Desktop dictionary builder")
  parser.add_argument("--app-dir", type=Path, default=DEFAULT_APP_DIR)
  parser.add_argument("--dict-dir", type=Path, default=Path("dict"))
  parser.add_argument(
    "--prune-stale",
    action="store_true",
    help="Drop existing translations whose keys are absent from this extraction"
  )
  args = parser.parse_args()

  asar_path = resolve_clean_asar_source(args.app_dir)
  ls_path = args.app_dir / "resources" / "bin" / "language_server.exe"

  print(f"[1/3] Extracting app.asar: {asar_path}")
  asar_raw = extract_asar_strings(asar_path)

  print(f"[2/3] Extracting embedded Web UI: {ls_path}")
  webui_raw = extract_webui_strings(ls_path)

  print(f"[3/3] Cleaning and writing dictionaries to {args.dict_dir}...")
  stats = build_dictionaries(args.dict_dir, asar_raw, webui_raw, prune_stale=args.prune_stale)
  print(
    f"Done! native={stats['native']}, exact={stats['exact']}, "
    f"patterns={stats['patterns']}, icons={stats['icons']}"
  )

  return 0


if __name__ == "__main__":
  sys.exit(main())
