"""
Regenerates the synthetic parser fixtures in test-corpus/.

Every name, company, address, case number and figure in these files is fictional.
Run from the repository root:

    python test-corpus/generate/generate_fixtures.py

Requires: reportlab, python-docx, openpyxl, Pillow.
legacy.doc and message.msg are produced by generate-doc.ps1 and generate-msg.ts.
"""

import io
import random
import zipfile
from email.message import EmailMessage
from email.utils import format_datetime
from datetime import datetime, timezone
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter, ImageFont
from reportlab.lib.pagesizes import letter
from reportlab.lib.utils import ImageReader
from reportlab.pdfgen import canvas
from docx import Document
from openpyxl import Workbook

OUT = Path(__file__).resolve().parent.parent
FICTION = "FICTIONAL DOCUMENT FOR SOFTWARE TESTING. ALL NAMES AND FACTS ARE INVENTED."
rng = random.Random(20260925)


def _pdf_metadata(c: canvas.Canvas, title: str) -> None:
    c.setAuthor("Jane Doe")
    c.setTitle(title)
    c.setSubject(FICTION)
    c.setCreator("casefile test-corpus generator")
    c.setProducer("casefile test-corpus generator")


# ── text-transcript.pdf: real text layer, >100 pages, >100,000 chars ─────────

QUESTIONS = [
    "Please state your name for the record.",
    "Where were you employed in the spring of the year in question?",
    "Did you review the shipping ledger before the meeting at 123 Example Street?",
    "Who else attended the meeting with Example Corp.?",
    "What did Mr. Roe say about the widget inventory?",
    "Did Acme Holdings receive the invoice for the second shipment?",
    "When did you first learn that the pallets were short?",
    "Can you identify the document marked as Exhibit 14?",
    "Did anyone instruct you to change the delivery dates?",
    "How many widgets were in the warehouse on the first of the month?",
    "Did you send that email to Mary Major?",
    "What was the purpose of the wire transfer to the Sample County account?",
]
ANSWERS = [
    "Jane Doe. D-O-E.",
    "I worked in the purchasing department at Acme Holdings, LLC.",
    "Yes, I reviewed it the morning before, at my desk.",
    "John Roe and Mary Major were there, and someone from accounting.",
    "He said the count did not match the ledger and he would look into it.",
    "I believe so, but I would have to check the accounts payable file.",
    "I think it was about two weeks after the delivery.",
    "Yes. That is the purchase order for the blue widgets.",
    "No. Nobody asked me to do that.",
    "I don't recall the exact number. It was several thousand.",
    "I may have. I sent a lot of emails that week.",
    "My understanding was that it was a deposit for the next order.",
    "Objection. Form. You can answer.",
    "I don't know. You would have to ask Mr. Roe.",
]


def text_transcript() -> None:
    path = OUT / "text-transcript.pdf"
    c = canvas.Canvas(str(path), pagesize=letter)
    _pdf_metadata(c, "Deposition of Jane Doe - Acme Holdings v. Example Corp.")
    width, height = letter
    pages = 120
    for page in range(1, pages + 1):
        c.setFont("Helvetica-Bold", 9)
        c.drawString(72, height - 40, "ACME HOLDINGS, LLC v. EXAMPLE CORP.   Case No. 00-CV-0000   Deposition of Jane Doe")
        c.drawRightString(width - 72, height - 40, f"Page {page}")
        c.setFont("Helvetica", 7)
        c.drawString(72, 30, FICTION)
        c.setFont("Courier", 10)
        y = height - 72
        if page == 1:
            header = [
                "IN THE SUPERIOR COURT OF THE STATE OF EXAMPLE",
                "IN AND FOR THE COUNTY OF SAMPLE",
                "",
                "ACME HOLDINGS, LLC, Plaintiff,",
                "        v.                                   Case No. 00-CV-0000",
                "EXAMPLE CORP., Defendant.",
                "",
                "VIDEOTAPED DEPOSITION OF JANE DOE",
                "Taken at 123 Example Street, Suite 400, Sampletown, EX 00000",
                "",
            ]
            for line in header:
                c.drawString(72, y, line)
                y -= 14
        line_no = 1
        while y > 60 and line_no <= 25:
            if line_no % 2 == 1:
                text = "Q.  " + rng.choice(QUESTIONS)
            else:
                text = "A.  " + rng.choice(ANSWERS)
            # Pad with a deterministic continuation so each page carries ~1,500 characters.
            text += " " + rng.choice(["(Pause.)", "Okay.", "Go ahead.", "Understood.", ""])
            c.drawString(60, y, f"{line_no:>2}")
            c.drawString(90, y, text[:88])
            if len(text) > 88:
                y -= 14
                c.drawString(90, y, text[88:])
            y -= 22
            line_no += 1
        c.showPage()
    c.save()


# ── scanned-agreement.pdf: image-only pages, no text layer ───────────────────

AGREEMENT_PAGES = [
    [
        "SERVICES AGREEMENT",
        "",
        "This Services Agreement is made between Acme Holdings, LLC,",
        "123 Example Street, Sampletown, EX 00000 (\"Acme\"), and",
        "Example Corp., 456 Sample Avenue, Exampleville, EX 00000.",
        "",
        "1. Services. Example Corp. shall supply widget warehousing",
        "   services as described in Schedule A.",
        "2. Term. This Agreement runs for twelve (12) months.",
        "3. Fees. Acme shall pay the fees set out in Schedule B.",
    ],
    [
        "4. Confidentiality. Each party shall keep the other party's",
        "   information confidential.",
        "5. Governing Law. The laws of the State of Example apply.",
        "",
        "IN WITNESS WHEREOF the parties have executed this Agreement.",
        "",
        "ACME HOLDINGS, LLC            EXAMPLE CORP.",
        "By: Jane Doe                  By: John Roe",
        "Title: Manager                Title: President",
    ],
    [
        "SCHEDULE A - SERVICES",
        "",
        "Storage of up to 10,000 widgets at the Sampletown warehouse.",
        "Weekly inventory counts delivered to Mary Major.",
        "",
        "SCHEDULE B - FEES",
        "",
        "Monthly storage fee: $1,000.00",
        "Per-pallet handling fee: $10.00",
    ],
]


def _scan_image(lines: list[str]) -> Image.Image:
    img = Image.new("L", (1275, 1650), 250)
    draw = ImageDraw.Draw(img)
    font = ImageFont.load_default(size=30)
    small = ImageFont.load_default(size=18)
    y = 150
    for line in lines:
        draw.text((130, y), line, fill=25, font=font)
        y += 52
    draw.text((130, 1560), FICTION, fill=90, font=small)
    # Scanner artefacts: slight skew, blur and speckle.
    img = img.rotate(0.6, fillcolor=250, resample=Image.BICUBIC)
    img = img.filter(ImageFilter.GaussianBlur(0.6))
    px = img.load()
    for _ in range(4000):
        x, yy = rng.randrange(img.width), rng.randrange(img.height)
        px[x, yy] = rng.choice([40, 120, 200])
    return img


def scanned_agreement() -> None:
    path = OUT / "scanned-agreement.pdf"
    c = canvas.Canvas(str(path), pagesize=letter)
    _pdf_metadata(c, "Scanned Services Agreement - Acme Holdings / Example Corp.")
    width, height = letter
    for lines in AGREEMENT_PAGES:
        buf = io.BytesIO()
        _scan_image(lines).save(buf, format="JPEG", quality=60)
        buf.seek(0)
        c.drawImage(ImageReader(buf), 0, 0, width=width, height=height)
        c.showPage()
    c.save()


# ── summary.docx ─────────────────────────────────────────────────────────────

def summary_docx() -> None:
    doc = Document()
    doc.core_properties.author = "Jane Doe"
    doc.core_properties.last_modified_by = "Jane Doe"
    doc.core_properties.title = "Deposition Summary - John Roe"
    doc.core_properties.comments = FICTION
    doc.add_heading("DEPOSITION SUMMARY", level=0)
    doc.add_paragraph("Acme Holdings, LLC v. Example Corp., Case No. 00-CV-0000")
    doc.add_paragraph("Deponent: John Roe, President of Example Corp.")
    doc.add_paragraph("Taken at 123 Example Street, Sampletown, EX 00000")
    doc.add_paragraph(FICTION)
    doc.add_heading("Summary of Testimony", level=1)
    topics = [
        ("Background", "Mr. Roe testified that he founded Example Corp. and has served as its president since the company was formed. He oversees warehousing and has no role in purchasing."),
        ("The Services Agreement", "Mr. Roe identified the Services Agreement with Acme Holdings, LLC and confirmed his signature. He stated the agreement was negotiated with Jane Doe over several weeks."),
        ("Inventory Counts", "Mr. Roe testified that weekly inventory counts were sent to Mary Major. He could not explain why the count for the third week did not match the shipping ledger."),
        ("The Wire Transfer", "Mr. Roe stated that he believed the wire to the Sample County account was a deposit for a future order. He did not review the wire instructions himself."),
        ("Document Retention", "Mr. Roe testified that Example Corp. keeps warehouse records for seven years and that no records relating to Acme were destroyed."),
    ]
    for heading, body in topics:
        doc.add_heading(heading, level=2)
        doc.add_paragraph(body)
        doc.add_paragraph(
            "Counsel for Acme Holdings asked follow-up questions on this topic; the answers were "
            "consistent with the testimony summarised above and are recorded in the full transcript."
        )
    doc.save(OUT / "summary.docx")


# ── workbook.xlsx (multiple sheets) ──────────────────────────────────────────

def workbook_xlsx() -> None:
    wb = Workbook()
    wb.properties.creator = "Jane Doe"
    wb.properties.lastModifiedBy = "Jane Doe"
    wb.properties.description = FICTION
    ws = wb.active
    ws.title = "Closing Statement"
    ws.append(["Closing Statement - 123 Example Street, Sampletown, EX 00000"])
    ws.append(["Buyer", "Acme Holdings, LLC"])
    ws.append(["Seller", "Example Corp."])
    ws.append([])
    ws.append(["Item", "Debit", "Credit"])
    ws.append(["Purchase Price", 1000000, None])
    ws.append(["Earnest Money Deposit", None, 50000])
    ws.append(["Title Insurance", 2500, None])
    ws.append(["Recording Fees", 150, None])
    ws.append(["Balance Due from Buyer", None, 952650])

    ws2 = wb.create_sheet("1031 Expenses")
    ws2.append(["Date", "Payee", "Description", "Amount"])
    ws2.append(["2026-01-05", "Sample Title Co.", "Exchange accommodator fee", 1200])
    ws2.append(["2026-01-12", "Example Appraisals", "Replacement property appraisal", 650])
    ws2.append(["2026-01-20", "Doe & Roe LLP", "Legal review of exchange documents", 3400])
    ws2.append(["Total", None, None, 5250])

    ws3 = wb.create_sheet("Notes")
    ws3.append([FICTION])
    ws3.append(["Prepared by Jane Doe for Acme Holdings, LLC."])
    wb.save(OUT / "workbook.xlsx")


# ── page.html (with <script> and <style>) ────────────────────────────────────

def page_html() -> None:
    html = """<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Example Secure File Share - Shared Files</title>
<style>
  body { font-family: Arial, sans-serif; margin: 2em; color: #222; }
  .file { padding: 0.4em 0; border-bottom: 1px solid #ddd; }
  .banner { background: #eef; padding: 0.5em; }
</style>
<script>
  // Tracking stub from the fictional file-share vendor. Must not appear in extracted text.
  window.exampleShare = { sessionId: "00000000-0000-0000-0000-000000000000" };
  function onDownload(name) { console.log("download", name); }
</script>
</head>
<body>
<div class="banner">""" + FICTION + """</div>
<div class="title"><strong>Citrix Attachments</strong></div>
<p>Jane Doe (jane.doe@acme-holdings.example) has shared 3 files with you from
Acme Holdings, LLC, 123 Example Street, Sampletown, EX 00000.</p>
<div class="file"><a href="#" onclick="onDownload('Example Wire Instructions.pdf')">Example Wire Instructions.pdf</a>
  <span>Example Widget Distributors - wire instructions for the deposit (48 KB)</span></div>
<div class="file"><a href="#" onclick="onDownload('Purchase Order 0001.pdf')">Purchase Order 0001.pdf</a>
  <span>Purchase order for blue widgets (112 KB)</span></div>
<div class="file"><a href="#" onclick="onDownload('Inventory Count Week 3.xlsx')">Inventory Count Week 3.xlsx</a>
  <span>Weekly inventory count sent to Mary Major (20 KB)</span></div>
<p>These links expire in 7 days. Questions? Contact John Roe at john.roe@example.com.</p>
</body>
</html>
"""
    (OUT / "page.html").write_text(html, encoding="utf-8", newline="\n")


# ── document.rtf ─────────────────────────────────────────────────────────────

def document_rtf() -> None:
    paras = [
        r"{\b\fs28 IN THE SUPERIOR COURT OF THE STATE OF EXAMPLE}",
        r"{\b\fs28 COUNTY OF SAMPLE}",
        r"ACME HOLDINGS, LLC, Plaintiff, v. EXAMPLE CORP., Defendant. Case No. 00-CV-0000",
        r"{\b STIPULATION FOR REFERRAL TO MEDIATION}",
        r"The parties, by their undersigned counsel, stipulate as follows:",
        r"1. The parties agree to the referral of this action to mediation before a mutually acceptable mediator.",
        r"2. Mediation shall be completed within ninety (90) days of the date of this stipulation.",
        r"3. The costs of mediation shall be shared equally between Acme Holdings, LLC and Example Corp.",
        r"4. All discovery deadlines are stayed pending the outcome of the referral.",
        r"Dated: January 15, 2026",
        r"Jane Doe, Doe & Roe LLP, 123 Example Street, Sampletown, EX 00000, Counsel for Plaintiff",
        r"John Roe, Roe Legal Group, 456 Sample Avenue, Exampleville, EX 00000, Counsel for Defendant",
        r"{\i " + FICTION + "}",
    ]
    body = "\n".join(p + r"\par" for p in paras)
    rtf = (
        r"{\rtf1\ansi\ansicpg1252\deff0"
        r"{\fonttbl{\f0\froman\fcharset0 Times New Roman;}{\f1\fswiss\fcharset0 Arial;}}"
        r"{\colortbl;\red0\green0\blue0;}"
        r"{\info{\title Stipulation for Referral to Mediation}{\author Jane Doe}{\operator Jane Doe}"
        r"{\company Doe & Roe LLP}}"
        "\n\\f0\\fs24\n" + body + "\n}"
    )
    (OUT / "document.rtf").write_text(rtf, encoding="ascii", newline="\n")


# ── message.eml (with attachment) ────────────────────────────────────────────

def _small_pdf(title: str, lines: list[str], compress: bool = True) -> bytes:
    buf = io.BytesIO()
    c = canvas.Canvas(buf, pagesize=letter, pageCompression=1 if compress else 0)
    _pdf_metadata(c, title)
    c.setFont("Helvetica", 11)
    y = letter[1] - 72
    for line in lines:
        c.drawString(72, y, line)
        y -= 16
    c.showPage()
    c.save()
    return buf.getvalue()


def message_eml() -> None:
    msg = EmailMessage()
    msg["From"] = "Jane Doe <jane.doe@acme-holdings.example>"
    msg["To"] = "John Roe <john.roe@example.com>, Mary Major <mary.major@example.org>"
    msg["Cc"] = "Richard Roe <richard.roe@example.net>"
    msg["Subject"] = "Acme v. Example Corp. - revised term sheet"
    msg["Date"] = format_datetime(datetime(2026, 1, 14, 16, 30, tzinfo=timezone.utc))
    msg["Message-ID"] = "<20260114163000.0001@acme-holdings.example>"
    msg.set_content(
        "John, Mary,\n\n"
        "Attached is the revised term sheet for the widget warehousing dispute. The main change is "
        "the payment schedule in section 3. Please let me know by Friday whether Example Corp. can "
        "accept these terms.\n\n"
        "Regards,\nJane Doe\nAcme Holdings, LLC\n123 Example Street, Sampletown, EX 00000\n\n"
        + FICTION + "\n"
    )
    attachment = _small_pdf(
        "Revised Term Sheet",
        ["REVISED TERM SHEET", "Acme Holdings, LLC and Example Corp.", "", "1. Settlement amount: $10,000.00",
         "2. Release of all claims relating to the widget shipments", "3. Payment in two instalments", "", FICTION],
    )
    msg.add_attachment(attachment, maintype="application", subtype="pdf", filename="Revised Term Sheet.pdf")
    (OUT / "message.eml").write_bytes(msg.as_bytes(policy=msg.policy.clone(linesep="\r\n")))


# ── archive.zip (two PDFs) ───────────────────────────────────────────────────

def _exhibit_pdf(title: str, pages: int) -> bytes:
    buf = io.BytesIO()
    # Uncompressed page streams so the archive's uncompressed size is realistic while the
    # zip itself stays small.
    c = canvas.Canvas(buf, pagesize=letter, pageCompression=0)
    _pdf_metadata(c, title)
    for p in range(1, pages + 1):
        c.setFont("Helvetica-Bold", 12)
        c.drawString(72, letter[1] - 60, f"{title} - page {p}")
        c.setFont("Helvetica", 9)
        y = letter[1] - 90
        for row in range(1, 46):
            c.drawString(72, y, f"Line {row:02d}: Widget lot {p:03d}-{row:02d} stored at 123 Example Street for Acme Holdings, LLC.")
            y -= 14
        c.drawString(72, 30, FICTION)
        c.showPage()
    c.save()
    return buf.getvalue()


def archive_zip() -> None:
    a = _exhibit_pdf("Exhibit A - Warehouse Receipts", 75)
    b = _exhibit_pdf("Exhibit B - Shipping Ledger", 75)
    with zipfile.ZipFile(OUT / "archive.zip", "w", compression=zipfile.ZIP_DEFLATED) as z:
        for name, data in (("1.pdf", a), ("1-1.pdf", b)):
            info = zipfile.ZipInfo(name, date_time=(2026, 1, 1, 0, 0, 0))
            info.compress_type = zipfile.ZIP_DEFLATED
            z.writestr(info, data)


# ── corrupt.pdf ──────────────────────────────────────────────────────────────

def corrupt_pdf() -> None:
    # PDF magic bytes so it routes to the PDF parser, followed by bytes that are not a PDF.
    (OUT / "corrupt.pdf").write_bytes(b"%PDF-1.7\n" + b"A" * 4096)


# ── attachment image for message.msg ─────────────────────────────────────────

def msg_attachment_png() -> None:
    img = Image.new("RGB", (240, 80), (230, 236, 250))
    d = ImageDraw.Draw(img)
    d.text((12, 12), "ACME HOLDINGS", fill=(20, 40, 120), font=ImageFont.load_default(size=22))
    d.text((12, 48), "fictional logo", fill=(90, 90, 90), font=ImageFont.load_default(size=14))
    img.save(Path(__file__).resolve().parent / "msg-attachment.png", format="PNG")


if __name__ == "__main__":
    text_transcript()
    scanned_agreement()
    summary_docx()
    workbook_xlsx()
    page_html()
    document_rtf()
    message_eml()
    archive_zip()
    corrupt_pdf()
    msg_attachment_png()
    print("generated fixtures in", OUT)
