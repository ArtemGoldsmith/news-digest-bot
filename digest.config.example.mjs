// Example digest configuration.
//
// Copy to digest.config.mjs (gitignored) and edit, or store the whole file in
// the DIGEST_CONFIG repository secret — the workflow writes it to
// digest.config.mjs before each run. Without either, this example is used.

// Who the digest is for, in plain words: what matters and what to skip.
// Written for the model, so any language works.
export const PERSONA = `
The reader is a software developer.
Interested in: AI and LLMs (new models, agents, developer tooling), notable
open-source and web-platform news, major world events, the economy and big
tech, breakthrough or simply curious science (space, physics, biology).
Not interested in: sports, celebrity gossip, clickbait, minor library releases
with no practical impact, crime reports from places the reader does not live in.
`;

// Output tuning. Every field is optional; these are the defaults.
export const OUTPUT = {
  language: "English", // language the digest is written in
  locale: "en-GB", // date format in the digest title
  timeZone: "UTC", // "today" is computed in this zone
  title: "📰 Digest",
  topics: "🤖 AI, 💻 Dev, 🌍 World, 💼 Business, 🔬 Science", // grouping hint
};

// Sources for the main digest. Google News RSS search works well:
// https://news.google.com/rss/search?q=<query>&hl=<lang>
export const FEEDS = [
  { url: "https://news.google.com/rss/search?q=AI+OR+LLM+OR+%22AI+agents%22+when:1d&hl=en" },
  { url: "https://hnrss.org/frontpage?points=150" },
  { url: "https://news.google.com/rss?hl=en&gl=US&ceid=US:en" },
  { url: "https://news.google.com/rss/headlines/section/topic/BUSINESS?hl=en" },
  { url: "https://news.google.com/rss/headlines/section/topic/SCIENCE?hl=en" },
];

// Optional local section, built by its own Gemini call from its own feeds with
// a 72h window and cross-run dedup. Delete this export (or set it to null) to
// turn the section off.
export const local = {
  name: "Bristol",
  // header: "🏘 Bristol",            // defaults to "🏘 <name>"

  // Items must mention one of these (regex fragments, case-insensitive) in the
  // title, description or source to enter the pool. Omit to keep every item.
  places: ["bristol", "clifton", "bedminster", "easton", "southville", "filton", "keynsham", "portishead"],

  // Nearby places that count for events/culture/transport, but not for crime
  // and incidents (those must be in the city itself).
  nearby: ["Keynsham", "Portishead", "Filton"],

  // Topics the model must drop. Sport is the usual offender: a bare city
  // search is often dominated by its clubs.
  skipTopics: [
    "sport — football, rugby, cricket, Bristol City, Bristol Rovers, Bristol Bears, match results, transfers, player and coach interviews",
  ],

  // `official: true` marks the city's own feed, which bypasses the `places`
  // check. Strip sport by query where you can.
  feeds: [
    { url: "https://news.google.com/rss/search?q=Bristol+(police+OR+crash+OR+fire+OR+court)+when:3d&hl=en-GB&gl=GB&ceid=GB:en" },
    { url: "https://news.google.com/rss/search?q=Bristol+council+OR+%22Bristol+city+centre%22+-football+-rugby+when:3d&hl=en-GB&gl=GB&ceid=GB:en" },
  ],
};
