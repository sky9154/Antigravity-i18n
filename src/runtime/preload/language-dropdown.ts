import type { LocaleOption, UiLocale } from "../../shared/types";


const LANG_SECTION_ID = "agy-i18n-language-section";
const LANG_MENU_ID = "agy-i18n-language-menu";

export interface LocaleViewState {
  activeLocale: UiLocale;
  availableLocales: LocaleOption[];
}


function createSvgIcon(pathD: string, size: number, className: string): SVGSVGElement {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("width", String(size));
  svg.setAttribute("height", String(size));
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "2");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("class", className);

  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("d", pathD);
  svg.appendChild(path);
  return svg;
}


function getLocaleDisplayLabel(state: LocaleViewState): string {
  return state.availableLocales.find((item) => item.id === state.activeLocale)?.label ?? state.activeLocale;
}


function getSectionCopy(
  translateText: (text: string) => string
): { heading: string; label: string; description: string } {
  return {
    heading: translateText("Language"),
    label: translateText("Display Language"),
    description: translateText("Choose the display language for the interface.")
  };
}


export function createLanguageDropdown(
  getLocaleState: () => LocaleViewState,
  onSelectLocale: (nextLocale: UiLocale) => void,
  translateText: (text: string) => string = (text) => text
) {
  let menuOpen = false;
  let hideTimer: number | null = null;
  let lastRenderedMenuKey = "";
  let globalListenersInstalled = false;

  function closeMenu(immediate = false): void {
    menuOpen = false;
    if (hideTimer !== null) {
      window.clearTimeout(hideTimer);
      hideTimer = null;
    }

    const menu = document.getElementById(LANG_MENU_ID);
    if (menu) {
      menu.removeAttribute("data-open");
      menu.removeAttribute("data-starting-style");
      if (immediate || menu.style.display === "none") {
        menu.removeAttribute("data-ending-style");
        menu.style.display = "none";
      } else {
        menu.setAttribute("data-ending-style", "");
        hideTimer = window.setTimeout(() => {
          hideTimer = null;
          if (!menuOpen) {
            menu.style.display = "none";
            menu.removeAttribute("data-ending-style");
          }
        }, 160);
      }
    }

    const trigger = document.querySelector(
      `#${LANG_SECTION_ID} [data-i18n-role="trigger"]`
    ) as HTMLButtonElement | null;
    if (trigger) {
      trigger.setAttribute("aria-expanded", "false");
    }
  }

  function renderMenuItems(menu: HTMLElement): void {
    const { activeLocale, availableLocales } = getLocaleState();
    const nextKey = `${activeLocale}|${availableLocales.map((o) => `${o.id}:${o.label}`).join(",")}`;
    if (menu.childElementCount > 0 && nextKey === lastRenderedMenuKey) {
      return;
    }
    lastRenderedMenuKey = nextKey;

    menu.textContent = "";
    const list = document.createElement("div");
    list.className = "p-1 flex flex-col gap-px w-full";

    for (const option of availableLocales) {
      const isSelected = option.id === activeLocale;
      const itemBtn = document.createElement("button");
      itemBtn.type = "button";
      itemBtn.setAttribute("role", "option");
      itemBtn.setAttribute("aria-selected", isSelected ? "true" : "false");
      if (isSelected) {
        itemBtn.setAttribute("data-selected", "");
      }
      itemBtn.className = [
        "agy-overlay-item w-full text-left whitespace-nowrap transition-colors duration-150 select-none rounded-md",
        "flex items-center justify-between gap-3 px-2 py-1 text-compact outline-none no-focus-ring border-none bg-transparent cursor-pointer",
        "hover:bg-secondary hover:text-foreground focus:bg-secondary focus:text-foreground",
        isSelected ? "text-foreground" : "text-secondary-foreground"
      ].join(" ");
      itemBtn.style.pointerEvents = "auto";

      const textSpan = document.createElement("span");
      textSpan.className = "truncate";
      textSpan.textContent = option.label;
      itemBtn.appendChild(textSpan);

      if (isSelected) {
        const checkIcon = createSvgIcon("M5 12l5 5L20 7", 14, "shrink-0");
        itemBtn.appendChild(checkIcon);
      }

      itemBtn.addEventListener("pointerdown", (event) => {
        event.stopPropagation();
      });

      itemBtn.addEventListener("mousedown", (event) => {
        event.stopPropagation();
      });

      itemBtn.addEventListener("click", (event) => {
        event.stopPropagation();
        const current = getLocaleState().activeLocale;
        closeMenu();
        if (current !== option.id) {
          onSelectLocale(option.id);
        }
      });

      list.appendChild(itemBtn);
    }

    menu.appendChild(list);
  }

  function openMenu(trigger: HTMLButtonElement): void {
    if (hideTimer !== null) {
      window.clearTimeout(hideTimer);
      hideTimer = null;
    }

    const hostCol = trigger.parentElement;
    if (!hostCol) {
      return;
    }

    let menu = document.getElementById(LANG_MENU_ID);
    if (!menu) {
      menu = document.createElement("div");
      menu.id = LANG_MENU_ID;
      menu.setAttribute("data-i18n-skip", "1");
      menu.setAttribute("data-select-popup", "");
      menu.setAttribute("role", "listbox");
      menu.className =
        "agy-overlay surface-glass border border-border rounded-lg bg-card text-foreground no-focus-ring flex flex-col shadow-md animate-slideIn overflow-hidden max-w-[400px] w-max";
      menu.style.position = "absolute";
      menu.style.top = "calc(100% + 4px)";
      menu.style.right = "0";
      menu.style.minWidth = "140px";
      menu.style.zIndex = "6000";
      menu.style.pointerEvents = "auto";
      menu.style.transformOrigin = "top center";
      menu.addEventListener("pointerdown", (event) => {
        event.stopPropagation();
      });
      menu.addEventListener("mousedown", (event) => {
        event.stopPropagation();
      });
    }

    if (menu.parentElement !== hostCol) {
      hostCol.appendChild(menu);
    }

    renderMenuItems(menu);
    menu.removeAttribute("data-ending-style");
    menu.setAttribute("data-side", "bottom");
    menu.setAttribute("data-starting-style", "");
    menu.setAttribute("data-open", "");
    menu.style.display = "flex";
    void menu.offsetHeight;

    menuOpen = true;
    trigger.setAttribute("aria-expanded", "true");
    requestAnimationFrame(() => {
      if (menuOpen && menu) {
        menu.removeAttribute("data-starting-style");
      }
    });
  }

  const handleWindowPointerDown = (event: Event) => {
    if (!menuOpen) {
      return;
    }
    const target = event.target as Node | null;
    const menu = document.getElementById(LANG_MENU_ID);
    const trigger = document.querySelector(`#${LANG_SECTION_ID} [data-i18n-role="trigger"]`);
    if (target && (menu?.contains(target) || trigger?.contains(target))) {
      return;
    }
    closeMenu();
  };

  const handleWindowKeyDown = (event: KeyboardEvent) => {
    if (menuOpen && event.key === "Escape") {
      closeMenu();
    }
  };

  const handleWindowScroll = () => {
    if (menuOpen) {
      closeMenu();
    }
  };

  const handleWindowResize = () => {
    if (menuOpen) {
      closeMenu();
    }
  };

  function installGlobalListeners(): void {
    if (globalListenersInstalled) {
      return;
    }
    globalListenersInstalled = true;

    window.addEventListener("pointerdown", handleWindowPointerDown, true);
    window.addEventListener("keydown", handleWindowKeyDown);
    window.addEventListener("scroll", handleWindowScroll, true);
    window.addEventListener("resize", handleWindowResize);
  }

  function destroy(): void {
    closeMenu(true);
    if (globalListenersInstalled) {
      globalListenersInstalled = false;
      window.removeEventListener("pointerdown", handleWindowPointerDown, true);
      window.removeEventListener("keydown", handleWindowKeyDown);
      window.removeEventListener("scroll", handleWindowScroll, true);
      window.removeEventListener("resize", handleWindowResize);
    }
    document.getElementById(LANG_SECTION_ID)?.remove();
  }

  function setTextIfChanged(el: Element | null, next: string): void {
    if (el && el.textContent !== next) {
      el.textContent = next;
    }
  }

  function updateContent(section: HTMLElement): void {
    const state = getLocaleState();
    const copy = getSectionCopy(translateText);
    const headingEl = section.querySelector("[data-i18n-role=\"heading\"]");
    const labelEl = section.querySelector("[data-i18n-role=\"row-label\"]");
    const descEl = section.querySelector("[data-i18n-role=\"row-desc\"]");
    const triggerLabelEl = section.querySelector("[data-i18n-role=\"trigger-label\"]");

    setTextIfChanged(headingEl, copy.heading);
    setTextIfChanged(labelEl, copy.label);
    setTextIfChanged(descEl, copy.description);
    setTextIfChanged(triggerLabelEl, getLocaleDisplayLabel(state));
  }

  function ensureMounted(): void {
    const modeGroup = document.getElementById("project4kMode");
    const hostSection = modeGroup?.parentElement;
    if (!hostSection) {
      if (menuOpen) {
        closeMenu(true);
      }
      return;
    }

    installGlobalListeners();

    let section = document.getElementById(LANG_SECTION_ID);
    if (!section) {
      section = document.createElement("div");
      section.id = LANG_SECTION_ID;
      section.setAttribute("data-i18n-skip", "1");
      section.className = "space-y-2 mt-4 relative";
      section.style.zIndex = "20";

      const headerWrap = document.createElement("div");
      headerWrap.className = "flex flex-col gap-1";
      const headerRow = document.createElement("div");
      headerRow.className = "flex items-center justify-between";
      const heading = document.createElement("h3");
      heading.className = "m-0 font-medium";
      heading.setAttribute("data-i18n-role", "heading");
      headerRow.appendChild(heading);
      headerWrap.appendChild(headerRow);

      const card = document.createElement("div");
      card.className =
        "agy-card bg-transparent rounded-xl border border-border divide-y divide-border";

      const row = document.createElement("div");
      row.className = "py-2 px-3 w-full bg-transparent flex justify-between gap-4 items-center";

      const leftCol = document.createElement("div");
      leftCol.className = "flex-1 flex flex-col gap-0.5";

      const labelWrap = document.createElement("div");
      labelWrap.className = "flex items-center gap-1.5";
      const labelSpan = document.createElement("span");
      labelSpan.setAttribute("data-i18n-role", "row-label");
      labelWrap.appendChild(labelSpan);

      const descSpan = document.createElement("span");
      descSpan.className = "text-sm text-muted-foreground whitespace-pre-wrap";
      descSpan.setAttribute("data-i18n-role", "row-desc");

      leftCol.appendChild(labelWrap);
      leftCol.appendChild(descSpan);

      const rightCol = document.createElement("div");
      rightCol.className = "shrink-0 relative";

      const trigger = document.createElement("button");
      trigger.type = "button";
      trigger.setAttribute("data-i18n-role", "trigger");
      trigger.setAttribute("aria-haspopup", "listbox");
      trigger.setAttribute("aria-expanded", "false");
      trigger.className =
        "agy-select-trigger appearance-none px-2 py-1 bg-secondary text-secondary-foreground hover:text-foreground rounded-md border-none cursor-pointer flex items-center gap-2 justify-between min-w-[120px]";

      const triggerLabel = document.createElement("span");
      triggerLabel.className = "truncate";
      triggerLabel.setAttribute("data-i18n-role", "trigger-label");

      const arrow = createSvgIcon("M6 9l6 6 6-6", 12, "w-3 h-3 shrink-0 opacity-70 ml-auto");

      trigger.appendChild(triggerLabel);
      trigger.appendChild(arrow);

      trigger.addEventListener("click", (event) => {
        event.stopPropagation();
        if (menuOpen) {
          closeMenu();
        } else {
          openMenu(trigger);
        }
      });

      rightCol.appendChild(trigger);
      row.appendChild(leftCol);
      row.appendChild(rightCol);
      card.appendChild(row);

      section.appendChild(headerWrap);
      section.appendChild(card);
      hostSection.appendChild(section);
    }

    updateContent(section);
  }

  return {
    ensureMounted,
    destroy
  };
}
