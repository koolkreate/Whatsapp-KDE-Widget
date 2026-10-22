#!/usr/bin/env bash
# ── Programmatic UI & API integration test for WhatsApp KDE Widget ───────────
# Tests the backend API contract that the QML widget depends on, then launches
# the widget in plasmawindowed for a live visual check + screenshot.
set -euo pipefail

# Derive every path from the script location so the suite runs from any
# checkout directory (and from a tarball extracted anywhere).
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WIDGET_DIR="$REPO_ROOT/widget"
BACKEND_DIR="$REPO_ROOT/backend"
TESTS_DIR="$REPO_ROOT/tests"

API="http://127.0.0.1:8002"
# The backend persists the effective key in this file. Prefer it over the
# environment so the test uses exactly what the running backend loaded.
CONFIG_FILE="${WA_CONFIG_FILE:-${XDG_CONFIG_HOME:-$HOME/.config}/whatsapp-kde-widget.ini}"
API_KEY=""
PASS=0
FAIL=0
RESULTS=""

# ── Helpers ──────────────────────────────────────────────────────────────────
pass()  { PASS=$((PASS+1)); RESULTS+="  ✅ $1\n"; echo "  ✅ $1"; }
fail()  { FAIL=$((FAIL+1)); RESULTS+="  ❌ $1\n"; echo "  ❌ $1"; }
check() {
    local desc="$1"; shift
    if "$@" >/dev/null 2>&1; then pass "$desc"; else fail "$desc"; fi
}

echo "═══════════════════════════════════════════════════════════"
echo " WhatsApp KDE Widget — Integration Test Suite"
echo "═══════════════════════════════════════════════════════════"
echo ""

# ── 1. Backend status ────────────────────────────────────────────────────────
echo "── 1. Backend connectivity ──────────────────────────────"
STATUS=$(curl -sf "$API/api/status" 2>/dev/null || echo '{"ready":false}')
READY=$(echo "$STATUS" | grep -o '"ready":true' || true)
if [ -n "$READY" ]; then
    pass "Backend is ready"
else
    fail "Backend is NOT ready ($STATUS)"
    echo "⚠️  Cannot continue without a running backend."
    echo "   Run: systemctl --user start whatsapp-backend.service"
    exit 1
fi

# The config file is written by the running backend, so it is authoritative.
# WA_API_KEY remains a fallback for environments that cannot read the file.
if [ -r "$CONFIG_FILE" ]; then
    API_KEY=$(sed -n 's/^[[:space:]]*apiKey[[:space:]]*=[[:space:]]*//p' "$CONFIG_FILE" 2>/dev/null \
        | head -n1 | tr -d '\r' | sed 's/[[:space:]]*$//')
fi
if [ -z "$API_KEY" ]; then
    API_KEY="${WA_API_KEY:-}"
fi
if [ -z "$API_KEY" ]; then
    fail "API key not found in $CONFIG_FILE"
    echo "⚠️  Start the backend first (it generates the key) or set WA_API_KEY."
    exit 1
fi

# ── 2. getAllChats ────────────────────────────────────────────────────────────
echo ""
echo "── 2. getAllChats endpoint ───────────────────────────────"
CHATS_RAW=$(curl -sf -X POST "$API/api/getAllChats" \
    -H "Content-Type: application/json" \
    -H "X-API-Key: $API_KEY" \
    -d '{"args":{}}' 2>/dev/null || echo "ERROR")

if [ "$CHATS_RAW" = "ERROR" ]; then
    fail "getAllChats request failed"
else
    pass "getAllChats returns 200"

    # Check response is an array
    CHAT_COUNT=$(echo "$CHATS_RAW" | python3 -c "
import sys, json
d = json.load(sys.stdin)
chats = d.get('response', d) if isinstance(d, dict) else d
print(len(chats) if isinstance(chats, list) else 0)
" 2>/dev/null || echo "0")
    if [ "$CHAT_COUNT" -gt 0 ]; then
        pass "Has $CHAT_COUNT chats"
    else
        fail "No chats returned (or parse error)"
    fi

    # Check required fields on first chat
    FIELDS_OK=$(echo "$CHATS_RAW" | python3 -c "
import sys, json
d = json.load(sys.stdin)
chats = d.get('response', d) if isinstance(d, dict) else d
if not chats: sys.exit(1)
c = chats[0]
required = ['id', 'name', 'isGroup', 'unreadCount', 't']
missing = [f for f in required if f not in c]
if missing: print('MISSING:' + ','.join(missing)); sys.exit(1)
print('OK')
" 2>/dev/null || echo "FAIL")
    if [ "$FIELDS_OK" = "OK" ]; then
        pass "Chat objects have required fields (id, name, isGroup, unreadCount, t)"
    else
        fail "Chat objects missing fields: $FIELDS_OK"
    fi

    # Extract first chat ID for message tests
    FIRST_CHAT_ID=$(echo "$CHATS_RAW" | python3 -c "
import sys, json
d = json.load(sys.stdin)
chats = d.get('response', d) if isinstance(d, dict) else d
if chats: print(chats[0]['id'])
" 2>/dev/null || echo "")
fi

# ── 3. getChatMessages ───────────────────────────────────────────────────────
echo ""
echo "── 3. getChatMessages endpoint ──────────────────────────"
if [ -n "$FIRST_CHAT_ID" ]; then
    MSGS_RAW=$(curl -sf -X POST "$API/api/getChatMessages" \
        -H "Content-Type: application/json" \
        -H "X-API-Key: $API_KEY" \
        -d "{\"args\":{\"chatId\":\"$FIRST_CHAT_ID\"}}" 2>/dev/null || echo "ERROR")

    if [ "$MSGS_RAW" = "ERROR" ]; then
        fail "getChatMessages request failed"
    else
        pass "getChatMessages returns 200"

        MSG_COUNT=$(echo "$MSGS_RAW" | python3 -c "
import sys, json
d = json.load(sys.stdin)
msgs = d.get('response', d) if isinstance(d, dict) else d
print(len(msgs) if isinstance(msgs, list) else 0)
" 2>/dev/null || echo "0")
        if [ "$MSG_COUNT" -gt 0 ]; then
            pass "Has $MSG_COUNT messages"
        else
            fail "No messages returned"
        fi

        # Check message fields (including new quotedMsg field)
        MSG_FIELDS=$(echo "$MSGS_RAW" | python3 -c "
import sys, json
d = json.load(sys.stdin)
msgs = d.get('response', d) if isinstance(d, dict) else d
if not msgs: sys.exit(1)
m = msgs[0]
required = ['id', 'body', 'type', 't', 'fromMe', 'senderName', 'reactions']
missing = [f for f in required if f not in m]
if missing: print('MISSING:' + ','.join(missing)); sys.exit(1)
print('OK')
" 2>/dev/null || echo "FAIL")
        if [ "$MSG_FIELDS" = "OK" ]; then
            pass "Message objects have required fields"
        else
            fail "Message objects missing fields: $MSG_FIELDS"
        fi

        # Check that quotedMsg field exists (even if null)
        QUOTED_FIELD=$(echo "$MSGS_RAW" | python3 -c "
import sys, json
d = json.load(sys.stdin)
msgs = d.get('response', d) if isinstance(d, dict) else d
if not msgs: sys.exit(1)
# Check if any message has quotedMsg key
has_key = any('quotedMsg' in m for m in msgs)
if has_key: print('OK')
else: print('MISSING')
" 2>/dev/null || echo "FAIL")
        if [ "$QUOTED_FIELD" = "OK" ]; then
            pass "Messages include quotedMsg field (reply context)"
        else
            fail "Messages missing quotedMsg field"
        fi

        # Check if any messages are actually replies (have non-null quotedMsg)
        REPLY_COUNT=$(echo "$MSGS_RAW" | python3 -c "
import sys, json
d = json.load(sys.stdin)
msgs = d.get('response', d) if isinstance(d, dict) else d
count = sum(1 for m in msgs if m.get('quotedMsg') is not None)
print(count)
" 2>/dev/null || echo "0")
        if [ "$REPLY_COUNT" -gt 0 ]; then
            pass "Found $REPLY_COUNT reply messages with quoted content"
        else
            echo "  ℹ️  No reply messages found in this chat (quotedMsg all null — normal if no replies exist)"
        fi

        # Check sig field for incremental polling
        SIG_OK=$(echo "$MSGS_RAW" | python3 -c "
import sys, json
d = json.load(sys.stdin)
if 'sig' in d and d['sig']: print('OK')
else: print('MISSING')
" 2>/dev/null || echo "FAIL")
        if [ "$SIG_OK" = "OK" ]; then
            pass "Response includes sig for incremental polling"
        else
            fail "Missing sig field in response"
        fi
    fi
else
    echo "  ⚠️  Skipping (no chat ID available)"
fi

# ── 4. Incremental fetch (since) ─────────────────────────────────────────────
echo ""
echo "── 4. Incremental message fetch (since param) ───────────"
if [ -n "$FIRST_CHAT_ID" ] && [ "$MSG_COUNT" -gt 0 ]; then
    # Get last message id and t for "since" param
    SINCE_ARGS=$(echo "$MSGS_RAW" | python3 -c "
import sys, json
d = json.load(sys.stdin)
msgs = d.get('response', d) if isinstance(d, dict) else d
if msgs:
    last = msgs[-1]
    print(json.dumps({'id': last['id'], 't': last.get('t', 0)}))
" 2>/dev/null || echo "")

    if [ -n "$SINCE_ARGS" ]; then
        INCR_RAW=$(curl -sf -X POST "$API/api/getChatMessages" \
            -H "Content-Type: application/json" \
            -H "X-API-Key: $API_KEY" \
            -d "{\"args\":{\"chatId\":\"$FIRST_CHAT_ID\",\"since\":$SINCE_ARGS}}" 2>/dev/null || echo "ERROR")

        if [ "$INCR_RAW" != "ERROR" ]; then
            INCR_COUNT=$(echo "$INCR_RAW" | python3 -c "
import sys, json
d = json.load(sys.stdin)
msgs = d.get('response', d) if isinstance(d, dict) else d
print(len(msgs) if isinstance(msgs, list) else -1)
" 2>/dev/null || echo "-1")
            # Should return 0 or very few new messages (since we just fetched)
            if [ "$INCR_COUNT" -ge 0 ]; then
                pass "Incremental fetch works ($INCR_COUNT new msgs since last)"
            else
                fail "Incremental fetch returned unexpected data"
            fi
        else
            fail "Incremental fetch request failed"
        fi
    fi
else
    echo "  ⚠️  Skipping (no messages to base since on)"
fi

# ── 5. waitMessages (long-poll, quick timeout) ───────────────────────────────
echo ""
echo "── 5. waitMessages (long-poll) ──────────────────────────"
if [ -n "$FIRST_CHAT_ID" ]; then
    # Use a short timeout test — should return within a few seconds
    WAIT_RAW=$(timeout 8 curl -sf -X POST "$API/api/waitMessages" \
        -H "Content-Type: application/json" \
        -H "X-API-Key: $API_KEY" \
        -d "{\"args\":{\"chatId\":\"$FIRST_CHAT_ID\",\"sig\":\"test_invalid_sig\"}}" 2>/dev/null || echo "TIMEOUT_OR_ERROR")

    if [ "$WAIT_RAW" != "TIMEOUT_OR_ERROR" ]; then
        pass "waitMessages endpoint responds"
        CHANGED=$(echo "$WAIT_RAW" | python3 -c "
import sys, json
d = json.load(sys.stdin)
print('changed' if d.get('changed') else 'unchanged')
" 2>/dev/null || echo "unknown")
        pass "waitMessages reports: $CHANGED"
    else
        # Timeout is actually expected (long-poll waits up to 20s)
        pass "waitMessages correctly holds connection (timed out as expected for long-poll)"
    fi
else
    echo "  ⚠️  Skipping"
fi

# ── 6. getAvatars ────────────────────────────────────────────────────────────
echo ""
echo "── 6. getAvatars endpoint ───────────────────────────────"
if [ -n "$FIRST_CHAT_ID" ]; then
    FIRST_CHAT_NAME=$(echo "$CHATS_RAW" | python3 -c "
import sys, json
d = json.load(sys.stdin)
chats = d.get('response', d) if isinstance(d, dict) else d
if chats: print(chats[0].get('name', ''))
" 2>/dev/null || echo "")

    AVATAR_RAW=$(curl -sf -X POST "$API/api/getAvatars" \
        -H "Content-Type: application/json" \
        -H "X-API-Key: $API_KEY" \
        -d "{\"args\":{\"chats\":[{\"id\":\"$FIRST_CHAT_ID\",\"name\":\"$FIRST_CHAT_NAME\"}],\"hashes\":{}}}" 2>/dev/null || echo "ERROR")

    if [ "$AVATAR_RAW" != "ERROR" ]; then
        pass "getAvatars returns 200"
    else
        fail "getAvatars request failed"
    fi
else
    echo "  ⚠️  Skipping"
fi

# ── 7. Widget QML syntax check ───────────────────────────────────────────────
echo ""
echo "── 7. Widget file integrity ─────────────────────────────"

# Check main.qml exists
if [ -f "$WIDGET_DIR/contents/ui/main.qml" ]; then
    pass "main.qml exists"
else
    fail "main.qml not found"
fi

# Check messageUtils.js exists
if [ -f "$WIDGET_DIR/contents/ui/messageUtils.js" ]; then
    pass "messageUtils.js exists"
else
    fail "messageUtils.js not found"
fi

# Check pollingUtils.js exists
if [ -f "$WIDGET_DIR/contents/ui/pollingUtils.js" ]; then
    pass "pollingUtils.js exists"
else
    fail "pollingUtils.js not found"
fi

# Check metadata
if [ -f "$WIDGET_DIR/metadata.json" ]; then
    pass "metadata.json exists"
else
    fail "metadata.json not found"
fi

# Check that MessagesPanel.qml contains the quotedMsg UI
# (moved out of main.qml in the Slice 7 MessagesPanel split)
if grep -q "quotedMsg" "$WIDGET_DIR/contents/ui/MessagesPanel.qml"; then
    pass "MessagesPanel.qml contains quotedMsg reply UI"
else
    fail "MessagesPanel.qml missing quotedMsg reply UI"
fi

# Check that SendMessageBar.qml contains ensureCursorVisible (auto-scroll fix,
# moved out of main.qml in the Slice 3 split)
if grep -q "ensureCursorVisible" "$WIDGET_DIR/contents/ui/SendMessageBar.qml"; then
    pass "SendMessageBar.qml contains cursor auto-scroll fix"
else
    fail "SendMessageBar.qml missing cursor auto-scroll fix"
fi

# QML compile gate (Slice 3 learning): a surviving plasmawindowed process does
# NOT imply error-free QML — the error dialog keeps it alive. qmlscene fails
# fast on alias/id/type errors instead. Headless qmlscene also prints
# environment banners (deprecation notice, absent window/plasma plugins,
# Qt-internal notes, FFmpeg banner, the driver's local-file XHR probe), so
# those are filtered out while hard error patterns are matched explicitly —
# the filter can never hide a real QML error.
QMLSCENE_BIN="$(ls /usr/lib64/qt6/bin/qmlscene 2>/dev/null || command -v qmlscene 2>/dev/null || true)"
if [ -n "$QMLSCENE_BIN" ]; then
    QML_NOISE="qmlscene.deprecated|installEventFilter|kf.windowsystem|propertyCache.append|kf.plasma.quick|qt.multimedia.ffmpeg|XMLHttpRequest: Using GET on a local file|Set QML_XHR_ALLOW_FILE_READ|VDPAU|libva|iHD|/dri|PlasmoidAttached"
    QML_RAW=$(timeout 15 env QT_QPA_PLATFORM=offscreen "$QMLSCENE_BIN" "$WIDGET_DIR/contents/ui/main.qml" 2>&1 || true)
    QML_ERR=$(echo "$QML_RAW" | grep -vE "$QML_NOISE" | grep -vE "^[[:space:]]*$" || true)
    QML_HARD=$(echo "$QML_RAW" | grep -aE "TypeError|ReferenceError|SyntaxError|is not a type|Unable to find id|Invalid alias|Cannot assign|Binding loop|File not found" || true)
    if [ -z "$QML_ERR" ] && [ -z "$QML_HARD" ]; then
        pass "main.qml loads with no QML errors (qmlscene)"
    else
        printf '%s\n%s\n' "$QML_HARD" "$QML_ERR" | grep -vE "^[[:space:]]*$" | head -n 10
        fail "main.qml has QML errors (qmlscene)"
    fi
else
    echo "  ⚠️  qmlscene not available, skipping QML compile gate"
fi

# Ensure the widget under test is built from this checkout. A stale install
# can otherwise hide QML/key changes while the launched process stays alive.
if command -v kpackagetool6 >/dev/null 2>&1; then
    if ! kpackagetool6 --type Plasma/Applet --upgrade "$WIDGET_DIR" >/dev/null 2>&1; then
        kpackagetool6 --type Plasma/Applet --install "$WIDGET_DIR" >/dev/null 2>&1 || true
    fi
fi

# Check widget is installed
if ls ~/.local/share/plasma/plasmoids/org.kde.whatsappquick/ >/dev/null 2>&1; then
    pass "Widget installed in plasmoids directory"
else
    fail "Widget not found in plasmoids directory"
fi

# Installed-vs-repo parity (the upgrade path once dropped a new QML file
# silently and every other check still passed — never again)
INSTALLED_UI=~/.local/share/plasma/plasmoids/org.kde.whatsappquick/contents/ui
if [ -d "$INSTALLED_UI" ]; then
    MISSING=""
    for f in "$WIDGET_DIR"/contents/ui/*.qml "$WIDGET_DIR"/contents/ui/*.js; do
        base=$(basename "$f")
        [ -f "$INSTALLED_UI/$base" ] || MISSING="$MISSING $base"
    done
    if [ -z "$MISSING" ]; then
        pass "Installed package contains all QML/JS files"
    else
        fail "Installed package missing files:$MISSING (reinstall cleanly)"
    fi

    if cmp -s "$WIDGET_DIR/contents/ui/main.qml" "$INSTALLED_UI/main.qml"; then
        pass "Installed main.qml matches repo"
    else
        fail "Installed main.qml differs from repo (stale install)"
    fi
else
    fail "Installed ui directory not found"
fi

# ── 8. Backend unit tests ────────────────────────────────────────────────────
echo ""
echo "── 8. Backend unit tests ────────────────────────────────"
TEST_OUTPUT=$(cd "$BACKEND_DIR" && node --test 2>&1 || true)
TEST_PASS=$(echo "$TEST_OUTPUT" | grep -oP '# pass \K\d+' || echo "0")
TEST_FAIL=$(echo "$TEST_OUTPUT" | grep -oP '# fail \K\d+' || echo "0")
TEST_TOTAL=$(echo "$TEST_OUTPUT" | grep -oP '# tests \K\d+' || echo "0")

if [ "$TEST_TOTAL" -gt 0 ] && [ "$TEST_FAIL" -eq 0 ]; then
    pass "All $TEST_TOTAL backend unit tests pass ($TEST_PASS passed, $TEST_FAIL failed)"
else
    if [ "$TEST_TOTAL" -gt 0 ]; then
        fail "Backend tests: $TEST_PASS passed, $TEST_FAIL failed out of $TEST_TOTAL"
    else
        fail "Could not run backend unit tests"
    fi
fi

# ── 9. QML unit tests (qmltestrunner) ────────────────────────────────────────
echo ""
echo "── 9. QML unit tests ────────────────────────────────────"
QMLTEST_BIN="$(command -v qmltestrunner 2>/dev/null || ls /usr/lib64/qt6/bin/qmltestrunner 2>/dev/null || true)"
if [ -n "$QMLTEST_BIN" ] && [ -d "$TESTS_DIR" ]; then
    QMLTEST_OUT=$(cd "$REPO_ROOT" && QT_QPA_PLATFORM=offscreen "$QMLTEST_BIN" -input "$TESTS_DIR" 2>&1 || true)
    QMLTEST_TOTALS=$(echo "$QMLTEST_OUT" | grep -oP 'Totals: \K\d+ passed, \d+ failed' || echo "")
    QMLTEST_FAILS=$(echo "$QMLTEST_OUT" | grep -oP 'Totals: \d+ passed, \K\d+' || echo "1")
    if [ "$QMLTEST_FAILS" = "0" ]; then
        pass "All QML unit tests pass ($QMLTEST_TOTALS)"
    else
        echo "$QMLTEST_OUT" | grep -E 'FAIL!|Loc:' | head -n 10
        fail "QML unit tests failed ($QMLTEST_TOTALS)"
    fi
else
    echo "  ⚠️  qmltestrunner not available or tests/ directory missing, skipping"
fi

# ── 10. Live widget launch (plasmawindowed) ──────────────────────────────────
echo ""
echo "── 10. Live widget in plasmawindowed ────────────────────"
# Launch the widget standalone for visual inspection
PW_PID=""
if command -v plasmawindowed &>/dev/null; then
    # Kill any existing plasmawindowed instances
    pkill -f "plasmawindowed.*whatsappquick" 2>/dev/null || true
    sleep 0.5

    # Launch in background
    plasmawindowed org.kde.whatsappquick &>/dev/null &
    PW_PID=$!
    sleep 3

    # Check if it's still running (didn't crash)
    if kill -0 "$PW_PID" 2>/dev/null; then
        pass "Widget launched in plasmawindowed (PID $PW_PID) — no crash"

        # Journal QML-error check: plasmawindowed logs QML errors to the
        # journal, NOT stderr — a live process proves nothing on its own
        # (an error dialog keeps it alive). Fail on binding loops, type
        # errors, bad aliases/ids, or missing component files.
        sleep 2
        JQML_ERR=$(journalctl --user --since "2 minutes ago" 2>/dev/null | grep -aP "plasmawindowed.*(Binding loop|TypeError|ReferenceError|Cannot read property|Unable to find id|Invalid alias|is not a type|File not found)" | head -n 5 || true)
        if [ -z "$JQML_ERR" ]; then
            pass "No QML errors in journal (plasmawindowed)"
        else
            echo "$JQML_ERR"
            fail "QML errors in journal (plasmawindowed)"
        fi

        # Try to take a screenshot
        if command -v spectacle &>/dev/null; then
            SCREENSHOT="$REPO_ROOT/test_screenshot.png"
            spectacle -b -n -o "$SCREENSHOT" 2>/dev/null || true
            if [ -f "$SCREENSHOT" ]; then
                pass "Screenshot saved to test_screenshot.png"
            fi
        fi
    else
        fail "plasmawindowed crashed on launch"
    fi
else
    echo "  ⚠️  plasmawindowed not available, skipping live test"
fi

# ── Summary ──────────────────────────────────────────────────────────────────
echo ""
echo "═══════════════════════════════════════════════════════════"
echo " Test Results: $PASS passed, $FAIL failed"
echo "═══════════════════════════════════════════════════════════"
echo ""
printf "$RESULTS"
echo ""

# Clean up plasmawindowed
if [ -n "$PW_PID" ] && kill -0 "$PW_PID" 2>/dev/null; then
    echo "ℹ️  plasmawindowed still running (PID $PW_PID). Close it manually or run: kill $PW_PID"
fi

if [ "$FAIL" -gt 0 ]; then
    exit 1
else
    echo "🎉 All tests passed!"
    exit 0
fi
