# Resources

Key documentation and primary sources for learning the WhatsApp KDE Widget tech stack:

## Primary Documentation
- **QML / Qt 6**: [Qt 6 QML Documentation](https://doc.qt.io/qt-6/qtqml-index.html) — Declarative UI language for KDE Plasma widgets.
- **KDE Plasma 6 Plasmoids**: [KDE Plasma Development Guide](https://develop.kde.org/docs/plasma/) — Plasmoid structure (`metadata.json`, `contents/ui/main.qml`).
- **Node.js & Express**: [Node.js Docs](https://nodejs.org/docs/latest/api/) — Local backend server architecture (`backend/server.js`).
- **Puppeteer**: [Puppeteer API Reference](https://pptr.dev/) — Headless Chrome automation for controlling WhatsApp Web.

## Internal Architecture References
- `widget/contents/ui/main.qml`: Core UI declaration, state management, HTTP requests to local backend.
- `backend/server.js`: Express HTTP REST server & Puppeteer session runner.
- `backend/lib/*`: Modular helpers (`messages.js`, `reply.js`, `avatars.js`, `pins.js`, `longPoll.js`).
