import { buildWebsiteLeadAnswers, type WebsiteContact } from "./sales-lead-mapping";
import { SalesLeadNextcloud } from "./sales-lead-nextcloud";
import { loadSalesLeadConfig } from "./sales-lead-sync";

/**
 * Whether website contacts are also turned into leads: the same gate the poller
 * uses (automation enabled and fully configured). An invalid config is reported by
 * the poller, so this channel just stays off.
 */
export function isWebsiteLeadEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return loadSalesLeadConfig(env).status === "ready";
}

/**
 * Submits the contact to the New Lead form; the poller creates the pipeline row,
 * contact card and folder from it. Throws on any failure (Nextcloud error, open
 * breaker, missing Company question).
 */
export async function submitWebsiteLead(
  contact: WebsiteContact,
  env: NodeJS.ProcessEnv = process.env
): Promise<void> {
  const config = loadSalesLeadConfig(env);
  if (config.status !== "ready") throw new Error("Sales lead automation is not configured");
  const api = new SalesLeadNextcloud(config.nextcloud, config.settings);
  const answers = buildWebsiteLeadAnswers(await api.getQuestions(), contact);
  await api.submitLead(answers);
}
