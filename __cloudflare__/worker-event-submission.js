// Accepts the Event Builder's JSON and opens a labelled issue in the private repo.

const ALLOWED_KEYS = new Set([
  "newPerformers",
  "updatedPerformers",
  "newVenues",
  "updatedVenues",
  "specificEvents",
  "musicEvents",
  "poetryEvents",
  "tours",
  "repertoire_shows",
  "festivals",
  "updatedFestivals",
  "podcasts",
  "updatedPodcasts",
  "promoters",
  "updatedPromoters",
  "publishers",
  "clubs",
  "updatedClubs",
  "podcastEpisodeAdditions",
  "updatedEvents",
  "tourChanges",
  "updatedTours",
  "repertoireShowChanges",
  "updatedRepertoireShows",
]);

const MAX_RAW = 60000; // bytes accepted from the page
const MAX_ISSUE = 64000; // GitHub's issue body limit is 65,536 chars

const text = (msg, status) =>
  new Response(msg, { status, headers: { "Content-Type": "text/plain" } });

export default {
  async fetch(request, env) {
    if (request.method !== "POST") return text("Method not allowed", 405);

    if (
      !env.SUBMIT_KEY ||
      request.headers.get("X-Submit-Key") !== env.SUBMIT_KEY
    ) {
      return text("Unauthorised", 401);
    }

    const raw = await request.text();
    if (raw.length > MAX_RAW)
      return text(
        "Too large (over 60,000 characters). Send fewer records at once.",
        413,
      );

    let data;
    try {
      data = JSON.parse(raw);
    } catch {
      return text("Bad JSON", 400);
    }
    if (!data || typeof data !== "object" || Array.isArray(data))
      return text("Expected a JSON object", 400);

    const keys = Object.keys(data);
    if (!keys.length) return text("Nothing to submit", 400);
    const unknown = keys.filter((k) => !ALLOWED_KEYS.has(k));
    if (unknown.length) return text("Unknown keys: " + unknown.join(", "), 400);

    const summary = keys
      .map((k) => {
        const v = data[k];
        return `${Array.isArray(v) ? v.length : Object.keys(v || {}).length} ${k}`;
      })
      .join(", ");

    const body = "~~~~json\n" + JSON.stringify(data, null, 2) + "\n~~~~";
    if (body.length > MAX_ISSUE)
      return text(
        "Too large for a GitHub issue. Send fewer records at once.",
        413,
      );

    const res = await fetch(
      `https://api.github.com/repos/${env.GITHUB_REPO}/issues`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${env.GITHUB_TOKEN}`,
          "User-Agent": "abn-event-builder",
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
        },
        body: JSON.stringify({
          title: `Submission: ${summary}`.slice(0, 200),
          labels: ["event-submission"],
          body,
        }),
      },
    );

    if (!res.ok) {
      console.log("GitHub error", res.status, await res.text());
      return text("GitHub rejected the submission (" + res.status + ")", 502);
    }
    const issue = await res.json();
    return new Response(JSON.stringify({ ok: true, issue: issue.number }), {
      headers: { "Content-Type": "application/json" },
    });
  },
};
