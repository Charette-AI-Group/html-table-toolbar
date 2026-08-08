'use strict';

// Minimal stand-in for the 'obsidian' module so main.js can be loaded and its
// pure table engine tested under Node (node --test tests/).

class Plugin {
    constructor(app, manifest) {
        this.app = app;
        this.manifest = manifest;
    }
    addRibbonIcon() {}
    addCommand() {}
    addSettingTab() {}
    addStatusBarItem() { return null; }
    register() {}
    registerEvent() {}
    registerDomEvent() {}
    loadData() { return Promise.resolve({}); }
    saveData() { return Promise.resolve(); }
}

class PluginSettingTab {
    constructor(app, plugin) {
        this.app = app;
        this.plugin = plugin;
    }
}

class Setting {
    setName() { return this; }
    setDesc() { return this; }
    setHeading() { return this; }
    addText() { return this; }
    addSlider() { return this; }
    addToggle() { return this; }
    addButton() { return this; }
    addExtraButton() { return this; }
    addColorPicker() { return this; }
}

class MarkdownView {}

const { FakeEl } = require('./dom.js');

// open() really runs onOpen() against stand-in elements, so the UI tests
// exercise the dialogs' construction rather than just their existence.
class Modal {
    constructor(app) {
        this.app = app;
        this.contentEl = new FakeEl('div');
        this.titleEl = new FakeEl('div');
        this.modalEl = new FakeEl('div');
    }
    open() { if (this.onOpen) this.onOpen(); }
    close() { if (this.onClose) this.onClose(); }
}

class Menu {
    addItem(cb) {
        if (cb) {
            const item = {
                setTitle: () => item,
                setIcon: () => item,
                setChecked: () => item,
                setDisabled: () => item,
                onClick: () => item,
            };
            cb(item);
        }
        return this;
    }
    addSeparator() { return this; }
    showAtMouseEvent() { return this; }
}

const notices = [];
class Notice {
    constructor(msg) { notices.push(msg); }
}

function setIcon() {}
function debounce(fn) { return fn; }

module.exports = {
    Plugin, PluginSettingTab, Setting, Modal, Menu, MarkdownView, Notice,
    setIcon, debounce, __notices: notices,
};
