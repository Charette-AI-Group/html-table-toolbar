'use strict';

// Builds the real toolbar against a DOM stand-in and clicks every button, so a
// dialog that throws on open — or a handler wired to nothing — fails here
// rather than in the vault.
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
const { installDom } = require('./mocks/dom.js');
const obsidian = require('./mocks/obsidian.js');

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

const TABLE = [
    'Prose above.',
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

const IN_CELL = { line: 8, ch: 6 };

function makePlugin(editor) {
    const p = Object.create(plugin.prototype);
    p.settings = Object.assign({}, {
        visible: true,
        contextual: false,
        statusBar: false,
        stackAboveFontToolbar: true,
        expandWhenAlone: true,
        inactiveDim: 14,
        defaultRows: 3,
        defaultCols: 3,
        headerRow: true,
        rowMarkers: false,
        cellShades: plugin.__internals.DEFAULT_CELL_SHADES,
        lastCellShade: '',
        lastColumnWidth: '',
    });
    p.app = { setting: null };
    p.manifest = { id: 'html-table-toolbar' };
    p.getEditor = () => editor;
    p.saveSettings = () => {};
    p.updateContext = () => {};
    return p;
}

// Every clickable control on the toolbar, labelled by its tooltip.
function toolbarButtons(p) {
    return p.toolbar
        .walk()
        .filter((el) => el.tag === 'button' && (el.listeners.click || []).length)
        .map((el) => ({ label: el.title || el.text || '(unlabelled)', el }));
}

test('the toolbar builds and every button is wired up', () => {
    const restore = installDom();
    try {
        const p = makePlugin(new MockEditor(TABLE, IN_CELL));
        p.buildToolbar();
        const buttons = toolbarButtons(p);
        assert.ok(buttons.length >= 20, 'expected the full expanded control set, got ' + buttons.length);
        // no two controls should be indistinguishable to a screen reader
        const labels = buttons.map((b) => b.label);
        assert.equal(labels.includes('(unlabelled)'), false, 'every button carries a tooltip');
        assert.ok(labels.includes('Insert table…'), 'the insert-table button exists');
    } finally {
        restore();
    }
});

test('clicking every toolbar button with the cursor in a table throws nothing', () => {
    const restore = installDom();
    const failures = [];
    try {
        for (const { label } of toolbarButtonList()) {
            // A fresh plugin and document per click, so one destructive button
            // cannot mask the next.
            const ed = new MockEditor(TABLE, IN_CELL);
            const p = makePlugin(ed);
            p.buildToolbar();
            const target = toolbarButtons(p).find((b) => b.label === label);
            try {
                target.el.fire('click');
            } catch (e) {
                failures.push(label + ' -> ' + e.message);
            }
        }
    } finally {
        restore();
    }
    assert.deepEqual(failures, []);
});

test('clicking every toolbar button OUTSIDE a table throws nothing', () => {
    const restore = installDom();
    const failures = [];
    try {
        for (const { label } of toolbarButtonList()) {
            const ed = new MockEditor(TABLE, { line: 0, ch: 3 });
            const p = makePlugin(ed);
            p.buildToolbar();
            const target = toolbarButtons(p).find((b) => b.label === label);
            try {
                target.el.fire('click');
            } catch (e) {
                failures.push(label + ' -> ' + e.message);
            }
        }
    } finally {
        restore();
    }
    assert.deepEqual(failures, []);
});

// Collected once so both tests iterate the same set.
function toolbarButtonList() {
    const restore = installDom();
    try {
        const p = makePlugin(new MockEditor(TABLE, IN_CELL));
        p.buildToolbar();
        return toolbarButtons(p).map((b) => ({ label: b.label }));
    } finally {
        restore();
    }
}

test('every command runs without throwing, in and out of a table', () => {
    const restore = installDom();
    const failures = [];
    try {
        const names = makePlugin(new MockEditor(TABLE, IN_CELL))
            .commandList()
            .map((c) => c.id);
        for (const id of names) {
            for (const cursor of [IN_CELL, { line: 0, ch: 3 }]) {
                const ed = new MockEditor(TABLE, cursor);
                const p = makePlugin(ed);
                const cmd = p.commandList().find((c) => c.id === id);
                try {
                    cmd.run();
                } catch (e) {
                    failures.push(id + ' @line' + cursor.line + ' -> ' + e.message);
                }
            }
        }
    } finally {
        restore();
    }
    assert.deepEqual(failures, []);
});

// A table broken by a stray character used to look exactly like being outside
// one: strip dimmed, status bar blank, no clue what was wrong.
const BROKEN = TABLE.replace('<tr>\n<td>Design review', '<tr>oops\n<td>Design review');

function contextFor(text, cursor) {
    const ed = new MockEditor(text, cursor);
    const p = makePlugin(ed);
    delete p.updateContext; // exercise the real one
    p.buildToolbar();
    p.statusEl = new (require('./mocks/dom.js').FakeEl)('div');
    p.updateContext();
    return {
        status: p.statusEl.text,
        warn: p.statusEl.classes.has('tt-status-warn'),
        dimmed: p.toolbar.classes.has('tt-inactive'),
    };
}

test('a table broken by stray text keeps the strip live and says what is wrong', () => {
    const restore = installDom();
    try {
        const r = contextFor(BROKEN, { line: 8, ch: 4 });
        assert.equal(r.dimmed, false, 'the strip stays live — the buttons repair before acting');
        assert.match(r.status, /^Table: line 8 —/, 'names the offending line in the note');
        assert.match(r.status, /text on the <tr> line/);
        assert.equal(r.warn, true, 'and reads as a warning, not a position');
    } finally {
        restore();
    }
});

test('a readable table still reports position, and outside one reports nothing', () => {
    const restore = installDom();
    try {
        const inside = contextFor(TABLE, IN_CELL);
        assert.match(inside.status, /^R2 · C1/);
        assert.equal(inside.warn, false);
        assert.equal(inside.dimmed, false);

        const outside = contextFor(TABLE, { line: 0, ch: 3 });
        assert.equal(outside.status, '');
        assert.equal(outside.warn, false);
        assert.equal(outside.dimmed, true, 'genuinely outside a table still dims');
    } finally {
        restore();
    }
});

// Catch whichever modal a click opens, so dialogs can be driven from the
// outside without widening the plugin's exports just for tests.
function captureModals(fn) {
    const opened = [];
    const original = obsidian.Modal.prototype.open;
    obsidian.Modal.prototype.open = function open() {
        opened.push(this);
        return original.call(this);
    };
    try {
        fn();
    } finally {
        obsidian.Modal.prototype.open = original;
    }
    return opened;
}

test('the insert-table button opens the grid picker, and picking a size inserts', () => {
    const restore = installDom();
    try {
        const ed = new MockEditor('\n', { line: 0, ch: 0 });
        const p = makePlugin(ed);
        p.buildToolbar();
        const insert = toolbarButtons(p).find((b) => b.label === 'Insert table…');

        const opened = captureModals(() => insert.el.fire('click'));
        assert.equal(opened.length, 1, 'the picker opened');

        const picker = opened[0];
        assert.ok(picker.cells && picker.cells.length, 'the hover grid was built');
        // hover row 3, column 2, then click it
        picker.cells[2][1].fire('mouseenter');
        assert.equal(picker.readout.text, '3 × 2');
        picker.cells[2][1].fire('click');

        const out = ed.getValue();
        assert.match(out, /<table class="tt-table" data-tt="1">/);
        assert.equal((out.match(/<tr>/g) || []).length, 3);
        assert.equal((out.match(/<th><\/th>/g) || []).length, 2, 'header row of two');
    } finally {
        restore();
    }
});

test('every dialog opens without throwing', () => {
    const restore = installDom();
    const failures = [];
    try {
        // Insert is the one dialog that wants the cursor OUTSIDE a table; the
        // rest need it inside.
        const dialogs = [
            { label: 'Table borders…', cursor: IN_CELL },
            { label: 'Row borders…', cursor: IN_CELL },
            { label: 'Column borders…', cursor: IN_CELL },
            { label: 'Set column width…', cursor: IN_CELL },
            { label: 'Set cell background…', cursor: IN_CELL },
            { label: 'Insert table…', cursor: { line: 0, ch: 3 } },
        ];
        for (const { label, cursor } of dialogs) {
            const ed = new MockEditor(TABLE, cursor);
            const p = makePlugin(ed);
            p.buildToolbar();
            const btn = toolbarButtons(p).find((b) => b.label === label);
            if (!btn) { failures.push(label + ' -> button missing'); continue; }
            try {
                const opened = captureModals(() => btn.el.fire('click'));
                if (!opened.length) failures.push(label + ' -> opened nothing');
            } catch (e) {
                failures.push(label + ' -> ' + e.message);
            }
        }
    } finally {
        restore();
    }
    assert.deepEqual(failures, []);
});
