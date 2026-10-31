import { z } from "zod";

// Where a contact-form submitter came from, sent by the marketing site. Purely
// informational and entirely optional: the contact route drops an invalid context
// instead of rejecting the request, so a bad value can never cost a lead.

// No control characters (newlines would let a visitor forge lines in the email).
const NO_CONTROL_CHARS = /^[^\p{Cc}\p{Zl}\p{Zp}]*$/u;
const PATH = /^\/[A-Za-z0-9\-._~/]{0,199}$/;
const HOSTNAME = /^[a-z0-9.-]{1,253}$/;

const pathSchema = z.string().regex(PATH);
const utmValueSchema = z.string().min(1).max(100).regex(NO_CONTROL_CHARS);

export const visitContextSchema = z.strictObject({
  referrer: z.string().regex(HOSTNAME).optional(),
  landingPath: pathSchema.optional(),
  utm: z
    .strictObject({
      source: utmValueSchema.optional(),
      medium: utmValueSchema.optional(),
      campaign: utmValueSchema.optional(),
      term: utmValueSchema.optional(),
      content: utmValueSchema.optional(),
    })
    .optional(),
  pages: z.array(pathSchema).max(20).optional(),
  secondsOnSite: z.number().int().min(0).max(86400).optional(),
});

export type VisitContext = z.infer<typeof visitContextSchema>;

const MAX_BLOCK_LENGTH = 1000;
const HEADER = "--- Visit context ---";

function formatDuration(totalSeconds: number): string {
  if (totalSeconds < 60) return `${totalSeconds}s`;
  if (totalSeconds < 3600) return `${Math.floor(totalSeconds / 60)}m ${totalSeconds % 60}s`;
  return `${Math.floor(totalSeconds / 3600)}h ${Math.floor((totalSeconds % 3600) / 60)}m`;
}

function campaignLine(utm: NonNullable<VisitContext["utm"]>): string | undefined {
  const main = [utm.source, utm.medium, utm.campaign].filter(Boolean).join(" / ");
  const extras = [utm.term && `term: ${utm.term}`, utm.content && `content: ${utm.content}`].filter(
    Boolean
  );
  const parts = [main, extras.length ? `(${extras.join(", ")})` : ""].filter(Boolean);
  return parts.length ? `Campaign: ${parts.join(" ")}` : undefined;
}

/**
 * Human-readable block for the notification email and the lead's Notes, or ""
 * when there is nothing to show. Capped at 1000 characters: the pages list is
 * trimmed first (ending in "…"), and only then is the whole block cut.
 */
export function formatVisitContext(ctx: VisitContext | undefined): string {
  if (!ctx) return "";
  const pages = ctx.pages ?? [];
  const campaign = ctx.utm ? campaignLine(ctx.utm) : undefined;
  const hasData =
    ctx.referrer || campaign || ctx.landingPath || pages.length > 0 || ctx.secondsOnSite != null;
  if (!hasData) return "";

  const build = (shownPages: string[], truncated: boolean): string => {
    const lines = [HEADER, `Found us via: ${ctx.referrer ?? "direct or unknown"}`];
    if (campaign) lines.push(campaign);
    if (ctx.landingPath) lines.push(`Landed on: ${ctx.landingPath}`);
    if (pages.length > 0) {
      const list = truncated ? [...shownPages, "…"] : shownPages;
      lines.push(`Pages viewed (${pages.length}): ${list.join(" → ")}`);
    }
    if (ctx.secondsOnSite != null) lines.push(`Time on site: ${formatDuration(ctx.secondsOnSite)}`);
    return lines.join("\n");
  };

  let block = build(pages, false);
  for (let keep = pages.length - 1; block.length > MAX_BLOCK_LENGTH && keep >= 0; keep--) {
    block = build(pages.slice(0, keep), true);
  }
  return block.length > MAX_BLOCK_LENGTH ? `${block.slice(0, MAX_BLOCK_LENGTH - 1)}…` : block;
}
