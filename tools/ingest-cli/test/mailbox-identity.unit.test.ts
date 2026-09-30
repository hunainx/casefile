import { describe, it, expect } from "vitest";
import { parseEml } from "../../../apps/api/src/services/document-parsers.js";
import { messageIdentity, addressesOf } from "../src/mailbox.js";

/**
 * BIGDATA-3B (D111): when two messages are the same message. Identity = Message-ID, Date (to the
 * second), From/To/Cc/Bcc addresses, Subject, body text and attachments (an attached email by
 * its own identity). Transport headers are not part of it; Message-ID alone does not decide it.
 */

const head = (extra: string[] = []) => [
  "From: Jane Doe <jane.doe@example.com>",
  "To: John Roe <john.roe@example.org>, Mary Major <mary.major@example.net>",
  "Subject: Fictional lease",
  "Date: Thu, 4 Mar 2021 10:11:12 +0000",
  "Message-ID: <lease-1@example.com>",
  ...extra,
];
const plain = (h: string[], body = "The fictional lease text.") => Buffer.from([...h, "Content-Type: text/plain; charset=utf-8", "", body, ""].join("\r\n"));
const id = async (b: Buffer) => messageIdentity(await parseEml(b));

function withAttachment(h: string[], name: string, type: string, content: string): Buffer {
  return Buffer.from([
    ...h, 'Content-Type: multipart/mixed; boundary="b1"', "", "--b1", "Content-Type: text/plain", "", "Body with an attachment.",
    "--b1", `Content-Type: ${type}; name="${name}"`, `Content-Disposition: attachment; filename="${name}"`, ...(type === "message/rfc822" ? [] : ["Content-Transfer-Encoding: base64"]), "",
    type === "message/rfc822" ? content : Buffer.from(content).toString("base64"), "--b1--", "",
  ].join("\r\n"));
}

describe("message identity (BIGDATA-3B)", () => {
  it("is the same for two copies that differ only in transport headers (Received, Status, Return-Path)", async () => {
    const a = plain(["Received: from mx.one.example.net; Thu, 4 Mar 2021 10:12:00 +0000", "Status: RO", ...head()]);
    const b = plain(["Return-Path: <jane.doe@example.com>", "Received: from mx.two.example.org; Thu, 4 Mar 2021 10:13:30 +0000", ...head(), "X-Mailer: another"]);
    expect(a.equals(b)).toBe(false);
    expect(await id(a)).toBe(await id(b));
  });

  it("ignores address case, display names and the order of recipients", async () => {
    const other = ["From: JANE.DOE@example.com", "To: mary.major@EXAMPLE.net, John <john.roe@example.org>", "Subject: Fictional lease", "Date: Thu, 04 Mar 2021 10:11:12 GMT", "Message-ID: <lease-1@example.com>"];
    expect(await id(plain(other))).toBe(await id(plain(head())));
    expect(addressesOf("B <b@x.example>, a@x.example; \"C, D\" <c@x.example>")).toEqual(["a@x.example", "b@x.example", "c@x.example"]);
  });

  it("differs when only the body differs, although the Message-ID is the same (Message-ID alone is not enough)", async () => {
    expect(await id(plain(head(), "Another fictional text."))).not.toBe(await id(plain(head())));
  });

  it("differs when one copy has a Bcc (the sender's copy) and the other has not", async () => {
    expect(await id(plain(head(["Bcc: Sam Poe <sam.poe@example.org>"])))).not.toBe(await id(plain(head())));
  });

  it("differs when the Date differs by a second, and ignores milliseconds", async () => {
    const later = head().map((l) => (l.startsWith("Date:") ? "Date: Thu, 4 Mar 2021 10:11:13 +0000" : l));
    expect(await id(plain(later))).not.toBe(await id(plain(head())));
  });

  it("is the same for two copies with no Message-ID and everything else equal (drafts)", async () => {
    const noId = head().filter((l) => !l.startsWith("Message-ID"));
    expect(await id(plain(noId))).toBe(await id(plain(noId)));
    expect(await id(plain(noId))).not.toBe(await id(plain(head())));
  });

  it("compares attachments by their bytes", async () => {
    const a = await id(withAttachment(head(), "a.txt", "text/plain", "fictional attachment"));
    expect(await id(withAttachment(head(), "renamed.txt", "text/plain", "fictional attachment"))).toBe(a);
    expect(await id(withAttachment(head(), "a.txt", "text/plain", "other fictional attachment"))).not.toBe(a);
  });

  it("compares an attached email by its own identity, not its bytes", async () => {
    const inner = (extra: string) => ["From: Richard Roe <richard.roe@example.com>", "To: jane.doe@example.com", "Subject: FW: survey", "Date: Sat, 20 Feb 2021 09:00:00 +0000", "Message-ID: <survey@example.org>", extra, "", "Fictional survey text.", ""].join("\r\n");
    const a = await id(withAttachment(head(), "fw.eml", "message/rfc822", inner("X-Copy: one")));
    expect(await id(withAttachment(head(), "fw.eml", "message/rfc822", inner("X-Copy: two, rendered elsewhere")))).toBe(a);
  });
});
