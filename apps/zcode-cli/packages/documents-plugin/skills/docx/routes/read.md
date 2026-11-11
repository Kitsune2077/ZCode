# Route: Read / Analyze / Extract

## Method 1: Text Extraction via pandoc (Fastest)

```bash
# Plain text
pandoc input.docx -t plain -o output.txt

# Markdown (preserves structure)
pandoc input.docx -t markdown -o output.md

# Extract with metadata
pandoc input.docx -t markdown --standalone -o output.md
```

**Best for**: Quick content reading, text analysis, word count, searching.

## Method 2: Raw XML Access (Detailed)

```bash
mkdir work && cd work && unzip ../input.docx

# Read main content
cat word/document.xml

# Read styles
cat word/styles.xml

# List embedded media
ls word/media/

# Read headers/footers
cat word/header1.xml
cat word/footer1.xml
```

**Best for**: Analyzing formatting, extracting styles, inspecting document structure, debugging layout issues.

### Quick XML Parsing

```python
import defusedxml.ElementTree as ET

tree = ET.parse("word/document.xml")
ns = {"w": "http://schemas.openxmlformats.org/wordprocessingml/2006/main"}

# Extract all text
texts = []
for t in tree.iter("{http://schemas.openxmlformats.org/wordprocessingml/2006/main}t"):
    if t.text:
        texts.append(t.text)
full_text = "".join(texts)

# Count paragraphs
paras = tree.findall(".//w:p", ns)
print(f"Paragraphs: {len(paras)}")

# Find headings
for para in paras:
    pPr = para.find("w:pPr", ns)
    if pPr is not None:
        pStyle = pPr.find("w:pStyle", ns)
        if pStyle is not None and "Heading" in pStyle.get(f"{{{ns['w']}}}val", ""):
            text = "".join(t.text for t in para.iter(f"{{{ns['w']}}}t") if t.text)
            print(f"  {pStyle.get(f'{{{ns[\"w\"]}}}val')}: {text}")
```

## Method 3: Convert to Images (Visual Analysis)

```bash
# Bundled engine — renders page PNGs in one step (page-0001.png, page-0002.png, ...)
dsoffice render --input input.docx --output-dir <dir> --pages all
```

**Best for**: Visual layout analysis, comparing formatting, generating previews, when user asks "what does it look like".

> 🔴 **No conversion engine?** Follow the engine resolution order in `SKILL.md` →
> *"Office conversion engine resolution order"*: bundled `dsoffice` first, then an existing local
> LibreOffice (`soffice --headless --convert-to pdf` + `pdftoppm -png -r 200`), then a user-consented
> install, and only with explicit user consent a preview through local Word/WPS (warn that fidelity
> may differ). If nothing is available, say the visual preview was not produced — never fabricate
> layout claims without rendering.

## Method 4: python-docx Reading

```python
from docx import Document

doc = Document("input.docx")

# Read paragraphs
for para in doc.paragraphs:
    print(f"[{para.style.name}] {para.text}")

# Read tables
for table in doc.tables:
    for row in table.rows:
        print([cell.text for cell in row.cells])

# Document properties
print(f"Sections: {len(doc.sections)}")
print(f"Paragraphs: {len(doc.paragraphs)}")
print(f"Tables: {len(doc.tables)}")
```

## Choosing the Right Method

| Need | Method |
|------|--------|
| Quick text content | pandoc |
| Document structure/outline | pandoc → markdown |
| Formatting details | Raw XML |
| Table data extraction | python-docx |
| Visual appearance | Convert to images |
| Style analysis | Raw XML (styles.xml) |
| Word/character count | pandoc → plain → wc |
