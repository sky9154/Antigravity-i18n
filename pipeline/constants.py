import os
from pathlib import Path
import re


DEFAULT_APP_DIR = (
  Path(os.environ.get("LOCALAPPDATA") or (Path.home() / "AppData" / "Local")) / "Programs" /
  "antigravity"
)

UI_PROP_KEYS = {
  "label", "title", "description", "placeholder", "searchPlaceholder", "message", "detail",
  "tooltip", "aria-label", "ariaLabel", "text", "header", "subtitle", "confirmText",
  "cancelText", "confirmLabel", "cancelLabel", "emptyText", "helperText", "buttonText", "caption",
  "heading", "subtext", "hint", "badge", "okText", "errorMessage", "successMessage",
  "emptyMessagePlural", "layout"
}

ICON_PROP_KEYS = {"icon", "iconName"}

NON_UI_PREFIXES = (
  "http://", "https://", "ws://", "wss://", "data:", "file://", "chrome://", "devtools://",
  "antigravity://", "mailto:"
)

TECH_NOISE_PATTERNS = [
  re.compile(r"^[a-z0-9_.\-/:#@]+$"),
  re.compile(r"^[A-Z0-9_.\-/]+$"),
  re.compile(r"^[\s\d\W]+$"),
  re.compile(
    r"^(?:flex|grid|bg-|text-|border-|px-|py-|mx-|my-|w-|h-|min-|max-|items-|justify-|gap-|rounded-)"
  ),
  re.compile(r"\.(?:ts|tsx|js|jsx|mjs|cjs|css|scss|html|json|proto|png|svg|mp3|woff2?)$", re.I)
]

TAILWIND_PREFIXES = (
  "bg-", "text-", "border-", "px-", "py-", "pt-", "pb-", "pl-", "pr-", "mx-", "my-", "mt-", "mb-",
  "ml-", "mr-", "p-", "m-", "w-", "h-", "min-w-", "max-w-", "min-h-", "max-h-", "flex-", "grid-",
  "items-", "justify-", "gap-", "space-x-", "space-y-", "rounded-", "shadow-", "opacity-",
  "shrink-", "grow-", "cursor-", "overflow-", "transition-", "duration-", "ease-", "z-", "top-",
  "bottom-", "left-", "right-", "inset-", "font-", "leading-", "tracking-", "select-",
  "pointer-events-", "hover:", "focus:", "focus-within:", "focus-visible:", "group-hover:",
  "group-focus:", "can-hover:", "dark:", "sm:", "md:", "lg:", "xl:", "data-[", "group-has-[",
  "has-["
)

TAILWIND_EXACT_TOKENS = {
  "flex", "inline-flex", "grid", "block", "inline-block", "hidden", "relative", "absolute", "fixed",
  "sticky", "truncate", "rounded", "border", "shadow", "uppercase", "lowercase", "capitalize",
  "underline", "italic", "antialiased", "sr-only", "contents", "surface-glass", "action-button",
  "agy-selection-pill"
}

TECH_DEBUG_SUBSTRINGS = (
  "cannot decode ", "cannot encode ", "cannot parse ", "FieldDescriptorProto", "Unknown chunk case",
  "socket not open", "readyState", "ReflectList", "ReflectMap", "ReflectMessage", "LinkedMap",
  "disposable on itself", "use client", "noopener", "noreferrer", "RFC 3339", "CRON_TZ=",
  "dirname(", "NAVIGATION_BLOCKED:", "PAGE_NOT_FOUND:", "Expected a function",
  "Expected function, string", "Expected usable value", "Invalid list", "Invalid PDF viewer",
  "must be of type", "The value of type", '== "', "grpc", "protobuf"
)

STANDARD_ELECTRON_MENUS = [
  "File", "Edit", "View", "Window", "Help", "Undo", "Redo", "Cut", "Copy", "Paste", "Select All",
  "Delete", "Reload", "Force Reload", "Toggle Developer Tools", "Actual Size", "Zoom In",
  "Zoom Out", "Toggle Full Screen", "Minimize", "Zoom", "Close", "Quit", "Services", "Hide",
  "Hide Others", "Show All"
]

EXTENSION_NATIVE_KEYS = (
  "Display Language",
)

EXTENSION_EXACT_KEYS = (
  "Language",
  "Display Language",
  "Choose the display language for the interface."
)

EXTENSION_PATTERN_KEYS = (
  "Scanned {0} unmapped strings; saved {1} new entries to missing-ui.json",
)
