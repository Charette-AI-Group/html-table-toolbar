# Forum announcement draft

Post to https://forum.obsidian.md/c/share-showcase/9 (Share & showcase).

**IMPORTANT — the category has a required template.** When you click "+ New Topic"
in Share & showcase, Discourse pre-fills the body with that template. Keep it and
fill in the fields; do NOT paste over it. The composer's version is authoritative
if it differs from the reconstruction below. Leaving a placeholder (e.g. "xyz") or
omitting the disclaimer gets the post rejected by moderators.

The disclaimer block and the community directory link must both be present.

For Discord `#updates` (requires the developer role), use the intro paragraph plus
the links; the disclaimer template is forum-only.

## Title

HTML Table Toolbar — Word-style table editing that pipe tables cannot do

## Body

## Disclaimer

> Is this project **open source**? Yes
> Is this project completely **free**? Yes
> Is this project **vibe-coded** beyond the author's ability to comprehend how it works? No

---

[HTML Table Toolbar on the Community Directory](https://community.obsidian.md/plugins/html-table-toolbar)

Hi everyone! This is the sister plugin to my [HTML Font Toolbar](https://community.obsidian.md/plugins/html-font-toolbar): **HTML Table Toolbar**, a Word-style toolbar for real `<table>` markup in your notes.

**Why not pipe tables?** Because they cannot merge cells, style an individual cell, hold multi-block content, or centre themselves on the page. This plugin emits and edits real HTML tables instead, and puts explicit buttons on the structural edits that raw markup normally makes tedious.

**What it does:**

- Insert via a hover grid, with an optional header row
- Add or delete rows and columns anywhere, with `colspan`/`rowspan` handled correctly
- Merge a selected rectangle of cells, or merge with the cell right or below without any selection at all — the latter works the same in Source mode and Live Preview
- Split a merged cell back apart
- Align a cell, a whole column, or the entire table — table centring is one of the clearest wins over Markdown
- Borders at three scopes: a whole-table pattern (grid, outline, none), plus individual row and column edges, each with its own thickness, line type and colour
- Cell shading from an editable swatch grid or the OS colour picker
- Optional row/column markers in the source — HTML comments that label every row and cell with its coordinates, so a forty-row table stays navigable while you hand-edit

Every button is also a command, so anything can be given a hotkey.

**The source stays readable.** Tables are written one tag per line, one cell per line, with formatting on short classes rather than inline styles — so the content stays visually dominant if you edit the markup by hand. A "Reformat table" command puts a hand-broken table back into that shape.

**Sister plugins.** HTML Table Toolbar and HTML Font Toolbar are designed to work side by side, but neither needs the other and neither imports the other's code — install either alone and it works completely. Install both and the table strip stacks above the font toolbar instead of overlapping it, shrinking to a compact row when they share the space and expanding to the font toolbar's proportions when it is on its own. The two CSS namespaces (`tt-` and `hft-`) never collide, and font formatting stays available inside table cells, which is exactly where you want it for header rows.

**Worth knowing before you adopt it:** raw HTML in Markdown is viewable in most places but editable in very few. Obsidian's native table controls, Advanced Tables and Dataview all operate on pipe tables and will ignore these. The trade is "editable everywhere, limited features" for "viewable most places, editable here" — a good deal for build-once/read-often reference tables, a worse one for working documents. The README spells out exactly what survives in GitHub, Hugo, Pandoc and elsewhere.

**Install:** search for "HTML Table Toolbar" in Settings → Community plugins → Browse (desktop only for now).

**Links:** [GitHub repo](https://github.com/Charette-AI-Group/html-table-toolbar) · [Sister plugin: HTML Font Toolbar](https://github.com/Charette-AI-Group/html-font-toolbar)

Feedback, bug reports, and feature ideas are very welcome, here or on the [GitHub issues](https://github.com/Charette-AI-Group/html-table-toolbar/issues). Thanks for reading!
