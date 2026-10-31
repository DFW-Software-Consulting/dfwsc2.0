import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetNextcloudBreakerForTests } from "../../lib/nextcloud";
import { isBadResponseError, SalesLeadNextcloud } from "../../lib/sales-lead-nextcloud";
import { loadSalesLeadConfig } from "../../lib/sales-lead-sync";
import { salesLeadEnv } from "../helpers/fake-nextcloud";

const api = new SalesLeadNextcloud(
  { baseUrl: "https://cloud.test", username: "dfwsc-admin", appPassword: "p" },
  {
    formId: 12,
    tableId: 8,
    addressbookPath: "dfwsc-sales_shared_by_messyginger0804",
    leadsFolder: ["DFWSC Sales", "Leads"],
  }
);

const fetchMock = vi.fn();
const respond = (body: string, status = 200) =>
  fetchMock.mockResolvedValueOnce(new Response(body, { status }));

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  resetNextcloudBreakerForTests();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

async function badResponseLabel(promise: Promise<unknown>) {
  const error = await promise.catch((e: unknown) => e);
  expect(isBadResponseError(error)).toBe(true);
  return (error as { label: string }).label;
}

describe("SalesLeadNextcloud requests", () => {
  it("lists submission ids from the OCS envelope, with paging parameters", async () => {
    respond(JSON.stringify({ ocs: { data: { submissions: [{ id: 9 }, { id: 8 }] } } }));
    expect(await api.listSubmissionIds(50)).toEqual([9, 8]);
    expect(fetchMock.mock.calls[0][0]).toBe(
      "https://cloud.test/ocs/v2.php/apps/forms/api/v3/forms/12/submissions?limit=50&offset=50&format=json"
    );
  });

  it("returns null for a deleted submission", async () => {
    respond("{}", 404);
    expect(await api.getSubmission(5)).toBeNull();
  });

  it("encodes the CardDAV and WebDAV paths", async () => {
    respond("", 201);
    await api.putContact("dfwsc-lead-12-5", "BEGIN:VCARD");
    respond("", 201);
    await api.createFolder("A&B (2)");
    expect(fetchMock.mock.calls.map((c) => c[0])).toEqual([
      "https://cloud.test/remote.php/dav/addressbooks/users/dfwsc-admin/dfwsc-sales_shared_by_messyginger0804/dfwsc-lead-12-5.vcf",
      "https://cloud.test/remote.php/dav/files/dfwsc-admin/DFWSC%20Sales/Leads/A%26B%20(2)",
    ]);
  });

  it("accepts an existing contact (412) and an existing folder (405)", async () => {
    respond("", 412);
    await expect(api.putContact("u", "x")).resolves.toBeUndefined();
    respond("", 405);
    await expect(api.createFolder("Acme")).resolves.toBeUndefined();
  });

  it("reads the file id from a PROPFIND answer with any namespace prefix", async () => {
    respond("<d:multistatus><x:fileid> 321 </x:fileid></d:multistatus>", 207);
    expect(await api.getFileId("Acme")).toBe(321);
  });

  it("finds a row by a cell value across pages", async () => {
    const page = (start: number, n: number) =>
      JSON.stringify(
        Array.from({ length: n }, (_, i) => ({
          id: start + i,
          data: [{ columnId: 14, value: `12:${start + i}` }],
        }))
      );
    respond(page(1, 200));
    respond(page(201, 10));
    expect(await api.findRowId(14, "12:205")).toBe(205);
    respond(page(1, 3));
    expect(await api.findRowId(14, "12:999")).toBeNull();
  });

  it("refuses to scan a table larger than it was built for", async () => {
    const full = JSON.stringify(Array.from({ length: 200 }, (_, i) => ({ id: i + 1, data: [] })));
    fetchMock.mockImplementation(async () => new Response(full));
    expect(await badResponseLabel(api.findRowId(14, "x"))).toBe("tables.list_rows");
  });

  it("builds links for the owner-side address book and the folder id", () => {
    expect(api.contactLink("dfwsc-lead-12-5")).toBe(
      "https://cloud.test/index.php/apps/contacts/direct/contact/dfwsc-lead-12-5~dfwsc-sales"
    );
    expect(api.folderLink(77)).toBe("https://cloud.test/index.php/f/77");
  });
});

describe("SalesLeadNextcloud unexpected responses", () => {
  it.each([
    ["not json", () => api.listSubmissionIds(0), "forms.list_submissions"],
    [JSON.stringify({ ocs: {} }), () => api.listSubmissionIds(0), "forms.list_submissions"],
    [
      JSON.stringify({ ocs: { data: {} } }),
      () => api.listSubmissionIds(0),
      "forms.list_submissions",
    ],
    [
      JSON.stringify({ ocs: { data: { submissions: [{ id: "7" }] } } }),
      () => api.listSubmissionIds(0),
      "forms.list_submissions",
    ],
    [JSON.stringify({ ocs: { data: {} } }), () => api.getQuestions(), "forms.get_form"],
    [
      JSON.stringify({ ocs: { data: { id: 5 } } }),
      () => api.getSubmission(5),
      "forms.get_submission",
    ],
    [JSON.stringify({}), () => api.getColumns(), "tables.columns"],
    [JSON.stringify({}), () => api.findRowId(1, "x"), "tables.list_rows"],
    [JSON.stringify({ id: 0 }), () => api.createRow({}), "tables.create_row"],
    ["<d:multistatus/>", () => api.getFileId("A"), "webdav.fileid"],
  ])("%s", async (body, call, label) => {
    respond(body, 200);
    expect(await badResponseLabel(call())).toBe(label);
  });

  it("defaults a question without text and an answer without text to empty strings", async () => {
    respond(JSON.stringify({ ocs: { data: { questions: [{ id: 3 }] } } }));
    expect(await api.getQuestions()).toEqual([{ id: 3, text: "" }]);
    respond(JSON.stringify({ ocs: { data: { id: 5, answers: [{ questionId: 3 }] } } }));
    expect(await api.getSubmission(5)).toEqual({ id: 5, answers: [{ questionId: 3, text: "" }] });
  });
});

describe("loadSalesLeadConfig", () => {
  it("is disabled unless the flag is exactly true", () => {
    for (const flag of [undefined, "", "false", "1", "TRUE"]) {
      expect(loadSalesLeadConfig(salesLeadEnv({ SALES_AUTOMATION_ENABLED: flag }))).toEqual({
        status: "disabled",
      });
    }
  });

  it("is ready with a full config, splitting the folder path", () => {
    const result = loadSalesLeadConfig(
      salesLeadEnv({ SALES_LEADS_FOLDER: "/DFWSC Sales//Leads/", SALES_POLL_INTERVAL_MS: "60000" })
    );
    expect(result).toMatchObject({
      status: "ready",
      settings: {
        formId: 12,
        tableId: 8,
        addressbookPath: "dfwsc-sales_shared_by_messyginger0804",
        leadsFolder: ["DFWSC Sales", "Leads"],
        pollIntervalMs: 60000,
      },
    });
    expect(loadSalesLeadConfig(salesLeadEnv())).toMatchObject({
      settings: { pollIntervalMs: 120000 },
    });
  });

  it("names every invalid variable, never its value", () => {
    const result = loadSalesLeadConfig(
      salesLeadEnv({
        NEXTCLOUD_APP_PASSWORD: undefined,
        SALES_LEAD_FORM_ID: "0",
        SALES_PIPELINE_TABLE_ID: "8x",
        SALES_ADDRESSBOOK_PATH: "a/b",
        SALES_LEADS_FOLDER: "DFWSC Sales/../Leads",
        SALES_POLL_INTERVAL_MS: "1000",
      })
    );
    expect(result.status).toBe("invalid");
    const problems = (result as { problems: string[] }).problems.join("\n");
    for (const name of [
      "NEXTCLOUD_APP_PASSWORD",
      "SALES_LEAD_FORM_ID",
      "SALES_PIPELINE_TABLE_ID",
      "SALES_ADDRESSBOOK_PATH",
      "SALES_LEADS_FOLDER",
      "SALES_POLL_INTERVAL_MS",
    ]) {
      expect(problems).toContain(name);
    }
    expect(problems).not.toContain("a/b");
  });

  it("rejects a non-https Nextcloud URL and an empty folder", () => {
    const result = loadSalesLeadConfig(
      salesLeadEnv({ NEXTCLOUD_BASE_URL: "http://cloud.test", SALES_LEADS_FOLDER: " / " })
    );
    expect(result).toMatchObject({ status: "invalid" });
    expect((result as { problems: string[] }).problems).toEqual([
      "NEXTCLOUD_BASE_URL must be a valid https:// URL",
      "SALES_LEADS_FOLDER must be a folder path without . or ..",
    ]);
  });
});
