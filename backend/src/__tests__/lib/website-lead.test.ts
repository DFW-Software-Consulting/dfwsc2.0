import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WEBSITE_LEAD_CAP_MAX, WEBSITE_LEAD_CAP_WINDOW_MS } from "../../lib/constants";
import { resetNextcloudBreakerForTests } from "../../lib/nextcloud";
import {
  buildWebsiteLeadAnswers,
  type FormQuestion,
  SalesLeadConfigError,
} from "../../lib/sales-lead-mapping";
import {
  isWebsiteLeadEnabled,
  reserveWebsiteLeadSlot,
  resetWebsiteLeadCapForTests,
  submitWebsiteLead,
} from "../../lib/website-lead";
import { QUESTION_IDS, salesLeadEnv } from "../helpers/fake-nextcloud";

const contact = {
  company: "Acme Co",
  name: "Jane Doe",
  email: "jane@example.com",
  message: "Hello there",
};

const textQuestions = (): FormQuestion[] =>
  Object.entries(QUESTION_IDS).map(([text, id]) => ({ id, text, type: "short", options: [] }));

const withSource = (source: Partial<FormQuestion>): FormQuestion[] =>
  textQuestions().map((q) => (q.text === "Source" ? { ...q, ...source } : q));

describe("buildWebsiteLeadAnswers", () => {
  it("maps fields to question ids by title and sets Source text on a text question", () => {
    expect(buildWebsiteLeadAnswers(textQuestions(), contact)).toEqual({
      [QUESTION_IDS.Company]: ["Acme Co"],
      [QUESTION_IDS["Contact name"]]: ["Jane Doe"],
      [QUESTION_IDS.Email]: ["jane@example.com"],
      [QUESTION_IDS.Source]: ["Website"],
      [QUESTION_IDS.Notes]: ["Hello there"],
    });
  });

  it("picks the Website option id when Source is a dropdown", () => {
    const questions = withSource({
      type: "dropdown",
      options: [
        { id: 1, text: "Referral" },
        { id: 2, text: "Company WEBSITE" },
      ],
    });
    const answers = buildWebsiteLeadAnswers(questions, contact);
    expect(answers[QUESTION_IDS.Source]).toEqual([2]);
    expect(answers[QUESTION_IDS.Notes]).toEqual(["Hello there"]);
  });

  it("leaves a choice Source unset and prefixes Notes when there is no Website option", () => {
    const questions = withSource({ type: "dropdown", options: [{ id: 1, text: "Referral" }] });
    const answers = buildWebsiteLeadAnswers(questions, contact);
    expect(answers).not.toHaveProperty(String(QUESTION_IDS.Source));
    expect(answers[QUESTION_IDS.Notes]).toEqual(["Source: website contact form\n\nHello there"]);
  });

  it("prefixes Notes when the Source question is missing", () => {
    const questions = textQuestions().filter((q) => q.text !== "Source");
    const answers = buildWebsiteLeadAnswers(questions, contact);
    expect(answers[QUESTION_IDS.Notes]).toEqual(["Source: website contact form\n\nHello there"]);
  });

  it("skips optional questions that do not exist and never answers the others", () => {
    const questions = textQuestions().filter(
      (q) => !["Email", "Contact name", "Notes"].includes(q.text)
    );
    const answers = buildWebsiteLeadAnswers(questions, contact);
    expect(Object.keys(answers).sort()).toEqual(
      [String(QUESTION_IDS.Company), String(QUESTION_IDS.Source)].sort()
    );
  });

  it("matches titles with surrounding whitespace", () => {
    const questions = textQuestions().map((q) =>
      q.text === "Company" ? { ...q, text: " Company " } : q
    );
    expect(buildWebsiteLeadAnswers(questions, contact)[QUESTION_IDS.Company]).toEqual(["Acme Co"]);
  });

  it("throws a config error when the required Company question is missing", () => {
    const questions = textQuestions().filter((q) => q.text !== "Company");
    expect(() => buildWebsiteLeadAnswers(questions, contact)).toThrow(SalesLeadConfigError);
  });
});

describe("website lead submission", () => {
  const fetchMock = vi.fn();
  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
    resetNextcloudBreakerForTests();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("is enabled only when sales automation is ready", () => {
    expect(isWebsiteLeadEnabled(salesLeadEnv())).toBe(true);
    expect(isWebsiteLeadEnabled(salesLeadEnv({ SALES_AUTOMATION_ENABLED: "false" }))).toBe(false);
    expect(isWebsiteLeadEnabled(salesLeadEnv({ SALES_LEAD_FORM_ID: undefined }))).toBe(false);
  });

  it("reads the form, then POSTs answers to the submissions endpoint", async () => {
    fetchMock
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ ocs: { data: { questions: textQuestions() } } }))
      )
      .mockResolvedValueOnce(new Response(JSON.stringify({ ocs: { data: {} } }), { status: 201 }));
    await submitWebsiteLead(contact, salesLeadEnv());
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [url, init] = fetchMock.mock.calls[1];
    expect(url).toBe("https://cloud.test/ocs/v2.php/apps/forms/api/v3/forms/12/submissions");
    expect(init.method).toBe("POST");
    expect(init.headers["OCS-APIRequest"]).toBe("true");
    expect(JSON.parse(init.body).answers[String(QUESTION_IDS.Company)]).toEqual(["Acme Co"]);
  });

  it("fails without posting when the Company question is missing", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          ocs: { data: { questions: textQuestions().filter((q) => q.text !== "Company") } },
        })
      )
    );
    await expect(submitWebsiteLead(contact, salesLeadEnv())).rejects.toThrow(SalesLeadConfigError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("fails when Nextcloud rejects the submission", async () => {
    fetchMock
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ ocs: { data: { questions: textQuestions() } } }))
      )
      .mockResolvedValueOnce(new Response("no", { status: 403 }));
    await expect(submitWebsiteLead(contact, salesLeadEnv())).rejects.toThrow(/forms\.submit/);
  });

  it("refuses to run when automation is not configured", async () => {
    await expect(
      submitWebsiteLead(contact, salesLeadEnv({ SALES_AUTOMATION_ENABLED: "false" }))
    ).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("reserveWebsiteLeadSlot", () => {
  beforeEach(() => {
    resetWebsiteLeadCapForTests();
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    resetWebsiteLeadCapForTests();
  });

  it("allows the cap, refuses the next, and resumes once the window rolls over", () => {
    for (let i = 0; i < WEBSITE_LEAD_CAP_MAX; i++) expect(reserveWebsiteLeadSlot()).toBe(true);
    expect(reserveWebsiteLeadSlot()).toBe(false);
    vi.advanceTimersByTime(WEBSITE_LEAD_CAP_WINDOW_MS - 1);
    expect(reserveWebsiteLeadSlot()).toBe(false);
    vi.advanceTimersByTime(1);
    expect(reserveWebsiteLeadSlot()).toBe(true);
  });

  it("does not count refused attempts against the window", () => {
    for (let i = 0; i < WEBSITE_LEAD_CAP_MAX; i++) reserveWebsiteLeadSlot();
    vi.advanceTimersByTime(WEBSITE_LEAD_CAP_WINDOW_MS / 2);
    for (let i = 0; i < 5; i++) expect(reserveWebsiteLeadSlot()).toBe(false);
    vi.advanceTimersByTime(WEBSITE_LEAD_CAP_WINDOW_MS / 2);
    expect(reserveWebsiteLeadSlot()).toBe(true);
  });
});
