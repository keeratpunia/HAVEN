"""
Builds docs/report/HAVEN-Progress-Report.docx and .pdf.

Format copied from the previous report (docs/report/previous-report.pdf): A4, Times New
Roman, UIET cover, INDEX table, "CHAPTER N" + title headings, numbered sections, bold
"Table X.Y" captions above tables, "Figure N" captions below figures, page numbers
centred at the bottom.

Every number in the text is listed with its source in docs/report/FACTS.md.

The PDF is produced by Microsoft Word (docx -> pdf through COM, scripts/docx2pdf.ps1).
The index page numbers are found by reading the PDF back (PyMuPDF) and the document is
rebuilt until they agree.

Usage:  python docs/report/scripts/build_report.py
"""
from __future__ import annotations

import json
import re
import subprocess
import sys
from pathlib import Path

import pymupdf  # PyMuPDF
from docx import Document
from docx.enum.section import WD_SECTION
from docx.enum.table import WD_TABLE_ALIGNMENT, WD_CELL_VERTICAL_ALIGNMENT
from docx.enum.text import WD_ALIGN_PARAGRAPH, WD_BREAK
from docx.oxml import OxmlElement
from docx.oxml.ns import qn
from docx.shared import Pt, Emu
from PIL import Image

HERE = Path(__file__).resolve().parent
REPORT = HERE.parent
DIAG = REPORT / "diagrams"
SHOTS = REPORT / "screenshots"
ASSETS = REPORT / "assets"
BUILD = REPORT / ".build"
DOCX = REPORT / "HAVEN-Progress-Report.docx"
PDF = REPORT / "HAVEN-Progress-Report.pdf"
MONTH = "October 2026"
FONT = "Times New Roman"
TEXT_W = 451.3  # A4 width 595.3 pt minus 72 pt margins

# --------------------------------------------------------------------------- helpers


def set_font(run, size=12, bold=None, italic=None, underline=None):
    run.font.name = FONT
    run.font.size = Pt(size)
    rpr = run._element.get_or_add_rPr()
    fonts = rpr.find(qn("w:rFonts"))
    if fonts is None:
        fonts = OxmlElement("w:rFonts")
        rpr.insert(0, fonts)
    for a in ("w:ascii", "w:hAnsi", "w:cs", "w:eastAsia"):
        fonts.set(qn(a), FONT)
    if bold is not None:
        run.bold = bold
    if italic is not None:
        run.italic = italic
    if underline is not None:
        run.underline = underline
    return run


def add_runs(p, text, size=12, italic=False):
    """Text with **bold** and `code` (shown in the body font, unstyled) spans."""
    for part in re.split(r"(\*\*[^*]+\*\*)", text):
        if not part:
            continue
        if part.startswith("**"):
            set_font(p.add_run(part[2:-2]), size, bold=True, italic=italic)
        else:
            set_font(p.add_run(part.replace("`", "")), size, italic=italic)


def fmt(p, align=WD_ALIGN_PARAGRAPH.JUSTIFY, before=0, after=8, keep=False, line=1.0):
    pf = p.paragraph_format
    p.alignment = align
    pf.space_before = Pt(before)
    pf.space_after = Pt(after)
    pf.line_spacing = line
    pf.keep_with_next = keep
    pf.widow_control = True
    return p


class Report:
    def __init__(self, index_pages: dict[int, int] | None):
        self.doc = Document()
        self.index_pages = index_pages or {}
        self.chapter = 0
        self.section = 0
        self.table_no = 0
        self.figure = 0
        self.figures: list[str] = []
        self.tables: list[str] = []
        self._setup()

    # ---- page, styles, footer
    def _setup(self):
        d = self.doc
        s = d.sections[0]
        s.page_width, s.page_height = Pt(595.3), Pt(841.9)
        s.left_margin = s.right_margin = Pt(72)
        s.top_margin = Pt(64)
        s.bottom_margin = Pt(64)
        s.footer_distance = Pt(30)
        normal = d.styles["Normal"]
        normal.font.name = FONT
        normal.font.size = Pt(12)
        normal.element.rPr.rFonts.set(qn("w:eastAsia"), FONT)
        for name in ("List Bullet", "List Number"):
            st = d.styles[name]
            st.font.name = FONT
            st.font.size = Pt(12)
        s.different_first_page_header_footer = True
        p = s.footer.paragraphs[0]
        p.alignment = WD_ALIGN_PARAGRAPH.CENTER
        run = p.add_run()
        set_font(run, 11)
        for tag, text in (("begin", None), (None, "PAGE"), ("end", None)):
            if tag:
                el = OxmlElement("w:fldChar")
                el.set(qn("w:fldCharType"), tag)
            else:
                el = OxmlElement("w:instrText")
                el.set(qn("xml:space"), "preserve")
                el.text = text
            run._element.append(el)

    # ---- blocks
    def para(self, text, size=12, align=WD_ALIGN_PARAGRAPH.JUSTIFY, after=8, before=0, keep=False, italic=False):
        p = self.doc.add_paragraph()
        add_runs(p, text, size, italic)
        return fmt(p, align, before, after, keep)

    def bullets(self, items, size=12, after=3):
        for i, t in enumerate(items):
            p = self.doc.add_paragraph(style="List Bullet")
            add_runs(p, t, size)
            fmt(p, WD_ALIGN_PARAGRAPH.JUSTIFY, 0, after if i < len(items) - 1 else 8)

    def page_break(self):
        p = self.doc.add_paragraph()
        p.add_run().add_break(WD_BREAK.PAGE)
        fmt(p, after=0)

    def chapter_start(self, title):
        self.chapter += 1
        self.section = 0
        self.table_no = 0
        self.page_break()
        p = self.doc.add_paragraph()
        set_font(p.add_run(f"CHAPTER {self.chapter}"), 14, bold=True)
        fmt(p, WD_ALIGN_PARAGRAPH.LEFT, 0, 6, keep=True)
        p = self.doc.add_paragraph()
        set_font(p.add_run(title.upper()), 17, bold=True)
        fmt(p, WD_ALIGN_PARAGRAPH.LEFT, 0, 10, keep=True)

    def heading(self, title):
        self.section += 1
        p = self.doc.add_paragraph()
        set_font(p.add_run(f"{self.chapter}.{self.section} {title}"), 13, bold=True)
        fmt(p, WD_ALIGN_PARAGRAPH.LEFT, 6, 5, keep=True)

    def table(self, title, header, rows, widths, size=10.5, align_center=False, keep_together=None):
        self.table_no += 1
        label = f"Table {self.chapter}.{self.table_no}"
        self.tables.append(f"{label}: {title}")
        p = self.doc.add_paragraph()
        set_font(p.add_run(f"{label}: {title}"), 12, bold=True)
        fmt(p, WD_ALIGN_PARAGRAPH.LEFT, 2, 5, keep=True)
        t = self.doc.add_table(rows=1 + len(rows), cols=len(header))
        t.style = self.doc.styles["Table Grid"]
        t.alignment = WD_TABLE_ALIGNMENT.CENTER
        t.autofit = False
        together = keep_together if keep_together is not None else len(rows) <= 10
        for r, values in enumerate([header] + rows):
            row = t.rows[r]
            trpr = row._tr.get_or_add_trPr()
            cant = OxmlElement("w:cantSplit")
            trpr.append(cant)
            if r == 0:
                hdr = OxmlElement("w:tblHeader")
                trpr.append(hdr)
            for c, v in enumerate(values):
                cell = row.cells[c]
                cell.width = Pt(widths[c])
                cell.vertical_alignment = WD_CELL_VERTICAL_ALIGNMENT.CENTER
                cp = cell.paragraphs[0]
                if r == 0:
                    set_font(cp.add_run(v), size + 0.5, bold=True)
                    a = WD_ALIGN_PARAGRAPH.CENTER
                else:
                    add_runs(cp, v, size)
                    a = WD_ALIGN_PARAGRAPH.CENTER if align_center else WD_ALIGN_PARAGRAPH.LEFT
                fmt(cp, a, 1, 1, keep=together and r < len(rows))
        self._grid_widths(t, widths)
        spacer = self.doc.add_paragraph()
        fmt(spacer, after=4)
        spacer.paragraph_format.line_spacing = 0.8
        return t

    @staticmethod
    def _grid_widths(t, widths):
        grid = t._tbl.tblGrid
        for gc, w in zip(grid.findall(qn("w:gridCol")), widths):
            gc.set(qn("w:w"), str(int(w * 20)))

    def _caption(self, container, title, size=10):
        self.figure += 1
        self.figures.append(f"Figure {self.figure}: {title}")
        p = container.add_paragraph() if hasattr(container, "add_paragraph") else container
        set_font(p.add_run(f"Figure {self.figure}"), size, bold=True)
        set_font(p.add_run(f": {title}"), size, italic=True)
        fmt(p, WD_ALIGN_PARAGRAPH.CENTER, 3, 10)
        return p

    def figure_img(self, path, title, width):
        p = self.doc.add_paragraph()
        p.add_run().add_picture(str(path), width=Pt(width))
        fmt(p, WD_ALIGN_PARAGRAPH.CENTER, 4, 0, keep=True)
        self._caption(self.doc, title)

    def grid(self, items, col_w, caption=None, label_size=10):
        """A borderless row of images. items: (path, width_pt, label | None, figure_title | None)."""
        t = self.doc.add_table(rows=1, cols=len(items))
        t.alignment = WD_TABLE_ALIGNMENT.CENTER
        t.autofit = False
        trpr = t.rows[0]._tr.get_or_add_trPr()
        trpr.append(OxmlElement("w:cantSplit"))
        for i, (path, w, label, fig_title) in enumerate(items):
            cell = t.rows[0].cells[i]
            cell.width = Pt(col_w)
            cell.vertical_alignment = WD_CELL_VERTICAL_ALIGNMENT.BOTTOM
            p = cell.paragraphs[0]
            p.add_run().add_picture(str(path), width=Pt(w))
            fmt(p, WD_ALIGN_PARAGRAPH.CENTER, 2, 1, keep=True)
            if label:
                lp = cell.add_paragraph()
                set_font(lp.add_run(label), label_size)
                fmt(lp, WD_ALIGN_PARAGRAPH.CENTER, 0, 2, keep=True)
            if fig_title:
                self._caption(cell.add_paragraph(), fig_title)
        self._grid_widths(t, [col_w] * len(items))
        if caption:
            self._caption(self.doc, caption)
        return t

    # ---- cover and index
    def cover(self):
        d = self.doc
        p = d.add_paragraph()
        set_font(p.add_run("HAVEN (HOSTEL ACCESS AND VISITOR ENTRY NETWORK) FOR SMART HOSTEL MANAGEMENT"), 30, bold=True)
        fmt(p, WD_ALIGN_PARAGRAPH.CENTER, 18, 6, line=1.0)
        p = d.add_paragraph()
        set_font(p.add_run(f"Progress Report — {MONTH}"), 16, italic=True)
        fmt(p, WD_ALIGN_PARAGRAPH.CENTER, 0, 18)
        p = d.add_paragraph()
        p.add_run().add_picture(str(ASSETS / "uiet-logo.png"), width=Pt(190))
        fmt(p, WD_ALIGN_PARAGRAPH.CENTER, 0, 30)
        t = d.add_table(rows=1, cols=2)
        t.autofit = False
        left, right = t.rows[0].cells
        left.width, right.width = Pt(200), Pt(251)
        self._grid_widths(t, [200, 251])
        lp = left.paragraphs[0]
        set_font(lp.add_run("Submitted To:"), 14, bold=True, underline=True)
        fmt(lp, WD_ALIGN_PARAGRAPH.LEFT, 0, 14)
        lp = left.add_paragraph()
        set_font(lp.add_run("Dr. Raj Kumari"), 16)
        fmt(lp, WD_ALIGN_PARAGRAPH.LEFT, 0, 0)
        rp = right.paragraphs[0]
        set_font(rp.add_run("Submitted By:"), 14, bold=True, underline=True)
        fmt(rp, WD_ALIGN_PARAGRAPH.RIGHT, 0, 14)
        for name in ("Aarush Bhandari UE238001", "Keerat Punia UE238044", "Naeva Setia UE238059", "Pankhuri Bhatia UE238068"):
            rp = right.add_paragraph()
            set_font(rp.add_run(name), 16)
            fmt(rp, WD_ALIGN_PARAGRAPH.RIGHT, 0, 0)
        rp = right.add_paragraph()
        set_font(rp.add_run("(B.E. IT 7"), 16)
        sup = set_font(rp.add_run("th"), 16)
        sup.font.superscript = True
        set_font(rp.add_run(" Semester)"), 16)
        fmt(rp, WD_ALIGN_PARAGRAPH.RIGHT, 0, 0)
        p = d.add_paragraph()
        set_font(p.add_run("DEPARTMENT OF INFORMATION TECHNOLOGY"), 15, bold=True)
        fmt(p, WD_ALIGN_PARAGRAPH.CENTER, 48, 6)
        for line in ("UNIVERSITY INSTITUTE OF ENGINEERING AND TECHNOLOGY", "PANJAB UNIVERSITY, CHANDIGARH"):
            p = d.add_paragraph()
            set_font(p.add_run(line), 13, italic=True)
            fmt(p, WD_ALIGN_PARAGRAPH.CENTER, 0, 4)

    def index(self, chapters):
        self.page_break()
        p = self.doc.add_paragraph()
        set_font(p.add_run("INDEX"), 18, bold=True)
        fmt(p, WD_ALIGN_PARAGRAPH.CENTER, 30, 16)
        t = self.doc.add_table(rows=1 + len(chapters), cols=3)
        t.style = self.doc.styles["Table Grid"]
        t.alignment = WD_TABLE_ALIGNMENT.CENTER
        widths = [55, 255, 110]
        for r, values in enumerate([("Sr. No.", "Topic", "Page Number")] + [
            (str(i + 1), c, str(self.index_pages.get(i + 1, "—"))) for i, c in enumerate(chapters)
        ]):
            for c, v in enumerate(values):
                cell = t.rows[r].cells[c]
                cell.width = Pt(widths[c])
                cp = cell.paragraphs[0]
                set_font(cp.add_run(v), 15 if r == 0 else 12, bold=r == 0)
                fmt(cp, WD_ALIGN_PARAGRAPH.LEFT, 3, 3)
        self._grid_widths(t, widths)


# --------------------------------------------------------------------------- content

CHAPTERS = [
    "Introduction and Project Status",
    "Changes Since the Previous Report",
    "System Overview",
    "User Flows",
    "Architecture and Design",
    "Security and Privacy",
    "Technology Stack",
    "Implementation",
    "Testing and Quality Assurance",
    "Development Methodology and Team Contributions",
    "Limitations and Next Phase",
    "Conclusion",
    "References",
]


def png_w(path):
    with Image.open(path) as im:
        return im.size[0]


def diagram_width(name, font_pt, css_font=16, cap=TEXT_W):
    """Width (pt) at which a diagram's text prints at about font_pt."""
    css_w = png_w(DIAG / f"{name}.png") / 3
    return min(cap, font_pt / css_font * css_w)


def build(index_pages):
    R = Report(index_pages)
    R.cover()
    R.index(CHAPTERS)

    def intro(text):
        """One short sentence before a table or figure, kept on its page."""
        return R.para(text, size=11.5, after=5, keep=True)

    # ------------------------------------------------------------------ 1
    R.chapter_start(CHAPTERS[0])
    R.para(
        "At Panjab University's Girls Hostel 8 (GH-8), guests are recorded in a paper register at the gate. "
        "The register cannot show who is inside right now, does not link a guest to the resident "
        "responsible for them, records no exits and cannot catch a day guest who quietly stays the night. "
        "After an unauthorised outsider entered the hostel, the warden announced fines for residents who "
        "host unregistered guests, but without records such rules cannot be applied fairly. HAVEN replaces "
        "the register with a phone-based system. The guest scans a QR code shown on a screen at the gate; "
        "the code changes every few seconds. The server checks that the code is fresh and that the "
        "guest's phone is really at the gate, the guest's live photo is sent to the resident they are "
        "visiting, and the warden can see at any moment who is inside, whose guest they are and since when."
    )
    R.heading("What Exists Today")
    R.para(
        "Our previous report described a proposed design. Before building, the team wrote a detailed "
        "design document describing the rules, screens and security of the system, and then built HAVEN "
        "from it step by step. HAVEN is now a working prototype: a server program with a database, and one "
        "app that shows the guest pages, the resident app, the warden and office screens and the gate "
        "screen in a web browser. All the main user journeys work from start to finish, and the team tried "
        "them live on real Android phones on 19 October 2026. For now the prototype runs on one laptop with "
        "made-up demo data, and phones reach it through a temporary internet link. It has **not** yet been "
        "put on a public server, has not sent real SMS messages or used real Google sign-in, has no "
        "installable Android app, and has never handled a real person's data. All code, tests and records "
        "are kept in the team's project repository."
    )
    intro("Table 1.1 gives a snapshot of the prototype's size and test results.")
    R.table(
        "Project status in numbers",
        ["Item", "Value"],
        [
            ["Requirements to meet", "159 items: 50 features, 14 quality targets (such as speed and privacy), 20 hostel rules, 24 unusual situations, 51 test scenarios"],
            ["Saved changes (commits)", "78, from 1 to 19 October 2026, before work on this report began"],
            ["Program code", "About 52,200 lines including tests (server 16,600 + server tests 12,000; app 11,900; shared code 3,600; database 1,900)"],
            ["Server functions / app screens", "86 server functions (API endpoints) / 43 screens"],
            ["Database", "25 tables, built in 20 recorded steps (migrations)"],
            ["Background work", "11 scheduled jobs; 20 kinds of notification"],
            ["Automated tests (21 Oct 2026)", "1,069 unit and integration tests, 31 end-to-end tests, 35 database tests — all passing"],
            ["Separate quality review", "Of 159 items: 142 pass, 0 fail, 9 partly met, 8 not testable yet"],
            ["Separate security review", "33 findings plus 4 on photo handling; all 3 high-severity findings fixed"],
            ["Recorded decisions", "25, each with its reason"],
        ],
        [150, 301],
        size=10,
    )
    # ------------------------------------------------------------------ 2
    R.chapter_start(CHAPTERS[1])
    R.heading("Design Changes")
    intro(
        "Table 2.1 compares the design in our previous report with what is built now, with the reason for "
        "each change. Most changes came from studying how the GH-8 gate really works: receptionists will not "
        "check guests, there is no list of residents or college e-mail, and guests will not install an app."
    )
    R.table(
        "Previous report compared with the current design",
        ["Area", "Previous report", "Current design (built)", "Reason"],
        [
            ["App", "React web app built with Vite", "One Expo (React Native) code base, run in the browser; Android app planned", "Residents and wardens need reliable phone notifications; guests still need only a browser"],
            ["Server", "Node.js with Express", "One Fastify server; Zod checks requests; Kysely builds queries", "Checking is built in; one server suits tens of visits a day"],
            ["Sign-in", "Phone OTP for visitors; passwords for others", "Phone OTP for guests; Google for residents (who also confirm their phone) and staff; sign-in passes last 15 min and renew", "There is no college e-mail; almost everyone has Gmail"],
            ["QR code", "Valid 15 s, usable once", "New code every 10 s, accepted for 30 s, usable by a group; the server re-calculates a code to check it, so none are stored", "Single-use codes blocked groups; 30 s leaves time for the phone's location prompt"],
            ["Gate QR codes", "Two: one to enter, one to leave", "One; the server offers check-in or check-out; a 10-minute scan session allows slow steps", "Simpler gate; nobody scans the wrong code"],
            ["Location check", "Turf.js library, 50 m", "The server checks the phone is inside the gate's circle (50 m by default), with GPS at most 60 s old; else the host can confirm", "A simple distance formula is enough; GPS often fails indoors"],
            ["Device check", "Device fingerprint per user", "Removed; phone sign-in, the scan session and the live photo do this job", "Browser fingerprints change often and are personal data; the host's photo check is stronger"],
            ["Live photo", "None", "Camera photo at every entry and exit, never a saved picture; host sees it beside the profile photo", "Catches a borrowed account or a QR code passed to an outsider"],
            ["Approval", "Resident approves every check-in", "Invited guests enter, then the host confirms or reports them; walk-ins need the host within 10 min; overnight also the warden", "Fewer taps; the host stays responsible"],
            ["Roles", "Visitor, resident, security staff (manual overrides), warden, admin", "Guest, resident, warden, office staff, super admin, plus the gate screen; no security role", "Receptionists will not check guests; the gate screen shows no personal data"],
            ["Live updates", "Supabase Realtime", "The server pushes changes to the warden's screen as they happen", "Apps never read the database directly"],
            ["Notifications", "Firebase Cloud Messaging", "Queued in the database, then sent by Expo push, SMS backup (MSG91 planned) or in-app list", "Retries; every message recorded; none sent if the change fails"],
            ["Rules", "Fixed columns in a rules table", "Versioned settings, checked by one shared rules checker", "The warden can change rules without a new release"],
            ["Check-out", "Separate exit QR; GPS required", "Same QR; never refused because of a rule; a failed GPS check on exit is allowed but flagged", "A guest must never be trapped inside"],
            ["Residents", "Residents also checked in and out", "Residents' own movements are not tracked", "Not a goal; privacy"],
            ["Analytics", "Peak hours, return rates", "Removed; visit counts and a recorded spreadsheet (CSV) export only", "The data-protection law limits data to its stated purpose"],
            ["Data model", "7 kinds of record", "25 tables; gate events, approvals, rules and audit log can never be altered", "The record of who let whom in must survive"],
            ["Hosting", "Railway + Vercel; tablet or Raspberry Pi at the gate", "Planned: Render, Vercel, Supabase. Today: one laptop. Gate: any phone browser, paired by code", "Free plans; no hardware to buy"],
        ],
        [62, 92, 172, 125],
        size=9.5,
        keep_together=False,
    )
    R.heading("Key Decisions Made During the Build")
    intro("The team wrote down every decision taken during the build, with its reason. The most important were:")
    R.bullets(
        [
            "**Arriving early** — guests may come up to 30 minutes early; one example in the team's written rules said otherwise, so the team kept the 30-minute rule and noted the conflict.",
            "**Demo sign-in** — in the demo, residents and staff sign in with their e-mail instead of Google; the server refuses this shortcut outside a developer's machine.",
            "**Second scan for new walk-ins** — a first-time guest who signs up during a scan scans once more (explained in Chapter 4).",
            "**Office staff** — they see charges only, never guests' phones, photos or live visit updates.",
            "**Background work** — queued, retried notifications; scheduled data deletion; account deletion; a daily summary for the warden.",
            "**Security review** — how each finding is handled, including leaving web security settings until deployment.",
            "**Deployment** — the server is packed into one file; photos sit in private storage behind links that expire after 120 seconds.",
            "**Privacy** — the privacy-notice wording, and storing which version each person agreed to, as the law requires.",
            "**Small cases** — a guest with location turned off goes straight to asking the host; a link opened inside another app's built-in browser asks the guest to open it in Chrome; stored times come from the server's clock.",
        ],
        size=11,
        after=2,
    )
    R.heading("Key Terms")
    intro("Table 2.2 explains words used in the rest of this report.")
    R.table(
        "Key terms",
        ["Term", "Meaning"],
        [
            ["Host", "The resident a guest is visiting; the host is responsible for the guest."],
            ["Pre-invite", "A visit the host sets up in advance; the guest receives a link."],
            ["Walk-in", "A guest who arrives without an invite and asks the host from the gate."],
            ["QR code token", "The code on the gate screen; it changes every 10 s and is accepted for 30 s."],
            ["Scan session", "A 10-minute window after scanning, to sign in, take a photo and check in."],
            ["Geofence", "A circle around the gate (50 m by default); the phone's GPS must be inside it."],
            ["OTP", "One-time password: a 6-digit code sent by SMS to prove a phone number."],
            ["Live photo", "A photo taken by the camera at that moment, never a saved picture."],
            ["API", "The server program the apps talk to; only it reads or writes the database."],
            ["Database", "Where all records are stored: people, visits, rules and charges."],
            ["End-to-end test", "An automated test that uses the real app in a browser, as a person would."],
            ["Regression test", "A test written for a fixed bug, proving it stays fixed."],
        ],
        [90, 361],
        size=9.5,
    )

    # ------------------------------------------------------------------ 3
    R.chapter_start(CHAPTERS[2])
    R.heading("Roles and Permissions")
    R.para(
        "HAVEN has five kinds of users, plus the gate screen, which signs in as a device with its own pass. "
        "Roles are given per hostel, and nobody can give themselves a role. Every request passes one central "
        "permission check, and each role receives only the data it may see — for example, office staff "
        "never receive a guest's phone number or photo."
    )
    intro("Table 3.1 lists each role, how it signs in and what it may do.")
    R.table(
        "Roles and what they may do",
        ["Role", "Signs in with", "Main permissions"],
        [
            ["Guest", "Phone OTP, in the browser", "Own profile and visits: request walk-in entry, check in and out at the gate, cancel a pending walk-in"],
            ["Resident (host)", "Google + phone OTP", "After the warden verifies them: invite guests, approve or reject walk-ins, host-assisted entry, confirm or dispute arrivals, request overnight stays, mark own guest as left; sees own guests' photos and phones"],
            ["Warden", "Google (set up by the team in the prototype)", "Own hostel: dashboard, roll call, verify residents, approve overnight stays, force check-out, disputes, rules, bans, suspensions, fines, charges (including waiving them), gates, office staff, reports, audit log"],
            ["Office staff", "Google (invited by the warden)", "Own hostel's charges only: confirm and mark paid. Cannot waive a charge (only the warden can); never sees guest phones or photos"],
            ["Super admin", "Google (set up by the team)", "All hostels: search and open any visit; verify residents, suspend hosts, bans, rules, gates, audit log; create hostels, invite wardens. The team kept the warden's day-to-day screens (dashboard, roll call, overnight approvals, reports) and forced check-out with the warden only"],
            ["Gate screen", "Device pass from pairing", "Shows the rotating QR code; holds no personal data"],
        ],
        [70, 101, 280],
        size=10,
    )
    R.heading("Visit Types")
    intro("Visits differ in who creates them, who approves them and how long they last; Table 3.2 compares the four types.")
    R.table(
        "Visit types",
        ["Type", "Created by", "Approved by", "Duration"],
        [
            ["Quick drop-off", "Guest at the gate or host", "Host", "15 minutes from entry"],
            ["Day visit", "Host (invite) or guest (walk-in)", "Host", "Host-chosen window, same day"],
            ["Overnight in my room", "Host", "Host and warden", "1 or more nights"],
            ["Hostel guest room", "Host", "Host and warden", "1 or more days"],
        ],
        [110, 140, 90, 111],
    )
    R.heading("Business Rules")
    R.para(
        "The rules come from Panjab University's hostel rules (26.1–26.8) and the GH-8 warden's notice. They "
        "are stored as settings, so the warden can change times, limits and charges without a new version "
        "of the app.", after=4
    )
    intro("Table 3.3 lists the 20 rules, numbered BR-01 to BR-20, with GH-8's current values.")
    R.table(
        "Business rules BR-01 to BR-20 (condensed)",
        ["ID", "Rule"],
        [
            ["BR-01", "No guest is admitted without approval from a verified, non-suspended resident host."],
            ["BR-02 / 03", "Day and quick drop-off guests must check in before 20:00; nobody checks in at or after 22:00."],
            ["BR-04", "A day visit lies between 08:00 and 22:00 on one date."],
            ["BR-05 / 06", "Overnight in a room: at most 3 nights per host per calendar month, and one such guest at a time."],
            ["BR-07", "A guest of the opposite or undisclosed gender meets the host in the Visitors' Room only, and cannot stay overnight."],
            ["BR-08", "Overnight stay ₹50 a night, guest room ₹150 a night; a pending charge is created when the warden approves."],
            ["BR-09 / 10", "Banned guests cannot be invited or enter; a suspended host cannot invite or approve, and their future visits are cancelled."],
            ["BR-11", "A host may have at most 3 day or quick drop-off guests inside at once."],
            ["BR-12 / 13", "A walk-in expires if the host does not answer in 10 minutes; a guest is overstaying 15 minutes after the visit's end time."],
            ["BR-14", "At 22:00 every day guest still inside is listed to the warden (the night check)."],
            ["BR-15", "A guest can be inside on only one visit at a time (checked by the rules and again by the database)."],
            ["BR-16", "Invites at most 7 days ahead; overnight requests at most 30 days ahead."],
            ["BR-17", "Check-out is never refused because of a rule; a failed GPS check on exit is allowed but flagged."],
            ["BR-18", "The warden may fine a host for an unregistered guest, minimum ₹400."],
            ["BR-19 / 20", "Overnight: arrive from 08:00, leave by 12:00 on the last day; guests may arrive up to 30 minutes early."],
        ],
        [62, 389],
        size=10.5,
    )

    # ------------------------------------------------------------------ 4
    R.chapter_start(CHAPTERS[3])
    R.para(
        "The main user journeys are grouped into eleven flows, F1 to F11. Figures 1 to 6 show the six that "
        "guests and residents meet most; Section 4.2 describes the rest. All time limits are judged by the "
        "server's clock, never the phone's, so changing the phone's time does not help. Section 9.1 says "
        "which flows have end-to-end tests."
    )
    R.heading("Guest Flows")
    intro("Figure 1 follows a guest with an invite; Figure 2 follows a guest who arrives without one.")
    fw = 8.6
    R.grid(
        [
            (DIAG / "f1-preinvite.png", diagram_width("f1-preinvite", fw), None, "F1 Pre-invite and check-in"),
            (DIAG / "f2-walkin.png", diagram_width("f2-walkin", fw), None, "F2 Walk-in at the gate"),
        ],
        225,
    )
    R.para(
        "In a walk-in the time limits are judged at the moment of the scan: a guest who scans at 19:58 and "
        "is approved at 20:03 is admitted. **Accepted difference from the plan:** the plan was that a "
        "first-time walk-in signs up and carries on with the same scan. In the build, signing up sends the "
        "guest back to scan the gate QR once more. Nothing they entered is lost, it happens only on their "
        "first visit, and every gate action still needs a fresh code, so the team accepted it rather than "
        "change a security-sensitive part late in the build.",
        size=11.5,
    )
    intro("Figure 3 shows what happens when the phone's location cannot be confirmed; Figure 4 shows leaving.")
    R.grid(
        [
            (DIAG / "f3-location.png", diagram_width("f3-location", fw), None, "F3 Location could not be verified"),
            (DIAG / "f5-checkout.png", diagram_width("f5-checkout", fw), None, "F5 Check-out"),
        ],
        225,
    )
    R.heading("Resident, Warden and Gate Flows")
    R.bullets(
        [
            "**F4 Host-assisted entry** — for a guest without a smartphone, the host scans the gate QR on their own phone, enters the guest's details and takes the guest's photo. It works and is tested through the server, but not yet with an end-to-end test.",
            "**F6 Overnight request** and **F7 Resident onboarding** — shown in Figures 5 and 6.",
            "**F8 Gate pairing and location** — the warden creates a one-time pairing code; the gate phone enters it and starts showing the QR code; the warden records the gate's position from several GPS readings.",
            "**F9 Dispute** — a host who taps \"Not my guest\" within 30 minutes alerts the warden, who resolves it.",
            "**F10 Forgotten check-out** — the host taps \"My guest has left\"; otherwise an overstay is flagged 15 minutes after the visit ends and passed on to the warden, who can force a check-out.",
            "**F11 Staff invite** — the warden invites office staff by e-mail; they accept with Google sign-in.",
        ],
        size=11.5,
    )
    R.grid(
        [
            (DIAG / "f6-overnight.png", diagram_width("f6-overnight", fw), None, "F6 Overnight request"),
            (DIAG / "f7-onboarding.png", diagram_width("f7-onboarding", fw), None, "F7 Resident onboarding"),
        ],
        225,
    )

    # ------------------------------------------------------------------ 5
    R.chapter_start(CHAPTERS[4])
    R.heading("System Architecture")
    R.para(
        "This section shows how the parts of HAVEN fit together (Figure 7). HAVEN is one server program "
        "divided into modules (a \"modular monolith\"), rather than many small services. There is one Fastify API (the server; Fastify is a toolkit for building web servers), one "
        "Supabase project (a hosted service) holding the PostgreSQL database and the photo storage, and one "
        "Expo code base (Expo builds phone and web apps from the same code) for all the apps. Apps never talk to the database directly; every "
        "request goes through the API. The same server also runs the scheduled jobs, sends notifications "
        "and pushes live updates to the warden's screen over a connection that stays open (Server-Sent Events)."
    )
    R.figure_img(DIAG / "architecture.png", "How the parts of HAVEN fit together", diagram_width("architecture", 9.5, 13 * 1.333, 400))
    R.heading("Code Organisation")
    intro("The code is kept in one repository, split into folders by purpose; Table 5.1 explains each folder.")
    R.table(
        "Folders in the project",
        ["Folder", "Contents"],
        [
            ["apps/api", "The server: modules for sign-in, gate, visits, rules, residents, administration, photos, accounts, live updates, notifications and scheduled jobs; demo and test tools"],
            ["apps/mobile", "The app: guest, resident, warden, office and gate screens; the end-to-end tests"],
            ["packages/shared", "Code used by both server and app: the rules checker, reading the gate QR, shared data formats, the wording shown to users, hiding personal data in logs"],
            ["packages/ui", "Colours, sizes and fonts shared by all screens"],
            ["supabase", "20 database migrations (recorded step-by-step changes to the database) and 4 database test files"],
            ["docs", "Records of decisions, test and review reports, demo and setup guides"],
        ],
        [95, 356],
    )
    R.heading("Request Pipeline")
    R.para(
        "Every request passes the same safety checks before anything happens, so no screen can skip a "
        "permission check. Figure 8 shows the steps. Each request gets an ID and is rate-limited (one phone "
        "or address can make only so many requests); its sign-in pass is checked; its input is validated; the "
        "permission check runs; the hostel rules are applied; the change is saved in one database "
        "transaction (all of it is saved, or none of it); and the reply contains only what the user's role "
        "may see. The rules checker has no clock of its own — the time is always handed to it — so tests "
        "can try any time of day."
    )
    R.figure_img(DIAG / "pipeline.png", "The checks every request passes", TEXT_W)
    R.heading("Visit State Machine")
    R.para(
        "Every visit moves through a fixed set of states, so a visit can never reach an impossible "
        "situation, such as being checked out before it was approved. A visit has 8 states and exactly 19 "
        "allowed moves between them (Figure 9), all listed in one place in the server's code; any other move "
        "is refused. 270 automated test cases try every state with every possible action, and every pair of "
        "states."
    )
    R.figure_img(DIAG / "state.png", "The states of a visit and the allowed moves between them", diagram_width("state", 7.6))
    R.heading("Gate Token and Scan Session")
    R.para(
        "This is the part that stops a photo of the QR code from being used anywhere else. The gate screen "
        "calculates a new code every 10 seconds from a secret key it received when it was paired, so it keeps "
        "working even if its internet connection drops. Each code carries an 80-bit signature (an HMAC: a "
        "check value that only the holder of the secret key can produce), so codes cannot be made up. The "
        "server accepts a code up to 30 seconds old and checks that the phone's GPS reading is inside the "
        "gate's circle. It then opens a 10-minute scan session that belongs only to the phone that scanned: "
        "that phone holds a one-time random number, which the server checks at every step. The slow "
        "steps — sign-in, profile, photo — happen inside the session. The check-in request is safe to "
        "resend, and it is saved in one database transaction (Figure 10)."
    )
    R.figure_img(DIAG / "gate-sequence.png", "Gate code, scan session and check-in, step by step", diagram_width("gate-sequence", 8.5, 21))
    R.heading("Data Model")
    R.para(
        "The database keeps every record HAVEN needs, and it is built so that the history of who entered "
        "cannot be quietly changed. It has 25 tables; Figure 11 shows the main 17 with their key columns, "
        "and each line links a record to the record it belongs to. Records are not deleted in normal use: a "
        "resident who moves out is marked \"left\", a ban is lifted rather than erased, and visits are kept. "
        "Gate events, approvals, rule versions and the audit log can only be added to, never edited or "
        "deleted — the database itself refuses. An audit record, with personal data removed, is written "
        "automatically for every change to visits, residents and roles."
    )
    R.figure_img(DIAG / "er.png", "Main database tables and their links (key columns only)", 360)
    R.heading("Notifications and Scheduled Jobs")
    R.para(
        "This part makes sure people hear about events reliably, and that time-based rules run on their "
        "own. When someone must be told about a change, the server adds a message to a queue in the "
        "database (the \"outbox\") in the same transaction as the change, so if the change fails, no message "
        "is sent. A background sender sends queued messages every 2 seconds, with retries, by Expo push "
        "notification or SMS. Eleven scheduled jobs do time-based work, such as expiring unanswered walk-ins, "
        "flagging overstays and deleting old data; eight run inside the database and three in the server. "
        "Each job is told the current time instead of reading a clock, so tests can run it at any chosen "
        "moment (Figure 12)."
    )
    R.figure_img(DIAG / "outbox.png", "Notification queue and scheduled jobs", diagram_width("outbox", 8.5))

    # ------------------------------------------------------------------ 6
    R.chapter_start(CHAPTERS[5])
    R.para(
        "HAVEN handles guests' and residents' phone numbers, photos and locations. These are personal data "
        "under India's Digital Personal Data Protection (DPDP) Act, 2023. The team's rule for personal data "
        "is: collect the least, show it to the fewest, keep it the shortest, and record who looked."
    )
    R.heading("Threat Model")
    intro(
        "The team listed the ways someone could misuse the gate or reach data they should not see. Table 6.1 "
        "shows the main threats, how HAVEN reduces each one, and the risk that remains."
    )
    R.table(
        "Main threats, protections and remaining risk",
        ["Threat", "Protection in HAVEN", "Risk left"],
        [
            ["A photo of the QR code sent to someone off-site", "Code accepted for 30 s only; GPS must be at the gate", "Low"],
            ["Someone inside sends the live QR to an outsider who fakes their GPS", "Live photo sent to the host; \"Not my guest\" button; a suspiciously exact distance (0 m) is flagged", "Medium"],
            ["A guest uses a friend's account", "Live photo shown to the host beside the profile photo", "Low"],
            ["A resident lies about who they are when signing up", "Warden checks an ID-card photo and a selfie", "Low"],
            ["Misuse of SMS codes, for example to run up SMS costs", "Limits per phone and per internet address; Indian numbers only; an \"are you human?\" check after 3 requests", "Low"],
            ["Guessing invite links, pairing codes or QR codes", "Far too many possibilities: 128-bit invite links; 40-bit pairing codes valid 10 min with 5 tries; 80-bit QR signatures", "Negligible"],
            ["A user sees records that are not theirs", "One central permission check; each role gets only its allowed data; tests for every group of server functions", "Low"],
            ["Staff browse data they should not", "Office staff see no phones or photos; viewing photos, the roll call or an export is recorded", "Low"],
            ["An outsider walks in without scanning at all", "No software can stop this; the 22:00 night check and the warden's rounds", "High (accepted)"],
        ],
        [150, 226, 75],
        size=10,
    )
    R.heading("Security Controls")
    intro("HAVEN also applies standard protections to its secrets, sign-in, inputs, photos and logs:")
    R.bullets(
        [
            "Gate secret keys are encrypted (AES-256-GCM). Pairing codes, renewal passes and gate-screen passes are stored only as one-way fingerprints (SHA-256 hashes), which are useless to a thief.",
            "Sign-in passes last 15 minutes. A 30-day renewal pass is replaced every time it is used; if an old one is ever reused, the whole session ends. On the web it is kept in a cookie that page scripts cannot read.",
            "Every input is checked; requests are limited to 64 KB (3 MB for photos); database queries are never built from raw text, which blocks a common attack; error replies never show internal details; only the app's own website may call the server.",
            "Photos: the file type is checked from its content, hidden camera and location details are removed, the size is reduced to 720 pixels, and photos are shown only through links that stop working after 120 seconds.",
            "Logs hide passes, codes, cookies and photo locations, and show phone numbers only in part.",
        ],
        size=11.5,
    )
    R.heading("Separate Security Review")
    intro(
        "On 18 October 2026 a separate security review checked the code against the threat list, a checklist "
        "of required protections and every security test scenario; its findings were written down before "
        "any fix. Table 6.2 gives the result."
    )
    R.table(
        "Security review findings by severity",
        ["Severity", "Found", "Fixed", "Not fixed"],
        [
            ["Critical", "0", "0", "—"],
            ["High", "3", "3", "—"],
            ["Medium", "11", "10", "Web security settings: planned for deployment"],
            ["Low", "12", "9", "Two accepted (a rare case where a phone's notification sign-up moves to another account, by design; warnings in developer-only tools) and one false alarm"],
            ["Information", "7", "1", "Checks that were already correct, or accepted by design"],
            ["Photo handling", "4", "4", "—"],
        ],
        [75, 50, 50, 276],
        size=10.5,
    )
    R.para(
        "The three high-severity findings were a public room search that revealed residents' names, "
        "protections that switched off if one setting was missing, and an image library with known "
        "weaknesses. All three were fixed, each with regression tests; 17 of the first 20 new security "
        "tests failed on the old code, which shows that they really detect the problems.",
        size=11.5,
    )
    R.heading("Privacy and the DPDP Act")
    R.para(
        "Guests and residents read a short privacy notice and tick a consent box before giving any data "
        "beyond their phone number; which version of the notice they agreed to, and when, is stored. Guests "
        "confirm they are 18 or older. There are no analytics or tracking tools: data is used only for "
        "hostel entry security. Users can see their own data, correct their name and delete their account; "
        "deletion waits until any visit in progress ends, then removes their photos and personal details "
        "while keeping the visit record. All the privacy wording is proposed text that still needs the "
        "warden's approval.",
        size=11.5,
    )
    intro("Old data is deleted automatically every night; Table 6.3 shows how long each kind is kept.")
    R.table(
        "How long data is kept",
        ["Data", "Kept for"],
        [
            ["Scan sessions with exact GPS readings", "Deleted 1 day after they expire"],
            ["SMS codes (OTP)", "Deleted after 1 day"],
            ["Photos taken at the gate", "180 days"],
            ["Guest profile photo", "365 days after the guest's last visit"],
            ["Resident ID-card photo", "Deleted once the warden decides"],
            ["Visit records", "2 years, then the guest's details are removed"],
        ],
        [240, 211],
        size=10.5,
    )

    # ------------------------------------------------------------------ 7
    R.chapter_start(CHAPTERS[6])
    intro(
        "Table 7.1 lists the main technologies in each part of HAVEN and why each was chosen. All code is "
        "written in TypeScript (JavaScript with type checks), and every library version is fixed."
    )
    R.table(
        "Technology stack",
        ["Part", "Technology", "Why"],
        [
            ["App", "Expo 57, React Native 0.86 and Web, Expo Router", "One code base; browser is enough"],
            ["Camera, QR, GPS", "expo-camera, @zxing/browser, expo-location", "Live camera; QR read in browser"],
            ["Server", "Node.js, Fastify 5, Zod, luxon", "Every request checked; times in IST"],
            ["Database", "PostgreSQL on Supabase, Kysely, pg", "Rules enforced in the database"],
            ["Sign-in", "jose (signed passes, JWT), phone OTP, Google", "Short-lived passes; Gmail sign-in"],
            ["Photos", "sharp, Supabase Storage (private)", "Details removed; 120 s links"],
            ["Notifications", "Database queue, Expo push, SMS gateway", "Retries; sent after saving"],
            ["Live updates, logs", "Server-Sent Events; pino; Sentry", "Live screens; logs without personal data"],
            ["Hosting (planned)", "Render (server), Vercel (web app), Supabase", "Free plans suit a pilot"],
        ],
        [80, 211, 160],
        size=10,
    )
    R.para(
        "Three libraries planned at the start are not used yet: TanStack Query, React Hook Form and the "
        "native Google sign-in library (needed only for the planned Android app).",
        size=11,
    )
    intro("Table 7.2 lists the tools used to build, test and demonstrate HAVEN.")
    R.table(
        "Development and testing tools",
        ["Tool", "Use"],
        [
            ["pnpm, Turborepo; ESLint, Prettier", "Manage the project's parts; check code style and types"],
            ["Vitest, Jest, Supertest, pgTAP", "Unit, integration and database tests on real PostgreSQL"],
            ["Playwright", "End-to-end tests with simulated camera and GPS; Chapter 8"],
            ["GitHub Actions", "Continuous integration (CI): runs every check on each change"],
            ["Cloudflare tunnel; Mermaid, Graphviz", "Real phones reach the laptop demo; report diagrams"],
            ["AI-assisted coding tools", "Implementation from the team's design, reviewed by the team"],
        ],
        [160, 291],
        size=10.5,
    )
    intro("HAVEN needs no special equipment; Table 7.3 lists what each user needs.")
    R.table(
        "Hardware requirements (current)",
        ["Who / what", "Hardware"],
        [
            ["Guests, residents", "Any smartphone with a browser, camera, GPS and mobile data"],
            ["Gate display", "Any phone or tablet browser, kept charged at the gate; no scanner or kiosk"],
            ["Warden, office", "A laptop or desktop browser"],
            ["Server", "Planned: one small server and a hosted database; the demo runs on one laptop"],
        ],
        [100, 351],
        size=10,
    )

    # ------------------------------------------------------------------ 8
    R.chapter_start(CHAPTERS[7])
    R.para(
        "This chapter shows the working prototype. All screenshots were taken automatically from the "
        "running app with made-up demo data; every name and phone number is fictitious. The camera was fed "
        "simple drawn faces, not photos of real people, so the live photos look realistic without showing "
        "anyone. The GPS was set to a placeholder location and the demo clock to 13:00 Indian time (20:05 "
        "for Figure 17(a)). Phone screens are 360 × 640 pixels, the size of a small phone.",
        size=11.5,
    )
    pw, cw = 112, 132

    def phones(items, title):
        R.grid([(SHOTS / f"{f}.png", pw, lab, None) for f, lab in items], cw, caption=title)

    R.heading("Guest")
    intro("A guest needs no app. Figure 13 shows a guest opening an invite link, confirming their phone with a one-time code, and giving their details and consent.")
    phones(
        [("g01-invite-landing", "(a) Invite link"), ("g02-otp", "(b) Phone OTP"), ("g03-profile-consent", "(c) Profile and consent")],
        "Guest: opening an invite and signing up",
    )
    intro("At the gate the guest scans the QR code and checks in; Figure 14 also shows a walk-in guest waiting for the host's answer.")
    phones(
        [("g04-scan-check-in", "(a) After scanning the gate QR"), ("g05-checked-in", "(b) Checked in"), ("g06-walk-in-waiting", "(c) Walk-in waiting for host")],
        "Guest: scanning at the gate",
    )
    R.heading("Resident")
    intro("Figure 15 shows the resident's home screen, the invite form, and a walk-in request with the guest's live photo beside the profile photo.")
    phones(
        [("r01-resident-home", "(a) Home"), ("r02-create-invite", "(b) Creating an invite"), ("r03-walk-in-approval", "(c) Walk-in with live photo")],
        "Resident: home, invite and walk-in approval",
    )
    intro("Figure 16 shows a resident confirming that an arrival really is their guest, and requesting an overnight stay for the warden to approve.")
    R.grid(
        [
            (BUILD / "r04-arrival-confirm.png", pw, "(a) Confirming an arrival", None),
            (BUILD / "r05-overnight-request.png", pw, "(b) Overnight request", None),
        ],
        cw + 30,
        caption="Resident: confirming an arrival and requesting an overnight stay",
    )
    R.heading("Rules and Security in Action")
    intro(
        "HAVEN tells the guest clearly when entry is refused. Figure 17 shows four refusals from the same "
        "demo run: a day walk-in after the 20:00 cut-off; a QR code two minutes old (codes are accepted for "
        "only 30 seconds); a phone about 1 km from the gate after three GPS attempts, where the guest is offered "
        "to ask the host to confirm instead; and a guest whom the warden had banned."
    )
    R.grid(
        [
            (BUILD / "s01-entry-closed.png", 106, "(a) Walk-in at 20:05", None),
            (BUILD / "s02-code-changed.png", 106, "(b) Old QR code", None),
            (BUILD / "s03-ask-host.png", 106, "(c) GPS failed 3 times", None),
            (BUILD / "s04-banned.png", 106, "(d) Banned guest", None),
        ],
        112,
        caption="Rules and security in action (guest's phone)",
        label_size=9,
    )
    R.heading("Gate, Warden and Office")
    intro("These screens were taken on a laptop and are cropped to their content. The gate screen shows only the rotating QR code, a bar counting down to the next code and a short instruction (Figure 18).")

    def desk(items, title):
        """Full-width desktop crops stacked in one figure: items = (file, label)."""
        for i, (name, label, *w) in enumerate(items):
            p = R.doc.add_paragraph()
            p.add_run().add_picture(str(BUILD / f"{name}.png"), width=Pt(w[0] if w else TEXT_W - 195))
            fmt(p, WD_ALIGN_PARAGRAPH.CENTER, 4, 1, keep=True)
            if label:
                lp = R.doc.add_paragraph()
                set_font(lp.add_run(label), 10)
                fmt(lp, WD_ALIGN_PARAGRAPH.CENTER, 0, 2, keep=i < len(items) - 1)
                lp.paragraph_format.keep_with_next = True
        R._caption(R.doc, title)

    R.grid(
        [(BUILD / "d01-gate-display.png", 110, None, None)],
        120,
        caption="Gate display: rotating QR code, 10-second countdown bar and the instruction; no personal data",
    )
    intro("The warden's dashboard gives counts, the gate's status and the latest events, and updates live (Figure 19).")
    p = R.doc.add_paragraph()
    p.add_run().add_picture(str(SHOTS / "w01-warden-dashboard.png"), width=Pt(TEXT_W - 190))
    fmt(p, WD_ALIGN_PARAGRAPH.CENTER, 4, 1, keep=True)
    R._caption(R.doc, "Warden dashboard: counts, gate status and latest events (live)")
    intro("For safety checks the warden can list everyone inside, with warnings such as overstays (Figure 20); opening a visit shows the gate photo beside the profile photo, and the visit's timeline (Figure 21).")
    desk([("w02-inside-now", None)], "Warden: everyone inside now, with warnings")
    desk([("w03-visit-photos", "(a) Visit detail: live photo at the gate beside the profile photo", 140), ("w04-visit-timeline", "(b) Timeline of the same visit")], "Warden: one visit")
    intro("An overnight request shows the host's history and the charge, to help the warden decide (Figure 22).")
    desk([("w05-approvals", None)], "Warden: overnight approvals with host history and charge")
    intro("The warden also sets the hostel's times and limits and manages the gate screens (Figure 23); office staff see only charges, which they confirm and mark as paid (Figure 24).")
    desk([("w06-rules", "(a) Rules editor: times and limits"), ("w07-gates", "(b) Gate with its location and paired screen")], "Warden: rules and gates")
    desk([("o01-office-charges", None)], "Office: charges awaiting confirmation and payment")

    # ------------------------------------------------------------------ 9
    R.chapter_start(CHAPTERS[8])
    R.heading("Strategy")
    R.para(
        "Automated tests check that HAVEN keeps its rules, so mistakes are caught before users meet them. "
        "Each kind of test checks a different layer. Unit tests check small pieces of code on their own. "
        "Integration tests send real requests to the server, backed by a real PostgreSQL database. Database "
        "tests, written with pgTAP, check that the database itself refuses bad data. End-to-end tests drive "
        "the real app in Chromium (the open-source version of Chrome) with a simulated GPS and camera; one "
        "even plays a video of the gate QR into the camera to test the app's built-in scanner. Tests set the "
        "clock themselves, so time rules are checked at exact limits: entry at 19:59 is allowed, at 20:00 "
        "refused.",
        size=11.5,
    )
    intro("Table 9.1 gives the counts from a fresh, complete run on 21 October 2026; every test passed.")
    R.table(
        "Automated tests by level (fresh run, 21 October 2026)",
        ["Level", "Files", "Tests"],
        [
            ["Server unit tests (including 270 visit-state cases)", "22", "409"],
            ["Server integration tests (real PostgreSQL)", "30", "480"],
            ["Shared code (rules checker, QR reading, wording)", "13", "158"],
            ["App unit tests (including shared screen styles)", "6", "22"],
            ["Database tests (pgTAP)", "4", "35"],
            ["End-to-end tests (Playwright, Chromium)", "—", "31"],
        ],
        [260, 80, 111],
        size=10.5,
        align_center=False,
    )
    R.para(
        "**Journeys with end-to-end tests.** Pre-invite (F1), walk-in (F2) and resident onboarding (F7) are "
        "covered in full. Location could not be verified (F3), check-out (F5), overnight request (F6), gate "
        "pairing (F8), dispute (F9) and forgotten check-out (F10: overstay, warning and forced check-out) "
        "are covered in part, with their other steps tested through the server. Host-assisted entry (F4) "
        "and staff invite (F11, which needs real Google sign-in) are tested through the server only.",
        size=11.5,
    )
    R.para(
        "**Continuous integration (CI).** Every change pushed to the project's online repository is checked "
        "automatically on GitHub. The run on 19 October 2026 passed every step: code checks, all unit and "
        "integration tests, the build, a check that the server starts, the database tests (35/35) and a scan "
        "of outside libraries for known security problems. There, end-to-end tests run only for proposed "
        "changes (pull requests), so they were not in that run; they pass on the team's laptop.",
        size=11.5,
    )
    R.heading("Requirement Coverage")
    R.para(
        "A separate quality review checked, one by one, all 159 items the system must meet — features, "
        "quality targets, hostel rules, unusual situations and test scenarios — against the code and its "
        "tests, and wrote its findings down before any fix. It found 6 failing items and 5 critical defects; "
        "all were fixed the same day, each with a regression test shown to fail on the old code.",
        size=11.5, after=4,
    )
    intro("Table 9.2 shows the results before and after the fixes.")
    R.table(
        "Quality review results before and after the fixes",
        ["Category", "Items", "PASS", "FAIL", "PARTIAL", "NOT TESTABLE"],
        [
            ["Features", "50", "47", "0", "3", "0"],
            ["Quality targets", "14", "2", "0", "5", "7"],
            ["Hostel rules", "20", "20", "0", "0", "0"],
            ["Unusual situations", "24", "22", "0", "1", "1"],
            ["Test scenarios", "51", "51", "0", "0", "0"],
            ["**All, after the fixes**", "**159**", "**142**", "**0**", "**9**", "**8**"],
            ["All, at the review (before)", "159", "116", "6", "29", "8"],
        ],
        [150, 50, 50, 50, 65, 86],
        size=10.5,
        align_center=True,
    )
    R.para(
        "PARTIAL means built but incomplete or not fully tested; NOT TESTABLE means it needs a deployed "
        "system, real devices or real people. Quality targets such as response time, load, the 5-second "
        "dashboard update, delivery of phone notifications, other browsers and accessibility are **not yet "
        "measured**.",
        size=11.5,
    )
    R.heading("Notable Defects Found and Fixed")
    R.para(
        "Walk-in guests were not held to the entry cut-off, so a day guest could enter at 20:30; the "
        "production build of the server could not start; guests' consent was not recorded; live updates used "
        "a database connection that cannot carry them, and photos would have been saved where they are lost "
        "on restart; a database rule returned the wrong error (found by the database tests); the server sent part of every reply twice (found in the phone rehearsal); and the gate's check-in "
        "screen did not name the host (found while taking this report's screenshots). Each was fixed with a "
        "regression test.",
        size=11.5,
    )

    # ------------------------------------------------------------------ 10
    R.chapter_start(CHAPTERS[9])
    R.heading("Progress Against the Previous Development Plan")
    intro(
        "Table 10.1 compares the four phases planned in our previous report with what exists today. "
        "\"Changed\" means the item was replaced by a different design (Chapter 2); \"Dropped\" means it was "
        "removed on purpose."
    )
    R.table(
        "Previous development plan (Phases 1–4) and current status",
        ["Phase", "Planned deliverable", "Status", "Note"],
        [
            ["1 Core and invites", "Database schema (users, hostels, rooms, visits, tokens)", "Changed", "25 tables; no token table, as codes are no longer stored"],
            ["—", "OTP registration for visitors", "Done", "Test numbers only; real SMS planned"],
            ["—", "Walk-in request and resident approval", "Done", "Host decides within 10 minutes"],
            ["—", "Visit state management", "Done", "8 states, 19 allowed moves"],
            ["—", "Login and walk-in approval screens", "Done", "Residents use Google sign-in (e-mail sign-in in the demo)"],
            ["—", "Pre-invite with a shareable token", "Done", "Invite link"],
            ["2 QR, GPS, check-out", "QR token, 15 s rotation, single use", "Changed", "New code every 10 s, accepted for 30 s, not single-use"],
            ["—", "Geofence with Turf.js", "Changed", "Simple distance check in the server"],
            ["—", "Check-in with QR scanning", "Done", "Phone camera or the app's own scanner"],
            ["—", "Separate check-out QR and endpoint", "Changed", "One QR; the server offers check-out"],
            ["—", "Gate display page", "Done", "Paired by code; works offline"],
            ["—", "Location event collection", "Dropped", "Location is read only at a scan (privacy)"],
            ["—", "Automatic check-out engine", "Changed", "No automatic check-out: overstays flagged, night check, host or warden checks the guest out"],
            ["3 Dashboards, rules, alerts", "Security dashboard (Supabase Realtime)", "Changed", "No security role; warden dashboard with live updates"],
            ["—", "Warden dashboard, occupancy, history", "Done", "Inside now, search, roll call"],
            ["—", "Rules engine: visiting hours, limits", "Done", "20 rules, stored as versioned settings"],
            ["—", "Visitor alerts; Firebase messaging", "Partly", "Notification queue and push built; push on real phones planned"],
            ["—", "Deployable to a real hostel", "Planned", "Not yet deployed (Chapter 11)"],
            ["4 Analytics, hardening, polish", "Rate limiting; complete audit log", "Done", "Plus a record of who viewed sensitive data, and a separate security review"],
            ["—", "Analytics page (peak hours, return rates)", "Dropped", "Data-protection law limits data use; counts and export only"],
            ["—", "Digital visitor pass (screen or PDF)", "Changed", "Invite link and My visits instead; no PDF"],
            ["—", "Unit tests for the token service", "Done", "Plus integration, database and end-to-end tests"],
            ["—", "Dark mode", "Planned", "Not built (light theme only)"],
            ["—", "Resident onboarding", "Done", "Warden verifies each resident"],
            ["—", "Deployed production", "Planned", "Render, Vercel, Supabase"],
        ],
        [80, 150, 52, 169],
        size=9.5,
        keep_together=False,
    )
    R.heading("Methodology")
    R.para(
        "The team first studied how visitor entry works at GH-8 and turned it into written rules, user "
        "flows, a data model and security requirements. The implementation was carried out with AI-assisted "
        "coding tools, working from the team's design; the team reviewed every milestone, wrote the "
        "specification for each one beforehand and recorded every change from the plan with its reason. "
        "When the features were complete, the team arranged separate security and quality reviews, fixed "
        "every defect they reported, and tested the whole system live on real phones."
    )
    R.heading("Team Contributions")
    intro("Table 10.2 records each member's main contributions.")
    R.table(
        "Team contributions",
        ["Member", "Area", "Contributions"],
        [
            ["Keerat Punia (UE238044)", "Technical lead and system architecture", "Design document authoring; architecture; gate QR, scan-session and geofence security design; milestone planning and AI-agent orchestration; review of each milestone; integration; live phone rehearsals; repository and setup."],
            ["Pankhuri Bhatia (UE238068)", "Requirements, business rules and user experience", "Study of GH-8's visitor process and rules; business rules (visiting hours, guest limits, gender zones, overnight quota, charges); user flows; review of guest and resident screens, copy and accessibility."],
            ["Naeva Setia (UE238059)", "Data, privacy and backend review", "Data model and database design review; visit state machine review; notification and scheduled-job requirements; privacy, retention and consent (DPDP Act); review of security audit findings."],
            ["Aarush Bhandari (UE238001)", "Testing and documentation", "Test scenarios and acceptance checks; manual testing on phones and laptops; warden and office flow review; report compilation."],
        ],
        [95, 110, 246],
        size=10.5,
    )
    R.para(
        "Key design decisions — removing receptionist verification, the GPS check against QR sharing, the "
        "resident-approval model and the accepted second scan for first-time walk-ins — were made jointly "
        "by the team."
    )

    # ------------------------------------------------------------------ 11
    R.chapter_start(CHAPTERS[10])
    intro(
        "The prototype is working, tested code, but it runs only on one laptop with demo data. Table 11.1 "
        "lists what must still happen before HAVEN can be used at GH-8; all of it is planned, none done yet."
    )
    R.table(
        "Limitations of the prototype and the planned next phase",
        ["Area", "Today", "Next phase (planned)"],
        [
            ["Hosting", "One laptop, local database, temporary internet address", "Supabase project, server on Render, web app on Vercel, fixed secure (HTTPS) addresses, real photo storage"],
            ["SMS", "Fixed code 123456 for test numbers; other codes shown on the laptop", "MSG91 account, with sender name and message templates registered with India's telecom regulator (required by law)"],
            ["Google sign-in", "E-mail sign-in for developers only", "Google sign-in set up for the web and Android apps"],
            ["Android and push", "Everything in the phone's browser; in-app banners", "An installable Android app with push notifications, tested on real phones"],
            ["GPS at the gate", "Placeholder location, 150 m radius for indoor demos", "Measure the real gate on site, tune the radius, test with different phones"],
            ["Performance, accessibility", "Not measured", "Scan-to-check-in time on a mid-range phone over 4G, load test, Safari and Samsung Internet, accessibility check"],
            ["Web security settings", "Not set up yet", "Browser security headers (Content-Security-Policy, HSTS) that block common web attacks"],
            ["Warden acceptance", "Built from the team's design", "Walkthrough with the GH-8 warden and office; their approval of the privacy and message wording before any real data"],
        ],
        [90, 160, 201],
        size=10,
    )
    R.para("Other known gaps:", after=4, keep=True)
    R.bullets(
        [
            "Two planned features are not built: a map preview when the warden sets the gate location, and the pictures on the \"camera blocked\" help screen.",
            "Host-assisted entry is tested through the server only, not yet with an end-to-end test.",
            "A first-time walk-in guest scans the QR code a second time (Chapter 4); this may be revisited.",
            "An outsider who simply walks in without scanning is not stopped; HAVEN detects and records, it does not lock the gate.",
            "Suggested in the phone rehearsal: fill in an invited guest's name and gender from the invite.",
            "If a guest's photo is refused as a duplicate (the server refuses the same picture twice), the guest sees only \"Something went wrong\"; no clearer message was written for this case.",
        ],
        size=11.5,
    )

    # ------------------------------------------------------------------ 12
    R.chapter_start(CHAPTERS[11])
    R.para(
        "Since the previous report, HAVEN has moved from a proposal to a working, tested prototype. Studying "
        "the real gate changed several parts of the design: a QR code that changes every 10 seconds and is "
        "accepted for 30, instead of a single-use code; a live photo checked by the host, instead of a device "
        "fingerprint; no security-staff role; and a queue that delivers notifications reliably. In the "
        "separate quality review, 142 of 159 items passed, and every critical defect and every "
        "high-severity security finding has been fixed. The main user journeys have been tried on real "
        "phones. What remains is mostly outside the code: putting HAVEN on a server, real SMS and Google "
        "sign-in, the Android app, measuring GPS at the real gate, performance measurements and the "
        "warden's approval. These form the plan for the next phase."
    )

    # ------------------------------------------------------------------ 13
    R.chapter_start(CHAPTERS[12])
    refs = [
        "Digital Personal Data Protection Act, 2023, Ministry of Electronics and Information Technology, Government of India. Available: https://www.meity.gov.in/data-protection-framework",
        "OWASP, QR Code Security. Available: https://owasp.org/www-community/attacks/QR_Code_Attack",
        "OWASP Top Ten Web Application Security Risks. Available: https://owasp.org/www-project-top-ten/",
        "OWASP Application Security Verification Standard. Available: https://owasp.org/www-project-application-security-verification-standard/",
        "MDN Web Docs, Geolocation API. Available: https://developer.mozilla.org/en-US/docs/Web/API/Geolocation_API",
        "MDN Web Docs, Server-sent events. Available: https://developer.mozilla.org/en-US/docs/Web/API/Server-sent_events",
        "Google, Rotating barcodes for passes. Available: https://developers.google.com/wallet/tickets/transit-passes/qr-code/resources/rotating-barcodes",
        "Merry, K., Bettinger, P., \"Smartphone GPS accuracy study in an urban environment,\" PLoS ONE, vol. 14, no. 7, 2019.",
        "Zandbergen, P. A., \"Accuracy of iPhone locations: a comparison of assisted GPS, WiFi and cellular positioning,\" Transactions in GIS, vol. 13, pp. 5–25, 2009.",
        "Krawczyk, H., Bellare, M., Canetti, R., \"HMAC: Keyed-Hashing for Message Authentication,\" RFC 2104, 1997. Available: https://www.rfc-editor.org/rfc/rfc2104",
        "Jones, M., Bradley, J., Sakimura, N., \"JSON Web Token (JWT),\" RFC 7519, 2015. Available: https://www.rfc-editor.org/rfc/rfc7519",
        "Expo Documentation. Available: https://docs.expo.dev/",
        "React Native for Web. Available: https://necolas.github.io/react-native-web/",
        "Fastify Documentation. Available: https://fastify.dev/docs/latest/",
        "Zod Documentation. Available: https://zod.dev/",
        "Kysely Documentation. Available: https://kysely.dev/",
        "PostgreSQL Documentation. Available: https://www.postgresql.org/docs/",
        "Supabase Documentation (Database, Storage). Available: https://supabase.com/docs",
        "pgTAP: Unit Testing for PostgreSQL. Available: https://pgtap.org/",
        "Vitest Documentation. Available: https://vitest.dev/",
        "Playwright Documentation. Available: https://playwright.dev/",
        "sharp: High performance Node.js image processing. Available: https://sharp.pixelplumbing.com/",
        "Expo Push Notifications. Available: https://docs.expo.dev/push-notifications/overview/",
        "Cloudflare Turnstile. Available: https://developers.cloudflare.com/turnstile/",
        "Vercel Documentation. Available: https://vercel.com/docs",
        "Render Documentation. Available: https://render.com/docs",
        "https://www.albertodirisio.com/visitor-management-systems/",
        "https://www.spacebasic.com/",
        "https://www.wanywhere.com/blogs/geofencing-attendance-system/",
        "https://www.ijraset.com/research-paper/smartaicampus-an-anti-proxy-attendance-system",
    ]
    for i, r in enumerate(refs, 1):
        p = R.doc.add_paragraph()
        set_font(p.add_run(f"{i}. {r}"), 11)
        fmt(p, WD_ALIGN_PARAGRAPH.LEFT, 0, 3)
        p.paragraph_format.left_indent = Pt(18)
        p.paragraph_format.first_line_indent = Pt(-18)

    R.doc.save(DOCX)
    return R


# --------------------------------------------------------------------------- pdf + index loop


def to_pdf():
    ps = HERE / "docx2pdf.ps1"
    subprocess.run(
        ["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", str(ps), str(DOCX), str(PDF)],
        check=True,
    )


def chapter_pages():
    found = {}
    with pymupdf.open(PDF) as doc:
        for i, page in enumerate(doc):
            m = re.search(r"^CHAPTER (\d+)\s*$", page.get_text(), re.M)
            if m:
                found.setdefault(int(m.group(1)), i + 1)
        return found, len(doc)


def prepare():
    BUILD.mkdir(exist_ok=True)
    # Desktop screenshots cropped to their content (device pixels, deviceScaleFactor 2). The
    # warden menu (450 px) is cut except on the dashboard. The rules crop starts below the
    # "Published …" line and the timeline crop ends above the "Approved" row: both were written
    # by the database's own now(), which shows the real time, not the 13:00 demo clock.
    crops = {
        "d01-gate-display": (820, 100, 1740, 1500),  # QR, countdown bar and instruction
        "w02-inside-now": (450, 80, 2560, 1270),
        "w03-visit-photos": (450, 190, 2560, 1600),
        "w04-visit-timeline": (450, 800, 2560, 1310),
        "w05-approvals": (450, 80, 2560, 900),
        "w06-rules": (450, 300, 2560, 1215),
        "w07-gates": (450, 80, 2560, 690),
        "o01-office-charges": (160, 100, 2400, 960),
    }
    # Two resident screens scroll inside the app, so a heading sits half-hidden under the top
    # bar; drop those few pixel rows (between the bar and the first whole element).
    for name, cut in (("r04-arrival-confirm", (97, 145)), ("r05-overnight-request", (97, 128))):
        with Image.open(SHOTS / f"{name}.png") as im:
            out = Image.new(im.mode, (im.width, im.height - (cut[1] - cut[0])))
            out.paste(im.crop((0, 0, im.width, cut[0])), (0, 0))
            out.paste(im.crop((0, cut[1], im.width, im.height)), (0, cut[0]))
            out.save(BUILD / f"{name}.png")
    # Refusal screens: only the top of the phone has content.
    for name in ("s01-entry-closed", "s02-code-changed", "s03-ask-host", "s04-banned"):
        crops[name] = (0, 0, 720, 800)
    for name, box in crops.items():
        if (SHOTS / f"{name}.png").exists():
            with Image.open(SHOTS / f"{name}.png") as im:
                im.crop(box).save(BUILD / f"{name}.png")


def main():
    prepare()
    pages: dict[int, int] | None = None
    for attempt in range(4):
        R = build(pages or {})
        to_pdf()
        found, total = chapter_pages()
        if found == pages:
            break
        pages = found
    else:
        sys.exit("index page numbers did not settle")
    meta = {
        "pages": total,
        "chapters": {CHAPTERS[k - 1]: v for k, v in sorted(found.items())},
        "figures": R.figures,
        "tables": R.tables,
    }
    (BUILD / "summary.json").write_text(json.dumps(meta, indent=2, ensure_ascii=False), encoding="utf-8")
    print(json.dumps(meta, indent=2, ensure_ascii=False))


if __name__ == "__main__":
    main()
