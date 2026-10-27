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
  button.addEventListener("click", async () => {
    const value = button.getAttribute("data-copy");
    if (!value || !navigator.clipboard) {
      button.setAttribute("aria-label", "Clipboard access is unavailable");
      return;
    }

    const originalText = button.textContent;
    const originalLabel = button.getAttribute("aria-label");

    try {
      await navigator.clipboard.writeText(value);
      button.textContent = "Copied";
      button.setAttribute("aria-label", "Command copied to clipboard");
      window.setTimeout(() => {
        button.textContent = originalText;
        if (originalLabel) {
          button.setAttribute("aria-label", originalLabel);
        }
      }, 1600);
    } catch {
      button.textContent = "Copy failed";
      button.setAttribute("aria-label", "Could not copy command to clipboard");
      window.setTimeout(() => {
        button.textContent = originalText;
        if (originalLabel) {
          button.setAttribute("aria-label", originalLabel);
        }
      }, 1600);
    }
  });
});
