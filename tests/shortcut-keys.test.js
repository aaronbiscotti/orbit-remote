const test = require('node:test');
const assert = require('node:assert/strict');
const { acceleratorFromKeyEvent, isValidAccelerator, formatAccelerator } = require('../electron/shortcut-keys');

const press = (code, held = {}) => ({ code, ctrlKey: false, altKey: false, shiftKey: false, metaKey: false, ...held });

test('a key press becomes a shortcut with modifiers in a fixed order', () => {
  assert.equal(acceleratorFromKeyEvent(press('KeyZ', { shiftKey: true, altKey: true, ctrlKey: true })), 'Control+Alt+Shift+Z');
  assert.equal(acceleratorFromKeyEvent(press('Digit4', { metaKey: true })), 'Command+4');
  assert.equal(acceleratorFromKeyEvent(press('F12', { ctrlKey: true })), 'Control+F12');
  assert.equal(acceleratorFromKeyEvent(press('ArrowUp', { ctrlKey: true, metaKey: true })), 'Control+Command+Up');
});

test('modifier keys alone, Escape and unknown keys are not a shortcut yet', () => {
  for (const code of ['ShiftLeft', 'ControlLeft', 'AltRight', 'MetaLeft', 'Escape', 'F20', 'CapsLock', '', undefined]) {
    assert.equal(acceleratorFromKeyEvent(press(code, { ctrlKey: true })), null);
  }
});

test('only shortcuts with Control or Command, known keys and known modifiers are accepted', () => {
  for (const good of ['Control+Alt+Shift+Z', 'Control+Alt+Shift+Q', 'Command+K', 'Control+Command+Up', 'Control+F5']) {
    assert.equal(isValidAccelerator(good), true, good);
  }
  for (const bad of ['Z', 'Alt+Shift+Z', 'Shift+Control+Z', 'Control+Control+Z', 'Control+', 'Control+Zz', 'Hyper+Z',
    'Control+Escape', 'Control+Z; rm -rf /', '', null, 42, ['Control+Z']]) {
    assert.equal(isValidAccelerator(bad), false, String(bad));
  }
  // Whatever a key press produces with Control held must be accepted back.
  for (const code of ['KeyA', 'Digit0', 'F19', 'Space', 'Enter', 'Home', 'PageDown', 'ArrowLeft']) {
    assert.equal(isValidAccelerator(acceleratorFromKeyEvent(press(code, { ctrlKey: true, shiftKey: true }))), true, code);
  }
});

test('shortcuts are shown with Mac key symbols', () => {
  assert.equal(formatAccelerator('Control+Alt+Shift+Z'), '⌃⌥⇧Z');
  assert.equal(formatAccelerator('Command+Up'), '⌘↑');
  assert.equal(formatAccelerator('Control+Space'), '⌃Space');
  assert.equal(formatAccelerator('not a shortcut'), '');
});
