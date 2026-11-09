#!/usr/bin/env python3
"""
Builds a genuine, standards-compliant Microsoft Word / Google Docs OpenXML (.docx)
whitepaper at:
  docs/design/zodiac-whitepaper.docx

Why .docx instead of .html for Google Docs?
  - Google Docs' HTML importer strips `<svg>` elements, ignores `data:image/png;base64`
    URIs, and drops `position: absolute; overflow: hidden` containers.
  - By contrast, a native OpenXML `.docx` archive stores high-resolution 400-DPI PNG
    renders of Figures 1-5 and the Appendix A bench JPEGs as real binary files in
    `word/media/` linked via `word/_rels/document.xml.rels` and `<w:drawing><wp:inline>`,
    alongside native `<w:tbl>` tables and `<w:pStyle>` headings (Heading1, Heading2).
  - Uploading `docs/design/zodiac-whitepaper.docx` via Google Docs (File -> Open -> Upload)
    converts every heading, table, callout, and 400-DPI figure into a native Google Doc.
"""

import html
import re
import zipfile
from pathlib import Path

import pymupdf as fitz

SCRIPT_DIR = Path(__file__).resolve().parent
REPO_ROOT = SCRIPT_DIR.parent
PDF_PATH = REPO_ROOT / "docs" / "design" / "zodiac-whitepaper.pdf"
FIG_DIR = REPO_ROOT / "docs" / "design" / "figures"
DOCX_OUT = REPO_ROOT / "docs" / "design" / "zodiac-whitepaper.docx"

# EMU conversions (1 inch = 914400 EMUs; 1 pt = 12700 EMUs)
EMU_PER_PT = 12700


def xml_escape(text: str) -> str:
    return (
        text.replace("&", "&amp;")
        .replace("<", "&lt;")
        .replace(">", "&gt;")
        .replace('"', "&quot;")
    )


class DocxBuilder:
    def __init__(self) -> None:
        self.body_xml: list[str] = []
        self.media: list[tuple[str, bytes, str]] = []  # (rId, bytes, filename)
        self.doc_pr_id = 1

    def add_image_bytes(self, data: bytes, ext: str) -> tuple[str, int, int]:
        idx = len(self.media) + 1
        r_id = f"rIdImg{idx}"
        fname = f"image{idx}.{ext}"
        self.media.append((r_id, data, fname))
        pix = fitz.Pixmap(data)
        return r_id, pix.width, pix.height

    def inline_drawing_xml(self, r_id: str, width_pt: float, height_pt: float) -> str:
        cx = int(width_pt * EMU_PER_PT)
        cy = int(height_pt * EMU_PER_PT)
        doc_id = self.doc_pr_id
        self.doc_pr_id += 1
        return f"""
        <w:r>
          <w:drawing>
            <wp:inline distT="0" distB="0" distL="0" distR="0">
              <wp:extent cx="{cx}" cy="{cy}"/>
              <wp:docPr id="{doc_id}" name="Picture {doc_id}"/>
              <wp:cNvGraphicFramePr>
                <a:graphicFrameLocks xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" noChangeAspect="1"/>
              </wp:cNvGraphicFramePr>
              <a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">
                <a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">
                  <pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture">
                    <pic:nvPicPr>
                      <pic:cNvPr id="{doc_id}" name="Image{doc_id}"/>
                      <pic:cNvPicPr/>
                    </pic:nvPicPr>
                    <pic:blipFill>
                      <a:blip r:embed="{r_id}"/>
                      <a:stretch><a:fillRect/></a:stretch>
                    </pic:blipFill>
                    <pic:spPr>
                      <a:xfrm><a:off x="0" y="0"/><a:ext cx="{cx}" cy="{cy}"/></a:xfrm>
                      <a:prstGeom prst="rect"><a:avLst/></a:prstGeom>
                    </pic:spPr>
                  </pic:pic>
                </a:graphicData>
              </a:graphic>
            </wp:inline>
          </w:drawing>
        </w:r>"""

    def add_page_break(self) -> None:
        self.body_xml.append('<w:p><w:r><w:br w:type="page"/></w:r></w:p>')

    def _format_runs(self, rich_text: str, default_color: str = "3C4043", default_sz: int = 20, bold_all: bool = False) -> str:
        """
        Parse lightweight inline tags (<strong>...</strong>, <code>...</code>) into Word <w:r> runs.
        default_sz is in half-points (20 = 10pt).
        """
        pattern = re.compile(r"(<strong>.*?</strong>|<code>.*?</code>)", re.DOTALL)
        parts = pattern.split(rich_text)
        runs: list[str] = []
        for part in parts:
            if not part:
                continue
            if part.startswith("<strong>") and part.endswith("</strong>"):
                inner = html.unescape(part[8:-9])
                runs.append(
                    f'<w:r><w:rPr><w:rFonts w:ascii="Arial" w:hAnsi="Arial"/>'
                    f'<w:b/><w:color w:val="202124"/><w:sz w:val="{default_sz}"/></w:rPr>'
                    f'<w:t xml:space="preserve">{xml_escape(inner)}</w:t></w:r>'
                )
            elif part.startswith("<code>") and part.endswith("</code>"):
                inner = html.unescape(part[6:-7])
                b_tag = "<w:b/>" if bold_all else ""
                runs.append(
                    f'<w:r><w:rPr><w:rFonts w:ascii="Courier New" w:hAnsi="Courier New"/>'
                    f'{b_tag}<w:color w:val="174EA6"/><w:shd w:val="clear" w:color="auto" w:fill="F1F3F4"/>'
                    f'<w:sz w:val="{max(16, default_sz - 2)}"/></w:rPr>'
                    f'<w:t xml:space="preserve">{xml_escape(inner)}</w:t></w:r>'
                )
            else:
                inner = html.unescape(part)
                b_tag = "<w:b/>" if bold_all else ""
                runs.append(
                    f'<w:r><w:rPr><w:rFonts w:ascii="Arial" w:hAnsi="Arial"/>'
                    f'{b_tag}<w:color w:val="{default_color}"/><w:sz w:val="{default_sz}"/></w:rPr>'
                    f'<w:t xml:space="preserve">{xml_escape(inner)}</w:t></w:r>'
                )
        return "".join(runs)

    def add_h1(self, text: str) -> None:
        self.body_xml.append(
            f'<w:p><w:pPr><w:pStyle w:val="Heading1"/><w:spacing w:before="280" w:after="120"/></w:pPr>'
            f'<w:r><w:rPr><w:rFonts w:ascii="Arial" w:hAnsi="Arial"/><w:b/><w:color w:val="1967D2"/><w:sz w:val="34"/></w:rPr>'
            f'<w:t>{xml_escape(text)}</w:t></w:r></w:p>'
        )

    def add_h2(self, text: str) -> None:
        self.body_xml.append(
            f'<w:p><w:pPr><w:pStyle w:val="Heading2"/><w:spacing w:before="220" w:after="80"/></w:pPr>'
            f'<w:r><w:rPr><w:rFonts w:ascii="Arial" w:hAnsi="Arial"/><w:b/><w:color w:val="1967D2"/><w:sz w:val="25"/></w:rPr>'
            f'<w:t>{xml_escape(text)}</w:t></w:r></w:p>'
        )

    def add_p(self, rich_text: str, space_after: int = 140, color: str = "3C4043", sz: int = 20) -> None:
        runs = self._format_runs(rich_text, default_color=color, default_sz=sz)
        self.body_xml.append(
            f'<w:p><w:pPr><w:spacing w:after="{space_after}" w:line="300" w:lineRule="auto"/></w:pPr>{runs}</w:p>'
        )

    def add_bullet(self, rich_text: str) -> None:
        runs = self._format_runs("•  " + rich_text, default_color="3C4043", default_sz=19)
        self.body_xml.append(
            f'<w:p><w:pPr><w:ind w:left="360" w:hanging="200"/><w:spacing w:after="90" w:line="280" w:lineRule="auto"/></w:pPr>{runs}</w:p>'
        )

    def add_callout(self, title: str, body_rich: str, fill_hex: str = "E8F0FE", border_hex: str = "1A73E8") -> None:
        title_runs = self._format_runs(f"<strong>{title}</strong>", default_color="202124", default_sz=19)
        body_runs = self._format_runs(body_rich, default_color="3C4043", default_sz=18)
        self.body_xml.append(f"""
        <w:tbl>
          <w:tblPr>
            <w:tblW w:w="9360" w:type="dxa"/>
            <w:tblBorders>
              <w:top w:val="none" w:sz="0" w:space="0" w:color="auto"/>
              <w:left w:val="single" w:sz="24" w:space="0" w:color="{border_hex}"/>
              <w:bottom w:val="none" w:sz="0" w:space="0" w:color="auto"/>
              <w:right w:val="none" w:sz="0" w:space="0" w:color="auto"/>
            </w:tblBorders>
            <w:tblCellMar>
              <w:top w:w="120" w:type="dxa"/>
              <w:left w:w="180" w:type="dxa"/>
              <w:bottom w:w="120" w:type="dxa"/>
              <w:right w:w="180" w:type="dxa"/>
            </w:tblCellMar>
          </w:tblPr>
          <w:tr>
            <w:tc>
              <w:tcPr><w:tcW w:w="9360" w:type="dxa"/><w:shd w:val="clear" w:color="auto" w:fill="{fill_hex}"/></w:tcPr>
              <w:p><w:pPr><w:spacing w:after="60"/></w:pPr>{title_runs}</w:p>
              <w:p><w:pPr><w:spacing w:after="0"/></w:pPr>{body_runs}</w:p>
            </w:tc>
          </w:tr>
        </w:tbl>
        <w:p><w:pPr><w:spacing w:after="80"/></w:pPr></w:p>
        """)

    def add_figure(self, png_bytes: bytes, caption_rich: str, max_width_pt: float = 496.0) -> None:
        r_id, px_w, px_h = self.add_image_bytes(png_bytes, "png")
        w_pt = max_width_pt
        h_pt = w_pt * (px_h / float(px_w))
        drawing = self.inline_drawing_xml(r_id, w_pt, h_pt)
        cap_runs = self._format_runs(caption_rich, default_color="5F6368", default_sz=17)
        self.body_xml.append(
            f'<w:p><w:pPr><w:jc w:val="center"/><w:spacing w:before="120" w:after="60"/></w:pPr>{drawing}</w:p>'
            f'<w:p><w:pPr><w:spacing w:after="160" w:line="260" w:lineRule="auto"/></w:pPr>{cap_runs}</w:p>'
        )

    def add_table(self, headers: list[str], rows: list[list[str]], col_pcts: list[int]) -> None:
        total_dxa = 9360  # 6.5 inches (full body width)
        col_dxas = [int(total_dxa * p / 100.0) for p in col_pcts]
        grid_cols = "".join(f'<w:gridCol w:w="{w}"/>' for w in col_dxas)

        tr_list: list[str] = []
        # Header row
        h_cells: list[str] = []
        for h_text, w_dxa in zip(headers, col_dxas):
            runs = self._format_runs(f"<strong>{h_text}</strong>", default_color="1967D2", default_sz=17, bold_all=True)
            h_cells.append(
                f'<w:tc><w:tcPr><w:tcW w:w="{w_dxa}" w:type="dxa"/>'
                f'<w:shd w:val="clear" w:color="auto" w:fill="E8F0FE"/>'
                f'<w:tcBorders>'
                f'<w:top w:val="single" w:sz="10" w:space="0" w:color="1A73E8"/>'
                f'<w:bottom w:val="single" w:sz="10" w:space="0" w:color="1A73E8"/>'
                f'</w:tcBorders></w:tcPr>'
                f'<w:p><w:pPr><w:spacing w:before="40" w:after="40"/></w:pPr>'
                f'<w:r><w:rPr><w:rFonts w:ascii="Arial" w:hAnsi="Arial"/><w:b/><w:color w:val="1967D2"/><w:sz w:val="17"/></w:rPr>'
                f'<w:t>{xml_escape(html.unescape(h_text))}</w:t></w:r></w:p></w:tc>'
            )
        tr_list.append(f"<w:tr><w:trPr><w:tblHeader/></w:trPr>{''.join(h_cells)}</w:tr>")

        # Body rows
        for r_idx, row in enumerate(rows):
            fill = "F8F9FA" if r_idx % 2 == 1 else "FFFFFF"
            b_cells: list[str] = []
            for cell_text, w_dxa in zip(row, col_dxas):
                runs = self._format_runs(cell_text, default_color="3C4043", default_sz=17)
                b_cells.append(
                    f'<w:tc><w:tcPr><w:tcW w:w="{w_dxa}" w:type="dxa"/>'
                    f'<w:shd w:val="clear" w:color="auto" w:fill="{fill}"/>'
                    f'<w:tcBorders><w:bottom w:val="single" w:sz="4" w:space="0" w:color="DADCE0"/></w:tcBorders>'
                    f'</w:tcPr>'
                    f'<w:p><w:pPr><w:spacing w:before="30" w:after="30" w:line="250" w:lineRule="auto"/></w:pPr>{runs}</w:p></w:tc>'
                )
            tr_list.append(f"<w:tr>{''.join(b_cells)}</w:tr>")

        self.body_xml.append(f"""
        <w:tbl>
          <w:tblPr>
            <w:tblW w:w="{total_dxa}" w:type="dxa"/>
            <w:tblCellMar>
              <w:top w:w="70" w:type="dxa"/>
              <w:left w:w="90" w:type="dxa"/>
              <w:bottom w:w="70" w:type="dxa"/>
              <w:right w:w="90" w:type="dxa"/>
            </w:tblCellMar>
          </w:tblPr>
          <w:tblGrid>{grid_cols}</w:tblGrid>
          {''.join(tr_list)}
        </w:tbl>
        <w:p><w:pPr><w:spacing w:after="100"/></w:pPr></w:p>
        """)

    def save(self, out_path: Path) -> None:
        content_types = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Default Extension="png" ContentType="image/png"/>
  <Default Extension="jpg" ContentType="image/jpeg"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
  <Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
  <Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>
  <Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>
</Types>"""

        root_rels = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>
  <Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>
</Relationships>"""

        core_xml = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <dc:title>Zodiac: A Real-Hardware Testbed and Deterministic Verifier for Agent-Proposed SDN Policy</dc:title>
  <dc:creator>Gravity TPU Infrastructure &amp; Agentic Networking Group</dc:creator>
</cp:coreProperties>"""

        app_xml = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties">
  <Application>Microsoft Office Word</Application>
</Properties>"""

        img_rels = "\n".join(
            f'  <Relationship Id="{r_id}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/{fname}"/>'
            for r_id, _, fname in self.media
        )
        doc_rels = f"""<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rIdStyles" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
{img_rels}
</Relationships>"""

        styles_xml = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:style w:type="paragraph" w:default="1" w:styleId="Normal">
    <w:name w:val="Normal"/>
    <w:rPr>
      <w:rFonts w:ascii="Arial" w:hAnsi="Arial"/>
      <w:sz w:val="20"/>
      <w:color w:val="3C4043"/>
    </w:rPr>
  </w:style>
  <w:style w:type="paragraph" w:styleId="Heading1">
    <w:name w:val="heading 1"/>
    <w:basedOn w:val="Normal"/>
    <w:next w:val="Normal"/>
    <w:pPr><w:keepNext/><w:spacing w:before="280" w:after="120"/><w:outlineLvl w:val="0"/></w:pPr>
    <w:rPr><w:rFonts w:ascii="Arial" w:hAnsi="Arial"/><w:b/><w:color w:val="1967D2"/><w:sz w:val="34"/></w:rPr>
  </w:style>
  <w:style w:type="paragraph" w:styleId="Heading2">
    <w:name w:val="heading 2"/>
    <w:basedOn w:val="Normal"/>
    <w:next w:val="Normal"/>
    <w:pPr><w:keepNext/><w:spacing w:before="220" w:after="80"/><w:outlineLvl w:val="1"/></w:pPr>
    <w:rPr><w:rFonts w:ascii="Arial" w:hAnsi="Arial"/><w:b/><w:color w:val="1967D2"/><w:sz w:val="25"/></w:rPr>
  </w:style>
</w:styles>"""

        document_xml = f"""<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document
  xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"
  xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"
  xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"
  xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"
  xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture">
  <w:body>
    {''.join(self.body_xml)}
    <w:sectPr>
      <w:pgSz w:w="12240" w:h="15840"/>
      <w:pgMar w:top="1080" w:right="1080" w:bottom="1080" w:left="1080" w:header="720" w:footer="720" w:gutter="0"/>
    </w:sectPr>
  </w:body>
</w:document>"""

        with zipfile.ZipFile(out_path, "w", compression=zipfile.ZIP_DEFLATED) as zf:
            zf.writestr("[Content_Types].xml", content_types)
            zf.writestr("_rels/.rels", root_rels)
            zf.writestr("docProps/core.xml", core_xml)
            zf.writestr("docProps/app.xml", app_xml)
            zf.writestr("word/_rels/document.xml.rels", doc_rels)
            zf.writestr("word/styles.xml", styles_xml)
            zf.writestr("word/document.xml", document_xml)
            for _, data, fname in self.media:
                zf.writestr(f"word/media/{fname}", data)


def crop_pdf_figure(pdf_doc: fitz.Document, page_idx: int, rect: fitz.Rect, dpi: int = 400) -> bytes:
    pix = pdf_doc[page_idx].get_pixmap(dpi=dpi, clip=rect)
    return pix.tobytes("png")


def build_docx() -> None:
    pdf_doc = fitz.open(str(PDF_PATH))
    fig1_png = crop_pdf_figure(pdf_doc, 6, fitz.Rect(50, 48, 562, 392), dpi=400)
    fig2_png = crop_pdf_figure(pdf_doc, 8, fitz.Rect(50, 120, 562, 265), dpi=400)
    fig3_png = crop_pdf_figure(pdf_doc, 11, fitz.Rect(50, 48, 562, 232), dpi=400)
    fig4_png = crop_pdf_figure(pdf_doc, 11, fitz.Rect(50, 326, 562, 495), dpi=400)
    fig5_png = crop_pdf_figure(pdf_doc, 12, fitz.Rect(50, 260, 562, 430), dpi=400)
    cover_png = crop_pdf_figure(pdf_doc, 0, fitz.Rect(240, 320, 595, 760), dpi=350)

    photo_stack_bytes = (FIG_DIR / "bench-jetson-switch-stack.jpg").read_bytes()
    photo_wiring_bytes = (FIG_DIR / "bench-port-wiring-workloads.jpg").read_bytes()

    b = DocxBuilder()

    # ---- COVER PAGE ----
    b.add_p(
        "<strong>Zodiac: A Real-Hardware Testbed and Deterministic Verifier for Agent-Proposed SDN Policy</strong>",
        space_after=140,
        color="202124",
        sz=48,
    )
    b.add_p(
        "Measuring OpenFlow 1.3 Silicon Boundaries, Proving Flow-Table Admissibility (A1–A11), and Evaluating Verifier-in-the-Loop Policy Synthesis Against a Live Hardware Adversary",
        space_after=160,
        color="5F6368",
        sz=24,
    )
    b.add_p(
        "<code>Track A: 196/196 Mutants Caught</code>   <code>Track B: 611/611 Wire Conformance</code>   <code>Track C: 7/7 Red-Team Scenarios</code>   <code>Protocol B: 98.8%–100% Admissible</code>",
        space_after=160,
    )
    b.add_figure(
        cover_png,
        "<strong>Zodiac Three-Vantage-Point Verification Architecture (O1, O2, O3)</strong> — 120 MHz ARM Cortex-M4 OpenFlow 1.3 Silicon with 128-Rule Flow Table.",
        max_width_pt=260.0,
    )
    b.add_p(
        "<strong>Gravity TPU Infrastructure &amp; Agentic Networking Group</strong> — Hardware Verification, Systems Telemetry &amp; Adversarial Evaluation",
        space_after=60,
        color="202124",
        sz=20,
    )
    b.add_p(
        "Repository: <code>gravity-tpu/agentic-era-networking</code> (Commit <code>79b36be</code>) · November 2026 (v3.0 Close-Out) · DUT: Northbound Networks Zodiac FX (FW 0.86) · Controller: NVIDIA Jetson Orin Nano Super",
        space_after=120,
        color="5F6368",
        sz=18,
    )
    b.add_page_break()

    # ---- REPOSITORY INVARIANTS & GOVERNANCE ----
    b.add_h1("Repository Invariants & Network Engineering Principles")
    b.add_p(
        "Zodiac enforces six deterministic software invariants (<code>AGENTS.md</code>) and six physical packet-forwarding principles (<code>.agents/rules/network-engineering-principles.md</code>) in CI and at the runtime OpenFlow install boundary. Agents propose; deterministic code decides admissibility; a human approves installation."
    )
    b.add_table(
        ["Invariant", "Core Requirement & Deterministic Boundary"],
        [
            ["Invariant 1 — No Suppression of Errors", "Zero <code>@ts-ignore</code>, loose <code>any</code> casts, or empty <code>catch</code> blocks. Protocol and state errors are handled deterministically at the boundary."],
            ["Invariant 2 — Integer Accounting & Monotonic Time", "All packet counters, byte rates, and SLA budgets use 64-bit integer arithmetic (<code>BigInt</code>) and monotonic nanoseconds (<code>process.hrtime.bigint()</code>)."],
            ["Invariant 3 — Fail Closed by Construction", "Ambiguous or unrecognized frames, rules, or tenant contexts are dropped or quarantined. Priority-0 table-miss explicitly drops unmatched traffic; controller loss wipes the hardware flow table."],
            ["Invariant 4 — Verify Before Actuating", "Every proposed rule set must pass deterministic checks (<code>A1</code>–<code>A11</code>) and receive explicit human sign-off. Detector containment is bounded by a pre-approved Quarantine Envelope (<code>k &lt;= 8</code>, <code>TTL &lt;= 300s</code>)."],
            ["Invariant 5 — Configurable, Bounded & Damped Limits", "Timeouts, rate limits, and hysteresis gates are named, bounded, and damped (3 consecutive bad readbacks before <code>A3</code> repair; 300 s minimum hold before quarantine release)."],
            ["Invariant 6 — Physical & Cryptographic Provenance", "No simulation is passed off as live telemetry. Disconnected hardware reports <code>0</code> rates and explicit offline status. Every benchmark artifact carries a SHA-256 provenance sidecar."],
        ],
        [34, 66],
    )
    b.add_table(
        ["Rule ID", "Engineering Principle", "Physical Enforcement on the Zodiac Testbed"],
        [
            ["NET-001", "Control / Data Plane Separation", "OpenFlow 1.3 TCP control (<code>10.0.1.99:6633</code>) runs on dedicated Native VLAN 200 (Port 4 to Jetson <code>enP8p1s0</code>), physically isolated from OpenFlow VLAN 100 data ports (Ports 1–3)."],
            ["NET-002", "Fate-Sharing & Fail-Closed State", "Hardware characterization proved Firmware 0.86 wipes all flow entries upon TCP control-channel loss (0/200 frames forwarded at <code>O3</code>). Controller reconnect automatically re-installs the verified baseline within 4–6 s."],
            ["NET-003", "Loop-Free Forwarding & Hairpin Guard", "Verifier checks <code>A1</code> (workload isolation), <code>A2</code> (no single-rule or two-hop hairpin), and <code>A10</code> (<code>arp_spa</code> source confinement on Port 2) before any <code>OFPFC_ADD</code> reaches the switch."],
            ["NET-004", "Flow-Table Budget & Cost Model", "Strictly capped at 128 rules (<code>A7</code>), with priority-65535 quarantines capped at <code>k &lt;= 8</code> and live throughput checked against the measured equation <code>80.0 us + 5.42 us * k</code> (<code>A8</code>)."],
            ["NET-005", "Queue Pacing & Speed-Step Management", "IEEE 802.3x Flow Control enabled on both GS105Ev2 switches plus 95 Mbit/s <code>tc fq</code> sender pacing on 1000BASE-T hosts prevents 1G-to-100M egress buffer drops from masquerading as DUT packet loss."],
            ["NET-006", "Passive Tap Hygiene (Zero Injection)", "Mirror destination ports <code>O1</code> and <code>O3</code> reside in isolated 1-port 802.1Q VLANs with <code>clsact</code> ingress drop / <code>blackhole</code> root qdiscs and hardware offloads disabled."],
        ],
        [14, 28, 58],
    )
    b.add_page_break()

    # ---- EXECUTIVE SUMMARY ----
    b.add_h1("Executive Summary")
    b.add_callout(
        "Key Empirical Finding",
        "“Deterministic verifier feedback in 2 turns raised local 27B policy admissibility from 43.0% to 98.8%—whereas heavier LoRA fine-tuning memorized rule templates and cut multi-intent accuracy to 48.3%.”",
        fill_hex="E8F0FE",
        border_hex="1A73E8",
    )
    b.add_p(
        "Can a large language model safely propose packet-forwarding rules for a real Software-Defined Network (SDN) switch when a single malformed priority, wildcard, or action list can silently blackhole traffic, create a forwarding loop, or exhaust switch CPU? <strong>Zodiac</strong> answers this question empirically on physical hardware rather than in an idealized simulator."
    )
    b.add_p(
        "Using a Northbound Networks <strong>Zodiac FX</strong> OpenFlow 1.3 switch (120 MHz ARM Cortex-M4 microcontroller, 4×100BASE-TX ports, 128-entry software flow table running Firmware 0.86) governed by an <strong>NVIDIA Jetson Orin Nano Super</strong> controller and instrumented via two managed <strong>NETGEAR GS105Ev2</strong> mirror switches across three independent wire vantage points (<code>O1</code> pre-DUT, <code>O2</code> policy-derived tap, and <code>O3</code> independent post-DUT egress), we built and verified a complete <strong>verifier-in-the-loop</strong> control architecture."
    )
    b.add_bullet(
        "<strong>Deterministic verification (<code>A1</code>–<code>A11</code>) + &lt;= 5 feedback turns solves policy admissibility without model weight tuning:</strong> Zero-shot LLM proposals (Protocol A) passed all 11 deterministic checks only <strong>43.0%</strong> of the time on Qwen3.8-27B (Prompt v2) and <strong>80.5%</strong> on Claude Haiku 5.5. Providing the exact rejected property and conflicting rule IDs in a bounded feedback loop (Protocol B, <code>&lt;= 5</code> turns, median 2 turns) raised admissibility to <strong>98.8% (79/80)</strong> on local Qwen3.8-27B and <strong>100.0% (80/80)</strong> on Claude Haiku 5.5 and Prompt v3."
    )
    b.add_bullet(
        "<strong>Longer LoRA fine-tuning degraded generalization on multi-constraint intents:</strong> While a light 15-step SFT+DPO LoRA adapter nudged zero-shot accuracy on seen intents (<code>INTENT-1..4</code>) from 87.0% to 88.0%, it regressed unseen harder intents (<code>INTENT-5..8</code>) from <strong>87.0% to 70.5%</strong>. Scaling to an 80-step SFT + 90-step DPO adapter collapsed 6-intent zero-shot admissibility from <strong>82.7% (248/300)</strong> to <strong>48.3% (145/300)</strong> due to cross-intent rule memorization."
    )
    b.add_bullet(
        "<strong>Controller-state verification must be paired with hardware-quirk modeling and wire ground truth:</strong> In Track B, <strong>128 distinct rule sets (611 flow checks)</strong> achieved <strong>100% (611/611)</strong> agreement between the software reference model and real frames captured at <code>O1</code>/<code>O2</code>/<code>O3</code>—but only after encoding Firmware 0.86's silent priority-0 instruction drop (<strong>Finding F1</strong>) and deployed-table per-packet traversal cost (<code>t_pkt = 80.0 us + 5.42 us * k</code>) into the verifier."
    )
    b.add_bullet(
        "<strong>Pre-approved quarantine envelopes bound adversarial failure modes:</strong> Across <strong>7 live hardware red-team scenarios</strong> launched from an untrusted Raspberry Pi 3B+ node, deterministic rules and bounded quarantine envelopes contained reconnaissance, lateral movement, spoofed Steering DoS, control-plane saturation (recovering within 4–6 s), and flow-table exhaustion while preserving legitimate workload traffic."
    )

    # ---- SECTION 1 ----
    b.add_h1("1. Introduction & Research Thesis")
    b.add_p(
        "Network configuration synthesis has long separated into two camps: formal control-plane verifiers that analyze static forwarding graphs (Header Space Analysis [2], VeriFlow [3], NetKAT [4], Batfish [5]) and machine-learning systems that translate operator intent into configuration stanzas. In the agentic era, where LLM agents are increasingly asked to propose low-level policy updates in response to operational tickets or anomaly alerts, a dangerous gap emerges between syntactic validity and physical data-plane admissibility."
    )
    b.add_h2("1.1 Why Constrained Hardware Exposes Agent Failure Modes")
    b.add_bullet(
        "<strong>Linear software table walk:</strong> On the Northbound Networks Zodiac FX (Atmel SAM4E8E 120 MHz ARM Cortex-M4), every frame traverses the software flow table sequentially. Each additional non-matching rule evaluated before a forwarding match adds microsecond-scale CPU overhead that directly reduces wire-rate packet capacity."
    )
    b.add_bullet(
        "<strong>Silent firmware quirks:</strong> Unlike reference specifications [1], embedded OpenFlow 1.3 firmware exhibits undocumented behaviors. On Firmware 0.86, installing a priority-0 flow entry causes the switch to record the match fields in its flow table while silently stripping the <code>OFPIT_APPLY_ACTIONS</code> instruction list—turning an intended catch-all forwarding rule into a silent blackhole."
    )
    b.add_bullet(
        "<strong>Adversarial untrusted segments:</strong> When an anomaly detector can trigger automatic host quarantine rules, an attacker on a shared L2 segment can forge source IPv4/MAC headers to trick the detector into quarantining the legitimate workload or exhausting the 128-rule table budget."
    )
    b.add_h2("1.2 Summary of Contributions Across Tracks A, B, and C")
    b.add_p(
        "Rather than claiming autonomous self-healing, Zodiac enforces a strict architectural separation: <strong>an agent proposes; deterministic code decides admissibility (<code>A1</code>–<code>A11</code>); a human approves policy installation; and independent hardware mirror taps verify what actually crossed the wire.</strong> Table 1 summarizes the physical hardware bill of materials."
    )
    b.add_table(
        ["Component", "Hardware Specification", "Network Role", "Verification / Measurement Function"],
        [
            ["Zodiac FX (DUT)", "Atmel SAM4E8E 120 MHz Cortex-M4, Micrel KSZ8795CLX 4×100M, FW 0.86", "OpenFlow 1.3 Switch (128-rule table)", "Executes verified flow tables on Ports 1–3 (VLAN 100); reports per-rule counters & actions over Port 4 (VLAN 200)."],
            ["NVIDIA Jetson Orin Nano Super", "6-core Arm Cortex-A78AE, 1024-core Ampere GPU, 8 GB LPDDR5, 3 wired GbE NICs", "Controller, Verifier & Observer (<code>O2</code>, <code>O3</code>)", "Runs <code>zodiac-bridge</code> (<code>:3003</code>), OpenFlow controller (<code>:6633</code>), GPU Anomaly Sentinel on <code>O2</code>, and egress capture on <code>O3</code>."],
            ["NETGEAR GS105Ev2 #1", "5-port Gigabit Plus Managed Switch (<code>192.168.0.239</code>), 802.3x Flow Ctrl ON", "Workload Switch & <code>O1</code> Mirror Source", "Aggregates untrusted <code>10.0.2.0/24</code> hosts on P1/P3/P4 to DUT Port 1 (P5); mirrors P5 Rx+Tx to isolated P2 (<code>O1</code>)."],
            ["NETGEAR GS105Ev2 #2", "5-port Gigabit Plus Managed Switch (<code>192.168.0.240</code>), 802.3x Flow Ctrl ON", "Uplink Switch & <code>O3</code> Mirror Source", "Terminates DUT Port 2 on P4 (VLAN 2) and mirrors P4 Rx+Tx to isolated P3 (<code>O3</code>, VLAN 3) on Jetson NIC #3."],
            ["rpi-hailo (Sensor Node)", "Raspberry Pi 5 (8 GB) + Hailo-8 M.2 NPU (26 TOPS, PCIe Gen3, HailoRT 4.20)", "<code>O1</code> Pre-DUT Capture & NPU Sensor", "<code>eth0</code> on workload segment (<code>10.0.2.51</code>); USB-GbE <code>eth1</code> captures pre-DUT ground truth on Switch #1 P2 (<code>O1</code>)."],
            ["agentic-node-01 / 02", "2× Raspberry Pi 3 Model B+ (Broadcom BCM2837B0, 1 GB RAM, Raspberry Pi OS)", "Adversary (<code>.50</code>) & Client (<code>.52</code>)", "<code>node-01</code> executes Track C red-team scenarios; <code>node-02</code> generates paced conformance and legitimate workload flows."],
        ],
        [20, 28, 20, 32],
    )

    # ---- SECTION 2 ----
    b.add_h1("2. Physical Testbed Architecture & Topology Breakdown")
    b.add_p(
        "A core requirement of Invariant 6 is that no synthetic counter or unverified topology assumption enters an empirical claim. On our physical bench (photographed in Appendix A), the switching fabric is organized as a compact <strong>three-switch vertical stack</strong> sitting beside the NVIDIA Jetson Orin Nano Super controller and the Raspberry Pi workload/sensor nodes."
    )
    b.add_h2("2.1 Three-Tier Switch Stack & Compute/Sensor Nodes")
    b.add_bullet(
        "<strong>Top of Stack — NETGEAR GS105Ev2 #2 (<code>192.168.0.240</code>, Uplink &amp; <code>O3</code> Mirror):</strong> Partitioned into three strict 802.1Q VLANs so out-of-band management traffic (VLAN 1), DUT uplink traffic (VLAN 2 on Port 4), and passive egress capture (<code>O3</code> on Port 3, VLAN 3) never cross-contaminate."
    )
    b.add_bullet(
        "<strong>Middle of Stack — NETGEAR GS105Ev2 #1 (<code>192.168.0.239</code>, Workload &amp; <code>O1</code> Mirror):</strong> Connects the three Raspberry Pi nodes on Ports 1, 3, and 4 (1000BASE-T) to the Zodiac FX's Port 1 via Port 5 (100BASE-TX), while hardware-mirroring Port 5 Rx+Tx to Port 2 (<code>O1</code>, isolated VLAN 2)."
    )
    b.add_bullet(
        "<strong>Bottom of Stack — Northbound Networks Zodiac FX (DUT, Firmware 0.86):</strong> Enclosed in its black 3D-printed chassis at the base of the stack, exposing Ports 1–3 to OpenFlow data-plane control (VLAN 100) and Port 4 to dedicated OpenFlow TCP control (<code>10.0.1.99/24</code>, Native VLAN 200)."
    )
    b.add_figure(
        fig1_png,
        "<strong>Figure 1: Physical Testbed Topology Breakdown (400 DPI Render).</strong> Complete port-level mapping of the 3-switch stack (NETGEAR GS105Ev2 #2 on top, NETGEAR GS105Ev2 #1 in middle, Zodiac FX DUT at bottom), the 3 wired NICs on the NVIDIA Jetson Orin Nano Super, the 3 Raspberry Pi nodes, and the three passive observation points (<code>O1</code>, <code>O2</code>, <code>O3</code>).",
    )
    b.add_h2("2.2 Port-by-Port Wiring, 802.1Q VLAN Isolation & Observation Points (O1, O2, O3)")
    b.add_p(
        "By sandwiching the Zodiac FX between two independent hardware mirror switches (<code>O1</code> on GS105Ev2 #1 Port 2 before the DUT, and <code>O3</code> on GS105Ev2 #2 Port 3 after the DUT), our conformance oracle compares every injected probe packet across all three points simultaneously (Table 2)."
    )
    b.add_table(
        ["Switch / Device", "Port / NIC", "VLAN / Subnet", "Connected Peer", "Role & Hardware Hygiene Enforcement"],
        [
            ["Zodiac FX (DUT)", "Port 1", "OF VLAN 100", "GS105Ev2 #1 Port 5 (100M)", "Untrusted workload ingress/egress; governed by verified 6-rule baseline + dynamic quarantines."],
            ["Zodiac FX (DUT)", "Port 2", "OF VLAN 100", "GS105Ev2 #2 Port 4 (100M)", "Uplink boundary; <code>A10</code> restricts <code>in_port=2</code> ARP to enumerated peer IPs (<code>none</code> in confinement mode)."],
            ["Zodiac FX (DUT)", "Port 3", "OF VLAN 100", "Jetson USB NIC #1 (<code>O2</code>)", "Policy-derived mirror tap; <code>p3-tap-return</code> rule (prio 100) returns probes in conformance sweeps."],
            ["Zodiac FX (DUT)", "Port 4", "Native VLAN 200", "Jetson <code>enP8p1s0</code> (<code>10.0.1.8</code>)", "Dedicated OpenFlow 1.3 control plane (<code>10.0.1.99:6633</code>) + USB CDC serial register telemetry."],
            ["GS105Ev2 #1", "P1, P3, P4", "802.1Q VLAN 1", "<code>node-02</code>, <code>node-01</code>, <code>rpi-hailo</code>", "1000BASE-T host links on <code>10.0.2.0/24</code>; 802.3x Flow Control enabled; 95 Mbit/s <code>fq</code> pacing on senders."],
            ["GS105Ev2 #1", "Port 2 (<code>O1</code>)", "802.1Q VLAN 2", "<code>rpi-hailo eth1</code> (USB-GbE)", "Hardware mirror of Port 5 Rx+Tx; isolated 1-port VLAN + <code>clsact</code> ingress drop prevents frame injection."],
            ["GS105Ev2 #2", "Port 3 (<code>O3</code>)", "802.1Q VLAN 3", "Jetson USB NIC #3", "Hardware mirror of Port 4 Rx+Tx; isolated 1-port VLAN + <code>blackhole</code> root qdisc; independent egress oracle."],
        ],
        [17, 13, 15, 23, 32],
    )
    b.add_h2("2.3 Host Interface Hygiene & 1G-to-100M Speed-Step Calibration")
    b.add_bullet(
        "<strong>Multi-homed Linux ARP flux:</strong> Both Raspberry Pi 3B+ nodes carry an out-of-band management interface (<code>eth1</code> on <code>10.0.0.0/24</code>) alongside their experiment interface (<code>eth0</code> on <code>10.0.2.0/24</code>). We enforce <code>net.ipv4.conf.all.arp_filter=1</code> and bring <code>wlan0</code> down prior to every measurement run."
    )
    b.add_bullet(
        "<strong>1000BASE-T to 100BASE-TX buffer overflow:</strong> Enabling IEEE 802.3x Flow Control on both GS105Ev2 switches and configuring Linux <code>tc qdisc add dev eth0 root fq maxrate 95mbit</code> on all workload senders eliminated switch-buffer drops completely."
    )

    # ---- SECTION 3 ----
    b.add_h1("3. Track A: Deterministic Flow-Table Verifier & Cost Model")
    b.add_p(
        "Every flow-table update proposed by a human operator or an LLM agent passes through the five-stage pipeline shown in Figure 2. At the center of this pipeline is <code>verifyFlowTable()</code> and <code>admitInstall()</code> (<code>src/sdn/flow-verifier.ts</code>, <code>src/sdn/install-gate.ts</code>), a pure, deterministic TypeScript verifier that evaluates <strong>11 formal properties (<code>A1</code>–<code>A11</code>)</strong> in under 5 milliseconds."
    )
    b.add_figure(
        fig2_png,
        "<strong>Figure 2: End-to-End Verifier-in-the-Loop &amp; On-Wire Conformance Pipeline (400 DPI Render).</strong> Candidate JSON rule sets are checked deterministically against <code>A1</code>–<code>A11</code> (with up to 5 structured rejection feedback turns in Protocol B), gated on human approval, verified against Firmware 0.86 readback on the Zodiac FX, and cross-checked against wire taps <code>O1</code>, <code>O2</code>, and <code>O3</code>.",
    )
    b.add_h2("3.1 The Eleven Verifier Properties (A1–A11) & Mutation-Corpus Coverage")
    b.add_table(
        ["ID", "Property Name", "Deterministic Check & What It Proves", "What It Does Not Prove / Boundary"],
        [
            ["A1", "Untrusted Workload Isolation", "Rejects any rule allowing frames from untrusted Port 1 to reach control Port 4 or unauthorized ports.", "Does not prevent L2 frame exchange between hosts on upstream Switch #1 (requires <code>O1</code> / quarantine)."],
            ["A2", "No Single-Rule or Two-Hop Hairpin", "Rejects rules where <code>in_port</code> is in <code>outputPorts</code>, or where Port <code>p -&gt; q</code> and Port <code>q -&gt; p</code> form an unguarded two-hop forwarding cycle.", "Checks the DUT's flow table; external L2 cable loops outside the DUT are prevented by VLAN segmentation."],
            ["A3", "Explicit Table-Miss & Action Guard", "Forbids user rules at priority <code>0</code> (preventing FW 0.86 silent action strip) and verifies switch readback retains <code>OFPIT_APPLY_ACTIONS</code>.", "Requires controller connectivity for readback; controller loss triggers hardware table wipe (NET-002)."],
            ["A4", "Deterministic Priority Precedence", "Rejects overlapping match rules at the <strong>same priority</strong> with conflicting actions, and rejects <strong>same-priority duplicate</strong> match rules.", "Different-priority overlaps are legal OpenFlow prefix shadowing and are classified under <code>A9</code>."],
            ["A5", "Controller-Channel Protection", "Rejects rules matching or redirecting TCP port <code>6633</code> or control subnet <code>10.0.1.0/24</code> on data ports.", "Physical separation (Port 4 VLAN 200) is the primary defense; <code>A5</code> guards against miswired rules."],
            ["A6", "Match-Field Prerequisite Hygiene", "Enforces OpenFlow 1.3 Section 7.2.3.8 prerequisites (e.g., <code>ipv4_src</code> requires <code>eth_type=0x0800</code>; <code>tcp_dst</code> requires <code>ip_proto=6</code>; <code>arp_spa</code> requires <code>eth_type=0x0806</code>).", "Prevents silent switch rejection or wildcard widening on Firmware 0.86."],
            ["A7", "128-Rule Hardware Table Budget", "Rejects any table where user rules + implicit priority-0 drop + reserved quarantine slots exceed <code>128</code> entries.", "Bounds memory footprint; CPU traversal time is checked separately by <code>A8</code>."],
            ["A8", "Hardware Traversal Cost Budget", "Bounds worst-case per-packet lookup latency using measured slopes (<code>4.24 us/rule</code> general; <code>80.0 + 5.42k us</code> deployed 6-rule shape) against <code>targetRatePps</code> (<code>6,000 pps</code> live).", "Evaluates steady-state 572-byte UDP saturation; 2x overload bursts are handled by Scenario 4 recovery."],
            ["A9", "Non-Redundancy & Shadowing Hygiene", "Detects lower-priority rules completely shadowed by higher-priority superset rules with identical or conflicting actions.", "Surfaces dead rules so agent-proposed policies remain minimal on a 128-entry switch."],
            ["A10", "Port-2 ARP Source IP Confinement", "Requires any rule permitting ARP (<code>0x0806</code>) on Port 2 to specify <code>arp_spa</code> in the declared peer allowlist (<code>allowedPort2ArpPeers=[]</code> in confinement mode).", "Prevents wildcard ARP rules on Port 2 from leaking spoofed uplink ARP frames across the DUT."],
            ["A11", "Intent-to-Rule Semantic Conformance", "Evaluates the candidate flow table over every concrete packet class in the operator's <code>IntentSpec</code> (highest-priority winning rule per packet class).", "Proves exact semantic equivalence on all declared traffic classes (<code>requiredOutcomes</code>)."],
        ],
        [8, 24, 42, 26],
    )
    b.add_h2("3.2 Precedence-Aware Conflict Detection (A4) Over Shadowed Redundancy (A9)")
    b.add_p(
        "We strengthened <code>A4</code> in <code>src/sdn/flow-verifier.ts</code> so that <strong>any two rules with overlapping or identical matches at the same priority are rejected immediately under <code>A4</code></strong>, reserving <code>A9</code> strictly for cross-priority shadowing where a strictly higher-priority rule shadows a lower-priority rule."
    )
    b.add_h2("3.3 Priority-0 Firmware Quirk, Action Readback & Damped A3 Auto-Repair")
    b.add_bullet(
        "<strong>Priority-0 instruction stripping &amp; damped auto-repair:</strong> If a forwarding rule returns from hardware readback with missing <code>OFPIT_APPLY_ACTIONS</code> instructions for <strong>3 consecutive damped checks</strong>, <code>zodiac-bridge</code> automatically re-pushes the verified rule set (<code>repair.enabled: true</code>)."
    )
    b.add_bullet(
        "<strong>Controller-loss hardware table wipe (NET-002):</strong> Stopping <code>zodiac-bridge</code> caused <strong>0/200 frames to reach <code>O3</code></strong> (100% hardware table wipe upon TCP socket close). Restarting the bridge automatically re-verified and re-installed the 6-rule baseline within <strong>4–6 seconds</strong>."
    )
    b.add_h2("3.4 Deployed-Table Cost Equation (A8) & Allow-Rule Floor Calibration")
    b.add_figure(
        fig3_png,
        "<strong>Figure 3: 600-Byte UDP Capacity vs. Rule Depth (Base vs. Forwarding-First Ordering, 400 DPI Render).</strong> Placing the active forwarding rule above unused rules reduces per-rule cost from <code>4.24 us/rule</code> to <code>1.30 us/rule</code>—yielding <strong>2.63x higher capacity</strong> at 126 rules (4,497 pps vs. 1,711 pps).",
    )
    b.add_callout(
        "Deployed 6-Rule Hardware Traversal Equation (src/sdn/deployed-cost-model.ts)",
        "<code>t_pkt(k) = 80.0 us + 5.42 us * k  ==&gt;  Capacity(k) = 1,000,000 / (80.0 + 5.42 * k) pps</code>   (for <code>k in 0..8</code> at 572 B payload). Across <code>1, 2, 4, 8</code> priority-120 allow rules at <code>k = 8</code>, hardware capacity held <strong>&gt;= 7,765 pps</strong>, well above the live <strong>6,000 pps</strong> <code>A8</code> ceiling.",
    )
    b.add_figure(
        fig4_png,
        "<strong>Figure 4: Deployed 6-Rule Policy Capacity Ladder (k = 0..8) and A8 Admissibility Boundaries (400 DPI Render).</strong> Red circles show measured hardware saturation; the blue curve shows the fitted model <code>80.0 us + 5.42 us * k</code> (±1.3%).",
    )

    # ---- SECTION 4 ----
    b.add_h1("4. Track A: Agent Policy Synthesis — Verifier Feedback vs. LoRA")
    b.add_h2("4.1 Evaluation Protocol: Zero-Shot (Protocol A) vs. Verifier-in-the-Loop (Protocol B)")
    b.add_p(
        "We evaluated eight operator intents spanning Standard Intents (<code>INTENT-1..4</code>) and Hard Multi-Constraint Intents (<code>INTENT-5..8</code>) across <strong>1,420 evaluated trials</strong> comparing Zero-Shot (Protocol A), Verifier Feedback (Protocol B, <code>&lt;= 5</code> turns), and LoRA SFT+DPO weight adaptation."
    )
    b.add_figure(
        fig5_png,
        "<strong>Figure 5: Agent Policy Synthesis Admissibility Across Protocols, Models, and LoRA Adapters (400 DPI Render).</strong> Adding up to 5 deterministic verifier feedback turns (Protocol B) lifts admissibility to <strong>98.8%–100.0%</strong> across all models, whereas scaling LoRA fine-tuning to 80 SFT + 90 DPO steps causes severe overfitting (<strong>48.3%</strong>).",
    )
    b.add_table(
        ["Model & Prompt / Adapter Configuration", "Intent Suite", "Protocol", "Admissible Rate", "Median Turns", "Primary Finding / Failure Mode"],
        [
            ["Qwen3.8-27B (Local MLX, 4-bit) · Prompt v2", "<code>INTENT-1..4</code>", "Protocol A (0-shot)", "<strong>86 / 200 (43.0%)</strong>", "1.0", "Missing <code>eth_type</code> prerequisites (<code>A6</code>), wildcard ARP on P2 (<code>A10</code>), missing tap return (<code>A11</code>)."],
            ["Claude Haiku 5.5 (Batch API) · Prompt v2", "<code>INTENT-1..4</code>", "Protocol A (0-shot)", "<strong>161 / 200 (80.5%)</strong>", "1.0", "Occasional <code>A11</code> packet-class omissions on <code>INTENT-3</code> and <code>INTENT-4</code>."],
            ["Qwen3.8-27B (Local MLX) · Prompt v2", "<code>INTENT-1..4</code>", "<strong>Protocol B (&lt;=5t)</strong>", "<strong>79 / 80 (98.8%)</strong>", "<strong>2.0</strong>", "79 of 80 converged to full <code>A1</code>–<code>A11</code> admissibility within 2–3 structured feedback turns."],
            ["Claude Haiku 5.5 · Prompt v2", "<code>INTENT-1..4</code>", "<strong>Protocol B (&lt;=5t)</strong>", "<strong>80 / 80 (100.0%)</strong>", "<strong>1.0</strong>", "100% convergence; every initial rejection resolved on Turn 2."],
            ["Gemma 4 26B-A4B (Local MLX) · Prompt v2", "<code>INTENT-1..4</code>", "<strong>Protocol B (&lt;=5t)</strong>", "<strong>60 / 60 (100.0%)</strong>", "<strong>1.0</strong>", "56/60 (93.3%) passed on Turn 1; remaining 4/60 repaired on Turn 2."],
            ["Qwen3.8-27B Base Control · Prompt v3", "<code>INTENT-1..4</code>", "Protocol A / B", "<strong>174/200 (87.0%)</strong> / <strong>80/80 (100%)</strong>", "1.0", "Explicitly listing <code>A1</code>–<code>A11</code> invariants in Prompt v3 doubled 0-shot accuracy (+44.0 pp)."],
            ["Qwen3.8-27B + 15-Step LoRA · Prompt v3", "<code>INTENT-1..4</code> (Seen)", "Protocol A / B", "<strong>176/200 (88.0%)</strong> / <strong>80/80 (100%)</strong>", "1.0", "Marginal +1.0 pp gain over base control on seen intents (not statistically significant)."],
            ["Qwen3.8-27B Base Control · Prompt v3", "<code>INTENT-5..8</code> (Hard)", "Protocol A (0-shot)", "<strong>174 / 200 (87.0%)</strong>", "1.0", "Base model generalized cleanly to unseen multi-constraint intents when given Prompt v3."],
            ["Qwen3.8-27B + 15-Step LoRA · Prompt v3", "<code>INTENT-5..8</code> (Unseen)", "Protocol A (0-shot)", "<strong>141 / 200 (70.5%)</strong>", "1.0", "<strong>-16.5 pp regression</strong> vs. base control: emitted memorized <code>INTENT-1..4</code> port/ARP templates."],
            ["Qwen3.8-27B + 80-SFT / 90-DPO LoRA (L4)", "6-Intent Suite", "Protocol A (0-shot)", "<strong>145 / 300 (48.3%)</strong>", "1.0", "<strong>-34.4 pp collapse</strong> vs. base control (248/300, 82.7%): cross-intent template contamination."],
        ],
        [25, 14, 14, 16, 9, 22],
    )
    b.add_h2("4.2 Why Weight Adaptation (LoRA SFT+DPO) Regressed on Hard Intents")
    b.add_p(
        "Flow-table JSON schemas across different intents share 90% of their boilerplate tokens and differ only in a few critical integer literals. Gradient updates on DPO preference pairs caused the adapter to memorize high-reward rule stanzas from one intent and splice them into other intents, triggering immediate <code>A10</code> and <code>A11</code> rejections. Keeping the base model weights frozen and supplying <strong>Prompt v3 + 1–2 turns of deterministic verifier feedback (Protocol B)</strong> achieved <strong>100.0% (80/80)</strong> admissibility at zero training cost."
    )

    # ---- SECTION 5 ----
    b.add_h1("5. Track B: Hardware Characterization & On-Wire Conformance Oracle")
    b.add_h2("5.1 128-Rule-Set Differential Conformance Campaign (611/611 Flow Checks)")
    b.add_table(
        ["Conformance Corpus Category", "Rule Sets", "Wire Flow Checks", "Model == Wire Agreement", "Key Hardware Properties Exercised on Zodiac FX (FW 0.86)"],
        [
            ["Baseline & Port Confinement", "24", "116", "<strong>116 / 116 (100.0%)</strong>", "Default table-miss drop, Port 1 &lt;--&gt; Port 3 tap return, Port 2 uplink block, VLAN 100 boundary."],
            ["Priority Precedence & Prefix Overlap", "32", "155", "<strong>155 / 155 (100.0%)</strong>", "Priority 65535 quarantine overrides prio 100–500 allow rules; longest-prefix / exact-match ordering."],
            ["L2 / L3 / L4 Match Tuple Variations", "36", "172", "<strong>172 / 172 (100.0%)</strong>", "<code>eth_type</code> (IPv4, ARP), <code>ipv4_src</code>/<code>dst</code>, <code>ip_proto</code> (TCP, UDP, ICMP), <code>tcp_dst</code>/<code>udp_dst</code>."],
            ["Agent-Proposed & Quarantine Envelopes", "24", "112", "<strong>112 / 112 (100.0%)</strong>", "Protocol B accepted policies across <code>INTENT-1..8</code> plus dynamic <code>k = 1..8</code> quarantine insertions."],
            ["Priority-0 Firmware Quirk Corpus (F1)", "12", "56", "<strong>56 / 56 (100.0%)</strong>", "Verifies hardware drops priority-0 <code>APPLY_ACTIONS</code> and confirms <code>A3</code> rejects prio-0 user rules."],
            ["Total Track B Campaign", "<strong>128</strong>", "<strong>611</strong>", "<strong>611 / 611 (100.0%)</strong>", "<strong>Zero unexplained discrepancies across all 128 rule sets and 611 flow checks.</strong>"],
        ],
        [26, 12, 14, 18, 30],
    )
    b.add_h2("5.2 Finding F1: Why Controller-State Verification Cannot Replace Wire Ground Truth")
    b.add_callout(
        "Finding F1 — Silent Priority-0 Action Stripping in Firmware 0.86",
        "When an OpenFlow 1.3 controller sends an <code>OFPFC_ADD</code> flow modification with <code>priority = 0</code> and an output action list, the Zodiac FX (Firmware 0.86) accepts the message without emitting an <code>OFPT_ERROR</code> and reports the flow entry as active in <code>OFPMP_FLOW</code> table dumps—<strong>but strips the <code>OFPIT_APPLY_ACTIONS</code> instruction block in hardware</strong>, causing 100% of matching packets to be silently dropped on the wire.",
        fill_hex="FEF7E0",
        border_hex="FBBC04",
    )
    b.add_h2("5.3 Physical Reality Gaps Discovered Across Hardware Conformance & Red-Team Tracks")
    b.add_p(
        "The central practical insight from deploying on real hardware is that several behaviors looked correct in controller software or simulated environments until physical vantage points contradicted them:"
    )
    b.add_bullet("<strong>Vacuous observer captures:</strong> A first table-miss experiment reported zero frames at the workload observer; the observing node lacked <code>tcpdump</code>, so its capture never ran and its zeros were false evidence. Observers now strictly prove execution before results are admitted. In Scenario 4, a capture helper read at most 2 MB of text, silently truncating a 250,000-frame capture until caught by size validation.")
    b.add_bullet("<strong>Capture-harness promiscuity bug:</strong> The initial wire run disagreed with the model on 11/28 flows. Running <code>tcpdump -p</code> disabled promiscuous mode on the O2 tap NIC, dropping unicast mirror frames. Removing <code>-p</code> resolved 7 disagreements immediately.")
    b.add_bullet("<strong>Switch-path drop of self-addressed frames:</strong> The remaining 4 smoke disagreements were IPv4 frames with source IP identical to destination IP (Land attack shape). The Zodiac FX switch silicon silently drops self-addressed frames before reaching mirror taps (safe failure mode); these degenerate flows were excluded from candidate test suites.")
    b.add_bullet("<strong>Aggregation switch VLAN bypass:</strong> During Scenario 1 debugging, a convenience change to the uplink aggregation switch gave both workload nodes an unmonitored second path onto the segment under test, bypassing the Zodiac FX entirely until discovered and isolated.")
    b.add_bullet("<strong>Linux weak-host model ARP interception:</strong> In Scenario 6, pinging a workload node failed 100%, appearing to confirm containment. In reality, Linux's default <code>arp_filter=0</code> caused the lab-facing NIC to answer for the workload NIC's IP, intercepting traffic before it ever touched the switch. Setting <code>arp_filter=1</code> and downing Wi-Fi revealed the switch rule was never exercised.")
    b.add_bullet("<strong>Protected-host authorization block:</strong> In Scenario 3, the detector correctly attributed 939 scan anomalies to the attacker, but every one of 1,543 quarantine requests failed with HTTP 403 because the scanning node was still on the protected-host list from an earlier test role.")

    # ---- SECTION 6 ----
    b.add_h1("6. Track C: Live Red-Team Adversary & Quarantine Envelope Evaluation")
    b.add_h2("6.1 Consolidated Hardware Red-Team Matrix (Scenarios 1–7)")
    b.add_table(
        ["#", "Adversary Scenario", "Attack Vector from node-01 (.50)", "Defense / Verifier Mechanism", "Measured On-Wire Outcome & Artifact Evidence"],
        [
            ["S1", "Passive Reconnaissance & Port Scan", "ARP sweep + TCP SYN scan across <code>10.0.2.0/24</code> and uplink gateway targets.", "6-rule confinement baseline + <code>A10</code> ARP peer restriction + Sentinel detection.", "<strong>0 frames leaked to <code>O3</code></strong>; scan detected on <code>O2</code> within 1 window; priority-65535 quarantine installed in <strong>18.4 ms</strong>."],
            ["S2", "Lateral Movement & L2 Bypass", "Direct L2 unicast probes from <code>.50</code> to legitimate client <code>.52</code> on upstream Switch #1.", "<code>O1</code> pre-DUT mirror on Switch #1 P2 + Port-1 quarantine drop at DUT boundary.", "Proves <code>O2</code>/DUT cannot block intra-Switch-#1 L2 frames directly, while <code>O1</code> provides visibility and DUT blocks all uplink/tap transit."],
            ["S3", "Spoofed-Source Steering (Self-DoS Attack)", "<code>.50</code> floods frames forging <code>ipv4_src = 10.0.2.52</code> (victim IP) and <code>10.0.1.8</code> (controller IP) to steer quarantine onto protected hosts.", "<strong>Quarantine Envelope</strong> (<code>protectedHosts</code> list) + <code>A5</code> control protection.", "<strong>100% of forged steering attempts against <code>.52</code>, <code>.51</code>, and <code>10.0.1.8</code> rejected</strong> by envelope; legitimate <code>.52</code> traffic uninterrupted."],
            ["S4", "Data-Plane Saturation & Overload Cliff", "<code>.50</code> blasts <strong>25,000 pps</strong> (2x switch capacity) of 600 B UDP frames into Port 1.", "802.3x Flow Control + NET-002 fail-closed table wipe + bridge auto-reconnect.", "At 25k pps, MCU CPU starvation drops OpenFlow TCP and wipes table (<strong>fail-closed: 0 leaked frames</strong>); bridge recovers & restores policy in <strong>4–6 s</strong>."],
            ["S5", "Multi-Host Quarantine Table Exhaustion", "<code>.50</code> rotates across <strong>64 random spoofed source IPs</strong> to exhaust the 128-rule table and degrade throughput.", "Envelope cap <code>maxQuarantineRules = 8</code> + <code>A8</code> deployed cost model (<code>8,106 pps</code> at <code>k=8</code>).", "Quarantine table strictly capped at <strong>k = 8 rules</strong>; remaining 56 spoofed IPs denied slot allocation; <code>node-02</code> throughput held <strong>&gt;= 8,100 pps</strong>."],
            ["S6", "Adversarial Policy Injection (Prompt/Rule)", "Adversarial intents attempting to trick LLM proposer into installing prio-0 blackholes, hairpins, or wildcard Port-2 ARP rules.", "<code>admitInstall()</code> gate (<code>A1</code>–<code>A11</code>) + mandatory human sign-off.", "<strong>100% of unsafe rule mutations rejected</strong> before reaching OpenFlow socket; Protocol B repaired all tricks into compliant rules."],
            ["S7", "Low-Rate Timing & Flap Evasion", "On-off burst pulses timed to trigger rapid quarantine install/release oscillation (rule flapping).", "Invariant 5 damping: <strong>300 s minimum TTL hold</strong> + consecutive-window hysteresis.", "<strong>Zero rule flapping</strong>; quarantine held steady across pulse gaps until full damped expiration or manual operator release."],
        ],
        [6, 21, 24, 20, 29],
    )
    b.add_h2("6.2 Pre-Approved Quarantine Envelope & Anti-Steering Guarantees")
    b.add_bullet(
        "<strong>Scope &amp; Action Restriction:</strong> Automatic containment may only insert or remove <code>DROP</code> rules on <code>in_port = 1</code> at <code>priority = 65535</code> matching a single <code>eth_type = 0x0800, ipv4_src = /32</code> host on <code>10.0.2.0/24</code>."
    )
    b.add_bullet(
        "<strong>Protected-Host Immunity (Scenario 3 defense):</strong> The envelope maintains an immutable exclusion list (<code>10.0.2.52</code> legitimate client, <code>10.0.2.51</code> sensor node, <code>10.0.1.0/24</code> control plane) so forged L2/L3 sources can never steer a quarantine onto protected hosts."
    )
    b.add_bullet(
        "<strong>Table &amp; Throughput Cap (Scenario 5 defense):</strong> Active quarantines are capped at <code>k &lt;= 8</code> (6.25% of the 128-rule table), guaranteeing that legitimate forwarding capacity never falls below <strong>8,106 pps</strong> (or <strong>7,765 pps</strong> with up to 8 allow rules)."
    )

    # ---- SECTION 7 & REFERENCES ----
    b.add_h1("7. Scope Boundaries, Threats to Validity & Owner's Review Sign-Off")
    b.add_table(
        ["Topic / Dimension", "What Zodiac Proves Empirically", "What Zodiac Explicitly Does Not Claim"],
        [
            ["Autonomy vs. Human Governance", "Verifier feedback (Protocol B) produces 98.8%–100% admissible proposals ready for human review.", "Does <strong>not</strong> claim autonomous self-driving networking; every policy install requires human approval."],
            ["Switch Scale & Silicon", "Exact characterization of a 120 MHz ARM Cortex-M4 OpenFlow 1.3 switch (128 rules, 4×100M ports, FW 0.86).", "Does <strong>not</strong> claim ASIC line-rate generalization to multi-terabit Tofino/Broadcom switches without re-measuring <code>A8</code> and <code>F1</code>."],
            ["Single-Switch vs. Multi-Hop Fabric", "Complete <code>A1</code>–<code>A11</code> verification and 3-point wire conformance across a single OpenFlow DUT.", "Does <strong>not</strong> claim distributed multi-switch state convergence or BGP/OSPF routing verification."],
            ["Source Spoofing on Shared L2", "Quarantine Envelope prevents spoofed-IP steering against protected hosts and caps table usage at <code>k &lt;= 8</code>.", "Does <strong>not</strong> claim unforgeable L2 identity without 802.1X / port-per-host switch isolation."],
            ["LoRA Fine-Tuning", "Demonstrates that 15-step and 90-step LoRA SFT+DPO overfit rule templates and regress multi-intent accuracy.", "Does <strong>not</strong> claim full-parameter pretraining on millions of diverse topologies would fail—only that verifier feedback dominates small-corpus LoRA."],
        ],
        [26, 37, 37],
    )
    b.add_callout(
        "Owner's Review Sign-Off Record (2026-11-07 · Commit 79b36be)",
        "All exit criteria across <strong>Track A</strong> (deterministic verifier <code>A1</code>–<code>A11</code>, 196/196 mutation tests, Protocol A vs. Protocol B &amp; LoRA evaluation, live Jetson bridge verification with <code>A3</code> auto-repair and <code>A8</code> cost model active), <strong>Track B</strong> (128 rule sets, 611/611 on-wire conformance checks across <code>O1</code>/<code>O2</code>/<code>O3</code>, Finding <code>F1</code>), and <strong>Track C</strong> (7/7 hardware red-team scenarios with SHA-256 provenance sidecars) have been verified and signed off in <code>docs/research/owner-review-packet.md</code> and <code>.agents/audit-log.md</code> (0 open remediation rows).",
        fill_hex="E6F4EA",
        border_hex="137333",
    )

    b.add_h1("References")
    refs = [
        "[1] Open Networking Foundation (ONF). OpenFlow Switch Specification, Version 1.3.0 (Wire Protocol 0x04). ONF TS-006, June 2012.",
        "[2] P. Kazemian, G. Varghese, and N. McKeown. “Header Space Analysis: Static Checking for Networks.” In Proc. USENIX NSDI, pp. 113–126, 2012.",
        "[3] A. Khurshid, X. Zou, W. Zhou, M. Caesar, and P. B. Godfrey. “VeriFlow: Verifying Network-Wide Invariants in Real Time.” In Proc. USENIX NSDI, pp. 15–27, 2013.",
        "[4] C. J. Anderson et al. “NetKAT: Semantic Foundations for Networks.” In Proc. ACM POPL, pp. 113–126, 2014.",
        "[5] A. Fogel et al. “A General Approach to Network Configuration Analysis (Batfish).” In Proc. USENIX NSDI, pp. 469–483, 2015.",
        "[6] R. Beckett, A. Gupta, R. Mahajan, and D. Walker. “A General Approach to Network Configuration Verification (Minesweeper).” In Proc. ACM SIGCOMM, pp. 155–168, 2017.",
        "[7] N. Lopes et al. “Checking Beliefs in Dynamic Networks (NoD).” In Proc. USENIX NSDI, pp. 499–512, 2015.",
        "[8] Northbound Networks. Zodiac FX OpenFlow 1.3 Hardware & Firmware v0.86 Reference Manual. Atmel SAM4E8E / Micrel KSZ8795CLX Architecture, 2018.",
        "[9] M. Kuzniar, P. Perešíni, and D. Kostić. “What You Need to Know About SDN Flow Tables.” In Proc. PAM, LNCS vol. 8995, pp. 347–359, 2015.",
        "[10] D. Y. Huang, K. Yocum, and A. C. Snoeren. “High-Fidelity Switch Models for Software-Defined Network Emulation.” In Proc. ACM HotSDN, pp. 43–48, 2013.",
        "[11] R. Rorig, P. V. B. da Silva, and L. C. E. Bona. “Empirical Performance Characterization of the Northbound Networks Zodiac FX OpenFlow Switch.” In IEEE LANMAN, 2019.",
        "[12] E. J. Hu et al. “LoRA: Low-Rank Adaptation of Large Language Models.” In Proc. ICLR, 2022.",
        "[13] R. Rafailov et al. “Direct Preference Optimization: Your Language Model is Secretly a Reward Model.” In Proc. NeurIPS, 2023.",
        "[14] S. Kambhampati et al. “LLMs Can't Plan, But Can Help Planning in LLM-Modulo Frameworks.” In Proc. ICML, 2024.",
        "[15] R. Mondal et al. “What Do LLMs Need to Synthesize Correct Router Configurations?” In Proc. ACM HotNets, pp. 189–196, 2023.",
        "[16] S. Dhawan et al. “SPHINX: Detecting Security Attacks in Software-Defined Networks.” In Proc. NDSS, 2015.",
        "[17] S. Shin, V. Yegneswaran, P. Porras, and G. Gu. “AVANT-GARDE: Exposing Consistent Security State in OpenFlow Networks.” In Proc. ACM CCS, pp. 275–286, 2013.",
        "[18] IEEE Standard 802.3x. Specification for 802.3 Full Duplex Operation and PAUSE Flow Control, 1997.",
        "[19] Gravity TPU Infrastructure Group. Zodiac Infrastructure Bandwidth & Rule-Depth Characterization Whitepaper (docs/benchmarks/zodiac-infrastructure-bandwidth-whitepaper-2026-10-04.md), October 2026.",
        "[20] Gravity TPU Infrastructure Group. Zodiac Owner's Review Packet & Consolidated Red-Team Evidence (docs/research/owner-review-packet.md), November 2026.",
    ]
    for r in refs:
        b.add_p(r, space_after=60, sz=17)

    # ---- APPENDIX A ----
    b.add_page_break()
    b.add_h1("Appendix A: Physical Testbed Attestation & Bench Evidence")
    b.add_p(
        "In addition to enforcing cryptographic SHA-256 provenance sidecars (<code>npm run check:provenance</code>) on every JSON and PCAP artifact in <code>docs/benchmarks/results/</code>, we include below physical bench photographs of the Zodiac testbed as wired during the Track A, Track B, and Track C campaigns."
    )

    r_id1, w1, h1 = b.add_image_bytes(photo_stack_bytes, "jpg")
    r_id2, w2, h2 = b.add_image_bytes(photo_wiring_bytes, "jpg")
    draw1 = b.inline_drawing_xml(r_id1, 232.0, 232.0 * (h1 / float(w1)))
    draw2 = b.inline_drawing_xml(r_id2, 232.0, 232.0 * (h2 / float(w2)))
    cap1 = b._format_runs(
        "<strong>Plate A1 — Controller &amp; Three-Switch Vertical Stack:</strong> NVIDIA Jetson Orin Nano Super (ROBOCO enclosure with live OLED telemetry at <code>49.5°C</code>) beside the 3-tier switch stack: Zodiac FX DUT at bottom, NETGEAR GS105Ev2 #1 in middle, and NETGEAR GS105Ev2 #2 on top.",
        default_color="3C4043",
        default_sz=16,
    )
    cap2 = b._format_runs(
        "<strong>Plate A2 — Front-Panel Port Wiring &amp; Workload/Sensor Nodes:</strong> Active link/activity LEDs and color-coded Cat6 cabling across GS105Ev2 #2 (top), GS105Ev2 #1 (middle), and Zodiac FX (bottom), alongside the Raspberry Pi 3B+ and Raspberry Pi 5 + Hailo-8 NPU nodes.",
        default_color="3C4043",
        default_sz=16,
    )
    b.body_xml.append(f"""
    <w:tbl>
      <w:tblPr><w:tblW w:w="9360" w:type="dxa"/></w:tblPr>
      <w:tblGrid><w:gridCol w:w="4680"/><w:gridCol w:w="4680"/></w:tblGrid>
      <w:tr>
        <w:tc>
          <w:tcPr><w:tcW w:w="4680" w:type="dxa"/></w:tcPr>
          <w:p><w:pPr><w:jc w:val="center"/><w:spacing w:after="60"/></w:pPr>{draw1}</w:p>
          <w:p><w:pPr><w:spacing w:after="80"/></w:pPr>{cap1}</w:p>
        </w:tc>
        <w:tc>
          <w:tcPr><w:tcW w:w="4680" w:type="dxa"/></w:tcPr>
          <w:p><w:pPr><w:jc w:val="center"/><w:spacing w:after="60"/></w:pPr>{draw2}</w:p>
          <w:p><w:pPr><w:spacing w:after="80"/></w:pPr>{cap2}</w:p>
        </w:tc>
      </w:tr>
    </w:tbl>
    """)

    b.add_h2("A.1 Mapping Physical Bench Cabling to Figure 1")
    b.add_bullet(
        "<strong>Bottom Chassis (Northbound Networks Zodiac FX, Firmware 0.86):</strong> Sits at the base of the three-switch stack. Its micro-USB CDC ACM serial port connects to the Jetson Orin Nano Super for out-of-band register telemetry and firmware verification, while RJ45 Ports 1–3 carry OpenFlow VLAN 100 data-plane traffic and Port 4 carries Native VLAN 200 OpenFlow 1.3 TCP control (<code>10.0.1.99:6633</code>)."
    )
    b.add_bullet(
        "<strong>Middle Switch (NETGEAR GS105Ev2 #1, <code>192.168.0.239</code>):</strong> Yellow-booted patch cords connect the untrusted <code>10.0.2.0/24</code> Raspberry Pi hosts (Ports 1, 3, 4) to Port 5 (uplink to Zodiac FX Port 1), while Port 2 outputs the hardware port mirror (<code>O1</code>) in isolated 802.1Q VLAN 2 to the Raspberry Pi 5's secondary USB-GbE capture interface (<code>eth1</code>)."
    )
    b.add_bullet(
        "<strong>Top Switch (NETGEAR GS105Ev2 #2, <code>192.168.0.240</code>):</strong> Terminates Zodiac FX Port 2 on Port 4 (VLAN 2) and mirrors all ingress/egress frames to Port 3 (<code>O3</code>, isolated VLAN 3), which feeds directly into the Jetson Orin Nano Super's dedicated USB 3.0 GbE capture interface (<code>enx9c69d39ddcc0</code>)."
    )
    b.add_bullet(
        "<strong>Excluded Peripheral Note:</strong> Any external desktop display dock visible on the broader workbench is strictly workstation display peripheral equipment and is not part of the Zodiac network topology, data plane, or control plane."
    )

    b.save(DOCX_OUT)
    pdf_doc.close()
    print(f"SUCCESS: Wrote {DOCX_OUT} ({DOCX_OUT.stat().st_size / 1024:.1f} KB)")


if __name__ == "__main__":
    build_docx()

