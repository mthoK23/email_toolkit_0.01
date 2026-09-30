const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// A small DOM stand-in for logic tests. Native focus, form validation and
// drag interaction still require the manual Edge checklist.
class Element {
  constructor(tag = '') {
    this.tag = tag;
    this.children = [];
    this.dataset = {};
    this.listeners = {};
    this.value = '';
    this.classList = { add() {}, remove() {} };
  }
  addEventListener(name, handler) { this.listeners[name] = handler; }
  setAttribute() {}
  append(...children) { this.children.push(...children); }
  replaceChildren() { this.children = []; }
  focus() { this.focused = true; }
  reset() {}
  setCustomValidity(message) { this.error = message; }
  reportValidity() { return !this.error; }
  checkValidity() { return /^[^\s@]+@[^\s@]+$/.test(this.value); }
  getBoundingClientRect() { return { top: 0, height: 100 }; }
  querySelectorAll(selector) {
    const all = this.children.flatMap(child => [child, ...child.querySelectorAll('*')]);
    if (selector === '*') return all;
    if (selector.startsWith('.')) return all.filter(child => child.className === selector.slice(1));
    return all.filter(child => child.tag === 'button' || (selector.includes('input') && child.tag === 'input'));
  }
  querySelector(selector) {
    if (selector.startsWith('.')) return this.querySelectorAll(selector)[0];
    const buttons = this.querySelectorAll('button');
    if (selector.includes('data-direction')) {
      return buttons.find(button => button.dataset.direction === selector.match(/="(.*?)"/)[1]);
    }
    return buttons.find(button => !button.disabled);
  }
}

function setup(initial = []) {
  const nodes = {};
  const state = { data: initial, writes: 0, failLoad: false, failSave: false };
  const context = vm.createContext({
    console: { error() {} },
    document: {
      createElement: tag => new Element(tag),
      querySelector: id => nodes[id] ??= new Element()
    },
    chrome: { storage: { local: {
      async get() {
        if (state.failLoad) throw Error('Simulated load failure');
        return { monitoredSenders: state.data };
      },
      async set(value) {
        if (state.failSave) throw Error('Simulated save failure');
        state.writes++;
        state.data = JSON.parse(JSON.stringify(value.monitoredSenders));
      }
    } } }
  });
  for (const name of ['storage', 'sender-model', 'matching', 'popup']) {
    const code = fs.readFileSync(path.join(__dirname, '../Extension/JS', `${name}.js`), 'utf8');
    vm.runInContext(code.replace(/initialisePopup\(\);\s*$/, ''), context);
  }
  return { state, nodes, run: code => vm.runInContext(code, context) };
}

test('matching: exact address, casing, blank subjects and literal Unicode text', () => {
  const { run } = setup();
  const rules = [{ email: 'alerts@example.com', subjectContains: 'application' }];
  const cases = [
    [' ALERTS@example.com ', 'APPLICATION received', true],
    ['alerts@example.com.attacker.test', 'application', false],
    ['other@example.com', 'application', false],
    ['alerts+tag@example.com', 'application', false],
    ['alerts@example.com', '', false],
    ['alerts@example.com', 'New vacancy', false]
  ];
  for (const [from, subject, expected] of cases) {
    assert.equal(run(`matchEmail(${JSON.stringify(rules)}, ${JSON.stringify({ from, subject })}).matched`), expected);
  }
  assert.equal(run('matchEmail([], {from:"a@b.com",subject:"x"}).matched'), false);
  assert.equal(run('matchEmail([{email:"a@b.com",subjectContains:"   "}], {from:"a@b.com",subject:""}).matched'), true);
  assert.equal(run('matchEmail([{email:"a@b.com",subjectContains:".*"}], {from:"a@b.com",subject:"anything"}).matched'), false);
  assert.equal(run('matchEmail([{email:"a@b.com",subjectContains:"café"}], {from:"a@b.com",subject:"cafe\\u0301"}).matched'), true);
  assert.equal(run('matchEmail([{email:"a@b.com",subjectContains:"<script>"}], {from:"a@b.com",subject:"<script>"}).matched'), true);
  assert.throws(() => run('matchEmail([], {from:"a@b.com",subject:null})'));
  assert.throws(() => run('matchEmail([], {from:"a@b.com",subject:"x".repeat(1001)})'));
});

test('legacy storage converts without writing; invalid records are rejected', async () => {
  const { run, state } = setup(['a@b.com', 'c@d.com']);
  await run('initialisePopup()');
  assert.equal(run('senders[0].subjectContains'), '');
  assert.equal(state.writes, 0);
  assert.equal(run('senders.map(s=>s.email).join(",")'), 'a@b.com,c@d.com');
  for (const data of [null, [null], ['a@b.com', 'A@b.com'], [{email:'a@b.com',subjectContains:1}], [{email:'a@b.com',subjectContains:'x'.repeat(201)}]]) {
    assert.throws(() => run(`normaliseSenderRecords(${JSON.stringify(data)})`));
  }
});

test('adding, editing, preview invalidation, removal and reload', async () => {
  const { run, nodes, state } = setup();
  await run('initialisePopup()');
  nodes['#sender-email'].value = 'a@b.com';
  nodes['#sender-subject'].value = ' application ';
  await nodes['#sender-form'].listeners.submit({preventDefault(){}});
  assert.equal(state.data[0].subjectContains, 'application');
  nodes['#preview-from'].value = 'a@b.com';
  nodes['#preview-subject'].value = 'Application received';
  nodes['#preview-form'].listeners.submit({preventDefault(){}});
  assert.match(nodes['#preview-result'].textContent, /^Match/);
  nodes['#sender-list'].children[0].querySelector('.edit-rule-button').listeners.click();
  nodes['#sender-subject'].value = 'interview';
  await nodes['#sender-form'].listeners.submit({preventDefault(){}});
  assert.equal(state.data[0].subjectContains, 'interview');
  assert.match(nodes['#preview-result'].textContent, /^Enter/);
  await run('initialisePopup()');
  assert.equal(run('senders[0].subjectContains'), 'interview');
  const remove = nodes['#sender-list'].children[0].querySelectorAll('button').find(b => b.textContent === 'Remove');
  await remove.listeners.click();
  assert.deepEqual(state.data, []);
});

test('all 18 drop positions preserve records and saved order', async () => {
  for (let from = 0; from < 3; from++) for (let over = 0; over < 3; over++) for (const before of [true, false]) {
    const original = ['a','b','c'].map(letter => ({email:`${letter}@example.com`,subjectContains:letter}));
    const { run, nodes, state } = setup(original);
    await run('initialisePopup()');
    const cards = nodes['#sender-list'].children;
    cards[from].children[0].listeners.dragstart({dataTransfer:{setData(){}},preventDefault(){}});
    cards[over].listeners.drop({clientY:before?10:90,preventDefault(){}});
    await new Promise(resolve => setImmediate(resolve));
    const expected = [...original];
    if(from !== over) {
      const [item] = expected.splice(from,1);
      let target = over + (before ? 0 : 1);
      if(from < target) target--;
      expected.splice(target,0,item);
    }
    assert.deepEqual(state.data, expected);
  }
});

test('failed load blocks editing; failed save preserves order and enables retry', async () => {
  const { run, state, nodes } = setup(['a@b.com','c@d.com']);
  state.failLoad = true;
  await run('initialisePopup()');
  assert.equal(nodes['#add-sender-button'].disabled, true);
  assert.equal(state.writes, 0);
  state.failLoad = false;
  await run('initialisePopup()');
  state.failSave = true;
  await run('moveSender("a@b.com",1,"down")');
  assert.equal(run('senders[0].email'), 'a@b.com');
  assert.equal(run('storageBusy'), false);
  assert.match(nodes['#status-message'].textContent, /unchanged/);
  state.failSave = false;
  await run('moveSender("a@b.com",1,"down")');
  assert.equal(state.data[1].email, 'a@b.com');
});

test('single sender boundaries, duplicates, and cancelling an edit', async () => {
  const { run, nodes, state } = setup([{email:'a@b.com',subjectContains:'original'}]);
  await run('initialisePopup()');
  const card = nodes['#sender-list'].children[0];
  const buttons = card.querySelectorAll('button');
  assert.equal(buttons.find(b => b.dataset.direction === 'up').disabled, true);
  assert.equal(buttons.find(b => b.dataset.direction === 'down').disabled, true);
  await run('moveSender("a@b.com",-1,"up")');
  await run('moveSender("a@b.com",1,"down")');
  assert.equal(state.writes, 0);
  nodes['#sender-email'].value = 'A@B.COM';
  nodes['#sender-subject'].value = '';
  await nodes['#sender-form'].listeners.submit({preventDefault(){}});
  assert.match(nodes['#sender-email'].error, /already/);
  assert.equal(state.writes, 0);
  card.querySelector('.edit-rule-button').listeners.click();
  nodes['#sender-subject'].value = 'unsaved change';
  nodes['#sender-form'].listeners.keydown({key:'Escape',preventDefault(){}});
  assert.equal(state.data[0].subjectContains, 'original');
  assert.equal(nodes['#sender-form'].hidden, true);
});
