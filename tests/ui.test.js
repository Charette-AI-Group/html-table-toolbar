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
        lastImageWidth: '300',
    });
    p.app = {
        setting: null,
        vault: {
            getFiles: () => [
                { path: 'attachments/shot.png', extension: 'png', stat: { mtime: 10 } },
                { path: 'Finance/Retirement/docs/chart.png', extension: 'png', stat: { mtime: 20 } },
                { path: 'notes/readme.md', extension: 'md', stat: { mtime: 30 } },
            ],
            getResourcePath: (f) => 'app://resolved/' + f.path,
        },
        metadataCache: { getFirstLinkpathDest: () => null },
        workspace: { getActiveFile: () => ({ path: 'Finance/Retirement/docs/Plan.md' }) },
    };
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

// The status bar warning is also the fix, so clicking it has to actually
// rewrite the note — not merely look clickable.
function statusBarFor(text, cursor) {
    const ed = new MockEditor(text, cursor);
    const p = makePlugin(ed);
    delete p.updateContext;
    p.buildToolbar();
    p.statusEl = new (require('./mocks/dom.js').FakeEl)('div');
    p.wireStatusBar();
    p.updateContext();
    return { ed, p, el: p.statusEl };
}

test('clicking the warning rewrites the table in the document', () => {
    const restore = installDom();
    try {
        const { ed, el } = statusBarFor(BROKEN, { line: 8, ch: 4 });
        assert.equal(el.classes.has('tt-status-warn'), true, 'the warning is showing');
        assert.match(el.title, /Click to reformat/);
        const before = ed.getValue();

        el.fire('click');

        assert.notEqual(ed.getValue(), before, 'the note actually changed');
        assert.equal(ed.getValue().includes('<tr>oops'), false, 'the stray text is gone');
        assert.ok(
            plugin.__internals.parseTable(ed.getValue().split('\n').slice(2, 12)),
            'and the table parses afterwards'
        );
    } finally {
        restore();
    }
});

test('clicking the readout does nothing when it is not a warning', () => {
    const restore = installDom();
    try {
        const { ed, el } = statusBarFor(TABLE, IN_CELL);
        assert.equal(el.classes.has('tt-status-warn'), false);
        assert.equal(el.title, '');
        const before = ed.getValue();
        el.fire('click');
        assert.equal(ed.getValue(), before, 'an ordinary R/C readout is inert');
    } finally {
        restore();
    }
});

test('a repair keeps the caret near the cell it was in, not at the first', () => {
    const restore = installDom();
    try {
        // break the table at the LAST cell, and start the caret there
        const late = TABLE.replace('<td>Alice</td>', '<td>Alice\nmore text</td>');
        const broken = late.replace('<tr>\n<td>Design review', '<tr>oops\n<td>Design review');
        const ed = new MockEditor(broken, { line: 10, ch: 2 });
        const p = makePlugin(ed);
        p.reformatTable();
        // Ask the plugin where the caret now is, rather than guessing from the
        // line text — a wrapped cell's caret sits on its last line, by the
        // closing tag, which is the right place but not the first line.
        const loc = p.locate(ed, false);
        assert.ok(loc, 'the table parses after the repair');
        assert.deepEqual({ row: loc.row, cell: loc.cell }, { row: 1, cell: 1 },
            'back in the last cell, not thrown to the first');
    } finally {
        restore();
    }
});

// Catch whichever modal a click opens, so dialogs can be driven from the
// outside without widening the plugin's exports just for tests.
function captureModals(fn) {
    const opened = [];
    // Both, because FuzzySuggestModal overrides open() and would otherwise
    // slip past a patch on Modal alone.
    const targets = [obsidian.Modal.prototype, obsidian.FuzzySuggestModal.prototype];
    const originals = targets.map((p) => p.open);
    targets.forEach((proto, i) => {
        proto.open = function open() {
            opened.push(this);
            return originals[i].call(this);
        };
    });
    try {
        fn();
    } finally {
        targets.forEach((proto, i) => { proto.open = originals[i]; });
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

test('the image picker offers only images, and writes the chosen one into the cell', () => {
    const restore = installDom();
    try {
        const ed = new MockEditor(TABLE, IN_CELL);
        const p = makePlugin(ed);
        const opened = captureModals(() => p.promptInsertImage());
        assert.equal(opened.length, 1, 'the picker opened');

        const picker = opened[0];
        const items = picker.getItems();
        assert.deepEqual(items.map((f) => f.path), [
            // the note's own folder first, whatever the modification times say
            'Finance/Retirement/docs/chart.png',
            'attachments/shot.png',
        ], 'images beside the note lead, and the markdown file is not offered');
        assert.equal(picker.getItemText(items[0]), 'Finance/Retirement/docs/chart.png',
            'the full path is the search text, so typing a folder narrows the list');

        // choosing leads to the width prompt, pre-filled with the last used
        const prompts = captureModals(() => picker.onChooseItem(items[0]));
        assert.equal(prompts.length, 1, 'the width prompt follows the picker');
        assert.equal(prompts[0].opts.value, '300', 'pre-filled with the remembered width');

        prompts[0].opts.onSubmit('240');
        assert.match(
            ed.getValue(),
            /<td>Design review<img data-tt-src="Finance\/Retirement\/docs\/chart\.png" alt="chart\.png" width="240"><\/td>/,
            'appended at the chosen width, leaving the text that was already there'
        );
        assert.ok(
            plugin.__internals.parseTable(ed.getValue().split('\n').slice(2, 12)),
            'and the table still parses'
        );
    } finally {
        restore();
    }
});

test('inserting an image needs the cursor in a table', () => {
    const restore = installDom();
    obsidian.__notices.length = 0;
    try {
        const ed = new MockEditor(TABLE, { line: 0, ch: 3 });
        const opened = captureModals(() => makePlugin(ed).promptInsertImage());
        assert.equal(opened.length, 0, 'no picker outside a table');
        assert.equal(obsidian.__notices.some((n) => /inside an HTML table first/.test(n)), true);
    } finally {
        restore();
    }
});

test('a dialog on an unreadable table names the line instead of blaming the cursor', () => {
    const restore = installDom();
    try {
        // a blank line after <tr>, which is what ends the HTML block
        const broken = TABLE.replace('<tr>\n<td>Design review', '<tr>\n\n<td>Design review');
        for (const method of ['promptInsertImage', 'promptCellBackground', 'promptColumnWidth', 'promptTableBorders']) {
            obsidian.__notices.length = 0;
            const ed = new MockEditor(broken, { line: 9, ch: 4 });
            const opened = captureModals(() => makePlugin(ed)[method]());
            assert.equal(opened.length, 0, method + ' should not open on an unreadable table');
            const said = obsidian.__notices.join(' | ');
            assert.match(said, /cannot be read — line 9/, method + ' should name the line, got: ' + said);
            assert.match(said, /blank line ends the table/, method + ' should give the reason');
            assert.doesNotMatch(said, /Put the cursor/, method + ' should not blame the cursor');
        }
    } finally {
        restore();
    }
});

test('the sweep resolves images the post-processor never reached', () => {
    const restore = installDom();
    try {
        const { FakeEl } = require('./mocks/dom.js');
        const p = makePlugin(new MockEditor(TABLE, IN_CELL));
        p.app.metadataCache.getFirstLinkpathDest = (link) => ({ path: link });

        const unresolved = new FakeEl('img');
        unresolved.setAttribute('data-tt-src', 'Finance/Retirement/docs/chart.png');
        const workspace = new FakeEl('div');
        workspace.classes.add('workspace');
        // only images without a src are collected, so working ones cost nothing
        workspace.querySelectorAll = (sel) => (/:not\(\[src\]\)/.test(sel) ? [unresolved] : []);
        global.document.querySelector = (sel) => (sel === '.workspace' ? workspace : null);

        assert.equal(p.sweepImages(), 1, 'one image was picked up');
        assert.equal(
            unresolved.getAttribute('src'),
            'app://resolved/Finance/Retirement/docs/chart.png'
        );
    } finally {
        restore();
    }
});

test('a re-rendered image is resolved as soon as the DOM changes', () => {
    const restore = installDom();
    try {
        const { FakeEl, FakeMutationObserver } = require('./mocks/dom.js');
        const p = makePlugin(new MockEditor(TABLE, IN_CELL));
        p.app.metadataCache.getFirstLinkpathDest = (link) => ({ path: link });

        const workspace = new FakeEl('div');
        let live = [];
        workspace.querySelectorAll = (sel) => (/:not\(\[src\]\)/.test(sel) ? live : []);
        global.document.querySelector = (sel) => (sel === '.workspace' ? workspace : null);

        p.watchImages();
        const observer = FakeMutationObserver.instances.find((o) => o.target === workspace);
        assert.ok(observer, 'the workspace is being watched');
        assert.equal(observer.options.childList && observer.options.subtree, true);

        // Obsidian re-renders the block: a brand-new img appears with no src,
        // which is exactly the state that used to persist until the next click
        const fresh = new FakeEl('img');
        fresh.setAttribute('data-tt-src', 'docs/chart.png');
        live = [fresh];

        observer.fire();
        assert.equal(fresh.getAttribute('src'), 'app://resolved/docs/chart.png',
            'resolved without waiting for another click');
    } finally {
        restore();
    }
});

test('watching stops when the plugin unloads', () => {
    const restore = installDom();
    try {
        const { FakeEl, FakeMutationObserver } = require('./mocks/dom.js');
        const p = makePlugin(new MockEditor(TABLE, IN_CELL));
        const cleanups = [];
        p.register = (fn) => cleanups.push(fn);
        const workspace = new FakeEl('div');
        workspace.querySelectorAll = () => [];
        global.document.querySelector = (sel) => (sel === '.workspace' ? workspace : null);

        p.watchImages();
        const observer = FakeMutationObserver.instances.find((o) => o.target === workspace);
        cleanups.forEach((fn) => fn());
        assert.equal(observer.disconnected, true, 'the observer is disconnected on unload');
    } finally {
        restore();
    }
});

test('the sweep is harmless when there is nothing to do', () => {
    const restore = installDom();
    try {
        const p = makePlugin(new MockEditor(TABLE, IN_CELL));
        global.document.querySelector = () => null;
        assert.equal(p.sweepImages(), 0, 'no workspace, no work, no throw');
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
