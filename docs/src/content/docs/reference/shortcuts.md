---
title: Keyboard shortcuts
description: Every keyboard shortcut QueryLens responds to.
---

Shown live in the app, under the playback controls, on any device with a keyboard — the hints
disappear entirely on touch devices, since none of the keys below exist there.

| Key | Action |
|---|---|
| <kbd>Space</kbd> | Play / pause the trace |
| <kbd>←</kbd> / <kbd>→</kbd> | Step back / forward one event |
| <kbd>Home</kbd> | Reset to the start of the trace |
| <kbd>⌘</kbd><kbd>↵</kbd> (macOS) or <kbd>Ctrl</kbd><kbd>↵</kbd> (elsewhere) | Run the query in the editor |

The Run shortcut's label always matches the modifier key your platform actually uses — it's read
from the same test CodeMirror itself uses to resolve its own keymap, so the hint and the key can
never disagree.

Playback shortcuts are suspended while the seed-data editor is open, so <kbd>←</kbd>/<kbd>→</kbd>
edit a table cell instead of stepping a trace you can't see behind the dialog.
