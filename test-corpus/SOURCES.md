# test-corpus — fixture provenance

Every file in this directory is **synthetic**. All people, companies, addresses, case
numbers, email addresses and amounts are invented ("Acme Holdings, LLC v. Example Corp.",
Jane Doe, John Roe, Mary Major, Richard Roe, 123 Example Street). Email domains use the
reserved `example.com` / `example.org` / `example.net` / `.example` names (RFC 2606).
Each document carries the line *"FICTIONAL DOCUMENT FOR SOFTWARE TESTING. ALL NAMES AND
FACTS ARE INVENTED."*

No third-party fixtures are used, so no external licence applies. The files were produced
by the generators in `generate/` and are covered by this repository's own licence.

| File | Generator | Property the tests rely on |
|---|---|---|
| `scanned-agreement.pdf` | `generate_fixtures.py` | 3 pages, each a raster image; no text layer (parses to 0 blocks → `needs_ocr`) |
| `text-transcript.pdf` | `generate_fixtures.py` | Real text layer, 120 pages, ~220,000 characters, >100 blocks (→ `indexed`) |
| `summary.docx` | `generate_fixtures.py` | Contains "DEPOSITION SUMMARY" and "Summary of Testimony", >1,000 characters |
| `workbook.xlsx` | `generate_fixtures.py` | Three sheets; first sheet contains "Purchase Price"; a sheet named "1031 Expenses" |
| `page.html` | `generate_fixtures.py` | Has `<script>` and `<style>`; visible text contains "Citrix Attachments" and "Example Wire Instructions.pdf" |
| `document.rtf` | `generate_fixtures.py` | RTF control words and `\par`; text contains "STIPULATION" and "referral" |
| `message.eml` | `generate_fixtures.py` | RFC 822, multipart with a PDF attachment, two To recipients, Message-ID, Date |
| `archive.zip` | `generate_fixtures.py` | Exactly two PDFs, `1.pdf` then `1-1.pdf`, >800,000 bytes uncompressed |
| `corrupt.pdf` | `generate_fixtures.py` | `%PDF-1.7` magic bytes followed by 4,096 bytes that are not a PDF |
| `legacy.doc` | `generate-doc.ps1` | Word 97-2003 binary; contains "ASSIGNMENT AND SUBSTITUTION" and "undersigned does hereby"; one primary footer ("Doe & Roe LLP - Example Footer Line") that must be indexed exactly once |
| `message.msg` | `generate-msg.ts` | Outlook [MS-OXMSG] compound file; sender, subject, Message-ID, one child attachment `image429c36.PNG` |
| `mailbox.mbox` | `generate-mailboxes.ts` | Six messages (LF line ends): M1 with a body line starting "From " (written `>From `), `bundle.zip` and an attached message; M2 the same message as another mailbox copy; M3 (June 2019) and M4 the same text sent again; M5 reusing M1's Message-ID with another body; M6 with a Bcc |
| `mailbox.pst` | `generate-mailboxes.ts` | Unicode PST, six messages in `Inbox/Projects` (M1 again), `Inbox/Q1/Q2 Reports` (Bcc, `figures.csv`, an embedded message), `Inbox/Case #12`, `Sent Items` (Bcc, `lease.pdf` attached by reference: no content), `Drafts` (the same draft twice, no Message-ID) |
| `mailbox-password.pst` | `generate-mailboxes.ts` | Unicode PST, one message; the store has a password (`PidTagPstPassword`) |

## Regenerating

From the repository root:

```bash
python test-corpus/generate/generate_fixtures.py        # needs reportlab, python-docx, openpyxl, Pillow
npx tsx test-corpus/generate/generate-msg.ts             # uses @kenjiuno/msgreader's CFB writer
powershell -ExecutionPolicy Bypass -File test-corpus/generate/generate-doc.ps1   # needs Microsoft Word (Windows)
npx tsx test-corpus/generate/generate-mailboxes.ts       # the .pst files need Windows (the fake-corpus PST writer)
```

`generate-mailboxes.ts` writes `mailbox.mbox` itself. The two `.pst` files are written by the
fake-corpus PST writer (`tools/fake-corpus/src/pst-writer.ts`, decision D114): a small C# program
built with the .NET Framework compiler that ships with Windows, on PSTFileFormat (LGPL-3.0-or-later)
and Microsoft's `Empty.pst` (MIT, from microsoft/outlook-pst-rs), both fetched at pinned commits into
a folder outside the repository. Neither is part of this repository. The PST library writes random
GUIDs and the current time, so a new run gives the same messages but not the same bytes.

`generate-doc.ps1` drives Word because the binary `.doc` format is only practical to
write with Word itself. It swaps Word's user name for a placeholder while saving and sets
`RemovePersonalInformation`, so the file carries no details of the generating machine.
`generate/msg-attachment.png` is the image embedded in `message.msg`, produced by
`generate_fixtures.py`.
