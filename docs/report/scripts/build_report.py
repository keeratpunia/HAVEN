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

    # ------------------------------------------------------------------ 1
    R.chapter_start(CHAPTERS[0])
    R.para(
        "Girls Hostel 8 (GH-8), Panjab University, records its guests in a paper register at the gate. "
        "The register cannot tell anyone who is inside right now, does not link a guest to the resident "
        "responsible for them, records no exits and cannot catch a day guest who quietly stays the night. "
        "After a breach by an unauthorised outsider the warden announced fines for hosts of unregistered "
        "guests, but without records such rules cannot be applied fairly. HAVEN replaces the register with "
        "a phone-based system: the guest scans a rotating QR code shown at the gate, the server checks that "
        "the code is fresh and that the guest's phone is at the gate, a live photo goes to the resident host, "
        "and the warden sees at any moment who is inside, whose guest they are and since when."
    )
    R.heading("What Exists Today")
    R.para(
        "Our previous report described a proposed design. Since then the team wrote a 123-page Software "
        "Design Document (SDD v3), which supersedes that design, and built the system milestone by "
        "milestone against it. Today HAVEN is a working prototype: a Fastify API with a PostgreSQL database, "
        "and one Expo code base that serves the guest pages, the resident app, the warden and office "
        "dashboards and the gate display in a web browser. All the main flows of the SDD run end to end, "
        "and they were rehearsed live on real Android phones on 19 October 2026. The prototype runs on one "
        "laptop (`pnpm demo`) with seeded, fictitious data, reachable from phones through a temporary "
        "tunnel. It has **not** yet been deployed to a staging or production server, has not used real SMS, "
        "real Google sign-in or a signed Android build, and has not processed any real person's data."
    )
    R.table(
        "Project status in numbers",
        ["Item", "Value"],
        [
            ["Specification", "SDD v3: 123 pages; 50 FR, 14 NFR, 20 BR, 24 edge cases, 51 test cases"],
            ["Commits on main", "78 (1–19 October 2026, before this report)"],
            ["Source code (tracked TypeScript, SQL and scripts)", "about 52,200 lines, tests included (API 16,600 + API tests 12,000; app 11,900; shared 3,600; SQL 1,900)"],
            ["API endpoints / app screens", "86 endpoints / 43 screens"],
            ["Database", "25 tables in schema haven, 20 migrations"],
            ["Background work", "11 scheduled jobs, 20 notification kinds"],
            ["Automated tests (fresh run, 21 Oct 2026)", "1,069 unit and integration, 31 end-to-end, 35 database (pgTAP) — all passing"],
            ["Requirement verdicts (final QA)", "142 PASS, 0 FAIL, 9 PARTIAL, 8 NOT TESTABLE of 159"],
            ["Security audit", "33 numbered findings + 4 media findings; all 3 HIGH fixed"],
            ["Recorded design decisions", "25 (DEC-001 to DEC-025)"],
        ],
        [170, 281],
    )

    # ------------------------------------------------------------------ 2
    R.chapter_start(CHAPTERS[1])
    R.heading("Design Changes")
    R.para(
        "Table 2.1 compares the design in our previous report with what is built now. Most changes were "
        "made while writing the SDD, after studying how GH-8's gate actually works: the receptionists will "
        "not check anyone, there is no resident roster and no college e-mail, and guests will not install "
        "an app (SDD §2.5). The reasons below are the ones recorded in the SDD (§2.7, decisions D1–D11) and "
        "in docs/DECISIONS.md."
    )
    R.table(
        "Previous report compared with the current design",
        ["Area", "Previous report", "Current design (built)", "Reason"],
        [
            ["Frontend", "React PWA built with Vite", "One Expo (React Native) code base, rendered on the web with React Native Web; Android build planned", "Residents and wardens need reliable push; guests still use only a browser (D5, D6)"],
            ["Backend", "Node.js with Express", "Fastify 5 modular monolith; Zod schemas; Kysely SQL", "Built-in schema validation; one service is enough for tens of visits a day (D11)"],
            ["Sign-in", "Phone OTP for visitors; passwords for others", "Phone OTP for guests; Google sign-in for residents and staff, plus phone verification for residents; 15-min JWT, rotating refresh tokens", "No college e-mail; Gmail is universal (D8)"],
            ["QR token", "15 s single-use HMAC token, stored as used", "New QR every 10 s; accepted up to 30 s old; not single-use; 80-bit HMAC; no used-token table", "Single-use blocked groups arriving together; 30 s covers a permission prompt (D2)"],
            ["Gate QRs", "Two QRs: check-in and check-out", "One QR; the server offers check-in or check-out from the visit's state; a 10-minute scan session holds the slow steps", "Simpler gate; no wrong-QR errors"],
            ["Geofence", "Turf.js, 50 m", "Haversine distance in the API; radius per gate (default 50 m); GPS fix at most 60 s old; host-confirm fallback (F3)", "A circle check needs no GIS library; GPS fails indoors"],
            ["Device check", "Device fingerprint per user", "Removed. Phone-OTP session, a scan session bound to a one-time nonce, and a live photo", "Browser fingerprints are unstable and are personal data; the host's photo check is stronger (D4)"],
            ["Live photo", "None", "In-app camera photo at every entry and exit, never a file picker; host sees it beside the profile photo", "Catches a friend's account or a relayed QR (T3, T5)"],
            ["Approval", "Resident approves every check-in", "Pre-invited guests enter on the invite and the host confirms or disputes; walk-ins need host approval in 10 min; overnight needs the warden", "Fewer taps; the host stays accountable"],
            ["Roles", "Visitor, resident, security staff (manual overrides), warden, admin", "Guest, resident, warden, office, super admin, plus the gate device as a machine principal; no security or receptionist role", "Receptionists will not verify guests (§2.5); the gate shows no personal data"],
            ["Live updates", "Supabase Realtime", "Server-Sent Events from the API, fed by PostgreSQL NOTIFY", "Clients never query the database (D7)"],
            ["Notifications", "Firebase Cloud Messaging", "Database outbox + worker; Expo push, SMS fallback (MSG91 planned), in-app list", "Retries, audit and send-after-commit (D10)"],
            ["Rules", "Fixed columns in a rules table", "Versioned JSON configuration, evaluated by one pure function shared by API and app", "Warden changes rules without a deploy (§4)"],
            ["Check-out", "Separate exit QR; GPS required", "Same QR; never refused for rule reasons; failed GPS allowed but flagged (BR-17)", "Never trap a guest inside"],
            ["Residents", "Residents also checked in and out", "Residents' own movements are not tracked", "Non-goal (SDD §2.3); privacy"],
            ["Analytics", "Visit analytics: peak hours, return rates (FR13)", "Removed; only operational reports with an audited CSV export", "DPDP purpose limitation (SDD §16.3)"],
            ["Data model", "7 entities", "25 tables; append-only gate events, approvals, rules and audit log", "Accountability record must survive"],
            ["Hosting", "Railway + Vercel; tablet or Raspberry Pi gate", "Planned: Render (API), Vercel (web), Supabase (database, storage). Today: one laptop. Gate: any phone browser paired by code", "Free tiers; no hardware to buy"],
        ],
        [66, 88, 164, 133],
        size=9.5,
        keep_together=False,
    )
    R.heading("Key Decisions Recorded During the Build")
    R.para(
        "Every divergence from the SDD and every choice it left open is recorded in docs/DECISIONS.md. "
        "The most important are listed below."
    )
    R.bullets(
        [
            "**DEC-006** — the SDD's \"30 minutes early\" rule (BR-20) contradicts one of its worked examples; the rule was kept and the contradiction recorded.",
            "**DEC-011** — a development-only e-mail sign-in replaces Google sign-in in the demo; the API refuses to start with it outside development.",
            "**DEC-013** — accepted deviation: a first-time guest who signs up in the middle of a scan must scan the gate QR once more (details in Chapter 4).",
            "**DEC-014** — office staff see charges only, never guest phones, photos or live visit events.",
            "**DEC-015 / DEC-016** — outbox, scheduled jobs, retention and account deletion; the team added a daily digest for the warden.",
            "**DEC-018** — the team's decisions on the security audit, including deferring web security headers to deployment.",
            "**DEC-019 / DEC-021** — the API ships as one esbuild bundle; photos go to private Supabase Storage buckets, served through 120-second signed links.",
            "**DEC-020** — privacy-notice wording and a stored consent version, required by the DPDP Act.",
            "**DEC-022 / DEC-023 / DEC-025** — a refused location permission goes straight to the host-confirm path; in-app browsers get a prompt to open Chrome; stored timestamps use the injected clock.",
        ],
        size=11.5,
    )

    # ------------------------------------------------------------------ 3
    R.chapter_start(CHAPTERS[2])
    R.heading("Roles and Permissions")
    R.para(
        "HAVEN has five human roles and one machine principal (SDD §3). Roles are granted per hostel, and "
        "nobody can grant themselves a role. Every API handler calls one central `authorize()` function, "
        "and responses go through role-based serializers, so for example office staff never receive a "
        "guest's phone number or photo."
    )
    R.table(
        "Roles (SDD §3.3, narrowed where DEC-014 records it)",
        ["Role", "Signs in with", "Main permissions"],
        [
            ["Guest", "Phone OTP, in the browser", "Own profile and visits: request walk-in entry, check in and out at the gate, cancel a pending walk-in"],
            ["Resident (host)", "Google + phone OTP", "After warden verification: invite guests, approve or reject walk-ins, host-assisted entry, confirm or dispute arrivals, request overnight stays, mark own guest as left; sees own guests' photos and phones"],
            ["Warden", "Google (seeded in the prototype)", "Own hostel: dashboard, roll call, verify residents, approve overnight stays, force check-out, disputes, rules, bans, suspensions, fines, charges (incl. waive), gates, office staff, reports, audit log"],
            ["Office staff", "Google (invited by the warden)", "Own hostel's charges only: confirm and mark paid. Cannot waive (only the warden can); never sees guest phones or photos"],
            ["Super admin", "Google (seeded by script)", "All hostels: search and open any visit; verify residents, suspend hosts, bans, rules, gates, audit log; create hostels, invite wardens. Not the warden's day-to-day screens (dashboard, roll call, overnight approvals, reports) or force check-out (DEC-014)"],
            ["Gate device", "Device token from pairing", "Shows the rotating QR; holds no personal data"],
        ],
        [70, 101, 280],
        size=10,
    )
    R.heading("Visit Types")
    R.table(
        "Visit types (SDD §4.1)",
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
        "The rules come from Panjab University's hostel rules 26.1–26.8 and the GH-8 warden's notice. "
        "They live in a versioned JSON configuration, so the warden can change the times, limits and "
        "charges below without a new release; the values shown are GH-8's version 1."
    )
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
            ["BR-12 / 13", "A walk-in expires if the host does not answer in 10 minutes; a guest is overstaying 15 minutes after the window ends."],
            ["BR-14", "At 22:00 every day guest still inside is listed to the warden (night sweep)."],
            ["BR-15", "A guest can be inside only one visit at a time (database constraint and rule check)."],
            ["BR-16", "Invites at most 7 days ahead; overnight requests at most 30 days ahead."],
            ["BR-17", "Check-out is never refused for a rule; a failed GPS check on exit is allowed but flagged."],
            ["BR-18", "The warden may fine a host for an unregistered guest, minimum ₹400."],
            ["BR-19 / 20", "Overnight: arrive from 08:00, leave by 12:00 on the last day; guests may arrive up to 30 minutes early."],
        ],
        [62, 389],
        size=10.5,
    )

    # ------------------------------------------------------------------ 4
    R.chapter_start(CHAPTERS[3])
    R.para(
        "The SDD defines eleven flows (F1–F11, §6). Figures 1 to 6 show the six that guests and residents "
        "meet most; Section 4.2 summarises the others. Every rule check in these flows is judged by the "
        "server's clock, never the phone's. Section 9.1 lists which flows have end-to-end browser tests."
    )
    R.heading("Guest Flows")
    fw = 8.6
    R.grid(
        [
            (DIAG / "f1-preinvite.png", diagram_width("f1-preinvite", fw), None, "F1 Pre-invite and check-in"),
            (DIAG / "f2-walkin.png", diagram_width("f2-walkin", fw), None, "F2 Walk-in at the gate"),
        ],
        225,
    )
    R.para(
        "In F2 the cut-off times are judged at the moment of the scan: a guest who scans at 19:58 and is "
        "approved at 20:03 is admitted. **DEC-013 (accepted deviation):** the SDD says a first-time walk-in "
        "signs up and continues on the same scan. In the build, signing up in the middle of a scan sends the "
        "guest back to scan the gate QR once more. Nothing they entered is lost, it affects only their first "
        "visit, and every gate action is still backed by a fresh token; the team accepted it rather than "
        "change a security-sensitive flow late in the build.",
        size=11.5,
    )
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
            "**F4 Host-assisted entry** — for a guest without a smartphone, the host scans the gate QR on their own phone, enters the guest's details and takes the guest's photo. Built and tested at the API level; no end-to-end browser test yet.",
            "**F6 Overnight request** and **F7 Resident onboarding** — Figures 5 and 6.",
            "**F8 Gate pairing and location** — the warden creates a one-time pairing code, the gate phone enters it and starts showing the QR; the warden records the gate's position from several GPS readings.",
            "**F9 Dispute** — a host who taps \"Not my guest\" within 30 minutes alerts the warden, who resolves it.",
            "**F10 Forgotten check-out** — the host taps \"My guest has left\"; otherwise an overstay is flagged 15 minutes after the window ends and escalated to the warden, who can force a check-out.",
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
        "HAVEN is a modular monolith (Figure 7): one Fastify API service, one Supabase project (PostgreSQL "
        "and Storage) and one Expo code base for all clients. Clients never touch the database; Supabase's "
        "automatic REST API does not expose the haven schema. The same API process runs the job runner, the "
        "notification outbox worker and the hub that streams live events to the warden's dashboard."
    )
    R.figure_img(DIAG / "architecture.png", "System architecture of HAVEN as built", diagram_width("architecture", 9.5, 13 * 1.333, 400))
    R.heading("Code Organisation")
    R.table(
        "Monorepo layout (pnpm workspaces + Turborepo)",
        ["Folder", "Contents"],
        [
            ["apps/api", "Fastify API: modules auth, gate, visits, rules, residents, admin, media, account, stream, notify, jobs; demo and test scripts"],
            ["apps/mobile", "Expo Router app: guest, resident, warden, office and gate screens; Playwright end-to-end tests"],
            ["packages/shared", "Pure rules engine, gate-QR parsing, API types, user-facing copy, log scrubbing"],
            ["packages/ui", "Design tokens shared by the screens"],
            ["supabase", "20 SQL migrations and 4 pgTAP test files"],
            ["docs", "SDD, decisions, traceability, QA and security reports, demo and setup guides"],
        ],
        [95, 356],
    )
    R.heading("Request Pipeline")
    R.para(
        "Every request passes the same steps (Figure 8). Validation, authorization and serialization are "
        "never skipped, and the rules engine is a pure function with no database access and no hidden "
        "clock: the time is always passed in, which is what makes it testable with plain objects."
    )
    R.figure_img(DIAG / "pipeline.png", "Request pipeline in the API", TEXT_W)
    R.heading("Visit State Machine")
    R.para(
        "A visit has 8 states and exactly 19 allowed transitions (Figure 9), held in one transition map in "
        "apps/api/src/visits/stateMachine.ts. Any other change is rejected with 409 INVALID_TRANSITION; "
        "its 270 unit-test cases try every state with every trigger, and every pair of states."
    )
    R.figure_img(DIAG / "state.png", "Visit state machine", diagram_width("state", 7.6))
    R.heading("Gate Token and Scan Session")
    R.para(
        "The gate display computes a new token every 10 seconds from a secret it received at pairing, so "
        "it keeps working if the network drops. The API accepts a token up to 30 seconds old, checks the "
        "GPS fix against the gate's circle, and opens a scan session that lasts 10 minutes and is bound to "
        "a one-time nonce held only by the phone that scanned. The slow steps — sign-in, profile, photo — "
        "happen inside that session. The check-in itself is one database transaction (Figure 10)."
    )
    R.figure_img(DIAG / "gate-sequence.png", "Gate token, scan session and check-in", diagram_width("gate-sequence", 8.5, 21))
    R.heading("Data Model")
    R.para(
        "The database has 25 tables in the schema haven (Figure 11 shows the main 17). Business rows are "
        "never deleted: residents become \"left\", bans are lifted, visits are kept. Gate events, approvals, "
        "rule versions and the audit log are append-only, enforced by database triggers, and a trigger "
        "writes an audit row, stripped of personal data, for every change to visits, residents and roles."
    )
    R.figure_img(DIAG / "er.png", "Main tables of the haven schema (key columns only)", diagram_width("er", 7.6, 12 * 1.333, TEXT_W))
    R.heading("Notifications and Scheduled Jobs")
    R.para(
        "Code that needs to notify someone only inserts a row into the notifications table, in the same "
        "transaction as the change, so a rolled-back change never notifies anyone. A worker in the API "
        "process sends them every 2 seconds, with retries, through Expo push or SMS. There are eleven "
        "scheduled jobs: eight are SQL functions (run by pg_cron on Supabase, otherwise by the API's job "
        "runner) and three run in the API. Every job receives the current time as a parameter, so tests "
        "can run it at any chosen moment (Figure 12)."
    )
    R.figure_img(DIAG / "outbox.png", "Notification outbox and scheduled jobs", diagram_width("outbox", 8.5))

    # ------------------------------------------------------------------ 6
    R.chapter_start(CHAPTERS[5])
    R.para(
        "The SDD's principle for personal data is: collect the least, show it to the fewest, keep it the "
        "shortest, log who looked. HAVEN handles phone numbers, photos and locations of guests and "
        "residents, which are personal data under India's Digital Personal Data Protection (DPDP) Act, 2023."
    )
    R.heading("Threat Model")
    R.table(
        "Main threats and mitigations (from SDD §16.1, T1–T16)",
        ["Threat", "Mitigation in HAVEN", "Residual"],
        [
            ["QR photo sent to someone off-site (T2)", "30 s token life; GPS geofence", "Low"],
            ["Someone inside relays the QR to an outsider with fake GPS (T3, T4)", "Live photo to host; dispute button; flag for suspiciously exact distance", "Medium"],
            ["Guest uses a friend's account (T5)", "Live photo beside profile photo, shown to host", "Low"],
            ["Resident lies at sign-up (T7)", "Warden checks ID-card photo and selfie", "Low"],
            ["OTP abuse, SMS pumping (T10)", "Per-phone and per-IP limits; Indian numbers only; CAPTCHA after 3 requests", "Low"],
            ["Guessing invite links, pairing codes, tokens (T11)", "128-bit invites; 40-bit codes, 10 min, 5 tries; 80-bit token MAC", "Negligible"],
            ["Broken access control (T13)", "Central authorize(); role serializers; tests for every endpoint group", "Low"],
            ["Staff misuse (T15)", "Office sees no phones or photos; reads of photos, roll call and exports audited", "Low"],
            ["Outsider walks in without scanning (T1)", "None in software; night sweep and warden checks", "High (accepted)"],
        ],
        [150, 226, 75],
        size=10,
    )
    R.heading("Security Controls")
    R.bullets(
        [
            "Gate secrets encrypted with AES-256-GCM; gate tokens, pairing codes, refresh and device tokens stored only as SHA-256 hashes.",
            "15-minute access tokens (HS256, algorithm pinned); 30-day refresh tokens rotated on every use, with reuse detection that ends the session; httpOnly cookie on the web.",
            "Zod validation of every input; 64 KB body limit (3 MB for photos); parameterised SQL only; no stack traces in responses; CORS limited to the app's own origin.",
            "Photos: JPEG/PNG checked by content, EXIF removed, resized to 720 px, stored in private buckets and served by 120-second signed links.",
            "Logs redact tokens, codes, cookies and photo paths, and show phone numbers masked.",
        ],
        size=11.5,
    )
    R.heading("Independent Security Audit")
    R.para(
        "On 18 October 2026 the code was audited against the SDD's threat model, controls checklist and "
        "every TC-SEC test case; findings were written down before any fix (docs/SECURITY-AUDIT.md). "
        "Table 6.2 gives the result. All three HIGH findings — a public room search that revealed residents' "
        "names, security controls that switched off if one setting was missing, and a vulnerable image "
        "library — were fixed with regression tests; 17 of the first 20 new security tests failed on the "
        "code before the fixes.",
        size=11.5,
    )
    R.table(
        "Security audit findings by severity",
        ["Severity", "Found", "Fixed", "Not fixed"],
        [
            ["Critical", "0", "0", "—"],
            ["High", "3", "3", "—"],
            ["Medium", "11", "10", "SA-12 web security headers: scheduled for deployment"],
            ["Low", "12", "9", "SA-18 accepted by design; SA-23 dev-tool advisories accepted; SA-22 false positive"],
            ["Info", "7", "1", "Checks that were already correct, or accepted by design"],
            ["Media review", "4", "4", "—"],
        ],
        [75, 50, 50, 276],
        size=10.5,
    )
    R.heading("Privacy and the DPDP Act")
    R.para(
        "Guests and residents see a short privacy notice and tick an explicit consent box before giving any "
        "data beyond the phone number; the consent version and time are stored. Guests confirm they are 18 "
        "or older. There are no analytics or tracking tools: data is used only for hostel entry security. Users can see their "
        "own data, correct their name and delete their account; deletion waits for an ongoing visit, then "
        "deletes photos and anonymises the person while keeping the visit record. Retention is enforced by a "
        "nightly job (Table 6.3). All the privacy wording is proposed text that still needs the warden's sign-off.",
        size=11.5,
    )
    R.table(
        "Retention schedule (SDD §16.5, job_retention)",
        ["Data", "Kept for"],
        [
            ["Scan sessions with raw GPS coordinates", "Deleted 1 day after expiry"],
            ["OTP challenges", "Deleted after 1 day"],
            ["Photos taken at the gate", "180 days"],
            ["Guest profile photo", "365 days after the guest's last visit"],
            ["Resident ID-card photo", "Deleted once the warden decides"],
            ["Visit records", "2 years, then guest details anonymised"],
        ],
        [240, 211],
        size=10.5,
    )

    # ------------------------------------------------------------------ 7
    R.chapter_start(CHAPTERS[6])
    R.para(
        "The stack is fixed by the SDD (§8.4), pinned in lockfiles and written in strict TypeScript."
    )
    R.table(
        "Technology stack",
        ["Layer", "Technology", "Why"],
        [
            ["Client", "Expo 57, React Native 0.86, React Native Web, Expo Router", "One code base; guests need only a browser"],
            ["Camera, QR, GPS", "expo-camera / getUserMedia, @zxing/browser, expo-location / Geolocation API", "Live camera only; QR scanning in the browser"],
            ["API", "Node.js, Fastify 5, Zod, luxon", "Schema-first routes; times compared in IST"],
            ["Database", "PostgreSQL (Supabase), Kysely, pg, SQL migrations", "Constraints and triggers; typed, safe SQL"],
            ["Auth", "jose (JWT HS256), phone OTP, Google Identity Services", "Short-lived tokens; Gmail sign-in"],
            ["Photos", "sharp, Supabase Storage (private buckets)", "Metadata stripped; 120 s signed links"],
            ["Notifications", "Database outbox, expo-server-sdk, SMS gateway", "Retries; sent only after commit"],
            ["Live updates, logs", "SSE (LISTEN/NOTIFY); pino with redaction; Sentry", "Live dashboards; logs without PII"],
            ["Hosting (planned)", "Render (API), Vercel (web), Supabase", "Free tiers suffice for a pilot"],
        ],
        [78, 215, 158],
        size=10,
    )
    R.para(
        "Not used yet, although the SDD lists them: TanStack Query, React Hook Form and the native Google "
        "sign-in library (needed only for the planned Android build).",
        size=11,
    )
    R.table(
        "Development and testing tools",
        ["Tool", "Use"],
        [
            ["pnpm 9.15.9, Turborepo; ESLint, Prettier", "Monorepo with cached builds; lint, format and strict type checks"],
            ["Vitest, Jest (jest-expo), Supertest, pgTAP", "Unit, integration, contract and database tests on real PostgreSQL (embedded-postgres)"],
            ["Playwright", "End-to-end tests with fake camera and GPS; Chapter 8's screenshots"],
            ["GitHub Actions", "CI: checks, tests, build, start check, pgTAP, Playwright, audit"],
            ["Cloudflare tunnel; Mermaid, Graphviz", "Demo on real phones over HTTPS; this report's diagrams (sources in the repository)"],
            ["AI-assisted coding tools", "Implementation from the SDD, reviewed by the team (Chapter 10)"],
        ],
        [170, 281],
        size=10.5,
    )
    R.table(
        "Hardware requirements (current)",
        ["Who / what", "Hardware"],
        [
            ["Guests, residents", "Any smartphone with a browser, camera, GPS and data (resident Android app planned)"],
            ["Gate display", "Any phone or tablet browser, kept charged at the gate; no scanner or kiosk"],
            ["Warden, office", "A laptop or desktop browser"],
            ["Server", "Planned: one small API server and a hosted database; the demo runs on one laptop"],
        ],
        [100, 351],
        size=10,
    )

    # ------------------------------------------------------------------ 8
    R.chapter_start(CHAPTERS[7])
    R.para(
        "All screenshots below were captured automatically from the running prototype by a Playwright script "
        "(docs/report/scripts/capture-screenshots.mjs) on the seeded demo data: every person is fictitious "
        "and phone numbers are the SDD's test numbers. Chromium's fake camera was fed a synthetic, illustrated "
        "face for each guest (drawn by scripts/fake_faces.py; not a photo of anyone), so the live photos "
        "look like photos without showing a real person. The GPS is faked at a placeholder location and the "
        "demo clock was set to 13:00 IST (20:05 for Figure 17(a)). Phone screens are 360 × 640, the size "
        "the SDD designs for.",
        size=11.5,
    )
    pw, cw = 122, 140

    def phones(items, title):
        R.grid([(SHOTS / f"{f}.png", pw, lab, None) for f, lab in items], cw, caption=title)

    R.heading("Guest")
    phones(
        [("g01-invite-landing", "(a) Invite link"), ("g02-otp", "(b) Phone OTP"), ("g03-profile-consent", "(c) Profile and consent")],
        "Guest: opening an invite and signing up",
    )
    phones(
        [("g04-scan-check-in", "(a) After scanning the gate QR"), ("g05-checked-in", "(b) Checked in"), ("g06-walk-in-waiting", "(c) Walk-in waiting for host")],
        "Guest: scanning at the gate",
    )
    R.heading("Resident")
    phones(
        [("r01-resident-home", "(a) Home"), ("r02-create-invite", "(b) Creating an invite"), ("r03-walk-in-approval", "(c) Walk-in with live photo")],
        "Resident: home, invite and walk-in approval",
    )
    R.grid(
        [
            (BUILD / "r04-arrival-confirm.png", pw, "(a) Confirming an arrival", None),
            (BUILD / "r05-overnight-request.png", pw, "(b) Overnight request", None),
        ],
        cw + 30,
        caption="Resident: confirming an arrival and requesting an overnight stay",
    )
    R.heading("Rules and Security in Action")
    R.para(
        "Figure 17 shows four refusals from the same demo run: a day walk-in after the 20:00 cut-off "
        "(BR-02), a QR code two minutes old (the 30-second token window), a phone about 1 km from the "
        "gate after three GPS attempts (F3), and a guest the warden had banned (BR-09).",
        size=11.5,
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
    R.para(
        "Desktop screens were captured at 1280 × 800 and are shown cropped to their content; the warden's "
        "navigation menu appears only in the dashboard figure.",
        size=11.5,
    )

    def desk(items, title):
        """Full-width desktop crops stacked in one figure: items = (file, label)."""
        for i, (name, label, *w) in enumerate(items):
            p = R.doc.add_paragraph()
            p.add_run().add_picture(str(BUILD / f"{name}.png"), width=Pt(w[0] if w else TEXT_W - 120))
            fmt(p, WD_ALIGN_PARAGRAPH.CENTER, 4, 1, keep=True)
            if label:
                lp = R.doc.add_paragraph()
                set_font(lp.add_run(label), 10)
                fmt(lp, WD_ALIGN_PARAGRAPH.CENTER, 0, 2, keep=i < len(items) - 1)
                lp.paragraph_format.keep_with_next = True
        R._caption(R.doc, title)

    R.grid(
        [(BUILD / "d01-gate-display.png", 150, None, None)],
        160,
        caption="Gate display: rotating QR, 10-second countdown bar and the instruction; no personal data",
    )
    p = R.doc.add_paragraph()
    p.add_run().add_picture(str(SHOTS / "w01-warden-dashboard.png"), width=Pt(TEXT_W - 90))
    fmt(p, WD_ALIGN_PARAGRAPH.CENTER, 4, 1, keep=True)
    R._caption(R.doc, "Warden dashboard: counts, gate status and latest events (live)")
    desk([("w02-inside-now", None)], "Warden: everyone inside now, with flags")
    desk([("w03-visit-photos", "(a) Visit detail: live photo at the gate beside the profile photo", 200), ("w04-visit-timeline", "(b) Timeline of the same visit")], "Warden: one visit")
    desk([("w05-approvals", None)], "Warden: overnight approvals with host history and charge")
    desk([("w06-rules", "(a) Rules editor: times and limits"), ("w07-gates", "(b) Gate with its location and paired screen")], "Warden: rules and gates")
    desk([("o01-office-charges", None)], "Office: charges awaiting confirmation and payment")

    # ------------------------------------------------------------------ 9
    R.chapter_start(CHAPTERS[8])
    R.heading("Strategy")
    R.para(
        "Testing follows the SDD's plan (§19). The rules engine and state machine are tested with plain "
        "objects; API tests use a real PostgreSQL database and an injected clock, so time rules "
        "are tested at exact boundaries (19:59 allowed, 20:00 refused); pgTAP tests check constraints and "
        "triggers. Playwright drives the real app in Chromium with fake GPS and a fake camera: the camera "
        "supplies the live photos, and one test project plays a video of the gate QR into it to test the "
        "in-app scanner (FR-22). Table 9.1 gives the counts from a fresh, uncached run; all passed.",
        size=11.5,
    )
    R.table(
        "Automated tests by level (fresh run, 21 October 2026)",
        ["Level", "Files", "Tests"],
        [
            ["API unit (incl. 270 state-machine cases)", "22", "409"],
            ["API integration and contract (real PostgreSQL)", "30", "480"],
            ["Shared package (rules engine, QR, copy)", "13", "158"],
            ["App unit (jest-expo) and UI package", "6", "22"],
            ["Database (pgTAP)", "4", "35"],
            ["End-to-end (Playwright, Chromium)", "—", "31"],
        ],
        [260, 80, 111],
        size=10.5,
        align_center=False,
    )
    R.para(
        "**Flows with end-to-end browser tests:** F1, F2 and F7 in full; F3, F5, F6, F8 (pairing), F9 and "
        "F10 (overstay, escalation, forced check-out) in part, with the remaining steps tested at the API level; F4 (host-assisted entry) and F11 "
        "(staff invite, which needs real Google sign-in) at the API level only.",
        size=11.5,
    )
    R.para(
        "**Continuous integration.** GitHub Actions ran on the pushed repository on 19 October 2026 "
        "(commit 24aaa59) and passed every step: checks, all unit and integration tests, build, start check, "
        "pgTAP via the Supabase CLI (35/35) and the audit. Playwright runs only on pull requests, so it was "
        "skipped there; it passes locally.",
        size=11.5,
    )
    R.heading("Requirement Coverage")
    R.para(
        "An independent QA review (docs/FINAL-QA-REPORT.md) checked all 159 requirements, edge cases and "
        "test cases in code and tests, without trusting our own traceability file. It found 6 failing items "
        "and 5 critical defects; all were fixed the same day, each with a regression test that was "
        "shown to fail on the old code. Table 9.2 shows the verdicts before and after.",
        size=11.5,
    )
    R.table(
        "Requirement verdicts before and after remediation",
        ["Category", "Items", "PASS", "FAIL", "PARTIAL", "NOT TESTABLE"],
        [
            ["Functional (FR)", "50", "47", "0", "3", "0"],
            ["Non-functional (NFR)", "14", "2", "0", "5", "7"],
            ["Business rules (BR)", "20", "20", "0", "0", "0"],
            ["Edge cases (E)", "24", "22", "0", "1", "1"],
            ["Test cases (TC)", "51", "51", "0", "0", "0"],
            ["**All, after remediation**", "**159**", "**142**", "**0**", "**9**", "**8**"],
            ["All, at the audit (before)", "159", "116", "6", "29", "8"],
        ],
        [150, 50, 50, 50, 65, 86],
        size=10.5,
        align_center=True,
    )
    R.para(
        "NFRs such as response time, load, the 5-second dashboard update, push delivery, other browsers "
        "and accessibility need a deployed system or real devices and are **not yet measured**.",
        size=11.5,
    )
    R.heading("Notable Defects Found and Fixed")
    R.para(
        "Walk-ins skipped the entry cut-offs, so a day guest could enter at 20:30 (BR-02); the production "
        "build could not start; consent was not recorded; live updates used a pooled connection and photos "
        "would have gone to temporary disk; a trigger raised the wrong error code (found by pgTAP); the API "
        "wrote response headers twice (found in the rehearsal); and the gate's check-in card did not name "
        "the host (found in this report's screenshots). Each was fixed with a regression test.",
        size=11.5,
    )

    # ------------------------------------------------------------------ 10
    R.chapter_start(CHAPTERS[9])
    R.heading("Progress Against the Previous Development Plan")
    R.para(
        "Table 10.1 checks the four phases planned in our previous report against what exists today. "
        "\"Changed\" means the deliverable was replaced by a different design (Chapter 2); \"Dropped\" "
        "means it was removed on purpose.",
        size=11.5,
    )
    R.table(
        "Previous development plan (Phases 1–4) and current status",
        ["Phase", "Planned deliverable", "Status", "Note"],
        [
            ["1 Core and invites", "Database schema (users, hostels, rooms, visits, tokens)", "Changed", "25 tables; no token table, as tokens are no longer stored"],
            ["", "OTP registration for visitors", "Done", "Test numbers only; real SMS planned"],
            ["", "Walk-in request and resident approval", "Done", "Host decides within 10 minutes (F2)"],
            ["", "Visit state management", "Done", "8 states, 19 transitions"],
            ["", "Login and walk-in approval screens", "Done", "Residents use Google sign-in (dev sign-in in the demo)"],
            ["", "Pre-invite with a shareable token", "Done", "Invite link (F1)"],
            ["2 QR, GPS, check-out", "QR token, 15 s rotation, single use", "Changed", "10 s rotation, accepted up to 30 s, not single-use"],
            ["", "Geofence with Turf.js", "Changed", "Haversine in the API"],
            ["", "Check-in with QR scanning", "Done", "Phone camera or in-app scanner"],
            ["", "Separate check-out QR and endpoint", "Changed", "One QR; the server offers check-out"],
            ["", "Gate display page", "Done", "Paired by code; works offline"],
            ["", "Location event collection", "Dropped", "Location is read only at a scan (privacy)"],
            ["", "Automatic check-out engine", "Changed", "No automatic check-out: overstays flagged, night sweep, host or warden checks out (F10)"],
            ["3 Dashboards, rules, alerts", "Security dashboard (Supabase Realtime)", "Changed", "No security role; warden dashboard over SSE"],
            ["", "Warden dashboard, occupancy, history", "Done", "Inside now, search, roll call"],
            ["", "Rules engine: visiting hours, limits", "Done", "Versioned rules, BR-01 to BR-20"],
            ["", "Visitor alerts; Firebase messaging", "Partly", "Outbox and Expo push built; push on real phones planned"],
            ["", "Deployable to a real hostel", "Planned", "Not yet deployed (Chapter 11)"],
            ["4 Analytics, hardening, polish", "Rate limiting; complete audit log", "Done", "Plus audited reads and an independent audit"],
            ["", "Analytics page (peak hours, return rates)", "Dropped", "DPDP purpose limitation; counts and CSV export only"],
            ["", "Digital visitor pass (screen or PDF)", "Changed", "Invite link and My visits instead; no PDF"],
            ["", "Unit tests for the token service", "Done", "Plus integration, database and end-to-end tests"],
            ["", "Dark mode", "Planned", "Not built (light theme only)"],
            ["", "Resident onboarding", "Done", "Warden verifies each resident (F7)"],
            ["", "Deployed production", "Planned", "Render, Vercel, Supabase"],
        ],
        [80, 150, 52, 169],
        size=9.5,
        keep_together=False,
    )
    R.heading("Methodology")
    R.para(
        "The team first studied how GH-8's visitor process works in practice and wrote the SDD v3, which "
        "fixes the business rules, flows, data model, API and security requirements. Implementation then "
        "went milestone by milestone using AI-assisted coding tools: for each milestone the team wrote the "
        "specification, reviewed the output against the SDD and recorded every deviation in "
        "docs/DECISIONS.md. Once the features were complete the team commissioned independent security and "
        "QA audits, remediated every defect they found, and tested the whole system live on real phones."
    )
    R.heading("Team Contributions")
    R.table(
        "Team contributions",
        ["Member", "Area", "Contributions"],
        [
            ["Keerat Punia (UE238044)", "Technical lead and system architecture", "SDD authoring; architecture; gate QR, scan-session and geofence security design; milestone planning and AI-agent orchestration; review of each milestone; integration; live phone rehearsals; repository and setup."],
            ["Pankhuri Bhatia (UE238068)", "Requirements, business rules and user experience", "Study of GH-8's visitor process and rules; business rules (visiting hours, guest limits, gender zones, overnight quota, charges); user flows; review of guest and resident screens, copy and accessibility."],
            ["Naeva Setia (UE238059)", "Data, privacy and backend review", "Data model and database design review; visit state machine review; notification and scheduled-job requirements; privacy, retention and consent (DPDP Act); review of security audit findings."],
            ["Aarush Bhandari (UE238001)", "Testing and documentation", "Test scenarios and acceptance checks; manual testing on phones and laptops; warden and office flow review; report compilation."],
        ],
        [95, 110, 246],
        size=10.5,
    )
    R.para(
        "Key design decisions — removing receptionist verification, the GPS check against QR sharing, the "
        "resident-approval model and the accepted second scan for first-time walk-ins (DEC-013) — were made "
        "jointly by the team."
    )

    # ------------------------------------------------------------------ 11
    R.chapter_start(CHAPTERS[10])
    R.para(
        "Everything in the prototype is real code, tested against the SDD, but it runs only on one laptop "
        "with demo data. Table 11.1 lists what stands between it and use at GH-8 (docs/NEXT-PHASE.md); all "
        "of it is planned, none of it is done."
    )
    R.table(
        "Limitations of the prototype and the planned next phase",
        ["Area", "Today", "Next phase (planned)"],
        [
            ["Hosting", "One laptop, local database, temporary tunnel address", "Supabase project, API on Render, web app on Vercel, fixed HTTPS addresses; real storage buckets"],
            ["SMS", "Fixed code 123456 for test numbers; other codes printed on the laptop", "MSG91 account with sender ID and templates registered on India's DLT system"],
            ["Google sign-in", "Development-only e-mail sign-in", "Google Cloud OAuth client IDs for web and Android"],
            ["Android and push", "Everything in the phone's browser; in-app banners", "Signed Android build with Expo push, tested on real phones"],
            ["GPS at the gate", "Placeholder location, 150 m radius for indoor demos", "Measure the real gate on site, tune the radius, test with different phones"],
            ["Performance, accessibility", "Not measured", "Scan-to-check-in time on a mid-range phone over 4G, load test, Safari and Samsung Internet, accessibility audit"],
            ["Web security headers", "Not configured (SA-12)", "Content-Security-Policy and HSTS on the deployed web app"],
            ["Warden acceptance", "Built from the SDD", "Walkthrough with the GH-8 warden and office, sign-off on the proposed privacy and message wording, before any real data"],
        ],
        [90, 160, 201],
        size=10,
    )
    R.para("Other known gaps:", after=4, keep=True)
    R.bullets(
        [
            "Two SDD features are not built: the map preview when the warden sets the gate location, and the screenshots on the \"camera blocked\" help screen.",
            "Host-assisted entry (F4) is tested at the API level only.",
            "DEC-013: a first-time walk-in guest scans the QR a second time; it may be revisited.",
            "An outsider who simply walks in without scanning is not stopped (threat T1); HAVEN detects and records, it does not lock the gate.",
            "Suggested in the rehearsal: pre-fill the invited guest's name and gender from the invite.",
            "A photo refused as a duplicate (PHOTO_REUSED) shows the guest only \"Something went wrong\"; the SDD gives no wording for it.",
        ],
        size=11.5,
    )

    # ------------------------------------------------------------------ 12
    R.chapter_start(CHAPTERS[11])
    R.para(
        "Since the previous report HAVEN has gone from a proposal to a working, tested prototype. Writing "
        "the SDD first changed several parts of the design — a 10-second rotating QR accepted for 30 seconds "
        "instead of a single-use code, a live photo checked by the host instead of a device fingerprint, no "
        "security-staff role, and an outbox for notifications — and the system was then built against that "
        "specification. 142 of 159 requirement items pass, every critical defect and every high-severity "
        "security finding found by the audits has been fixed, and the main flows have been rehearsed on real "
        "phones. What remains is mostly outside the code: deployment, real SMS and Google sign-in, the "
        "Android build, on-site GPS calibration, performance measurements and the warden's acceptance. "
        "These form the plan for the next phase."
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
        "Bradner, S., \"Key words for use in RFCs to Indicate Requirement Levels,\" RFC 2119, 1997. Available: https://www.rfc-editor.org/rfc/rfc2119",
        "Expo Documentation. Available: https://docs.expo.dev/",
        "React Native for Web. Available: https://necolas.github.io/react-native-web/",
        "Fastify Documentation. Available: https://fastify.dev/docs/latest/",
        "Zod Documentation. Available: https://zod.dev/",
        "Kysely Documentation. Available: https://kysely.dev/",
        "PostgreSQL Documentation (LISTEN/NOTIFY, triggers, constraints). Available: https://www.postgresql.org/docs/",
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
