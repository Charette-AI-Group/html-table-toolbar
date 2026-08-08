'use strict';

// Regression tests for the table engine in main.js.
// Run with: node --test "tests/*.test.js"

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const Module = require('node:module');

// Route require('obsidian') to the mock before loading the plugin
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
    if (request === 'obsidian') return path.join(__dirname, 'mocks', 'obsidian.js');
    return origResolve.call(this, request, ...rest);
};

const plugin = require('../main.js');
const {
    parseTable, serializeTable, lineOfCell, cellAtLine, gridInfo, columnOfCell,
    insertRow, deleteRow, insertColumn, deleteColumn, mergeCells, mergeDirection, splitCell,
    toggleHeaderRow, setCellAlign, setColumnAlign, setTableAlign, setColumnWidth,
    setTableBorder, currentBorder, setStyleProp, getStyleProp,
    setRowBorder, rowEdges, rowLineFormat, setColumnBorder, columnEdges, columnLineFormat,
    buildTableLines, stampMarker, parseAttrs, attrsToString, getAttr, colMarker,
    parseColor, toRgba, sameColor, isColorish, isLengthish, DEFAULT_CELL_SHADES,
} = plugin.__internals;

// --- helpers ---------------------------------------------------------------

// Compact notation: each string is a row, cells separated by '|'.
// A cell may carry spans as "text@RxC" (rowspan x colspan).
function table(rows, opts) {
    const out = ['<table>'];
    if (opts && opts.cols) {
        out.push('<colgroup>');
        for (const c of opts.cols) out.push('<col' + (c ? ' style="width:' + c + '"' : '') + '>');
        out.push('</colgroup>');
    }
    for (const row of rows) {
        out.push('<tr>');
        for (const spec of row.split('|')) {
            const m = /^([^@]*)(?:@(\d+)x(\d+))?$/.exec(spec);
            const tag = m[1].startsWith('!') ? 'th' : 'td';
            const text = m[1].startsWith('!') ? m[1].slice(1) : m[1];
            let attrs = '';
            if (m[2] && Number(m[2]) > 1) attrs += ' rowspan="' + m[2] + '"';
            if (m[3] && Number(m[3]) > 1) attrs += ' colspan="' + m[3] + '"';
            out.push('<' + tag + attrs + '>' + text + '</' + tag + '>');
        }
        out.push('</tr>');
    }
    out.push('</table>');
    return out;
}

function parsed(rows, opts) {
    const model = parseTable(table(rows, opts));
    assert.ok(model, 'fixture should parse');
    return model;
}

// Render the model back to the compact grid notation, resolving spans so a
// merged cell shows up in every position it covers. This is what makes the
// span-aware assertions readable.
function render(model) {
    const { grid, cols } = gridInfo(model);
    return grid.map((g) => {
        const line = [];
        for (let c = 0; c < cols; c++) {
            const cell = g[c];
            if (!cell) { line.push('.'); continue; }
            const src = model.rows[cell.row].cells[cell.cell];
            line.push((src.tag === 'th' ? '!' : '') + (src.content || ''));
        }
        return line.join('|');
    });
}

// --- parse / serialize -----------------------------------------------------

test('parses the canonical format and round-trips it byte for byte', () => {
    const lines = [
        '<table class="tt-table" data-tt="1">',
        '<colgroup>',
        '<col style="width:38%">',
        '<col>',
        '</colgroup>',
        '<tr>',
        '<th>Task</th>',
        '<th>Owner</th>',
        '</tr>',
        '<tr>',
        '<td>Design review</td>',
        '<td class="tt-c">Alice</td>',
        '</tr>',
        '</table>',
    ];
    const model = parseTable(lines);
    assert.ok(model);
    assert.equal(model.rows.length, 2);
    assert.equal(model.cols.length, 2);
    assert.equal(model.rows[0].cells[0].tag, 'th');
    assert.equal(model.rows[1].cells[0].content, 'Design review');
    assert.deepEqual(serializeTable(model), lines);
});

test('rejects layouts the fast path cannot address by line', () => {
    // two cells on one line
    assert.equal(parseTable(['<table>', '<tr>', '<td>a</td><td>b</td>', '</tr>', '</table>']), null);
    // blank line inside the table (terminates the HTML block under CommonMark)
    assert.equal(parseTable(['<table>', '<tr>', '', '<td>a</td>', '</tr>', '</table>']), null);
    // missing </tr>
    assert.equal(parseTable(['<table>', '<tr>', '<td>a</td>', '</table>']), null);
    // not a table at all
    assert.equal(parseTable(['<div>', '</div>']), null);
});

test('keeps cell content containing inline HTML on one line', () => {
    const lines = ['<table>', '<tr>', '<td><b>a</b><br>b</td>', '</tr>', '</table>'];
    const model = parseTable(lines);
    assert.equal(model.rows[0].cells[0].content, '<b>a</b><br>b');
    assert.deepEqual(serializeTable(model), lines);
});

test('attributes keep their original order and quoting style', () => {
    const attrs = parseAttrs(' data-x="1" class="a b" colspan="2"');
    assert.equal(attrsToString(attrs), ' data-x="1" class="a b" colspan="2"');
});

// --- addressing ------------------------------------------------------------

test('cell address and line number are inverses of each other', () => {
    const model = parsed(['!a|!b', 'c|d'], { cols: ['30%', ''] });
    for (let r = 0; r < model.rows.length; r++) {
        for (let ci = 0; ci < model.rows[r].cells.length; ci++) {
            const line = lineOfCell(model, r, ci);
            assert.deepEqual(cellAtLine(model, line), { row: r, cell: ci });
        }
    }
    // colgroup lines and the <table>/</table> lines are outside any row
    assert.deepEqual(cellAtLine(model, 0), { row: -1, cell: -1 });
    assert.deepEqual(cellAtLine(model, 2), { row: -1, cell: -1 });
});

test('grid columns account for colspan and rowspan', () => {
    // a spans two columns; b spans two rows
    const model = parsed(['a@1x2|b@2x1', 'c|d']);
    const { cols } = gridInfo(model);
    assert.equal(cols, 3);
    assert.deepEqual(render(model), ['a|a|b', 'c|d|b']);
    assert.equal(columnOfCell(model, 1, 1), 1);
});

// --- rows ------------------------------------------------------------------

test('inserts a row above and below', () => {
    const model = parsed(['a|b', 'c|d']);
    insertRow(model, 1);
    assert.deepEqual(render(model), ['a|b', '|', 'c|d']);
});

test('a rowspan straddling the insertion point grows instead of splitting', () => {
    // b covers both rows; inserting between them must extend b, not break it
    const model = parsed(['a|b@2x1', 'c']);
    insertRow(model, 1);
    assert.deepEqual(render(model), ['a|b', '|b', 'c|b']);
    assert.equal(model.rows[1].cells.length, 1, 'new row only gets the uncovered column');
});

test('deleting a row shortens the spans that passed through it', () => {
    const model = parsed(['a|b@3x1', 'c', 'd']);
    deleteRow(model, 1);
    assert.deepEqual(render(model), ['a|b', 'd|b']);
});

test('deleting a row re-anchors a span that started in it', () => {
    const model = parsed(['a|b@2x1', 'c', 'd|e']);
    deleteRow(model, 0);
    // b was anchored in row 0 and continued into row 1: it moves down
    assert.deepEqual(render(model), ['c|b', 'd|e']);
    assert.equal(model.rows[0].cells[1].content, 'b');
});

test('refuses to delete the only row', () => {
    const model = parsed(['a|b']);
    assert.throws(() => deleteRow(model, 0), /only row/);
});

// --- columns ---------------------------------------------------------------

test('inserts a column left and right', () => {
    const model = parsed(['a|b', 'c|d']);
    insertColumn(model, 1);
    assert.deepEqual(render(model), ['a||b', 'c||d']);
});

test('a colspan straddling the insertion point grows instead of splitting', () => {
    const model = parsed(['a@1x2', 'c|d']);
    insertColumn(model, 1);
    assert.deepEqual(render(model), ['a|a|a', 'c||d']);
    assert.equal(model.rows[0].cells.length, 1, 'the spanning row gets no extra cell');
});

test('deleting a column narrows spans and drops single cells', () => {
    const model = parsed(['a@1x2|b', 'c|d|e']);
    deleteColumn(model, 1);
    assert.deepEqual(render(model), ['a|b', 'c|e']);
});

test('deleting a column keeps the colgroup in step', () => {
    const model = parsed(['a|b|c'], { cols: ['20%', '30%', '50%'] });
    deleteColumn(model, 1);
    assert.equal(model.cols.length, 2);
    assert.equal(serializeTable(model).filter((l) => /^<col[\s>]/.test(l)).length, 2);
});

test('refuses to delete the only column', () => {
    const model = parsed(['a', 'b']);
    assert.throws(() => deleteColumn(model, 0), /only column/);
});

// --- merge / split ---------------------------------------------------------

test('merges a rectangle and joins the text with <br>', () => {
    const model = parsed(['a|b', 'c|d']);
    const target = mergeCells(model, 0, 0, 1, 1);
    assert.deepEqual(render(model), ['a<br>b<br>c<br>d|a<br>b<br>c<br>d', 'a<br>b<br>c<br>d|a<br>b<br>c<br>d']);
    assert.deepEqual(target, { row: 0, cell: 0 });
    assert.equal(model.rows[0].cells.length, 1);
    assert.equal(model.rows[1].cells.length, 0, 'fully covered row keeps an empty <tr>');
});

test('merging over an existing merge grows the rectangle to enclose it', () => {
    // b already spans two columns; selecting only a must pull b in whole
    const model = parsed(['a|b@1x2', 'c|d|e']);
    mergeCells(model, 0, 0, 0, 1);
    assert.deepEqual(render(model), ['a<br>b|a<br>b|a<br>b', 'c|d|e']);
});

test('merge needs more than one cell', () => {
    const model = parsed(['a|b']);
    assert.throws(() => mergeCells(model, 0, 0, 0, 0), /at least two/);
});

test('split restores plain cells across every row the merge covered', () => {
    const model = parsed(['a|b', 'c|d']);
    mergeCells(model, 0, 0, 1, 1);
    splitCell(model, 0, 0);
    const grid = render(model);
    assert.equal(grid.length, 2);
    assert.equal(grid[0].split('|').length, 2);
    assert.equal(grid[1].split('|').length, 2);
    assert.equal(model.rows[0].cells[0].content, 'a<br>b<br>c<br>d');
    assert.equal(model.rows[1].cells.length, 2, 'the emptied row gets its cells back');
});

test('merge then split round-trips the shape', () => {
    const before = parsed(['a|b|c', 'd|e|f', 'g|h|i']);
    const model = parsed(['a|b|c', 'd|e|f', 'g|h|i']);
    mergeCells(model, 0, 1, 1, 2);
    splitCell(model, 0, 1);
    const dims = (m) => gridInfo(m).grid.map((g) => g.filter(Boolean).length);
    assert.deepEqual(dims(model), dims(before));
});

test('merge right joins the neighbouring cell without any selection', () => {
    const model = parsed(['a|b|c', 'd|e|f']);
    const target = mergeDirection(model, 0, 0, 'right');
    assert.deepEqual(render(model), ['a<br>b|a<br>b|c', 'd|e|f']);
    assert.deepEqual(target, { row: 0, cell: 0 });
});

test('merge down joins the cell beneath', () => {
    const model = parsed(['a|b', 'c|d']);
    mergeDirection(model, 0, 1, 'down');
    assert.deepEqual(render(model), ['a|b<br>d', 'c|b<br>d']);
});

test('merging right again from an already merged cell keeps growing it', () => {
    const model = parsed(['a|b|c', 'd|e|f']);
    mergeDirection(model, 0, 0, 'right');
    mergeDirection(model, 0, 0, 'right');
    assert.deepEqual(render(model), ['a<br>b<br>c|a<br>b<br>c|a<br>b<br>c', 'd|e|f']);
});

test('merge down from a wide cell takes the whole width with it', () => {
    const model = parsed(['a@1x2|b', 'c|d|e']);
    mergeDirection(model, 0, 0, 'down');
    // the two cells beneath the span are absorbed, so the merge stays square
    assert.deepEqual(render(model), ['a<br>c<br>d|a<br>c<br>d|b', 'a<br>c<br>d|a<br>c<br>d|e']);
});

test('merge right from a tall cell keeps both rows together', () => {
    const model = parsed(['a@2x1|b', 'c']);
    mergeDirection(model, 0, 0, 'right');
    assert.deepEqual(render(model), ['a<br>b<br>c|a<br>b<br>c', 'a<br>b<br>c|a<br>b<br>c']);
});

test('merging past the edge says so instead of throwing', () => {
    const model = parsed(['a|b', 'c|d']);
    assert.throws(() => mergeDirection(model, 0, 1, 'right'), /no cell to the right/);
    assert.throws(() => mergeDirection(model, 1, 0, 'down'), /no cell below/);
});

test('split refuses on an unmerged cell', () => {
    const model = parsed(['a|b']);
    assert.throws(() => splitCell(model, 0, 0), /not merged/);
});

test('cell operations on a row emptied by a merge report it clearly', () => {
    const model = parsed(['a|b', 'c|d']);
    mergeCells(model, 0, 0, 1, 1);
    assert.equal(model.rows[1].cells.length, 0);
    assert.throws(() => setCellAlign(model, 1, -1, 'center'), /covered by a merge/);
    assert.throws(() => splitCell(model, 1, -1), /covered by a merge/);
    assert.throws(() => toggleHeaderRow(model, 1), /covered by a merge/);
});

// --- formatting ------------------------------------------------------------

test('header row toggles both ways', () => {
    const model = parsed(['a|b', 'c|d']);
    toggleHeaderRow(model, 0);
    assert.equal(model.rows[0].cells[0].tag, 'th');
    toggleHeaderRow(model, 0);
    assert.equal(model.rows[0].cells[0].tag, 'td');
});

test('cell alignment is exclusive and the same button clears it', () => {
    const model = parsed(['a|b']);
    setCellAlign(model, 0, 0, 'center');
    assert.match(serializeTable(model)[2], /class="tt-c"/);
    setCellAlign(model, 0, 0, 'right');
    assert.match(serializeTable(model)[2], /class="tt-r"/);
    setCellAlign(model, 0, 0, 'right');
    assert.doesNotMatch(serializeTable(model)[2], /class=/, 'reapplying clears it');
});

test('column alignment touches every cell in the column exactly once', () => {
    const model = parsed(['a|b', 'c@2x1|d', 'e']);
    setColumnAlign(model, 0, 'center');
    assert.match(serializeTable(model).join('\n'), /<td class="tt-c">a<\/td>/);
    assert.equal((serializeTable(model).join('\n').match(/tt-c/g) || []).length, 2);
});

test('table alignment toggles a class on the table element', () => {
    const model = parsed(['a']);
    setTableAlign(model, 'center');
    assert.match(serializeTable(model)[0], /class="tt-center"/);
    setTableAlign(model, 'center');
    assert.doesNotMatch(serializeTable(model)[0], /tt-center/);
});

// --- borders ----------------------------------------------------------------

test('setStyleProp edits one declaration and leaves the rest alone', () => {
    const attrs = parseAttrs(' style="color:red; width:40%; margin:0"');
    setStyleProp(attrs, 'width', '60%');
    assert.equal(getAttr(attrs, 'style'), 'width:60%; color:red; margin:0');
    setStyleProp(attrs, 'width', '');
    assert.equal(getAttr(attrs, 'style'), 'color:red; margin:0');
    assert.equal(getStyleProp(attrs, 'color'), 'red');
    assert.equal(getStyleProp(attrs, 'width'), '');
});

test('the style attribute is dropped once its last declaration goes', () => {
    const attrs = parseAttrs(' style="width:40%"');
    setStyleProp(attrs, 'width', '');
    assert.equal(getAttr(attrs, 'style'), null);
    assert.equal(attrsToString(attrs), '');
});

const PLAIN = { width: '1px', style: 'solid', color: '' };

test('the default grid pattern writes nothing at all', () => {
    const model = parsed(['a|b']);
    setTableBorder(model, 'grid', PLAIN);
    assert.equal(serializeTable(model)[0], '<table>');
    assert.equal(currentBorder(model), 'grid');
});

test('each pattern sets its own class, exclusively', () => {
    const model = parsed(['a|b']);
    setTableBorder(model, 'rules', PLAIN);
    assert.match(serializeTable(model)[0], /class="tt-rules"/);
    assert.equal(currentBorder(model), 'rules');
    setTableBorder(model, 'box', PLAIN);
    assert.match(serializeTable(model)[0], /class="tt-box"/);
    assert.doesNotMatch(serializeTable(model)[0], /tt-rules/);
    assert.equal(currentBorder(model), 'box');
    // and back to the default clears it again
    setTableBorder(model, 'grid', PLAIN);
    assert.doesNotMatch(serializeTable(model)[0], /class=/);
});

test('choosing the pattern already set keeps it, rather than toggling it off', () => {
    const model = parsed(['a|b']);
    setTableBorder(model, 'rules', PLAIN);
    setTableBorder(model, 'rules', PLAIN);
    assert.equal(currentBorder(model), 'rules');
});

test('thickness, line type and colour ride on the table, not on every cell', () => {
    const model = parsed(['a|b', 'c|d']);
    setTableBorder(model, 'grid', { width: '3px', style: 'dashed', color: '#8888aa' });
    const lines = serializeTable(model);
    assert.match(lines[0], /--tt-line-color:#8888aa/);
    assert.match(lines[0], /--tt-line-width:3px/);
    assert.match(lines[0], /--tt-line-style:dashed/);
    // every cell line is untouched
    assert.equal(lines.filter((l) => /^<t[dh]/.test(l)).every((l) => !l.includes('border')), true);
});

test('every offered line type is accepted and written', () => {
    for (const style of ['dashed', 'dotted', 'double']) {
        const model = parsed(['a|b']);
        setTableBorder(model, 'grid', { width: '3px', style, color: '' });
        assert.match(serializeTable(model)[0], new RegExp('--tt-line-style:' + style));
    }
});

test('solid is the default and so is never written out', () => {
    const model = parsed(['a|b']);
    setTableBorder(model, 'grid', { width: '2px', style: 'solid', color: '' });
    const open = serializeTable(model)[0];
    assert.match(open, /--tt-line-width:2px/);
    assert.doesNotMatch(open, /--tt-line-style/);
});

test('defaults are left out so an ordinary table carries no inline style', () => {
    const model = parsed(['a|b']);
    setTableBorder(model, 'grid', { width: '3px', style: 'dotted', color: '#333' });
    setTableBorder(model, 'grid', PLAIN);
    assert.equal(serializeTable(model)[0], '<table>');
});

test('borders coexist with table alignment on the same element', () => {
    const model = parsed(['a|b']);
    setTableAlign(model, 'center');
    setTableBorder(model, 'rules', { width: '2px', style: 'dashed', color: '#444' });
    const open = serializeTable(model)[0];
    assert.match(open, /tt-center/);
    assert.match(open, /tt-rules/);
    assert.match(open, /--tt-line-width:2px/);
    assert.match(open, /--tt-line-style:dashed/);
});

// --- row and column edges ---------------------------------------------------

test('a row border marks the <tr> and nothing else', () => {
    const model = parsed(['!Task|!Owner', 'a|b', 'c|d']);
    setRowBorder(model, 0, ['bottom'], PLAIN);
    const lines = serializeTable(model);
    assert.deepEqual(lines.filter((l) => l.startsWith('<tr')), [
        '<tr class="tt-rb">', '<tr>', '<tr>',
    ]);
    assert.equal(lines[0], '<table>', 'the table pattern is untouched');
    assert.deepEqual(rowEdges(model, 0), ['bottom']);
});

test('a row can carry both edges, and None clears them', () => {
    const model = parsed(['a|b', 'c|d']);
    setRowBorder(model, 1, ['top', 'bottom'], PLAIN);
    assert.deepEqual(rowEdges(model, 1), ['top', 'bottom']);
    assert.match(serializeTable(model)[5], /class="tt-rt tt-rb"/);
    setRowBorder(model, 1, [], PLAIN);
    assert.deepEqual(rowEdges(model, 1), []);
    assert.equal(serializeTable(model)[5], '<tr>');
});

test('several rows can carry borders at once', () => {
    const model = parsed(['a|b', 'c|d', 'e|f']);
    setRowBorder(model, 0, ['bottom'], PLAIN);
    setRowBorder(model, 2, ['top'], PLAIN);
    assert.deepEqual(rowEdges(model, 0), ['bottom']);
    assert.deepEqual(rowEdges(model, 2), ['top']);
});

test('row borders layer over whatever pattern the table has', () => {
    const model = parsed(['a|b', 'c|d']);
    setTableBorder(model, 'none', PLAIN);
    setRowBorder(model, 0, ['bottom'], PLAIN);
    const open = serializeTable(model)[0];
    assert.match(open, /tt-bare/, 'the pattern survives');
    assert.deepEqual(rowEdges(model, 0), ['bottom']);
});

test('a marked row travels with a structural edit above it', () => {
    const model = parsed(['a|b', 'c|d']);
    setRowBorder(model, 1, ['bottom'], PLAIN);
    insertRow(model, 0);
    assert.deepEqual(rowEdges(model, 2), ['bottom']);
    assert.deepEqual(rowEdges(model, 1), []);
});

test('a column border marks the cells sitting on that edge', () => {
    const model = parsed(['a|b|c', 'd|e|f']);
    setColumnBorder(model, 1, ['right'], PLAIN);
    const cells = serializeTable(model).filter((l) => /^<t[dh]/.test(l));
    assert.deepEqual(cells, [
        '<td>a</td>', '<td class="tt-cr">b</td>', '<td>c</td>',
        '<td>d</td>', '<td class="tt-cr">e</td>', '<td>f</td>',
    ]);
    assert.deepEqual(columnEdges(model, 1), ['right']);
});

test('a spanning cell counts on the first and last column it covers', () => {
    const model = parsed(['wide@1x2|tail', 'a|b|c']);
    // the wide cell starts at column 0 and ends at column 1
    setColumnBorder(model, 1, ['right'], PLAIN);
    assert.deepEqual(columnEdges(model, 1), ['right']);
    assert.match(serializeTable(model)[2], /colspan="2" class="tt-cr"/);
    // its left edge belongs to column 0, not column 1
    setColumnBorder(model, 0, ['left'], PLAIN);
    assert.match(serializeTable(model)[2], /tt-cl/);
});

test('column None clears only that column', () => {
    const model = parsed(['a|b|c']);
    setColumnBorder(model, 0, ['left'], PLAIN);
    setColumnBorder(model, 2, ['right'], PLAIN);
    setColumnBorder(model, 0, [], PLAIN);
    assert.deepEqual(columnEdges(model, 0), []);
    assert.deepEqual(columnEdges(model, 2), ['right'], 'the other column is left alone');
});

test('edge line format is only written where it differs from the table', () => {
    const model = parsed(['a|b']);
    setTableBorder(model, 'grid', { width: '2px', style: 'solid', color: '' });
    // same as the table: nothing extra written, so it keeps tracking the table
    setRowBorder(model, 0, ['bottom'], { width: '2px', style: 'solid', color: '' });
    assert.equal(serializeTable(model)[1], '<tr class="tt-rb">');
    // different: written, and onto the row rather than the table
    setRowBorder(model, 0, ['bottom'], { width: '4px', style: 'dashed', color: '#c00' });
    assert.doesNotMatch(serializeTable(model)[0], /--tt-row-/, 'never onto the table');
    const tr = serializeTable(model)[1];
    assert.match(tr, /--tt-row-width:4px/);
    assert.match(tr, /--tt-row-style:dashed/);
    assert.match(tr, /--tt-row-color:#c00/);
});

test('each row keeps its own colour', () => {
    const model = parsed(['a|b', 'c|d', 'e|f', 'g|h']);
    setRowBorder(model, 1, ['bottom'], { width: '2px', style: 'solid', color: '#c00' });
    setRowBorder(model, 3, ['bottom'], { width: '1px', style: 'dashed', color: '#00c' });
    assert.equal(rowLineFormat(model, 1).color, '#c00', 'row 2 stays red');
    assert.equal(rowLineFormat(model, 1).width, '2px');
    assert.equal(rowLineFormat(model, 3).color, '#00c', 'row 4 is blue');
    assert.equal(rowLineFormat(model, 3).style, 'dashed');
    // both rows still marked
    assert.deepEqual(rowEdges(model, 1), ['bottom']);
    assert.deepEqual(rowEdges(model, 3), ['bottom']);
});

test('each column keeps its own line, per side', () => {
    const model = parsed(['a|b|c', 'd|e|f']);
    setColumnBorder(model, 0, ['right'], { width: '3px', style: 'solid', color: '#c00' });
    setColumnBorder(model, 1, ['left'], { width: '1px', style: 'dotted', color: '#00c' });
    assert.equal(columnLineFormat(model, 0).color, '#c00');
    assert.equal(columnLineFormat(model, 1).color, '#00c');
    // the same cell can serve both, so the two sides are stored apart
    const cellB = serializeTable(model).find((l) => l.includes('>b<'));
    assert.match(cellB, /tt-cl/);
    assert.match(cellB, /--tt-cl-color:#00c/);
    const cellA = serializeTable(model).find((l) => l.includes('>a<'));
    assert.match(cellA, /--tt-cr-color:#c00/);
});

test('dropping the last edge clears its line format too', () => {
    const model = parsed(['a|b']);
    setRowBorder(model, 0, ['bottom'], { width: '4px', style: 'dashed', color: '#c00' });
    assert.match(serializeTable(model)[1], /--tt-row-width/);
    setRowBorder(model, 0, [], { width: '4px', style: 'dashed', color: '#c00' });
    assert.equal(serializeTable(model)[1], '<tr>');
    assert.equal(serializeTable(model)[0], '<table>');
});

test('setting one row does not disturb another', () => {
    const model = parsed(['a|b', 'c|d', 'e|f']);
    setRowBorder(model, 0, ['bottom'], { width: '3px', style: 'solid', color: '#c00' });
    const before = serializeTable(model)[1];
    setRowBorder(model, 2, ['top'], { width: '1px', style: 'dotted', color: '#0a0' });
    assert.equal(serializeTable(model)[1], before, 'row 1 is byte-identical afterwards');
});

test('a row, column or edge that does not exist is refused', () => {
    const model = parsed(['a|b']);
    assert.throws(() => setRowBorder(model, 5, ['bottom'], PLAIN), /row does not exist/);
    assert.throws(() => setColumnBorder(model, 9, ['left'], PLAIN), /column does not exist/);
    assert.throws(() => setRowBorder(model, 0, ['left'], PLAIN), /Unknown row edge/);
    assert.throws(() => setColumnBorder(model, 0, ['top'], PLAIN), /Unknown column edge/);
});

test('the superseded single-row class is still read and then cleaned up', () => {
    const model = parseTable(['<table>', '<tr class="tt-rule">', '<td>a</td>', '</tr>', '</table>']);
    assert.deepEqual(rowEdges(model, 0), ['bottom']);
    setRowBorder(model, 0, ['top'], PLAIN);
    assert.equal(serializeTable(model)[1], '<tr class="tt-rt">');
});

test('an unknown pattern or line type is refused', () => {
    const model = parsed(['a|b']);
    assert.throws(() => setTableBorder(model, 'dotted-ish', PLAIN), /Unknown border pattern/);
    assert.throws(
        () => setTableBorder(model, 'grid', { width: '1px', style: 'squiggly', color: '' }),
        /Unknown line type/
    );
});

test('column width creates a colgroup on demand and removes it when empty', () => {
    const model = parsed(['a|b']);
    setColumnWidth(model, 0, '40%');
    assert.deepEqual(serializeTable(model).slice(1, 4), ['<colgroup>', '<col style="width:40%">', '<col>']);
    setColumnWidth(model, 0, '');
    assert.equal(model.cols, null, 'an all-empty colgroup is dropped');
});

// --- construction ----------------------------------------------------------

test('new tables are canonical, marked, and parse back', () => {
    const lines = buildTableLines(2, 3, true);
    assert.equal(lines[0], '<table class="tt-table" data-tt="1">');
    const model = parseTable(lines);
    assert.ok(model);
    assert.equal(model.rows.length, 2);
    assert.equal(model.rows[0].cells.every((c) => c.tag === 'th'), true);
    assert.equal(model.rows[1].cells.length, 3);
});

// --- row markers ------------------------------------------------------------

test('parses a marked table and round-trips it', () => {
    const lines = [
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
    ];
    const model = parseTable(lines);
    assert.ok(model);
    assert.equal(model.markers, true);
    // the marker is stripped from the content, not kept as text
    assert.equal(model.rows[1].cells[0].content, 'Design review');
    assert.deepEqual(serializeTable(model), lines);
});

test('a marker on any row or cell is enough to keep a table marked', () => {
    const byRow = parseTable(['<table>', '<tr><!-- r01 -->', '<td>a</td>', '</tr>', '</table>']);
    assert.equal(byRow.markers, true);
    assert.deepEqual(serializeTable(byRow).slice(1, 3), ['<tr><!-- r01 -->', '<td><!-- c01 -->a</td>']);

    const byCell = parseTable(['<table>', '<tr>', '<td><!-- c01 -->a</td>', '</tr>', '</table>']);
    assert.equal(byCell.markers, true);
});

test('an old legend line still parses and is dropped on the next write', () => {
    const lines = [
        '<table>',
        '<!-- cols: 1 Task | 2 Owner -->',
        '<tr><!-- r01 -->',
        '<td>Task</td>',
        '<td>Owner</td>',
        '</tr>',
        '</table>',
    ];
    const model = parseTable(lines);
    assert.equal(model.markers, true);
    assert.equal(model.sourceLegend, true);
    const out = serializeTable(model);
    assert.equal(out.some((l) => l.includes('cols:')), false, 'legend is not written back');
    assert.equal(out[1], '<tr><!-- r01 -->');
    // the legend still occupies a line in the SOURCE, so cursor mapping must
    // account for it while the new output must not
    assert.deepEqual(cellAtLine(model, 3), { row: 0, cell: 0 });
    assert.equal(lineOfCell(model, 0, 0), 2);
});

test('unmarked tables stay unmarked', () => {
    const model = parsed(['a|b']);
    assert.equal(model.markers, false);
    assert.equal(serializeTable(model).some((l) => l.includes('<!--')), false);
});

test('markers are renumbered wholesale after a structural edit', () => {
    const model = parsed(['!a|!b', 'c|d', 'e|f']);
    model.markers = true;
    deleteRow(model, 1);
    insertRow(model, 1);
    const trs = serializeTable(model).filter((l) => l.startsWith('<tr'));
    assert.deepEqual(trs, ['<tr><!-- r01 -->', '<tr><!-- r02 -->', '<tr><!-- r03 -->']);
});

test('marker width grows past ninety-nine rows', () => {
    const rows = [];
    for (let i = 0; i < 100; i++) rows.push('a|b');
    const model = parsed(rows);
    model.markers = true;
    const trs = serializeTable(model).filter((l) => l.startsWith('<tr'));
    assert.equal(trs[0], '<tr><!-- r001 -->');
    assert.equal(trs[99], '<tr><!-- r100 -->');
});

test('every cell states its own column', () => {
    const model = parsed(['!Task|!Owner|!Notes', 'a|b|c']);
    model.markers = true;
    const cells = serializeTable(model).filter((l) => /^<t[dh]/.test(l));
    assert.deepEqual(cells, [
        '<th><!-- c01 -->Task</th>',
        '<th><!-- c02 -->Owner</th>',
        '<th><!-- c03 -->Notes</th>',
        '<td><!-- c01 -->a</td>',
        '<td><!-- c02 -->b</td>',
        '<td><!-- c03 -->c</td>',
    ]);
});

test('a spanning cell states its range and the row below keeps true numbers', () => {
    const model = parsed(['Wide@1x2|Tail', 'a|b|c']);
    model.markers = true;
    const cells = serializeTable(model).filter((l) => /^<t[dh]/.test(l));
    assert.deepEqual(cells, [
        '<td colspan="2"><!-- c01-02 -->Wide</td>',
        '<td><!-- c03 -->Tail</td>',
        '<td><!-- c01 -->a</td>',
        '<td><!-- c02 -->b</td>',
        '<td><!-- c03 -->c</td>',
    ]);
});

test('a rowspan does not shift the numbering of the row beneath it', () => {
    // the tall cell holds column 1, so the next row's own cell is column 2
    const model = parsed(['Tall@2x1|b', 'c']);
    model.markers = true;
    const cells = serializeTable(model).filter((l) => /^<t[dh]/.test(l));
    assert.deepEqual(cells, [
        '<td rowspan="2"><!-- c01 -->Tall</td>',
        '<td><!-- c02 -->b</td>',
        '<td><!-- c02 -->c</td>',
    ]);
});

test('marker width follows the count, independently for rows and columns', () => {
    assert.equal(colMarker(0, 1, 9), '<!-- c01 -->');
    assert.equal(colMarker(9, 1, 100), '<!-- c010 -->');
    assert.equal(colMarker(0, 3, 9), '<!-- c01-03 -->');
});

test('markers never shift the line arithmetic', () => {
    const plain = parsed(['a|b', 'c|d']);
    const marked = parsed(['a|b', 'c|d']);
    marked.markers = true;
    assert.equal(lineOfCell(marked, 1, 1), lineOfCell(plain, 1, 1));
    for (let r = 0; r < 2; r++) {
        for (let ci = 0; ci < 2; ci++) {
            assert.deepEqual(cellAtLine(marked, lineOfCell(marked, r, ci)), { row: r, cell: ci });
        }
    }
});

test('markers and a colgroup coexist', () => {
    const model = parsed(['a|b'], { cols: ['40%', ''] });
    model.markers = true;
    const lines = serializeTable(model);
    assert.equal(lines[1], '<colgroup>');
    assert.equal(lines[5], '<tr><!-- r01 -->');
    assert.equal(lines[6], '<td><!-- c01 -->a</td>');
    assert.deepEqual(cellAtLine(model, lineOfCell(model, 0, 1)), { row: 0, cell: 1 });
});

test('markers do not leak into merged content', () => {
    const lines = [
        '<table>', '<tr><!-- r01 -->',
        '<td><!-- c01 -->a</td>', '<td><!-- c02 -->b</td>',
        '</tr>', '</table>',
    ];
    const model = parseTable(lines);
    mergeCells(model, 0, 0, 0, 1);
    assert.equal(model.rows[0].cells[0].content, 'a<br>b');
    assert.equal(serializeTable(model)[2], '<td colspan="2"><!-- c01-02 -->a<br>b</td>');
});

test('new tables follow the row-marker preference', () => {
    assert.equal(buildTableLines(2, 2, true, false).some((l) => l.includes('<!--')), false);
    const marked = buildTableLines(2, 2, true, true);
    assert.equal(marked[1], '<tr><!-- r01 -->');
    assert.equal(marked[2], '<th><!-- c01 --></th>');
    assert.ok(parseTable(marked), 'still canonical');
});

// --- cell background colours ------------------------------------------------

test('parseColor reads the forms a note may already carry', () => {
    assert.deepEqual(parseColor('#ffd500'), { hex: '#ffd500', alpha: 1 });
    assert.deepEqual(parseColor('#FFD500'), { hex: '#ffd500', alpha: 1 });
    assert.deepEqual(parseColor('#fd0'), { hex: '#ffdd00', alpha: 1 });
    assert.deepEqual(parseColor('rgb(255, 213, 0)'), { hex: '#ffd500', alpha: 1 });
    assert.deepEqual(parseColor('rgba(255, 213, 0, 0.28)'), { hex: '#ffd500', alpha: 0.28 });
    assert.deepEqual(parseColor(' rgba(255 213 0 / 0.5) '), { hex: '#ffd500', alpha: 0.5 });
});

test('parseColor gives up rather than guessing', () => {
    // named colours and CSS variables cannot be shown in a hex picker, so the
    // dialog falls back to its default instead of inventing one
    assert.equal(parseColor('tomato'), null);
    assert.equal(parseColor('var(--my-colour)'), null);
    assert.equal(parseColor(''), null);
    assert.equal(parseColor(undefined), null);
});

test('toRgba keeps opaque picks as plain hex', () => {
    assert.equal(toRgba('#ffd500', 1), '#ffd500');
    assert.equal(toRgba('#ffd500', 0.28), 'rgba(255, 213, 0, 0.28)');
    // no floating-point tails in the note source
    assert.equal(toRgba('#ffd500', 0.1 + 0.2), 'rgba(255, 213, 0, 0.3)');
});

test('isColorish decides what is worth remembering as the last colour used', () => {
    assert.equal(isColorish('#ffd500'), true);
    assert.equal(isColorish('rgba(255, 213, 0, 0.28)'), true);
    // forms the hex picker cannot read but CSS understands
    assert.equal(isColorish('tomato'), true);
    assert.equal(isColorish('var(--my-colour)'), true);
    assert.equal(isColorish('var(--my-colour, #fff)'), true);
    // and the ones that would only poison the next dialog
    assert.equal(isColorish(''), false);
    assert.equal(isColorish('   '), false);
    assert.equal(isColorish('not a colour'), false);
    assert.equal(isColorish('#zzz'), false);
});

test('isLengthish decides what is worth remembering as the last width used', () => {
    assert.equal(isLengthish('38%'), true);
    assert.equal(isLengthish('12em'), true);
    assert.equal(isLengthish('220px'), true);
    assert.equal(isLengthish('.5in'), true);
    assert.equal(isLengthish(' 10rem '), true);
    assert.equal(isLengthish('auto'), true);
    assert.equal(isLengthish('fit-content'), true);
    assert.equal(isLengthish('calc(100% - 2em)'), true);
    // no unit, no meaning as a CSS width
    assert.equal(isLengthish('220'), false);
    assert.equal(isLengthish(''), false);
    assert.equal(isLengthish('wide'), false);
    assert.equal(isLengthish('38 %'), false);
});

test('every preset shade round-trips through the picker', () => {
    for (const s of DEFAULT_CELL_SHADES) {
        const p = parseColor(s.value);
        assert.ok(p, s.name + ' should be parseable');
        assert.equal(toRgba(p.hex, p.alpha), s.value, s.name + ' should survive a round trip');
        assert.ok(p.alpha < 1, s.name + ' should be translucent');
    }
});

test('the same colour spelled differently still matches its swatch', () => {
    assert.equal(sameColor('rgba(128, 128, 128, 0.2)', 'rgba(128,128,128,0.20)'), true);
    assert.equal(sameColor('#ffd500', 'rgb(255, 213, 0)'), true);
    assert.equal(sameColor('', ''), true);
    assert.equal(sameColor('rgba(255, 213, 0, 0.28)', 'rgba(255, 213, 0, 0.5)'), false);
    assert.equal(sameColor('', 'rgba(255, 213, 0, 0.28)'), false);
    // unparseable values fall back to exact comparison rather than matching
    assert.equal(sameColor('var(--a)', 'var(--b)'), false);
    assert.equal(sameColor('var(--a)', 'var(--a)'), true);
});

// --- stacking above the sibling font toolbar --------------------------------

// positionBar reads the live DOM, so drive it with a stub document rather than
// pulling in a full DOM implementation.
function layoutWith(neighbour, opts) {
    const inst = Object.create(plugin.prototype);
    inst.settings = {
        stackAboveFontToolbar: !opts || opts.stack !== false,
        expandWhenAlone: !opts || opts.expand !== false,
    };
    const classes = {};
    inst.toolbar = {
        style: {},
        classList: { toggle: (name, on) => { classes[name] = !!on; } },
    };
    const prevDoc = global.document;
    const prevWin = global.window;
    global.document = {
        querySelector: (sel) => {
            if (sel.includes(':not(.hft-hidden)') && (!neighbour || neighbour.hidden)) return null;
            return neighbour ? { getBoundingClientRect: () => neighbour.rect } : null;
        },
    };
    global.window = { innerHeight: 800 };
    try {
        inst.positionBar();
        return { bottom: inst.toolbar.style.bottom, expanded: !!classes['tt-expanded'] };
    } finally {
        global.document = prevDoc;
        global.window = prevWin;
    }
}

// a 32px font bar sitting 44px off the bottom of an 800px window
const SHARING = { rect: { top: 724, height: 32 } };

test('rests at the default height and expands when the font toolbar is absent', () => {
    assert.deepEqual(layoutWith(null), { bottom: '44px', expanded: true });
});

test('stacks above the font toolbar and stays compact', () => {
    assert.deepEqual(layoutWith(SHARING), { bottom: '82px', expanded: false });
    // the same bar wrapped onto two rows is taller, so we move further up
    assert.deepEqual(layoutWith({ rect: { top: 692, height: 64 } }), { bottom: '114px', expanded: false });
});

test('drops back down and expands when the font toolbar is hidden or unmeasurable', () => {
    assert.deepEqual(layoutWith({ hidden: true, rect: { top: 724, height: 32 } }), { bottom: '44px', expanded: true });
    // present in the DOM but not laid out yet
    assert.deepEqual(layoutWith({ rect: { top: 0, height: 0 } }), { bottom: '44px', expanded: true });
});

test('expanding keys off the neighbour being there, not off the stacking preference', () => {
    // stacking off, but the font toolbar is still occupying the space
    assert.deepEqual(layoutWith(SHARING, { stack: false }), { bottom: '44px', expanded: false });
});

test('expansion can be turned off without affecting stacking', () => {
    assert.deepEqual(layoutWith(null, { expand: false }), { bottom: '44px', expanded: false });
    assert.deepEqual(layoutWith(SHARING, { expand: false }), { bottom: '82px', expanded: false });
});

test('stampMarker adds the class and marker without duplicating them', () => {
    const model = parsed(['a']);
    stampMarker(model);
    stampMarker(model);
    assert.equal(serializeTable(model)[0], '<table class="tt-table" data-tt="1">');
});
