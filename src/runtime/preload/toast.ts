let activeToastEl: HTMLDivElement | null = null;
let activeToastTimer: ReturnType<typeof setTimeout> | null = null;


export function showToast(message: string): void {
  if (!document.body) {
    return;
  }

  if (activeToastTimer !== null) {
    clearTimeout(activeToastTimer);
    activeToastTimer = null;
  }

  if (activeToastEl) {
    activeToastEl.remove();
    activeToastEl = null;
  }

  const toast = document.createElement("div");
  toast.setAttribute("data-i18n-skip", "1");
  toast.textContent = message;
  toast.style.cssText = [
    "position: fixed",
    "bottom: 20px",
    "right: 20px",
    "z-index: 2147483647",
    "padding: 8px 14px",
    "border-radius: 8px",
    "background: rgba(24, 24, 27, 0.92)",
    "color: #fafafa",
    "font-size: 13px",
    "font-family: system-ui, sans-serif",
    "box-shadow: 0 4px 16px rgba(0, 0, 0, 0.25)",
    "pointer-events: none"
  ].join("; ");

  document.body.appendChild(toast);
  activeToastEl = toast;
  activeToastTimer = setTimeout(() => {
    toast.remove();
    if (activeToastEl === toast) {
      activeToastEl = null;
    }
    activeToastTimer = null;
  }, 2600);
}
