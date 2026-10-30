import CircuitBreaker from "opossum";

// Read-only Nextcloud access for Cerebo, as one service account. Nextcloud is
// optional: without credentials Cerebo still serves its own records and marks
// Nextcloud data "not_configured". Calls go through a breaker of their own, so a
// Nextcloud outage degrades project views and never touches the Stripe or SMTP
// breakers the payment routes depend on.

const REQUEST_TIMEOUT_MS = 8_000;

interface NextcloudConfig {
  baseUrl: string;
  username: string;
  appPassword: string;
}

function getConfig(): NextcloudConfig | null {
  const baseUrl = process.env.NEXTCLOUD_BASE_URL?.trim();
  const username = process.env.NEXTCLOUD_USERNAME?.trim();
  const appPassword = process.env.NEXTCLOUD_APP_PASSWORD;
  if (!baseUrl || !username || !appPassword) return null;
  return { baseUrl: baseUrl.replace(/\/+$/, ""), username, appPassword };
}

export class NextcloudHttpError extends Error {
  constructor(
    readonly status: number,
    path: string
  ) {
    super(`Nextcloud answered ${status} for ${path}`);
    this.name = "NextcloudHttpError";
  }
}

// A 4xx other than 401 means Nextcloud answered and the request was the problem
// (board deleted, not shared with the service account). That must not open the
// breaker for every other project. 401 means the app password is wrong or
// revoked, which affects every call, so it counts.
function isCallerError(error: unknown): boolean {
  return (
    error instanceof NextcloudHttpError &&
    error.status >= 400 &&
    error.status < 500 &&
    error.status !== 401
  );
}

const breaker = new CircuitBreaker(
  async (config: NextcloudConfig, path: string) => {
    const res = await fetch(`${config.baseUrl}${path}`, {
      headers: {
        authorization: `Basic ${Buffer.from(`${config.username}:${config.appPassword}`).toString("base64")}`,
        "OCS-APIRequest": "true",
        accept: "application/json",
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!res.ok) throw new NextcloudHttpError(res.status, path);
    return (await res.json()) as unknown;
  },
  {
    name: "nextcloud",
    timeout: REQUEST_TIMEOUT_MS + 2_000,
    resetTimeout: 30_000,
    volumeThreshold: 5,
    errorThresholdPercentage: 50,
    errorFilter: isCallerError,
  }
);

async function getJson(config: NextcloudConfig, path: string): Promise<unknown> {
  return breaker.fire(config, path);
}

export type Unavailable = { status: "not_configured" } | { status: "unavailable"; reason: string };

function unavailable(error: unknown): Unavailable {
  if (CircuitBreaker.isOurError(error as Error)) {
    return { status: "unavailable", reason: "Nextcloud is not responding; retrying shortly." };
  }
  if (error instanceof NextcloudHttpError) {
    if (error.status === 404 || error.status === 403) {
      return {
        status: "unavailable",
        reason: "Not found, or not shared with the Cerebo service account.",
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
  const config = getConfig();
  if (!config) return { status: "not_configured" };
  if (!/^\d+$/.test(boardId)) return { status: "unavailable", reason: "Invalid Deck board id." };
  try {
    const stacks = (await getJson(
      config,
      `/index.php/apps/deck/api/v1.0/boards/${boardId}/stacks`
    )) as DeckStack[];
    return summarizeDeckStacks(boardId, Array.isArray(stacks) ? stacks : []);
  } catch (error) {
    return unavailable(error);
  }
}

export type NextcloudStatus = { status: "ok"; version: string } | Unavailable;

export async function getNextcloudStatus(): Promise<NextcloudStatus> {
  const config = getConfig();
  if (!config) return { status: "not_configured" };
  try {
    const body = (await getJson(config, "/ocs/v2.php/cloud/capabilities?format=json")) as {
      ocs?: { data?: { version?: { string?: string } } };
    };
    return { status: "ok", version: body.ocs?.data?.version?.string ?? "unknown" };
  } catch (error) {
    return unavailable(error);
  }
}

export function resetNextcloudBreakerForTests() {
  breaker.close();
}
