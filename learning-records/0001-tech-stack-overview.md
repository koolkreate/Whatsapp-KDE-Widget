# Learning Record 0001: Tech Stack Overview

- **Date**: 2026-08-31
- **Topic**: WhatsApp KDE Widget Architecture & Tech Stack

## Insights & Lessons Learned
1. **Dual-Layer Architecture**:
   - **Frontend**: QML (Qt 6) running natively inside KDE Plasma (`plasmashell`).
   - **Backend**: Node.js (Express) daemon + Puppeteer driving headless Chrome.
2. **Communication**:
   - QML sends JSON payloads to Express endpoints at `http://127.0.0.1:8002` via standard `XMLHttpRequest`.
   - Polling & long-polling (`/api/waitMessages`) provide real-time updates.

## Zone of Proximal Development (Next Step)
- Lesson 0002: QML UI Declarations & State Management in `main.qml`
- Hands-on exercises modifying QML bindings and testing backend endpoints.
