// Stream shortcuts: turn a key press into Electron's shortcut text ("Control+Alt+Shift+Z") and that text into
// Mac key symbols ("⌃⌥⇧Z"). Loaded by the window as a plain script and by the main process with require().
(function (root) {
  // [key event property, Electron's name, Mac symbol], in the order Electron and macOS write them.
  const MODIFIERS = [['ctrlKey', 'Control', '⌃'], ['altKey', 'Alt', '⌥'], ['shiftKey', 'Shift', '⇧'], ['metaKey', 'Command', '⌘']];
  // event.code -> Electron's key name. event.code is the physical key, so Option+Z stays "Z", not "Ω".
  const NAMED_KEYS = {
    Space: 'Space', Tab: 'Tab', Enter: 'Return', Backspace: 'Backspace', Delete: 'Delete',
    ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right',
    Home: 'Home', End: 'End', PageUp: 'PageUp', PageDown: 'PageDown'
  };
  const KEY_SYMBOLS = { Return: '↩', Backspace: '⌫', Delete: '⌦', Tab: '⇥', Up: '↑', Down: '↓', Left: '←', Right: '→' };
  const KEY_NAME = /^([A-Z]|[0-9]|F([1-9]|1[0-9]))$/; // letters, digits, F1-F19
  const isKey = (name) => KEY_NAME.test(name) || Object.values(NAMED_KEYS).includes(name);

  function keyName(code) {
    const plain = /^(?:Key|Digit)(.)$/.exec(code || '');
    const name = plain ? plain[1] : NAMED_KEYS[code] || code;
    return isKey(name) ? name : null;
  }

  // Null while only modifier keys are down, or for a key that can't be part of a shortcut.
  function acceleratorFromKeyEvent(event) {
    const key = keyName(event.code);
    if (!key) return null;
    return [...MODIFIERS.filter(([held]) => event[held]).map(([, name]) => name), key].join('+');
  }

  // Control or Command is required: a shortcut made of Option or Shift alone would swallow ordinary typing,
  // and macOS 15 and later refuses to register one.
  function isValidAccelerator(accelerator) {
    if (typeof accelerator !== 'string') return false;
    const parts = accelerator.split('+');
    const key = parts.pop();
    const names = MODIFIERS.map(([, name]) => name);
    const inOrder = parts.every((part, i) => names.indexOf(part) > (i ? names.indexOf(parts[i - 1]) : -1));
    return isKey(key) && inOrder && (parts.includes('Control') || parts.includes('Command'));
  }

  function formatAccelerator(accelerator) {
    if (!isValidAccelerator(accelerator)) return '';
    const parts = accelerator.split('+');
    const key = parts.pop();
    return parts.map((part) => MODIFIERS.find(([, name]) => name === part)[2]).join('') + (KEY_SYMBOLS[key] || key);
  }

  const api = { acceleratorFromKeyEvent, isValidAccelerator, formatAccelerator };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.OrbitShortcuts = api;
})(typeof window === 'object' ? window : globalThis);
