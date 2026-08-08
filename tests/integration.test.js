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
        '<tr><!-- r01 -->',
        '<th><!-- c01 -->Task</th>',
        '<th><!-- c02 -->Owner</th>',
        '</tr>',
        '<tr><!-- r02 -->',
        '<td><!-- c01 -->Design review</td>',
        '<td><!-- c02 -->Alice</td>',
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
    assert.match(ed.getValue(), /<td><!-- c01 -->one<\/td>/);
    assert.match(ed.getValue(), /<td><!-- c01 -->two<\/td>/);
    assert.equal(ed.getValue().split('<tr><!-- r01 -->').length - 1, 2);

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
    assert.match(ed.getValue(), /<tr><!-- r01 -->/);
    assert.match(ed.getValue(), /<td><!-- c01 -->Design review<\/td>/);
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
    assert.deepEqual(trs, ['<tr><!-- r01 -->', '<tr><!-- r02 -->', '<tr><!-- r03 -->']);
});

test('column markers renumber when a column is inserted', () => {
    const ed = new MockEditor(SAMPLE, IN_CELL);
    const p = makePlugin(ed);
    p.toggleMarkers();
    p.runOp((m, l) => plugin.__internals.insertColumn(m, plugin.__internals.columnOfCell(m, l.row, l.cell) + 1));

    const header = ed.getValue().split('\n').filter((l) => l.startsWith('<th'));
    assert.deepEqual(header, [
        '<th><!-- c01 -->Task</th>',
        '<th><!-- c02 --></th>',
        '<th><!-- c03 -->Owner</th>',
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
    assert.match(ed.getValue(), /<tr><!-- r01 -->/);
    assert.match(ed.getValue(), /<th><!-- c01 --><\/th>/);

    const ed2 = new MockEditor('\n', { line: 0, ch: 0 });
    makePlugin(ed2, { rowMarkers: false }).insertTable(2, 2, true);
    assert.equal(ed2.getValue().includes('<!--'), false);
});

test('operations still work with the cursor on a marked <tr> line', () => {
    const ed = new MockEditor(SAMPLE, IN_CELL);
    const p = makePlugin(ed);
    p.toggleMarkers();
    // put the cursor on the second row's <tr><!-- r02 --> line
    const trLine = ed.getValue().split('\n').findIndex((l) => l.startsWith('<tr><!-- r02'));
    ed.setCursor({ line: trLine, ch: 0 });
    p.runOp((m, l) => plugin.__internals.deleteRow(m, l.row));

    const out = ed.getValue();
    assert.equal(out.includes('Design review'), false, 'row 2 was the one deleted');
    assert.match(out, /<tr><!-- r01 -->/);
    assert.equal(out.split('\n').filter((l) => l.startsWith('<tr')).length, 1);
});

test('a structural edit leaves an unmarked table unmarked', () => {
    const ed = new MockEditor(SAMPLE, IN_CELL);
    const p = makePlugin(ed);
    p.runOp((m, l) => plugin.__internals.insertRow(m, l.row + 1));
    assert.equal(ed.getValue().includes('<!--'), false);
});
