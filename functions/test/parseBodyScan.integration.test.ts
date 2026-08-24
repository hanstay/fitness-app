// Emulator-backed: parseBodyScan has no separately-exported core function
// (unlike the other three generators), so this invokes the onCall handler's
// own `.run({auth, data})` — the documented way to exercise a v2 callable
// directly in tests. Both the LLM boundary and the Storage PDF download are
// mocked, so this suite stays Firestore-emulator-only (no Storage emulator,
// no real PDF fixture needed). See functions/test/README.md.
import { vi, describe, it, expect, beforeEach } from "vitest";
import { getTestDb, clearFirestoreEmulator } from "./helpers/emulatorFirestore";
import { defaultFixtureResponse } from "./fixtures/llmFixtures";
import { parseBodyScan } from "../src/scans/parseBodyScan";

const mockExtractStructuredJson = vi.hoisted(() => vi.fn());
vi.mock("../src/lib/claude", () => ({
  extractStructuredJson: mockExtractStructuredJson,
  MODEL: "claude-sonnet-4-5-20250929",
}));

const mockDownload = vi.hoisted(() => vi.fn(async () => [Buffer.from("fake pdf bytes")]));
vi.mock("firebase-admin/storage", () => ({
  getStorage: () => ({ bucket: () => ({ file: () => ({ download: mockDownload }) }) }),
}));

const db = getTestDb();
const UID = "s1";

beforeEach(async () => {
  await clearFirestoreEmulator();
  mockExtractStructuredJson.mockReset();
  mockExtractStructuredJson.mockImplementation(defaultFixtureResponse);
  mockDownload.mockClear();
});

describe("parseBodyScan", () => {
  it("scenario 1: happy path downloads the PDF, extracts, and writes the scan doc", async () => {
    const result = await parseBodyScan.run({
      auth: { uid: UID } as never,
      data: { scanId: "scan1", storagePath: `users/${UID}/bodyscans/scan1.pdf` },
      rawRequest: {} as never,
    });

    expect(mockDownload).toHaveBeenCalled();
    expect(mockExtractStructuredJson).toHaveBeenCalledWith(expect.objectContaining({ toolName: "record_body_scan" }));

    const doc = await db.doc(`users/${UID}/bodyScans/scan1`).get();
    expect(doc.exists).toBe(true);
    expect(doc.data()?.confirmedByUser).toBe(false);
    expect(doc.data()?.extracted.weight_kg).toBe((result as { extracted: { weight_kg: number } }).extracted.weight_kg);
  });

  it("scenario 2: a storagePath outside the caller's own uploads is rejected before any Storage/LLM call", async () => {
    await expect(
      parseBodyScan.run({
        auth: { uid: UID } as never,
        data: { scanId: "scan1", storagePath: `users/someone-else/bodyscans/scan1.pdf` },
        rawRequest: {} as never,
      })
    ).rejects.toThrow();

    expect(mockDownload).not.toHaveBeenCalled();
    expect(mockExtractStructuredJson).not.toHaveBeenCalled();
  });
});
