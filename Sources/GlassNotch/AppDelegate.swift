import AppKit
import Combine
import ServiceManagement

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate, NSMenuDelegate {
    private var controller: NotchController?
    private var widget: DesktopWidgetController?
    private let iconGuard = DesktopIconGuard()
    private var bag = Set<AnyCancellable>()
    private var statusItem: NSStatusItem?
    private let welcome = WelcomeWindowController()
    private let prefs = Prefs.shared

    func applicationDidFinishLaunching(_ notification: Notification) {
        // Diagnostic (`open --env GLASSNOTCH_DIAG=<file>`): report the Screen Recording state and quit.
        if let path = ProcessInfo.processInfo.environment["GLASSNOTCH_DIAG"] {
            let report = "screenRecording=\(CGPreflightScreenCaptureAccess())\n"
            try? report.write(toFile: path, atomically: true, encoding: .utf8)
            exit(0)
        }
        if let id = Bundle.main.bundleIdentifier,
           NSRunningApplication.runningApplications(withBundleIdentifier: id)
               .contains(where: { $0 != NSRunningApplication.current }) {
            NSApp.terminate(nil)
            return
        }
        let controller = NotchController()
        controller.start()
        self.controller = controller
        let widget = DesktopWidgetController()
        iconGuard.widgetFrame = { [weak widget] in widget?.contentFrame }
        widget.onPlaced = { [weak self] in self?.iconGuard.scheduleCheck() }
        widget.start()
        self.widget = widget
        prefs.$showStatsWidget.combineLatest(prefs.$keepIconsClear)
            .map { $0 && $1 }
            .removeDuplicates()
            .receive(on: DispatchQueue.main)
            .sink { [weak self] on in on ? self?.iconGuard.start() : self?.iconGuard.stop() }
            .store(in: &bag)
        setUpStatusItem()
        welcome.onFinish = { [weak controller] in controller?.showHello() }
        if !WelcomeWindowController.hasBeenShown { welcome.show() }
    }

    func applicationWillTerminate(_ notification: Notification) {
        controller?.stop()
        widget?.stop()
    }

    /// Opening GlassNotch again (Spotlight, Launchpad, Finder) while it runs brings back the stats
    /// widget, for anyone who hid it and can't spot the menu bar icon.
    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        prefs.showStatsWidget = true
        return false
    }

    // MARK: - Menu bar item

    private func setUpStatusItem() {
        let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
        let symbol = ["capsule.tophalf.filled", "macbook", "circle.tophalf.filled"]
            .lazy.compactMap { NSImage(systemSymbolName: $0, accessibilityDescription: "GlassNotch") }.first
        item.button?.image = symbol
        let menu = NSMenu()
        menu.delegate = self
        item.menu = menu
        statusItem = item
    }

    func menuNeedsUpdate(_ menu: NSMenu) {
        menu.removeAllItems()

        let title = NSMenuItem(title: "GlassNotch", action: nil, keyEquivalent: "")
        title.isEnabled = false
        menu.addItem(title)
        menu.addItem(.separator())

        let glassItem = NSMenuItem(title: "Glass", action: nil, keyEquivalent: "")
        let glassMenu = NSMenu()
        if !GlassSupport.liquidGlass {
            let note = NSMenuItem(title: "Frosted (Liquid Glass needs macOS 26)", action: nil, keyEquivalent: "")
            note.isEnabled = false
            glassMenu.addItem(note)
        }
        for style in GlassStyle.allCases where GlassSupport.liquidGlass {
            let item = NSMenuItem(title: style.title, action: #selector(selectGlassStyle(_:)), keyEquivalent: "")
            item.target = self
            item.representedObject = style.rawValue
            item.state = prefs.glassStyle == style ? .on : .off
            glassMenu.addItem(item)
        }
        let frostLevels: [(String, Double)] = GlassSupport.liquidGlass ? [("Light", 0.7), ("Medium", 0.88), ("Full", 1.0)] : []
        if !frostLevels.isEmpty {
            glassMenu.addItem(.separator())
            let frostTitle = NSMenuItem(title: "Frost (Waterdrop)", action: nil, keyEquivalent: "")
            frostTitle.isEnabled = false
            glassMenu.addItem(frostTitle)
        }
        for (label, value) in frostLevels {
            let item = NSMenuItem(title: label, action: prefs.glassStyle == .waterdrop ? #selector(selectFrost(_:)) : nil,
                                  keyEquivalent: "")
            item.target = self
            item.representedObject = value
            item.state = abs(prefs.frost - value) < 0.01 ? .on : .off
            item.indentationLevel = 1
            glassMenu.addItem(item)
        }
        glassItem.submenu = glassMenu
        menu.addItem(glassItem)

        menu.addItem(toggle("Dark Glass", prefs.darkGlass, #selector(toggleDark)))
        menu.addItem(toggle("Tint Glass with Album Colors", prefs.tintWithArtwork, #selector(toggleTint)))
        menu.addItem(.separator())
        menu.addItem(toggle("Show Music in Notch", prefs.showMusicActivity, #selector(toggleMusic)))
        menu.addItem(toggle("Show Agents in Notch", prefs.showAgentActivity, #selector(toggleAgents)))
        menu.addItem(toggle("Show Calls in Notch", prefs.showCallActivity, #selector(toggleCalls)))
        menu.addItem(toggle("Haptic Feedback", prefs.haptics, #selector(toggleHaptics)))
        menu.addItem(toggle("Stats Widget on Desktop", prefs.showStatsWidget, #selector(toggleStatsWidget)))
        let iconsItem = toggle("Move Desktop Icons Out of Its Way", prefs.keepIconsClear, #selector(toggleKeepIconsClear))
        iconsItem.indentationLevel = 1
        if !prefs.showStatsWidget { iconsItem.action = nil }
        menu.addItem(iconsItem)

        let delayItem = NSMenuItem(title: "Open Delay", action: nil, keyEquivalent: "")
        let delayMenu = NSMenu()
        for (label, value) in [("Instant", 0.0), ("Short", 0.12), ("Medium", 0.3), ("Long", 0.6)] {
            let item = NSMenuItem(title: label, action: #selector(selectDelay(_:)), keyEquivalent: "")
            item.target = self
            item.representedObject = value
            item.state = abs(prefs.hoverDelay - value) < 0.01 ? .on : .off
            delayMenu.addItem(item)
        }
        delayItem.submenu = delayMenu
        menu.addItem(delayItem)

        menu.addItem(.separator())
        if let usage = controller?.usage {
            let item = NSMenuItem(title: usage.isConnected ? "Disconnect Claude Usage Limits" : "Connect Claude Usage Limits…",
                                  action: #selector(toggleUsage), keyEquivalent: "")
            item.target = self
            menu.addItem(item)
        }
        menu.addItem(toggle("Launch at Login", SMAppService.mainApp.status == .enabled, #selector(toggleLogin)))
        let welcomeItem = NSMenuItem(title: "Welcome & Permissions…", action: #selector(showWelcome), keyEquivalent: "")
        welcomeItem.target = self
        menu.addItem(welcomeItem)
        menu.addItem(.separator())
        let quit = NSMenuItem(title: "Quit GlassNotch", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        menu.addItem(quit)
    }

    private func toggle(_ title: String, _ on: Bool, _ action: Selector) -> NSMenuItem {
        let item = NSMenuItem(title: title, action: action, keyEquivalent: "")
        item.target = self
        item.state = on ? .on : .off
        return item
    }

    @objc private func selectGlassStyle(_ sender: NSMenuItem) {
        if let raw = sender.representedObject as? String, let style = GlassStyle(rawValue: raw) {
            prefs.glassStyle = style
        }
    }

    @objc private func selectFrost(_ sender: NSMenuItem) {
        if let value = sender.representedObject as? Double { prefs.frost = value }
    }

    @objc private func selectDelay(_ sender: NSMenuItem) {
        if let value = sender.representedObject as? Double { prefs.hoverDelay = value }
    }

    @objc private func toggleDark() { prefs.darkGlass.toggle() }
    @objc private func toggleTint() { prefs.tintWithArtwork.toggle() }
    @objc private func toggleMusic() { prefs.showMusicActivity.toggle() }
    @objc private func toggleAgents() { prefs.showAgentActivity.toggle() }
    @objc private func toggleCalls() { prefs.showCallActivity.toggle() }
    @objc private func toggleStatsWidget() { prefs.showStatsWidget.toggle() }
    @objc private func toggleKeepIconsClear() { prefs.keepIconsClear.toggle() }

    @objc private func showWelcome() { welcome.show() }

    @objc private func toggleUsage() {
        guard let usage = controller?.usage else { return }
        if usage.isConnected { usage.disconnect() } else { usage.connect() }
    }
    @objc private func toggleHaptics() { prefs.haptics.toggle() }

    @objc private func toggleLogin() {
        do {
            if SMAppService.mainApp.status == .enabled {
                try SMAppService.mainApp.unregister()
            } else {
                try SMAppService.mainApp.register()
            }
        } catch {
            NSApp.activate()
            NSAlert(error: error).runModal()
        }
    }
}
