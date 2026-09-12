const params = new URLSearchParams(window.location.search);

const performer_badge = params.get("performer");
const venue_badge = params.get("venue");
const storyclub_badge = params.get("club");

let badgeText = "";
let badgeImage = "";

if (performer_badge) {
  badgeText = "Find me on";
  badgeImage = "findmeon.png";
} else if (venue_badge || storyclub_badge) {
  badgeText = "Find us on";
  badgeImage = "finduson.png";
}

if (badgeText) {
  const pageUrl = window.location.href;

  const badgeCode =
    `<a href="${pageUrl}" target="_blank" rel="noopener">` +
    `<img src="https://newtroubadours.com/badges/${badgeImage}" ` +
    `alt="${badgeText} New Troubadours">` +
    `</a>`;

  // Show the badge container
  document.getElementById("badge-container").style.display = "block";

  // Show the actual badge
  document.getElementById("badge-preview").innerHTML = badgeCode;

  // Copy HTML link
  document
    .getElementById("copy-badge")
    .addEventListener("click", async (event) => {
      event.preventDefault();

      const message = document.getElementById("copy-message");

      try {
        await navigator.clipboard.writeText(badgeCode);

        message.textContent = "Copied!";

        setTimeout(() => {
          message.textContent = "";
        }, 2000);
      } catch (error) {
        console.error("Could not copy badge HTML:", error);

        message.textContent = "Copy failed";

        setTimeout(() => {
          message.textContent = "";
        }, 3000);
      }
    });
}
