import { describe, it, expect } from "vitest";
import { parseEml } from "../src/services/document-parsers.js";

/**
 * BIGDATA-3B: an attachment with no file name is not dropped. Mailboxes are full of them: an
 * inline image of an HTML message (Content-ID, no name), a forwarded message sent as a
 * message/rfc822 part without a name. parseEml used to keep only attachments with a file name,
 * so these disappeared without a record; each now gets a name (attachment_<n> and an extension
 * from its type) and is ingested like any attachment.
 */
const eml = Buffer.from([
  "From: Jane Doe <jane.doe@example.com>",
  "To: John Roe <john.roe@example.org>",
  "Subject: Fictional message with unnamed parts",
  "Date: Thu, 4 Mar 2021 10:11:12 +0000",
  "Message-ID: <unnamed@example.com>",
  "MIME-Version: 1.0",
  'Content-Type: multipart/mixed; boundary="outer"',
  "",
  "--outer",
  'Content-Type: multipart/related; boundary="rel"',
  "",
  "--rel",
  "Content-Type: text/html; charset=utf-8",
  "",
  '<p>Fictional body with a logo <img src="cid:logo@example.com"></p>',
  "--rel",
  "Content-Type: image/png",
  "Content-Transfer-Encoding: base64",
  "Content-ID: <logo@example.com>",
  "",
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  "--rel--",
  "--outer",
  "Content-Type: message/rfc822",
  "",
  "From: Richard Roe <richard.roe@example.com>",
  "To: Jane Doe <jane.doe@example.com>",
  "Subject: Forwarded fictional note",
  "Date: Sat, 20 Feb 2021 09:00:00 +0000",
  "",
  "The forwarded fictional text.",
  "--outer",
  'Content-Type: application/pdf; name="named.pdf"',
  "Content-Disposition: attachment; filename=\"named.pdf\"",
  "Content-Transfer-Encoding: base64",
  "",
  Buffer.from("%PDF-1.4 fictional").toString("base64"),
  "--outer--",
  "",
].join("\r\n"));

describe("parseEml: attachments without a file name (BIGDATA-3B)", () => {
  it("keeps every attachment, naming the unnamed ones by their position and type", async () => {
    const r = await parseEml(eml);
    expect(r.attachments.map((a) => a.filename).sort()).toEqual(["attachment_1.png", "attachment_2.eml", "named.pdf"]);
    const fw = r.attachments.find((a) => a.filename === "attachment_2.eml")!;
    expect(fw.content.toString("utf8")).toContain("Subject: Forwarded fictional note");
    expect(r.attachments.find((a) => a.filename === "attachment_1.png")!.content.subarray(1, 4).toString("latin1")).toBe("PNG");
  });
});
