const params = new URLSearchParams(window.location.search);

const badge_performer = params.get("performer");
const badge_venue = params.get("venue");
const badge_storyclub = params.get("club");

let badgeText = "";

// Decide which type of page this is
if (badge_performer) {
  badgeText = "Find me on";
} else if (badge_venue || badge_storyclub) {
  badgeText = "Find us on";
}

// Only create the badge if we have a valid page type
if (badgeText) {
  const pageUrl = window.location.href;

  const badgeCode =
    `<a href="${pageUrl}" target="_blank" rel="noopener">` +
    `<img src="https://newtroubadours.com/badges/findmeon.png" ` +
    `alt="${badgeText} New Troubadours">` +
    `</a>`;

  // Show the badge section
  document.getElementById("badge-container").style.display = "block";

  // Display the HTML
  document.getElementById("badge-code").value = badgeCode;

  // Display a preview
  document.getElementById("badge-preview").innerHTML = badgeCode;

  // Copy button
  document.getElementById("copy-badge").addEventListener("click", async () => {
    const message = document.getElementById("copy-message");

    try {
      await navigator.clipboard.writeText(badgeCode);

      message.textContent = "Copied!";

      setTimeout(() => {
        message.textContent = "";
      }, 2000);
    } catch (error) {
      console.error("Could not copy badge HTML:", error);

      message.textContent = "Copy failed — please copy the HTML manually.";

      setTimeout(() => {
        message.textContent = "";
      }, 3000);
    }
  });
}
