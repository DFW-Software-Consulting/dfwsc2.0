import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Migration Journal Consistency Guard (issue #105)
 *
 * backend/drizzle/meta/_journal.json is drizzle-kit's source of truth for which migrations
 * exist and in what order they apply. It must never drift from the .sql files on disk -
 * drift breaks Drizzle's applied-migration tracking in production.
 *
 * This test reads the real files under backend/drizzle/ (no fixtures) and asserts the
 * journal and the directory agree with each other.
 *
 * IMPORTANT: backend/drizzle/** (including _journal.json and meta/) is applied-in-production
 * migration history. Do NOT "fix" a failing assertion here by renaming, renumbering, or
 * hand-editing any existing file under backend/drizzle/. Pre-existing anomalies are
 * grandfathered explicitly below; anything NEW must go through `drizzle-kit generate`
 * (see docs/DATABASE.md, "Migration authoring policy").
 */

const DRIZZLE_DIR = join(__dirname, "../../../drizzle");
const META_DIR = join(DRIZZLE_DIR, "meta");
const JOURNAL_PATH = join(META_DIR, "_journal.json");

/**
 * Migration tags whose numeric filename prefix collides with another migration's prefix.
 * This is pre-existing hand-edit drift (two migrations were both hand-numbered "0019"),
 * not something to be "fixed" by renaming applied-in-production files. Enumerated exactly:
 * if a NEW file collides with an existing prefix, its tag will not be in this list and the
 * duplicate-prefix check below will fail.
 */
const GRANDFATHERED_DUPLICATE_PREFIX_TAGS: readonly string[] = [
  "0019_brave_ravenous",
  "0019_hash_onboarding_tokens",
];

interface JournalEntry {
  idx: number;
  version: string;
  when: number;
  tag: string;
  breakpoints: boolean;
}

interface Journal {
  version: string;
  dialect: string;
  entries: JournalEntry[];
}

function readJournal(): Journal {
  const raw = readFileSync(JOURNAL_PATH, "utf-8");
  return JSON.parse(raw) as Journal;
}

/** Tags (filename without ".sql") for every top-level migration file in backend/drizzle/. */
function listTopLevelSqlTags(): string[] {
  return readdirSync(DRIZZLE_DIR, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".sql"))
    .map((entry) => entry.name.replace(/\.sql$/, ""));
}

/** Numeric prefixes (e.g. "0022") that have a meta/<prefix>_snapshot.json file. */
function listMetaSnapshotPrefixes(): Set<string> {
  const prefixes = new Set<string>();
  for (const name of readdirSync(META_DIR)) {
    const match = name.match(/^(\d+)_snapshot\.json$/);
    if (match) prefixes.add(match[1]);
  }
  return prefixes;
}

function numericPrefix(tag: string): string {
  const match = tag.match(/^(\d+)_/);
  if (!match) {
    throw new Error(`Migration tag "${tag}" does not start with a numeric prefix.`);
  }
  return match[1];
}

describe("migration journal consistency (backend/drizzle)", () => {
  const journal = readJournal();
  const sqlTags = listTopLevelSqlTags();

  it("has a .sql file for every journal entry", () => {
    for (const entry of journal.entries) {
      expect(
        sqlTags,
        `journal entry idx ${entry.idx} references tag "${entry.tag}", but ` +
          `backend/drizzle/${entry.tag}.sql does not exist`
      ).toContain(entry.tag);
    }
  });

  it("has a journal entry for every top-level .sql file", () => {
    const journalTags = new Set(journal.entries.map((entry) => entry.tag));
    for (const tag of sqlTags) {
      expect(
        journalTags.has(tag),
        `backend/drizzle/${tag}.sql exists but has no entry in meta/_journal.json`
      ).toBe(true);
    }
  });

  it("has strictly increasing, unique idx values in entry order", () => {
    const idxValues = journal.entries.map((entry) => entry.idx);

    for (let i = 1; i < idxValues.length; i++) {
      expect(
        idxValues[i],
        `journal entry at position ${i} has idx ${idxValues[i]}, which does not exceed ` +
          `the previous entry's idx ${idxValues[i - 1]}`
      ).toBeGreaterThan(idxValues[i - 1]);
    }
    expect(new Set(idxValues).size, "journal contains duplicate idx values").toBe(idxValues.length);
  });

  it("has unique numeric filename prefixes, except the grandfathered 0019 pair", () => {
    const tagsByPrefix = new Map<string, string[]>();
    for (const tag of sqlTags) {
      const prefix = numericPrefix(tag);
      const group = tagsByPrefix.get(prefix) ?? [];
      group.push(tag);
      tagsByPrefix.set(prefix, group);
    }

    for (const [prefix, tags] of tagsByPrefix) {
      if (tags.length <= 1) continue;
      for (const tag of tags) {
        const others = tags.filter((other) => other !== tag).join(", ");
        expect(
          GRANDFATHERED_DUPLICATE_PREFIX_TAGS,
          `"${tag}" shares numeric prefix "${prefix}" with ${others}. New migrations must ` +
            "be created with `npx drizzle-kit generate`, never hand-numbered - see " +
            'docs/DATABASE.md "Migration authoring policy".'
        ).toContain(tag);
      }
    }
  });

  it("has a meta snapshot for the latest journal entry", () => {
    const latest = journal.entries.reduce((max, entry) => (entry.idx > max.idx ? entry : max));
    const prefix = numericPrefix(latest.tag);
    const snapshotPrefixes = listMetaSnapshotPrefixes();

    expect(
      snapshotPrefixes.has(prefix),
      `meta/${prefix}_snapshot.json is missing for the latest migration "${latest.tag}" ` +
        `(idx ${latest.idx}). Historical snapshots may be missing (grandfathered), but the ` +
        "latest migration must always have one - it should be generated automatically by " +
        "`npx drizzle-kit generate`."
    ).toBe(true);
  });
});
