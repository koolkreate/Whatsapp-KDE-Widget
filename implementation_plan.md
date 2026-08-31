# Implementation Plan

[Overview]
Add three user-facing features to the WhatsApp KDE Plasma 6 widget:
1. **Widget-local chat pinning**: Right-click menu on chat list items to pin/unpin chats, with pins persisted via the backend (`backend/data/pinned_chats.json`).
2. **Emoji picker upgrade**: Convert the emoji picker from a horizontal strip into a vertical `GridView` with category section tabs/headers (Smileys, People, Animals, Food, Travel, Activities, Objects, Symbols, Flags).
3. **Interactive message reactions**: Fix backend reaction extraction & `fromMe` detection (comparing sender JID against `getMeUser().id._serialized`), aggregate duplicate emojis into count chips with sender tooltips, and allow toggling your reaction by clicking any reaction chip (WhatsApp behavior: remove if you already reacted with that emoji, add if you haven't).

Context: the widget is QML (`widget/contents/ui/main.qml` + shared JS helpers) talking to a Node/Puppeteer backend (`backend/server.js` + `backend/lib/*`). The chat list is a `ListView` over `root.filteredChats`, sorted in `fetchChats()`: pinned first, then unread count, then timestamp.

High-level approach: three independent, testable slices, implemented in that order. Pinning uses a backend API endpoint backed by a local JSON file (`backend/data/pinned_chats.json`) so pins survive restarts cleanly without Plasma 6 config schema dependency. The emoji grid features category tabs for fast navigation. Reactions get a shared pure aggregation helper (TDD-able in Node via `messageUtils.js`), accurate `fromMe` extraction in `server.js`, and chip toggling logic.

[Types]
No formal type system (JavaScript/QML). Data shapes:

- `pinnedChats: string[]` — Array of pinned chat IDs (e.g., `["135789837070555@lid", "447123456789@c.us"]`), fetched from `/api/getPinnedChats` and updated via `/api/togglePinChat`.
- Aggregated reaction chip: `{ emoji: string, count: number, senders: string[], fromMe: boolean }` — output of `aggregateReactions(rawReactions)`; `fromMe` is true if the current user is among the senders who reacted with this emoji.

[Files]
- **Modify `widget/contents/ui/main.qml`**
  - Add `property var pinnedChats: []` state.
  - Add `fetchPinnedChats()` and `togglePinChat(chatId)` functions calling backend endpoints `/api/getPinnedChats` and `/api/togglePinChat`.
  - Add right-click `MouseArea` on the chat row delegate (`chatRow`) and a new `Menu { id: chatContextMenu }` with Pin/Unpin action.
  - Pinned-first ordering in `fetchChats()` sorting logic.
  - Render a 📌 indicator on pinned chat rows.
  - Upgrade emoji picker overlay (`~line 1759`): replace horizontal `ListView` with category navigation tabs + vertical `GridView` with category headers.
  - Extend `sendReaction(chatId, msgId, reaction, remove)` (~line 464) to pass `remove` flag to backend.
  - Reactions row (~line 1427): render aggregated chips with count badge, sender tooltip, and click-to-toggle reaction logic (removes if `fromMe`, sends reaction if not).
- **New `backend/lib/pins.js`** — Module to read/write `backend/data/pinned_chats.json` safely with atomic write guards.
- **Modify `backend/server.js`**
  - Add `/api/getPinnedChats` (GET/POST) and `/api/togglePinChat` (POST) endpoints.
  - Fix reaction collection in BOTH extraction paths (Method A ~line 524, Method B ~line 590):
    - Fallback fields: `r.orphan || r.emoji || r.reactionText`
    - Accurate `fromMe` detection: extract meUser JID via `window.require('WAWebUserPrefsMeUser').getMeUser().id._serialized` or `window.Store.MaybeMeUser` and compare against `r.sender.id._serialized` (or `r.sent_by_me`).
    - Filter out invalid/empty emoji entries.
- **Modify `widget/contents/ui/messageUtils.js`** — add pure `aggregateReactions(raw)`; export in `module.exports` block for Node testing.
- **New `backend/test/reactions.test.js`** — unit tests for `aggregateReactions`.
- **New `backend/test/pins.test.js`** — unit tests for `pins.js` helper.

[Functions]
- **New `aggregateReactions(raw)` — `widget/contents/ui/messageUtils.js`**
  - `function aggregateReactions(raw) -> [{emoji, count, senders, fromMe}]`. Groups raw reaction list by emoji, preserves first-seen order, accumulates count and sender names, sets `fromMe = true` if any contributor for that emoji is me.
- **New `pins.js` helpers — `backend/lib/pins.js`**
  - `getPinned()`: Reads JSON file; returns string array of chat IDs.
  - `togglePin(chatId)`: Toggles ID in list, writes JSON file, returns updated array.
- **New Endpoints — `backend/server.js`**
  - `POST /api/getPinnedChats` → returns `{ response: ["id1", "id2"] }`
  - `POST /api/togglePinChat` → body `{ chatId: string }`, returns `{ response: ["id1", ...] }`
- **Modified `fetchChats()` — `main.qml`** — sort order: pinned chats first, then unread count desc, then timestamp desc.
- **Modified `sendReaction(chatId, msgId, reaction, remove)` — `main.qml`** — sends `remove: !!remove` in API request payload.

[Classes]
No QML/JS classes. UI component changes in `main.qml`:
- **Emoji Picker**:
  - Top category bar: clickable tabs for categories (😀 Smileys, 👋 People, 🐶 Animals, 🍎 Food, 🚗 Travel, ⚽ Activities, 💡 Objects, 🔣 Symbols, 🚩 Flags).
  - Main area: `GridView` (`cellWidth: 38`, `cellHeight: 38`, `flow: GridView.FlowLeftToRight`), scrolling smoothly to category headers or filtered lists.
- **Chat Context Menu (`chatContextMenu`)**:
  - `Menu` popup triggered by right-click on chat rows with "Pin Chat" / "Unpin Chat" label dynamically set.
- **Reactions Row**:
  - Displays aggregated chips using `Repeater` over `aggregateReactions(modelData.reactions)`.
  - Hovering chip shows `ToolTip` with comma-separated list of senders (`senders.join(", ")`).
  - Clicking chip: if `chip.fromMe` is true, calls `sendReaction(..., remove=true)` to unreact; otherwise calls `sendReaction(..., remove=false)` to react with that emoji.

[Dependencies]
None added. Standard Node `.fs` / `.path` modules used for `pinned_chats.json` persistence.

[Testing]
- **New `backend/test/reactions.test.js`**: Unit tests for `aggregateReactions` (counts, ordering, `fromMe` calculation, null checks).
- **New `backend/test/pins.test.js`**: Unit tests for `pins.js` persistence helper.
- **Existing tests**: Must remain green (`node --test`).
- **Validation**:
  - Syntax checks (`node --check server.js`, `main.qml` structural validation).
  - `./manage.sh reinstall-widget` & `test_ui.sh` execution.
  - Live testing of right-click pin/unpin persistence across backend restarts.
  - Live testing of category navigation in emoji picker.
  - Live testing of reaction chip display and toggle actions.

[Implementation Order]
1. **Reactions backend & shared helper (TDD)**: Write `reactions.test.js` → implement `aggregateReactions` in `messageUtils.js` → fix `fromMe` & emoji extraction in `server.js` → verify tests pass.
2. **Reactions UI**: Render aggregated reaction chips in `main.qml` delegate with tooltips; implement WhatsApp-style toggle click handling (add/remove reaction).
3. **Emoji Picker grid with categories**: Replace horizontal list with category navigation tabs + vertical `GridView` in `main.qml`.
4. **Chat Pinning (Backend + UI)**: Implement `backend/lib/pins.js` + unit tests → add `/api/getPinnedChats` and `/api/togglePinChat` endpoints → update `main.qml` with `chatContextMenu`, 📌 indicator, and pin-first sorting.
5. **Final Verification**: Run `test_ui.sh`, backend unit test suite, reinstall widget, restart backend, and verify in `plasmawindowed`.
