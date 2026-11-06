import {
  cereboRequest,
  getNextcloudConfig,
  NextcloudCircuitOpenError,
  type NextcloudConfig,
  NextcloudHttpError,
} from "../lib/nextcloud";

// Read-only Nextcloud access for Cerebo through the shared service account in
// lib/nextcloud.ts, on a breaker of its own so a failing Deck cannot lock out admin login. Nextcloud is optional: without credentials Cerebo
// still serves its own records and marks Nextcloud data "not_configured".

export type Unavailable = { status: "not_configured" } | { status: "unavailable"; reason: string };

function configOrUnavailable(): { config: NextcloudConfig } | Unavailable {
  const result = getNextcloudConfig();
  if (result.ok) return { config: result.config };
  if (result.reason === "not_configured") return { status: "not_configured" };
  return { status: "unavailable", reason: "Nextcloud requires a valid HTTPS base URL." };
}

async function getJson(config: NextcloudConfig, path: string, label: string): Promise<unknown> {
  const res = await cereboRequest(config, { method: "GET", path, label });
  return JSON.parse(res.body) as unknown;
}

function unavailable(error: unknown): Unavailable {
  if (error instanceof NextcloudCircuitOpenError) {
    return { status: "unavailable", reason: "Nextcloud is not responding; retrying shortly." };
  }
  if (error instanceof NextcloudHttpError) {
    if (error.status === 404 || error.status === 403) {
      return {
        status: "unavailable",
        reason: "Not found, or not shared with the Nextcloud service account.",
      };
    }
    return { status: "unavailable", reason: `Nextcloud answered ${error.status}.` };
  }
  return { status: "unavailable", reason: "Nextcloud could not be reached." };
}

interface DeckCard {
  id: number;
  title: string;
  duedate: string | null;
  done: string | null;
  archived: boolean;
}

interface DeckStack {
  id: number;
  title: string;
  order: number;
  cards?: DeckCard[];
}

export type DeckBoardSummary =
  | {
      status: "ok";
      boardId: string;
      totalCards: number;
      doneCards: number;
      overdueCards: number;
      stacks: { id: number; title: string; cards: number }[];
    }
  | Unavailable;

export function summarizeDeckStacks(
  boardId: string,
  stacks: DeckStack[],
  now = new Date()
): DeckBoardSummary {
  let totalCards = 0;
  let doneCards = 0;
  let overdueCards = 0;
  const ordered = [...stacks].sort((a, b) => a.order - b.order);
  for (const stack of ordered) {
    for (const card of stack.cards ?? []) {
      if (card.archived) continue;
      totalCards += 1;
      if (card.done) doneCards += 1;
      else if (card.duedate && new Date(card.duedate) < now) overdueCards += 1;
    }
  }
  return {
    status: "ok",
    boardId,
    totalCards,
    doneCards,
    overdueCards,
    stacks: ordered.map((s) => ({
      id: s.id,
      title: s.title,
      cards: (s.cards ?? []).filter((c) => !c.archived).length,
    })),
  };
}

export async function getDeckBoardSummary(boardId: string): Promise<DeckBoardSummary> {
  const resolved = configOrUnavailable();
  if (!("config" in resolved)) return resolved;
  if (!/^\d+$/.test(boardId)) return { status: "unavailable", reason: "Invalid Deck board id." };
  try {
    const stacks = (await getJson(
      resolved.config,
      `/index.php/apps/deck/api/v1.0/boards/${boardId}/stacks`,
      "deck.stacks"
    )) as DeckStack[];
    return summarizeDeckStacks(boardId, Array.isArray(stacks) ? stacks : []);
  } catch (error) {
    return unavailable(error);
  }
}

export type NextcloudStatus = { status: "ok"; version: string } | Unavailable;

export async function getNextcloudStatus(): Promise<NextcloudStatus> {
  const resolved = configOrUnavailable();
  if (!("config" in resolved)) return resolved;
  try {
    const body = (await getJson(
      resolved.config,
      "/ocs/v2.php/cloud/capabilities?format=json",
      "capabilities"
    )) as { ocs?: { data?: { version?: { string?: string } } } };
    return { status: "ok", version: body.ocs?.data?.version?.string ?? "unknown" };
  } catch (error) {
    return unavailable(error);
  }
}
