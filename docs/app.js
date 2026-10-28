const navToggle = document.querySelector(".nav-toggle");
const navLinks = document.querySelector(".nav-links");

if (navToggle && navLinks) {
  navToggle.addEventListener("click", () => {
    const isOpen = navLinks.classList.toggle("open");
    navToggle.setAttribute("aria-expanded", String(isOpen));
  });

  navLinks.addEventListener("click", (event) => {
    if (event.target instanceof HTMLAnchorElement) {
      navLinks.classList.remove("open");
      navToggle.setAttribute("aria-expanded", "false");
    }
  });
}

document.querySelectorAll("[data-copy]").forEach((button) => {
  const originalText = button.textContent;
  const originalLabel = button.getAttribute("aria-label");
  let resetTimer;
  let attempt = 0;

  const restore = () => {
    button.textContent = originalText;
    if (originalLabel !== null) {
      button.setAttribute("aria-label", originalLabel);
    } else {
      button.removeAttribute("aria-label");
    }
  };

  const showStatus = (text, label) => {
    button.textContent = text;
    button.setAttribute("aria-label", label);
    resetTimer = window.setTimeout(restore, 1600);
  };

  button.addEventListener("click", async () => {
    const currentAttempt = ++attempt;
    window.clearTimeout(resetTimer);
    restore();
    const value = button.getAttribute("data-copy");
    if (!value || !navigator.clipboard) {
      showStatus("Copy failed", "Clipboard access is unavailable");
      return;
    }

    try {
      await navigator.clipboard.writeText(value);
      if (currentAttempt === attempt) {
        showStatus("Copied", "Command copied to clipboard");
      }
    } catch {
      if (currentAttempt === attempt) {
        showStatus("Copy failed", "Could not copy command to clipboard");
      }
    }
  });
});
