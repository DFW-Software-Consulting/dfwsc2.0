import type { BillingFormAnswer, BillingFormQuestion } from "./billing-request-mapping";
import { encodePathSegments, type NextcloudConfig, nextcloudRequest } from "./nextcloud";
import {
  NextcloudBadResponseError,
  ocsData,
  positiveInt,
  SUBMISSION_PAGE_SIZE,
} from "./sales-lead-nextcloud";

// Thin wrappers around the two Nextcloud APIs the "New invoice" form needs besides the results
// table (lib/portal-mirror-nextcloud.ts): Forms v3 and the OCS user groups lookup. Every call goes
// through nextcloudRequest (shared breaker, timeout) with a fixed, PII-free label.

const FORMS_BASE = "/ocs/v2.php/apps/forms/api/v3/forms";
const USERS_BASE = "/ocs/v2.php/cloud/users";

export interface BillingForm {
  questions: BillingFormQuestion[];
}

export interface BillingSubmission {
  id: number;
  userId: string | null;
  /** Unix seconds when the form was submitted; null when Nextcloud did not say. */
  submittedAt: number | null;
  answers: BillingFormAnswer[];
}

export class BillingRequestNextcloud {
  constructor(
    private readonly nc: NextcloudConfig,
    readonly formId: number
  ) {}

  /** One page of submission ids, newest first. */
  async listSubmissionIds(offset: number): Promise<number[]> {
    const label = "forms.list_submissions";
    const res = await nextcloudRequest(this.nc, {
      method: "GET",
      label,
      path: `${FORMS_BASE}/${this.formId}/submissions?limit=${SUBMISSION_PAGE_SIZE}&offset=${offset}&format=json`,
    });
    const data = ocsData(res.body, label) as { submissions?: { id?: unknown }[] };
    if (!Array.isArray(data.submissions)) throw new NextcloudBadResponseError(label);
    return data.submissions.map((s) => positiveInt(s.id, label));
  }

  async getForm(): Promise<BillingForm> {
    const label = "forms.get_form";
    const res = await nextcloudRequest(this.nc, {
      method: "GET",
      label,
      path: `${FORMS_BASE}/${this.formId}?format=json`,
    });
    const data = ocsData(res.body, label) as { questions?: { id?: unknown; name?: unknown }[] };
    if (!Array.isArray(data.questions)) throw new NextcloudBadResponseError(label);
    return {
      questions: data.questions.map((q) => ({
        id: positiveInt(q.id, label),
        name: typeof q.name === "string" ? q.name : "",
      })),
    };
  }

  /** The submission, or null when it was deleted. */
  async getSubmission(submissionId: number): Promise<BillingSubmission | null> {
    const label = "forms.get_submission";
    const res = await nextcloudRequest(this.nc, {
      method: "GET",
      label,
      path: `${FORMS_BASE}/${this.formId}/submissions/${submissionId}?format=json`,
      okStatuses: [404],
    });
    if (res.status === 404) return null;
    const data = ocsData(res.body, label) as {
      id?: unknown;
      userId?: unknown;
      timestamp?: unknown;
      answers?: { questionId?: unknown; text?: unknown }[];
    };
    if (!Array.isArray(data.answers)) throw new NextcloudBadResponseError(label);
    return {
      id: positiveInt(data.id, label),
      userId: typeof data.userId === "string" ? data.userId : null,
      submittedAt:
        typeof data.timestamp === "number" && Number.isFinite(data.timestamp) && data.timestamp > 0
          ? data.timestamp
          : null,
      answers: data.answers.map((a) => ({
        questionId: positiveInt(a.questionId, label),
        text: typeof a.text === "string" ? a.text : "",
      })),
    };
  }

  /**
   * Nextcloud groups of a user, or null when Nextcloud does not know the user (OCS answers 404).
   * Needs the service account to be an admin (dfwsc-admin is).
   */
  async getUserGroups(userId: string): Promise<string[] | null> {
    const label = "users.groups";
    const res = await nextcloudRequest(this.nc, {
      method: "GET",
      label,
      path: `${USERS_BASE}/${encodePathSegments([userId])}/groups?format=json`,
      okStatuses: [404],
    });
    if (res.status === 404) return null;
    const data = ocsData(res.body, label) as { groups?: unknown };
    if (!Array.isArray(data.groups)) throw new NextcloudBadResponseError(label);
    return data.groups.filter((g): g is string => typeof g === "string");
  }
}
