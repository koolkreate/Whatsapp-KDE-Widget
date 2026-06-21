#!/usr/bin/env bash

# Exit immediately if a command exits with a non-zero status
set -e

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKEND_DIR="$PROJECT_DIR/backend"
WIDGET_DIR="$PROJECT_DIR/widget"
WIDGET_ID="org.kde.whatsappquick"
LOG_FILE="$PROJECT_DIR/backend.log"
PID_FILE="$PROJECT_DIR/backend.pid"

function usage() {
    echo "Usage: $0 {install-widget|uninstall-widget|reinstall-widget|setup-backend|start-backend|stop-backend|status-backend|logs-backend}"
    echo
    echo "Actions:"
    echo "  install-widget      Install the KDE Plasma 6 Widget"
    echo "  uninstall-widget    Remove the KDE Plasma 6 Widget"
    echo "  reinstall-widget    Upgrade/Reinstall the KDE Plasma 6 Widget"
    echo "  setup-backend       Install Node.js dependencies for the backend"
    echo "  start-backend       Start the backend daemon and tail logs for QR code"
    echo "  stop-backend        Stop the backend daemon process"
    echo "  status-backend      Check if the backend daemon is running"
    echo "  logs-backend        Tail the backend server log file"
    echo
}

case "$1" in
    install-widget)
        echo "Installing KDE widget '$WIDGET_ID'..."
        kpackagetool6 --type Plasma/Applet --install "$WIDGET_DIR"
        echo "Widget installed successfully! You can now add 'WhatsApp Quick' to your desktop or panel."
        ;;
    uninstall-widget)
        echo "Uninstalling KDE widget '$WIDGET_ID'..."
        kpackagetool6 --type Plasma/Applet --remove "$WIDGET_ID" || true
        echo "Widget uninstalled."
        ;;
    reinstall-widget)
        echo "Reinstalling (upgrading) KDE widget '$WIDGET_ID'..."
        kpackagetool6 --type Plasma/Applet --upgrade "$WIDGET_DIR"
        echo "Widget upgraded successfully. Please restart plasmashell if changes do not reflect immediately:"
        echo "  plasmashell --replace &"
        ;;
    setup-backend)
        echo "Installing Node.js dependencies in $BACKEND_DIR..."
        cd "$BACKEND_DIR"
        npm install
        echo "Dependencies installed."
        ;;
    start-backend)
        if [ -f "$PID_FILE" ]; then
            PID=$(cat "$PID_FILE")
            if ps -p "$PID" > /dev/null 2>&1; then
                echo "Backend is already running (PID $PID)."
                echo "Tailing logs... (Press Ctrl+C to exit log view, daemon will keep running)"
                tail -n 50 -f "$LOG_FILE"
                exit 0
            fi
        fi

        echo "Starting backend daemon..."
        cd "$BACKEND_DIR"
        # Start server in background, redirecting stdout/stderr to log file
        nohup npm start > "$LOG_FILE" 2>&1 &
        NEW_PID=$!
        echo "$NEW_PID" > "$PID_FILE"
        echo "Backend started with PID $NEW_PID."
        echo "Tailing logs for QR code scan. Please wait..."
        echo "Press Ctrl+C to exit logs view anytime (the server will remain running in background)."
        echo "----------------------------------------------------------------------------------------"
        sleep 2
        tail -n 100 -f "$LOG_FILE"
        ;;
    stop-backend)
        echo "Stopping all backend processes (node server.js and chrome)..."
        pkill -f "node server.js" || true
        pkill -f "chrome" || true
        if [ -f "$PID_FILE" ]; then
            PID=$(cat "$PID_FILE")
            kill "$PID" >/dev/null 2>&1 || true
            rm -f "$PID_FILE"
        fi
        echo "Backend stopped."
        ;;
    status-backend)
        PIDS=$(pgrep -f "node server.js" || true)
        if [ -n "$PIDS" ]; then
            echo "Backend is running (PIDs: $PIDS)."
            exit 0
        fi
        echo "Backend is stopped."
        ;;
    logs-backend)
        if [ -f "$LOG_FILE" ]; then
            tail -n 100 -f "$LOG_FILE"
        else
            echo "No log file found. Has the backend been started?"
        fi
        ;;
    *)
        usage
        exit 1
        ;;
esac
