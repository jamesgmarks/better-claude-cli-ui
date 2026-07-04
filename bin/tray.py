#!/usr/bin/env python3
"""Claude Deck tray icon: start/stop the server from the top bar.

Runs from ~/.config/autostart (installed by `claude-deck install`).
Controls the claude-deck systemd --user service and shows its state.
"""
import os
import signal
import subprocess
import urllib.request

import gi
gi.require_version("Gtk", "3.0")
from gi.repository import Gtk, GLib  # noqa: E402

try:
    gi.require_version("AppIndicator3", "0.1")
    from gi.repository import AppIndicator3
    HAVE_INDICATOR = True
except (ValueError, ImportError):
    HAVE_INDICATOR = False

PORT = os.environ.get("PORT", "3456")
URL = f"http://127.0.0.1:{PORT}"
SERVICE = "claude-deck.service"

ICON_ON = "utilities-terminal"          # themed icons; present on stock GNOME
ICON_OFF = "utilities-terminal-symbolic"


def sysctl(*args):
    subprocess.Popen(["systemctl", "--user", *args],
                     stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


def server_up():
    try:
        with urllib.request.urlopen(f"{URL}/api/state", timeout=1):
            return True
    except Exception:
        return False


class Tray:
    def __init__(self):
        self.up = None
        self.status_item = Gtk.MenuItem(label="checking…")
        self.status_item.set_sensitive(False)
        self.toggle_item = Gtk.MenuItem(label="Start server")
        self.toggle_item.connect("activate", self.toggle)

        menu = Gtk.Menu()
        open_item = Gtk.MenuItem(label="🚀 Open Deck")
        open_item.connect("activate", lambda *_: subprocess.Popen(["xdg-open", URL]))
        restart_item = Gtk.MenuItem(label="Restart server")
        restart_item.connect("activate", lambda *_: sysctl("restart", SERVICE))
        quit_item = Gtk.MenuItem(label="Quit tray (server keeps running)")
        quit_item.connect("activate", Gtk.main_quit)

        for it in (self.status_item, Gtk.SeparatorMenuItem(), open_item,
                   self.toggle_item, restart_item, Gtk.SeparatorMenuItem(), quit_item):
            menu.append(it)
        menu.show_all()

        if HAVE_INDICATOR:
            self.ind = AppIndicator3.Indicator.new(
                "claude-deck", ICON_OFF,
                AppIndicator3.IndicatorCategory.APPLICATION_STATUS)
            self.ind.set_status(AppIndicator3.IndicatorStatus.ACTIVE)
            self.ind.set_menu(menu)
            self.ind.set_title("Claude Deck")
        else:  # ancient fallback
            self.icon = Gtk.StatusIcon(icon_name=ICON_OFF)
            self.icon.set_tooltip_text("Claude Deck")
            self.icon.connect("popup-menu",
                              lambda i, b, t: menu.popup(None, None, None, None, b, t))
            self.icon.connect("activate", lambda *_: subprocess.Popen(["xdg-open", URL]))

        self.refresh()
        GLib.timeout_add_seconds(5, self.refresh)

    def toggle(self, *_):
        sysctl("stop" if self.up else "start", SERVICE)
        GLib.timeout_add_seconds(1, self.refresh)

    def refresh(self, *_):
        up = server_up()
        if up != self.up:
            self.up = up
            self.status_item.set_label(f"● server running on :{PORT}" if up else "○ server stopped")
            self.toggle_item.set_label("Stop server" if up else "Start server")
            icon = ICON_ON if up else ICON_OFF
            if HAVE_INDICATOR:
                self.ind.set_icon_full(icon, "Claude Deck")
            else:
                self.icon.set_property("icon-name", icon)
        return True  # keep the GLib timer alive


if __name__ == "__main__":
    signal.signal(signal.SIGINT, signal.SIG_DFL)
    Tray()
    Gtk.main()
