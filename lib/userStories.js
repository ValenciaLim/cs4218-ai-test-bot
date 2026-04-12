const fs = require("fs-extra");
const path = require("path");

/** Strip leading slashes and ./ so story paths match repo-relative paths like client/src/... */
function normalizePinnedPath(p) {
  if (p == null || p === "") return "";
  let s = String(p).replace(/\\/g, "/").trim();
  s = s.replace(/^\.\/+/, "");
  while (s.startsWith("/")) s = s.slice(1);
  return s;
}

/**
 * Normalize a raw story object to { title, type, priority, description, files, testFor }.
 * testFor: which agent(s) should use this story — comma-separated tokens, or "all" / empty = every agent.
 * Tokens: unit | integration | ui | e2e | playwright | performance | load | soak | spike | stress | ...
 */
function normalizeStory(raw, fallbackKey = "") {
  if (!raw || typeof raw !== "object") {
    return {
      title: String(fallbackKey || "Untitled"),
      type: "story",
      priority: "medium",
      description: "",
      files: [],
      testFor: ""
    };
  }
  const files = raw.files || raw.targetFiles || raw.paths || [];
  const rawList = Array.isArray(files) ? files.map(String) : [];
  const normalizedFiles = rawList.map(normalizePinnedPath).filter(Boolean);
  const testFor = raw.testFor != null ? String(raw.testFor).trim() : "";
  return {
    title: raw.title != null ? String(raw.title) : String(fallbackKey || "Untitled"),
    type: raw.type != null ? String(raw.type) : "story",
    priority: raw.priority != null ? String(raw.priority) : "medium",
    description: raw.description != null ? String(raw.description) : "",
    files: normalizedFiles,
    testFor
  };
}

const UNIT_TOKENS = new Set(["unit"]);
const INTEGRATION_TOKENS = new Set(["integration", "ui", "e2e", "playwright", "system"]);
const PERFORMANCE_TOKENS = new Set(["performance", "load", "stress", "soak", "spike"]);

/** Subset of testFor tokens that map to `{mode}_test.js` k6 scripts */
const K6_MODE_TOKENS = new Set(["load", "soak", "stress", "spike"]);
const K6_MODE_ORDER = ["load", "soak", "stress", "spike"];

function testForTokens(story) {
  const tf = String((story && story.testFor) || "")
    .trim()
    .toLowerCase();
  if (!tf || tf === "all" || tf === "*") return null;
  return tf
    .split(/[,;|]/)
    .map(s => s.trim())
    .filter(Boolean);
}

/**
 * Whether a story should be consumed by an agent. Empty / all / * => true for every agent.
 * Otherwise at least one token must match the agent (e.g. testFor: "unit" or "unit,integration").
 */
function storyAppliesToAgent(story, agentKind) {
  const tokens = testForTokens(story);
  if (tokens == null) return true;
  const set =
    agentKind === "unit"
      ? UNIT_TOKENS
      : agentKind === "integration"
        ? INTEGRATION_TOKENS
        : agentKind === "performance"
          ? PERFORMANCE_TOKENS
          : new Set();
  return tokens.some(t => set.has(t));
}

function filterStoriesForAgent(stories, agentKind) {
  return (stories || []).filter(s => storyAppliesToAgent(s, agentKind));
}

/**
 * Union of k6 mode tokens in `testFor` for stories that apply to the performance agent.
 * Returns [] if no story names a concrete mode (e.g. only `performance` / `k6`) — caller should fall back to `performance.modes` in config.
 * Stories with `testFor` all / * / empty are skipped here so they do not imply every mode.
 */
function collectPerformanceModesFromStories(stories) {
  const found = new Set();
  for (const s of stories || []) {
    if (!storyAppliesToAgent(s, "performance")) continue;
    const tokens = testForTokens(s);
    if (tokens == null) continue;
    for (const t of tokens) {
      if (K6_MODE_TOKENS.has(t)) found.add(t);
    }
  }
  if (!found.size) return [];
  return K6_MODE_ORDER.filter(m => found.has(m));
}

/**
 * Load user stories from a JSON file. Supports:
 * - { "stories": [ {...}, ... ] }
 * - [ {...}, ... ]
 * - { "epics": { "path/to/file.js": "description text" } } (legacy-style map)
 */
async function loadUserStories(filePath) {
  const abs = path.isAbsolute(filePath) ? filePath : path.join(process.cwd(), filePath);
  if (!(await fs.pathExists(abs))) {
    throw new Error(`User stories file not found: ${abs}`);
  }
  const text = await fs.readFile(abs, "utf-8");
  let data;
  try {
    data = JSON.parse(text);
  } catch (e) {
    throw new Error(`User stories JSON parse error in ${abs}: ${e.message}`);
  }

  if (Array.isArray(data)) {
    return data.map((s, i) => normalizeStory(s, `story_${i}`));
  }
  if (data.stories && Array.isArray(data.stories)) {
    return data.stories.map((s, i) => normalizeStory(s, `story_${i}`));
  }
  if (data.epics && typeof data.epics === "object" && !Array.isArray(data.epics)) {
    return Object.entries(data.epics).map(([key, val]) =>
      normalizeStory(
        typeof val === "string"
          ? { title: val, description: val, files: [key] }
          : { ...val, title: val.title || key, files: val.files || [key] },
        key
      )
    );
  }
  return [normalizeStory(data, "story_0")];
}

/**
 * Stories relevant to a source file path (posix-style relative paths preferred).
 * If any story pins `files`, only path-matched stories are used for that file.
 * Stories with empty `files` are not path-pinned and are ignored here unless no pins exist.
 */
function storiesForFile(stories, relativeFilePath) {
  const norm = normalizePinnedPath(relativeFilePath.replace(/\\/g, "/"));
  const pinned = stories.filter(s => (s.files || []).length > 0);
  if (pinned.length === 0) return stories;
  const pathMatch = pinned.filter(s =>
    s.files.some(f => {
      const fp = normalizePinnedPath(f);
      if (!fp || !norm) return false;
      return norm === fp || norm.endsWith("/" + fp);
    })
  );
  return pathMatch;
}

/** All repo-relative source paths: selected manifest + every path pinned on a story. */
function collectUnitTargetFiles(selectedFiles, stories) {
  const set = new Set();
  for (const f of selectedFiles.frontend || []) {
    const n = normalizePinnedPath(f);
    if (n) set.add(n);
  }
  for (const f of Object.keys(selectedFiles.backend || {})) {
    const n = normalizePinnedPath(f);
    if (n) set.add(n);
  }
  for (const s of stories || []) {
    if (!storyAppliesToAgent(s, "unit")) continue;
    for (const f of s.files || []) {
      const n = normalizePinnedPath(f);
      if (n) set.add(n);
    }
  }
  return [...set];
}

/** Build stories from selectedFiles.json-style { epics: { "path": "title or text" } } */
function storiesFromEpicsManifest(manifest) {
  const epics = manifest && manifest.epics;
  if (!epics || typeof epics !== "object" || Array.isArray(epics)) return [];
  return Object.entries(epics).map(([key, val]) =>
    normalizeStory(
      typeof val === "string"
        ? { title: val, description: val, files: [key] }
        : { ...val, title: (val && val.title) || key, files: (val && val.files) || [key] },
      key
    )
  );
}

function mergeStoriesForPrompt(stories) {
  if (!stories || stories.length === 0) {
    return { title: "", type: "story", priority: "medium", description: "", testFor: "" };
  }
  if (stories.length === 1) return { ...stories[0], files: stories[0].files };
  return {
    title: stories.map(s => s.title).join(" | "),
    type: stories[0].type || "story",
    priority: stories.map(s => s.priority).join(", "),
    description: stories.map((s, i) => `(${i + 1}) ${s.description || s.title}`).join("\n"),
    files: [...new Set(stories.flatMap(s => s.files || []))],
    testFor: stories.map(s => s.testFor || "all").join(" | ")
  };
}

module.exports = {
  loadUserStories,
  normalizeStory,
  normalizePinnedPath,
  storiesForFile,
  storiesFromEpicsManifest,
  mergeStoriesForPrompt,
  collectUnitTargetFiles,
  storyAppliesToAgent,
  filterStoriesForAgent,
  testForTokens,
  collectPerformanceModesFromStories
};
