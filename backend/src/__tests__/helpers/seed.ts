export interface SeedableDataStore {
  clients: Map<string, any>;
  clientsByApiKey?: Map<string, string>;
  onboardingTokens?: Map<string, any>;
  clientGroups?: Map<string, any>;
}

export interface SeedClientOpts {
  id: string;
  name?: string;
  email?: string;
  apiKey?: string;
  apiKeyHash?: string | null;
  status?: string;
  stripeAccountId?: string | null;
  stripeCustomerId?: string | null;
  groupId?: string | null;
  [key: string]: any;
}

export function seedClient(dataStore: SeedableDataStore, opts: SeedClientOpts) {
  const {
    id,
    name = "Acme Corp",
    email = "billing@acme.test",
    apiKey = `api-key-${id}`,
    apiKeyHash,
    status = "active",
    stripeAccountId = null,
    stripeCustomerId = null,
    groupId = null,
    ...rest
  } = opts;
  dataStore.clients.set(id, {
    id,
    name,
    email,
    apiKey,
    apiKeyHash: apiKeyHash !== undefined ? apiKeyHash : `hashed:${apiKey}`,
    status,
    stripeAccountId,
    stripeCustomerId,
    groupId,
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
    token: opts.token,
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
  }
) {
  dataStore.clientGroups?.set(opts.id, {
    id: opts.id,
    name: opts.name,
    status: opts.status ?? "active",
    createdAt: new Date(),
    updatedAt: new Date(),
  });
}
