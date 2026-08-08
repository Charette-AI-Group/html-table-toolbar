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

// Installs the globals the plugin reaches for, and returns a restore function.
function installDom() {
    const saved = {
        document: global.document,
        window: global.window,
        Option: global.Option,
        MutationObserver: global.MutationObserver,
    };
    const body = new FakeEl('body');
    global.document = {
        body,
        createElement: (tag) => new FakeEl(tag),
        querySelector: () => null,
        addEventListener() {},
    };
    global.window = { innerHeight: 800, addEventListener() {} };
    global.Option = function Option(text, value) { return { text, value }; };
    global.MutationObserver = class {
        observe() {}
        disconnect() {}
    };
    return () => Object.assign(global, saved);
}

module.exports = { FakeEl, installDom };
