'use strict';

// End-to-end tests: drive the plugin's own operations against a fake editor,
// so the wiring between locate -> mutate -> write-back is covered, not just
// the pure engine.
// Run with: node --test "tests/*.test.js"

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const Module = require('node:module');

const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
    if (request === 'obsidian') return path.join(__dirname, 'mocks', 'obsidian.js');
    return origResolve.call(this, request, ...rest);
};

const plugin = require('../main.js');

// Mimics the slice of Obsidian's Editor API the plugin uses.
class MockEditor {
    constructor(text, from, to) {
        this.lines = String(text).split('\n');
        this.from = { ...from };
        this.to = to ? { ...to } : { ...from };
    }
    getCursor(which) { return which === 'from' ? { ...this.from } : { ...this.to }; }
    getLine(n) { return this.lines[n]; }
    lineCount() { return this.lines.length; }
    getValue() { return this.lines.join('\n'); }
    setCursor(p) { this.from = { ...p }; this.to = { ...p }; }
    setSelection(a, b) { this.from = { ...a }; this.to = b ? { ...b } : { ...a }; }
    focus() {}
    replaceRange(s, a, b) {
        const merged = this.lines[a.line].slice(0, a.ch) + s + this.lines[b.line].slice(b.ch);
        this.lines.splice(a.line, b.line - a.line + 1, ...merged.split('\n'));
    }
}

// A plugin instance with just enough around it to run an operation.
function makePlugin(editor, settings) {
    const p = Object.create(plugin.prototype);
    p.settings = Object.assign({ rowMarkers: false, stackAboveFontToolbar: false }, settings);
    p.getEditor = () => editor;
    p.updateContext = () => {};
    p.saveSettings = () => {};
    return p;
}

const SAMPLE = [
    'Some prose above.',
    '',
    '<table class="tt-table" data-tt="1">',
    '<tr>',
    '<th>Task</th>',
    '<th>Owner</th>',
    '</tr>',
    '<tr>',
    '<td>Design review</td>',
    '<td>Alice</td>',
    '</tr>',
    '</table>',
    '',
].join('\n');

// line 8 is the "Design review" cell
const IN_CELL = { line: 8, ch: 6 };

test('toggling markers numbers every row and cell in the document', () => {
    const ed = new MockEditor(SAMPLE, IN_CELL);
    const p = makePlugin(ed);
    p.toggleMarkers();

    assert.equal(p.settings.rowMarkers, true, 'the switch is global state');
    assert.deepEqual(ed.getValue().split('\n').slice(2, 12), [
        '<table class="tt-table" data-tt="1">',
        '<tr>',
        '<th><!-- r01c01 -->Task</th>',
        '<th><!-- r01c02 -->Owner</th>',
        '</tr>',
        '<tr>',
        '<td><!-- r02c01 -->Design review</td>',
        '<td><!-- r02c02 -->Alice</td>',
        '</tr>',
        '</table>',
    ]);
    // prose either side is untouched, and no line was added
    assert.equal(ed.getValue().split('\n')[0], 'Some prose above.');
    assert.equal(ed.lineCount(), SAMPLE.split('\n').length);
});

test('toggling a second time removes them again', () => {
    const ed = new MockEditor(SAMPLE, IN_CELL);
    const p = makePlugin(ed);
    p.toggleMarkers();
    p.toggleMarkers();
    assert.equal(p.settings.rowMarkers, false);
    assert.equal(ed.getValue(), SAMPLE);
});

test('the switch reaches every table in the note, not just the one at the cursor', () => {
    const two = [
        '<table>', '<tr>', '<td>one</td>', '</tr>', '</table>',
        '',
        'Text between.',
        '',
        '<table>', '<tr>', '<td>two</td>', '</tr>', '</table>',
    ].join('\n');
    const ed = new MockEditor(two, { line: 2, ch: 4 });
    const p = makePlugin(ed);

    p.toggleMarkers();
    assert.match(ed.getValue(), /<td><!-- r01c01 -->one<\/td>/);
    assert.match(ed.getValue(), /<td><!-- r01c01 -->two<\/td>/);
    assert.equal(ed.getValue().split('<!-- r01c01 -->').length - 1, 2);

    p.toggleMarkers();
    assert.equal(ed.getValue(), two, 'and strips them all again');
});

test('a table the fast parser cannot read is left alone by the switch', () => {
    // two cells on one line: not canonical, so not this switch's business
    const broken = ['<table>', '<tr>', '<td>a</td><td>b</td>', '</tr>', '</table>'].join('\n');
    const ed = new MockEditor(broken, { line: 2, ch: 6 });
    const changed = makePlugin(ed).setMarkers(true, false);
    assert.equal(changed, 0);
    assert.equal(ed.getValue(), broken);
});

test('an existing table conforms to the switch on the next operation', () => {
    const ed = new MockEditor(SAMPLE, IN_CELL);
    // markers already on globally, but this table has none yet
    const p = makePlugin(ed, { rowMarkers: true });
    p.runOp((m, l) => plugin.__internals.insertRow(m, l.row + 1));
    assert.match(ed.getValue(), /<td><!-- r02c01 -->Design review<\/td>/);
});

test('an operation strips markers from a table when the switch is off', () => {
    const ed = new MockEditor(SAMPLE, IN_CELL);
    const p = makePlugin(ed);
    p.toggleMarkers();
    p.settings.rowMarkers = false; // as if switched off from another note
    p.runOp((m, l) => plugin.__internals.insertRow(m, l.row + 1));
    assert.equal(ed.getValue().includes('<!--'), false);
});

test('the cursor stays in the same cell across a marker toggle', () => {
    const ed = new MockEditor(SAMPLE, IN_CELL);
    const p = makePlugin(ed);
    p.toggleMarkers();
    assert.match(ed.getLine(ed.getCursor('from').line), /Design review/);
});

test('a marker toggle leaves an unmarked, unparseable note alone but reports zero', () => {
    const ed = new MockEditor('Just prose, no tables.', { line: 0, ch: 0 });
    assert.equal(makePlugin(ed).setMarkers(true, false), 0);
});

test('markers survive a structural edit and renumber', () => {
    const ed = new MockEditor(SAMPLE, IN_CELL);
    const p = makePlugin(ed);
    p.toggleMarkers();
    p.runOp((m, l) => plugin.__internals.insertRow(m, l.row + 1));

    const trs = ed.getValue().split('\n').filter((l) => l.startsWith('<tr'));
    assert.deepEqual(trs, ['<tr>', '<tr>', '<tr>'], 'nothing lands on the <tr> lines');
    const firstCells = ed.getValue().split('\n').filter((l) => /^<t[dh]/.test(l)).filter((_, i) => i % 2 === 0);
    assert.deepEqual(firstCells, [
        '<th><!-- r01c01 -->Task</th>',
        '<td><!-- r02c01 -->Design review</td>',
        '<td><!-- r03c01 --></td>',
    ]);
});

test('column markers renumber when a column is inserted', () => {
    const ed = new MockEditor(SAMPLE, IN_CELL);
    const p = makePlugin(ed);
    p.toggleMarkers();
    p.runOp((m, l) => plugin.__internals.insertColumn(m, plugin.__internals.columnOfCell(m, l.row, l.cell) + 1));

    const header = ed.getValue().split('\n').filter((l) => l.startsWith('<th'));
    assert.deepEqual(header, [
        '<th><!-- r01c01 -->Task</th>',
        '<th><!-- r01c02 --></th>',
        '<th><!-- r01c03 -->Owner</th>',
    ]);
});

// SAMPLE lines: 3 <tr>, 4 <th>Task, 5 <th>Owner, 6 </tr>,
//               7 <tr>, 8 <td>Design review, 9 <td>Alice, 10 </tr>, 11 </table>
function mergeWith(from, to) {
    const ed = new MockEditor(SAMPLE, from, to);
    makePlugin(ed).mergeSelection();
    return ed.getValue();
}

test('dragging across two cells in a row merges them', () => {
    const out = mergeWith({ line: 8, ch: 6 }, { line: 9, ch: 10 });
    assert.match(out, /<td colspan="2">Design review<br>Alice<\/td>/);
});

test('a drag that overshoots onto the </tr> line still merges that row', () => {
    // releasing the mouse just past the last cell is the common gesture
    const out = mergeWith({ line: 8, ch: 0 }, { line: 10, ch: 0 });
    assert.match(out, /<td colspan="2">Design review<br>Alice<\/td>/);
});

test('a drag starting on the <tr> line snaps to that row\'s first cell', () => {
    const out = mergeWith({ line: 7, ch: 0 }, { line: 9, ch: 5 });
    assert.match(out, /<td colspan="2">Design review<br>Alice<\/td>/);
});

test('dragging across rows merges the rectangle', () => {
    const out = mergeWith({ line: 4, ch: 4 }, { line: 9, ch: 5 });
    assert.match(out, /colspan="2" rowspan="2"|rowspan="2" colspan="2"/);
    assert.match(out, /Task<br>Owner<br>Design review<br>Alice/);
});

test('dragging over the whole table merges all of it', () => {
    const out = mergeWith({ line: 2, ch: 0 }, { line: 11, ch: 8 });
    assert.match(out, /Task<br>Owner<br>Design review<br>Alice/);
});

test('a cursor with no selection is refused rather than merging one cell', () => {
    assert.equal(mergeWith({ line: 8, ch: 6 }), SAMPLE);
});

test('a selection inside a single cell is refused', () => {
    assert.equal(mergeWith({ line: 8, ch: 2 }, { line: 8, ch: 9 }), SAMPLE);
});

// --- repair: what happens after someone presses Enter in a cell -------------
// These need a DOMParser, so they run under the stand-in from mocks/dom.js.

const { installDom } = require('./mocks/dom.js');
const obsidian = require('./mocks/obsidian.js');

// Enter pressed in the middle of "Design review", wrapping the cell over two
// lines. This is legal now — the tags are the delimiters, not the line.
const SPLIT = SAMPLE.replace('<td>Design review</td>', '<td>Design\nreview</td>');

test('a cell wrapped across lines is read as one cell, untouched', () => {
    const ed = new MockEditor(SPLIT, { line: 9, ch: 3 });
    const p = makePlugin(ed);
    const loc = p.locate(ed, false);
    assert.ok(loc, 'it parses without any repair');
    assert.equal(loc.model.rows[1].cells[0].content, 'Design\nreview');
    assert.deepEqual({ row: loc.row, cell: loc.cell }, { row: 1, cell: 0 },
        'the cursor on the second line is still in that cell');
});

test('operations on a wrapped cell leave the wrapping exactly as typed', () => {
    obsidian.__notices.length = 0;
    const ed = new MockEditor(SPLIT, { line: 9, ch: 3 });
    makePlugin(ed).runOp((m, l) => plugin.__internals.insertRow(m, l.row + 1));
    assert.equal(
        obsidian.__notices.some((n) => /inside an HTML table first/.test(n)), false,
        'no "not in a table": ' + JSON.stringify(obsidian.__notices)
    );
    assert.match(ed.getValue(), /<td>Design\nreview<\/td>/, 'still wrapped, no <br> forced in');
    assert.equal(ed.getValue().split('<tr>').length - 1, 3, 'and the row was inserted');
});

test('a paragraph break becomes two <br>, while a wrap stays a wrap', () => {
    const restore = installDom();
    try {
        // the blank line is the part that cannot survive: it ends the HTML
        // block, so it comes back as <br><br>
        const typed = SAMPLE.replace(
            '<td>Design review</td>',
            '<td>First paragraph.\n\nSecond paragraph, which\nwraps across lines.</td>'
        );
        const ed = new MockEditor(typed, IN_CELL);
        makePlugin(ed).runOp(() => null);
        assert.match(
            ed.getValue(),
            /<td>First paragraph\.<br><br>Second paragraph, which\nwraps across lines\.<\/td>/
        );
    } finally {
        restore();
    }
});

test('inline markup inside a cell is carried through a repair intact', () => {
    const restore = installDom();
    try {
        const styled = SAMPLE.replace(
            '<th>Task</th>',
            '<th><span style="font-style:italic; color:#6e6e6e">Monday</span><br>Suffering</th>'
        );
        const ed = new MockEditor(styled, IN_CELL);
        makePlugin(ed).runOp(() => null);
        assert.match(ed.getValue(), /<span style="font-style:italic; color:#6e6e6e">Monday<\/span><br>Suffering/);
    } finally {
        restore();
    }
});

test('Reformat table fixes a paragraph break, on the real-world shape', () => {
    const restore = installDom();
    try {
        const note = [
            '<table class="tt-table" data-tt="1">',
            '<tr>',
            '<th><!-- r01c01 --><span style="font-style:italic; color:#6e6e6e">Monday, June 16, 2025.</span><br>Suffering/Trauma/Pain Body</th>',
            '</tr>',
            '<tr>',
            '<td><!-- r02c01 -->Suffering and Trauma are somewhat the same because trauma can be considered a "GROUP" of sufferings.',
            '',
            'I have been hearing Eckhart talking about the "pain body" for years.</td>',
            '</tr>',
            '</table>',
            '',
        ].join('\n');

        const ed = new MockEditor(note, { line: 5, ch: 30 });
        const p = makePlugin(ed);

        // it does not parse to begin with, and the diagnosis points at the gap
        assert.equal(p.locate(ed, false), null);
        const d = plugin.__internals.diagnose(note.split('\n').slice(0, 10), 0);
        assert.equal(d.line, 6);
        assert.match(d.why, /blank line ends the table/);

        p.reformatTable();

        const out = ed.getValue();
        assert.match(out, /a "GROUP" of sufferings\.<br><br>I have been hearing/, 'paragraph kept as <br><br>');
        assert.match(out, /<span style="font-style:italic; color:#6e6e6e">Monday, June 16, 2025\.<\/span><br>/,
            'the font toolbar span survives untouched');
        assert.ok(
            plugin.__internals.parseTable(out.split('\n').filter((l) => l.trim()).slice(0)),
            'and the table parses afterwards'
        );
        assert.notEqual(p.locate(ed, false), null, 'the toolbar is live on it again');
    } finally {
        restore();
    }
});

// Markers are generated, and the repair path reads cell content back out of
// innerHTML — comments included — so it has to strip them or it stacks a new
// one on top of the old.
const MARKED_BROKEN = [
    '<table class="tt-table" data-tt="1">',
    '<tr>',
    '<th><!-- r01c01 -->Task</th>',
    '<th><!-- r01c02 -->Owner</th>',
    '</tr>',
    '<tr>',
    '',
    '<td><!-- r02c01 -->Design review</td>',
    '<td><!-- r02c02 -->Alice</td>',
    '</tr>',
    '</table>',
    '',
].join('\n');

test('reformatting a marked table does not duplicate the markers', () => {
    const restore = installDom();
    try {
        const ed = new MockEditor(MARKED_BROKEN, { line: 2, ch: 20 });
        const p = makePlugin(ed, { rowMarkers: true });
        p.reformatTable();

        const out = ed.getValue();
        assert.equal((out.match(/<!--/g) || []).length, 4, 'one marker per cell, not two');
        assert.equal(out.includes('<!-- r01c01 --><!-- r01c01 -->'), false, 'no stacking');
        assert.match(out, /<th><!-- r01c01 -->Task<\/th>/);
        assert.match(out, /<td><!-- r02c01 -->Design review<\/td>/);
    } finally {
        restore();
    }
});

test('reformatting repeatedly never accumulates markers', () => {
    const restore = installDom();
    try {
        const ed = new MockEditor(MARKED_BROKEN, { line: 2, ch: 20 });
        const p = makePlugin(ed, { rowMarkers: true });
        p.reformatTable();
        const once = ed.getValue();
        p.reformatTable();
        p.reformatTable();
        assert.equal(ed.getValue(), once, 'reformatting is idempotent');
    } finally {
        restore();
    }
});

test('reformatting with markers off strips the ones already there', () => {
    const restore = installDom();
    try {
        const ed = new MockEditor(MARKED_BROKEN, { line: 2, ch: 20 });
        makePlugin(ed, { rowMarkers: false }).reformatTable();
        assert.equal(ed.getValue().includes('<!--'), false,
            'the old markers go, rather than being left embedded in the content');
        assert.match(ed.getValue(), /<th>Task<\/th>/);
    } finally {
        restore();
    }
});

test('the other ways of breaking a table are repaired too', () => {
    const restore = installDom();
    try {
        for (const broken of [
            SAMPLE.replace('<tr>\n<td>Design review', '<tr>oops\n<td>Design review'),
            SAMPLE.replace('<td>Design review</td>', '<td>Design review</td><td>x</td>'),
            SAMPLE.replace('<td>Alice</td>', '<td>Alice</td>\n'),
        ]) {
            const ed = new MockEditor(broken, IN_CELL);
            makePlugin(ed).runOp(() => null);
            const lines = ed.getValue().split('\n');
            const start = lines.findIndex((l) => l.startsWith('<table'));
            const end = lines.findIndex((l) => l.startsWith('</table>'));
            assert.ok(
                plugin.__internals.parseTable(lines.slice(start, end + 1)),
                'should parse after repair: ' + lines.slice(start, end + 1).join(' / ')
            );
        }
    } finally {
        restore();
    }
});

test('an older table with widths but no sizing classes is brought up to date', () => {
    const stale = [
        'Prose.',
        '',
        '<table class="tt-table" data-tt="1">',
        '<colgroup>',
        '<col style="width:220px">',
        '<col>',
        '</colgroup>',
        '<tr>',
        '<td>a</td>',
        '<td>b</td>',
        '</tr>',
        '</table>',
        '',
    ].join('\n');
    const ed = new MockEditor(stale, { line: 8, ch: 2 });
    makePlugin(ed).runOp(() => null);
    assert.match(ed.getValue(), /<table class="tt-table tt-sized" data-tt="1">/,
        'any action adds the class that makes the width bind');
    assert.match(ed.getValue(), /<col style="width:220px">/, 'and the width itself is untouched');
});

test('a table from when percentages were offered is cleaned up on the next action', () => {
    const legacy = [
        '<table class="tt-table tt-sized tt-sized-pct" data-tt="1">',
        '<colgroup>',
        '<col style="width:45%">',
        '<col>',
        '</colgroup>',
        '<tr>',
        '<th>Task</th>',
        '<th>Owner</th>',
        '</tr>',
        '</table>',
        '',
    ].join('\n');
    const ed = new MockEditor(legacy, { line: 6, ch: 5 });
    makePlugin(ed).runOp(() => null);
    const open = ed.getValue().split('\n')[0];
    assert.doesNotMatch(open, /tt-sized-pct/, 'the retired flag is dropped');
    assert.match(open, /tt-sized/, 'fixed layout is kept, since a width is still set');
    assert.match(ed.getValue(), /<col style="width:45%">/,
        'the width itself is left alone — nothing rewrites what you typed');
});

test('inserting a table inside a table is refused, not spliced in', () => {
    const ed = new MockEditor(SAMPLE, IN_CELL);
    makePlugin(ed).insertTable(2, 2, true);
    assert.equal(ed.getValue(), SAMPLE, 'the existing table is untouched');
});

// The guard, and the toolbar's active/inactive styling, both rest on this.
test('findTableBlock distinguishes inside from outside on every line', () => {
    const ed = new MockEditor(SAMPLE, IN_CELL);
    const p = makePlugin(ed);
    const inside = [];
    for (let i = 0; i < ed.lineCount(); i++) inside.push(!!p.findTableBlock(ed, i));
    assert.deepEqual(inside, [
        false, false,               // prose, blank
        true, true, true, true,     // <table>, <tr>, two <th>
        true, true, true, true,     // </tr>, <tr>, two <td>
        true, true,                 // </tr>, </table>
        false,                      // trailing blank
    ]);
});

test('a table still inserts normally outside a table', () => {
    const ed = new MockEditor(SAMPLE, { line: 0, ch: 17 });
    makePlugin(ed).insertTable(2, 2, true);
    assert.match(ed.getValue(), /Some prose above\./);
    // two tables now, the original plus the new one
    assert.equal(ed.getValue().split('<table').length - 1, 2);
});

test('inserting a table honours the row-marker setting', () => {
    const ed = new MockEditor('\n', { line: 0, ch: 0 });
    makePlugin(ed, { rowMarkers: true }).insertTable(2, 2, true);
    assert.match(ed.getValue(), /<th><!-- r01c01 --><\/th>/);

    const ed2 = new MockEditor('\n', { line: 0, ch: 0 });
    makePlugin(ed2, { rowMarkers: false }).insertTable(2, 2, true);
    assert.equal(ed2.getValue().includes('<!--'), false);
});

test('operations still work with the cursor on a marked <tr> line', () => {
    const ed = new MockEditor(SAMPLE, IN_CELL);
    const p = makePlugin(ed);
    p.toggleMarkers();
    // put the cursor on the second row's <tr> line
    const lines = ed.getValue().split('\n');
    const trLine = lines.findIndex((l, i) => l === '<tr>' && /r02c01/.test(lines[i + 1] || ''));
    ed.setCursor({ line: trLine, ch: 0 });
    p.runOp((m, l) => plugin.__internals.deleteRow(m, l.row));

    const out = ed.getValue();
    assert.equal(out.includes('Design review'), false, 'row 2 was the one deleted');
    assert.match(out, /<th><!-- r01c01 -->Task<\/th>/);
    assert.equal(out.split('\n').filter((l) => l.startsWith('<tr')).length, 1);
});

test('a structural edit leaves an unmarked table unmarked', () => {
    const ed = new MockEditor(SAMPLE, IN_CELL);
    const p = makePlugin(ed);
    p.runOp((m, l) => plugin.__internals.insertRow(m, l.row + 1));
    assert.equal(ed.getValue().includes('<!--'), false);
});
