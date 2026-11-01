import { FakeTablesNextcloud, MIRROR_NC_URL, MIRROR_NC_USER } from "./fake-nextcloud-tables";

// In-memory Nextcloud for the "New invoice" form tests: Forms v3 (form, submissions), the OCS
// user groups lookup, and (inherited) Tables v1 for the "Billing Requests" results table.
// Install with vi.stubGlobal("fetch", vi.fn(fake.fetch)).

export const BR_FORM_ID = 7;
export const BR_WEBHOOK_SECRET = "billing-request-secret-0123456789abcdefghij";
export const BR_FORM_QUESTIONS = {
  client_code: 301,
  company: 302,
  kind: 303,
  description: 304,
  amount_usd: 305,
  interval: 306,
  payments: 307,
  start_date: 308,
  memo: 309,
} as const;
export type BillingAnswers = Partial<Record<keyof typeof BR_FORM_QUESTIONS, string>>;

export const billingRequestEnv = (overrides: Record<string, string | undefined> = {}) =>
  ({
    BILLING_REQUESTS_ENABLED: "true",
    NEXTCLOUD_BASE_URL: MIRROR_NC_URL,
    NEXTCLOUD_USERNAME: MIRROR_NC_USER,
    NEXTCLOUD_APP_PASSWORD: "app-password-for-tests",
    BILLING_REQUESTS_FORM_ID: String(BR_FORM_ID),
    BILLING_REQUESTS_WEBHOOK_SECRET: BR_WEBHOOK_SECRET,
    ...overrides,
  }) as NodeJS.ProcessEnv;

interface StoredSubmission {
  userId: string | null;
  timestamp: number;
  answers: { questionId: number; text: string }[];
}
interface FormFault {
  match: RegExp;
  status: number;
  times: number;
}

const FORMS = `/ocs/v2.php/apps/forms/api/v3/forms/${BR_FORM_ID}`;
const ocs = (data: unknown, status = 200) =>
  new Response(JSON.stringify({ ocs: { meta: { status: "ok" }, data } }), {
    status,
    headers: { "content-type": "application/json" },
  });

export class FakeBillingRequestNextcloud extends FakeTablesNextcloud {
  /** Technical names of the form's questions (extra, unknown ones can be pushed). */
  formQuestions: { id: number; name: string }[] = Object.entries(BR_FORM_QUESTIONS).map(
    ([name, id]) => ({ id, name })
  );
  submissions = new Map<number, StoredSubmission>();
  /** Nextcloud user id to group ids. An unknown user answers 404, like OCS. */
  users = new Map<string, string[]>([
    ["alice", ["dfwsc-admins"]],
    ["mallory", ["staff"]],
    ["mia", ["managers", "staff"]],
  ]);
  formCalls: { method: string; path: string }[] = [];
  private formFaults: FormFault[] = [];

  constructor() {
    super();
    const tables = this.fetch;
    this.fetch = async (input, init = {}) => {
      const url = new URL(typeof input === "string" ? input : input.toString());
      const method = (init.method ?? "GET").toUpperCase();
      const path = url.pathname;
      const isForms = path.startsWith(FORMS);
      const groups = /^\/ocs\/v2\.php\/cloud\/users\/([^/]+)\/groups$/.exec(path);
      if (!isForms && !groups) return tables(input, init);
      this.formCalls.push({ method, path });
      const fault = this.formFaults.find((f) => f.match.test(path) && f.times > 0);
      if (fault) {
        fault.times -= 1;
        return ocs({}, fault.status);
      }
      if (groups) {
        const list = this.users.get(decodeURIComponent(groups[1]));
        return list ? ocs({ groups: list }) : ocs({}, 404);
      }
      if (method === "GET" && path === `${FORMS}/submissions`) {
        const offset = Number(url.searchParams.get("offset") ?? 0);
        const limit = Number(url.searchParams.get("limit") ?? 50);
        const ids = [...this.submissions.keys()].sort((a, b) => b - a);
        return ocs({ submissions: ids.slice(offset, offset + limit).map((id) => ({ id })) });
      }
      const single = new RegExp(`^${FORMS}/submissions/(\\d+)$`).exec(path);
      if (method === "GET" && single) {
        const id = Number(single[1]);
        const s = this.submissions.get(id);
        if (!s) return ocs({}, 404);
        return ocs({ id, userId: s.userId, timestamp: s.timestamp, answers: s.answers });
      }
      if (method === "GET" && path === FORMS)
        return ocs({ id: BR_FORM_ID, questions: this.formQuestions });
      return ocs({}, 404);
    };
  }

  /** The next `times` Forms/users requests whose path matches answer `status`. */
  failForms(match: RegExp, status: number, times = 1) {
    this.formFaults.push({ match, status, times });
  }

  addSubmission(
    id: number,
    answers: BillingAnswers,
    options: { userId?: string | null; timestamp?: number; extra?: [number, string][] } = {}
  ) {
    const mapped = Object.entries(answers).map(([name, text]) => ({
      questionId: BR_FORM_QUESTIONS[name as keyof typeof BR_FORM_QUESTIONS],
      text: text as string,
    }));
    for (const [questionId, text] of options.extra ?? []) mapped.push({ questionId, text });
    this.submissions.set(id, {
      userId: options.userId === undefined ? "alice" : options.userId,
      timestamp: options.timestamp ?? Math.floor(Date.now() / 1000),
      answers: mapped,
    });
  }
}
