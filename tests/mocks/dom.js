'use strict';

// A DOM stand-in covering the slice of the API the toolbar and modals use,
// including Obsidian's own HTMLElement extensions (createDiv, setText,
// addClass, ...). Enough to build the toolbar, open every dialog, and fire
// click handlers under Node.

class FakeEl {
    constructor(tag) {
        this.tag = String(tag || 'div').toLowerCase();
        this.children = [];
        this.classes = new Set();
        this.listeners = {};
        this.attributes = {};
        this.text = '';
        this.value = '';
        this.title = '';
        this.options = [];
        this.style = {
            setProperty: (k, v) => { this.style[k] = v; },
            removeProperty: (k) => { delete this.style[k]; },
        };
        const set = this.classes;
        this.classList = {
            add: (...c) => c.forEach((x) => set.add(x)),
            remove: (...c) => c.forEach((x) => set.delete(x)),
            contains: (c) => set.has(c),
            toggle: (c, on) => {
                const want = on === undefined ? !set.has(c) : !!on;
                if (want) set.add(c); else set.delete(c);
                return want;
            },
        };
    }

    get className() { return [...this.classes].join(' '); }
    set className(v) {
        this.classes.clear();
        String(v).split(/\s+/).filter(Boolean).forEach((c) => this.classes.add(c));
    }

    make(tag, o) {
        const child = new FakeEl(tag);
        if (o && o.cls) String(o.cls).split(/\s+/).filter(Boolean).forEach((c) => child.classes.add(c));
        if (o && o.text) child.text = o.text;
        if (o && o.type) child.type = o.type;
        if (o && o.placeholder) child.placeholder = o.placeholder;
        this.children.push(child);
        return child;
    }

    createDiv(o) { return this.make('div', o); }
    createSpan(o) { return this.make('span', o); }
    createEl(tag, o) { return this.make(tag, o); }
    appendChild(c) { this.children.push(c); return c; }
    insertBefore(c) { this.children.unshift(c); return c; }
    appendText(t) { this.text += t; }
    setText(t) { this.text = String(t); }
    setAttribute(k, v) { this.attributes[k] = v; }
    getAttribute(k) {
        return Object.prototype.hasOwnProperty.call(this.attributes, k) ? this.attributes[k] : null;
    }
    removeAttribute(k) { delete this.attributes[k]; }
    hasAttribute(k) { return Object.prototype.hasOwnProperty.call(this.attributes, k); }
    empty() { this.children = []; }
    remove() { this.removed = true; }
    addClass(...c) { this.classList.add(...c); }
    removeClass(...c) { this.classList.remove(...c); }
    toggleClass(c, on) { return this.classList.toggle(c, on); }
    hasClass(c) { return this.classes.has(c); }
    addEventListener(name, fn) { (this.listeners[name] = this.listeners[name] || []).push(fn); }
    removeEventListener() {}
    focus() {}
    select() {}
    add(option) { this.options.push(option); }
    querySelector() { return null; }
    querySelectorAll() { return []; }
    getBoundingClientRect() {
        return { width: 0, height: 0, top: 0, left: 0, right: 0, bottom: 0 };
    }

    // Every descendant, self included.
    walk(out) {
        const acc = out || [];
        acc.push(this);
        for (const c of this.children) c.walk(acc);
        return acc;
    }

    fire(name, evt) {
        for (const fn of this.listeners[name] || []) fn(evt || { preventDefault() {} });
    }
}

// A stand-in for DOMParser covering table markup only — enough to exercise the
// plugin's repair path, which is otherwise untestable under Node and had been
// hiding bugs because of it. It is not a real HTML parser: it handles the
// canonical shape and the ways a person breaks it by hand (a cell split across
// lines, stray text, a blank line), which is what repair actually meets.
const ATTRS = /([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;

function attrsOf(s) {
    const out = [];
    ATTRS.lastIndex = 0;
    let m;
    while ((m = ATTRS.exec(s || '')) !== null) {
        const v = m[2] !== undefined ? m[2] : m[3] !== undefined ? m[3] : m[4];
        out.push({ name: m[1], value: v === undefined ? '' : v });
    }
    return out;
}

function fakeTable(text) {
    const open = /<table\b([^>]*)>/i.exec(text);
    if (!open) return null;
    const body = text.slice(open.index + open[0].length);

    const cg = /<colgroup\b([^>]*)>([\s\S]*?)<\/colgroup>/i.exec(body);
    const colgroup = cg && {
        attributes: attrsOf(cg[1]),
        querySelectorAll: () => (cg[2].match(/<col\b[^>]*>/gi) || []).map((c) => ({
            attributes: attrsOf(/<col\b([^>]*?)\/?>/i.exec(c)[1]),
        })),
    };

    const rows = [];
    const rowRe = /<tr\b([^>]*)>([\s\S]*?)<\/tr>/gi;
    let r;
    while ((r = rowRe.exec(body)) !== null) {
        const inner = r[2];
        const cells = [];
        const cellRe = /<(td|th)\b([^>]*)>([\s\S]*?)<\/\1>/gi;
        let c;
        while ((c = cellRe.exec(inner)) !== null) {
            cells.push({ tagName: c[1].toUpperCase(), attributes: attrsOf(c[2]), innerHTML: c[3] });
        }
        rows.push({ attributes: attrsOf(r[1]), cells });
    }

    return {
        attributes: attrsOf(open[1]),
        rows,
        querySelector: (sel) => (/colgroup/.test(sel) ? colgroup : null),
    };
}

class FakeDOMParser {
    parseFromString(text) {
        const table = fakeTable(text);
        return { querySelector: (sel) => (sel === 'table' ? table : null) };
    }
}

// Records itself so a test can fire the callback the plugin registered.
class FakeMutationObserver {
    constructor(cb) {
        this.cb = cb;
        FakeMutationObserver.instances.push(this);
    }
    observe(target, options) { this.target = target; this.options = options; }
    disconnect() { this.disconnected = true; }
    fire() { this.cb([], this); }
}
FakeMutationObserver.instances = [];

// Installs the globals the plugin reaches for, and returns a restore function.
function installDom() {
    const saved = {
        document: global.document,
        window: global.window,
        Option: global.Option,
        MutationObserver: global.MutationObserver,
        DOMParser: global.DOMParser,
    };
    global.DOMParser = FakeDOMParser;
    const body = new FakeEl('body');
    global.document = {
        body,
        createElement: (tag) => new FakeEl(tag),
        querySelector: () => null,
        addEventListener() {},
    };
    global.window = { innerHeight: 800, addEventListener() {} };
    global.Option = function Option(text, value) { return { text, value }; };
    FakeMutationObserver.instances = [];
    global.MutationObserver = FakeMutationObserver;
    return () => Object.assign(global, saved);
}

module.exports = { FakeEl, FakeDOMParser, FakeMutationObserver, installDom };
