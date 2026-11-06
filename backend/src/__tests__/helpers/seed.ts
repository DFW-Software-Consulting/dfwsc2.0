import crypto from "node:crypto";

export interface SeedableDataStore {
  clients: Map<string, any>;
  clientsByApiKey?: Map<string, string>;
  onboardingTokens?: Map<string, any>;
  clientGroups?: Map<string, any>;
  paymentLedger?: Map<string, any>;
}

export interface SeedClientOpts {
  id: string;
  name?: string;
  email?: string;
  apiKey?: string;
  apiKeyHash?: string | null;
  apiKeyLookup?: string | null;
  status?: string;
  stripeAccountId?: string | null;
  groupId?: string | null;
  workspace?: string;
  chargesEnabled?: boolean;
  payoutsEnabled?: boolean;
  detailsSubmitted?: boolean;
  [key: string]: any;
}

function sha256(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

export function seedClient(dataStore: SeedableDataStore, opts: SeedClientOpts) {
  const {
    id,
    name = "Acme Corp",
    email = "billing@acme.test",
    apiKey = `api-key-${id}`,
    apiKeyHash,
    apiKeyLookup,
    status = "active",
    stripeAccountId = null,
    groupId = null,
    workspace = "client_portal",
    ...rest
  } = opts;

  // apiKeyHash uses the fake "hashed:${key}" format matching the bcryptjs mock in tests.
  // apiKeyLookup is the SHA256 of the key, matching what auth.ts computes for DB lookup.
  const resolvedApiKeyHash = apiKeyHash !== undefined ? apiKeyHash : `hashed:${apiKey}`;
  const resolvedApiKeyLookup = apiKeyLookup !== undefined ? apiKeyLookup : sha256(apiKey);

  dataStore.clients.set(id, {
    id,
    name,
    email,
    apiKey,
    apiKeyHash: resolvedApiKeyHash,
    apiKeyLookup: resolvedApiKeyLookup,
    status,
    stripeAccountId,
    groupId,
    workspace,
    ...rest,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  dataStore.clientsByApiKey?.set(apiKey, id);
}

export function seedOnboardingToken(
  dataStore: SeedableDataStore,
  opts: {
    id: string;
    clientId: string;
    token: string;
    status?: string;
    email?: string;
    state?: string | null;
    stateExpiresAt?: Date | null;
  }
) {
  dataStore.onboardingTokens?.set(opts.id, {
    id: opts.id,
    clientId: opts.clientId,
    token: sha256(opts.token),
    status: opts.status ?? "pending",
    email: opts.email ?? "",
    state: opts.state ?? null,
    stateExpiresAt: opts.stateExpiresAt ?? null,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
}

export function seedClientGroup(
  dataStore: SeedableDataStore,
  opts: {
    id: string;
    name: string;
    status?: string;
    workspace?: string;
    [key: string]: any;
  }
) {
  const { id, name, status = "active", workspace = "client_portal", ...rest } = opts;
  dataStore.clientGroups?.set(opts.id, {
    id,
    name,
    status,
    workspace,
    ...rest,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
}
