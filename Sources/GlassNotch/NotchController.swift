import AppKit
import Combine
import SwiftUI

/// Owns the notch window, tracks the pointer and drives the open/close springs.
@MainActor
final class NotchController {
    let model = NotchModel()
    let nowPlaying = NowPlayingService()
    let clipboard = ClipboardMonitor()
    let agents = AgentMonitor()
    let screenshots = ScreenshotService()
    let usage = ClaudeUsageService()
    let calls = CallMonitor()
    let prefs = Prefs.shared

    private var panel: NotchPanel!
    private var screenFrame: CGRect = .zero
    private var monitors: [Any] = []
    private var observers: [NSObjectProtocol] = []
    private var bag = Set<AnyCancellable>()

    private var hoverTask: Task<Void, Never>?
    private var collapseTask: Task<Void, Never>?
    private var glassOffTask: Task<Void, Never>?
    private var pollTimer: Timer?
    private var mouseIsDown = false
    private var toast: LiveActivity?
    private var toastTask: Task<Void, Never>?

    /// In a fullscreen Space the music wings stay hidden until the pointer comes near the notch.
    private let fullscreen = FullscreenDetector()
    private var pointerNearNotch = false

    // MARK: Debug aids (environment variables)

    /// `GLASSNOTCH_PIN=expanded|peeking|collapsed` freezes the notch in one state.
    private let pinned: NotchPhase? = {
        switch ProcessInfo.processInfo.environment["GLASSNOTCH_PIN"] {
        case "expanded": .expanded
        case "peeking": .peeking
        case "collapsed": .collapsed
        default: nil
        }
    }()
    private var demoTimer: Timer?
    private var backdrop: NSWindow?

    func start() {
        panel = NotchPanel()
        let root = NotchRootView(model: model, nowPlaying: nowPlaying, clipboard: clipboard, agents: agents,
                                 screenshots: screenshots, usage: usage, calls: calls, prefs: prefs)
        let host = NotchHostingView(rootView: root)
        host.sizingOptions = []
        panel.contentView = host
        applyAppearance()
        layout()
        panel.orderFrontRegardless()

        observers.append(NotificationCenter.default.addObserver(
            forName: NSApplication.didChangeScreenParametersNotification, object: nil, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated { self?.layout() }
        })
        observers.append(NSWorkspace.shared.notificationCenter.addObserver(
            forName: NSWorkspace.didWakeNotification, object: nil, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated { self?.layout() }
        })
        installMouseMonitors()

        // Recompute the live activity after the published values have actually changed.
        nowPlaying.$isActive.removeDuplicates()
            .combineLatest(prefs.$showMusicActivity.removeDuplicates())
            .receive(on: DispatchQueue.main)
            .sink { [weak self] _ in self?.refreshActivity() }
            .store(in: &bag)
        agents.$sessions.map { _ in () }
            .merge(with: agents.$completion.map { _ in () })
            .combineLatest(prefs.$showAgentActivity.removeDuplicates())
            .receive(on: DispatchQueue.main)
            .sink { [weak self] _ in self?.refreshActivity() }
            .store(in: &bag)
        // Pages refresh while they are on screen.
        model.$tab.combineLatest(model.$phase)
            .receive(on: DispatchQueue.main)
            .sink { [weak self] tab, phase in
                guard let self else { return }
                self.agents.fastMode = phase == .expanded && tab == .agents
                if phase == .expanded && tab == .screenshots { self.screenshots.refresh() }
            }
            .store(in: &bag)
        calls.$call.map { _ in () }
            .merge(with: calls.$isMicMuted.map { _ in () })
            .combineLatest(prefs.$showCallActivity.removeDuplicates())
            .receive(on: DispatchQueue.main)
            .sink { [weak self] _ in self?.refreshActivity() }
            .store(in: &bag)
        prefs.$darkGlass.removeDuplicates()
            .receive(on: DispatchQueue.main)
            .sink { [weak self] _ in self?.applyAppearance() }
            .store(in: &bag)

        fullscreen.onChange = { [weak self] _ in
            guard let self else { return }
            self.pointerNearNotch = self.pointerIsNearNotch()
            self.refreshActivity()
        }
        fullscreen.start()
        nowPlaying.start()
        clipboard.start()
        agents.start()
        usage.start()
        calls.onToast = { [weak self] symbol, text, success in
            self?.showToast(symbol: symbol, text: text, success: success)
        }
        calls.start()
        screenshots.requestCollapse = { [weak self] in self?.collapse() }
        screenshots.onToast = { [weak self] symbol, text, success in
            self?.showToast(symbol: symbol, text: text, success: success)
        }

        let env = ProcessInfo.processInfo.environment
        if let pinned {
            model.glassActive = pinned != .collapsed
            model.phase = pinned
            panel.ignoresMouseEvents = pinned != .expanded
        }
        if let raw = env["GLASSNOTCH_TAB"], let tab = NotchTab(rawValue: raw) { model.tab = tab }
        if env["GLASSNOTCH_BACKDROP"] != nil { showDebugBackdrop() }
        if env["GLASSNOTCH_DEMO"] != nil { startDemo() }
    }

    func stop() {
        calls.stop()
        nowPlaying.stop()
        monitors.forEach { NSEvent.removeMonitor($0) }
        monitors.removeAll()
    }

    // MARK: - Layout

    private func layout() {
        guard let screen = NSScreen.screens.first(where: { $0.safeAreaInsets.top > 0 })
                ?? NSScreen.main ?? NSScreen.screens.first else { return }
        screenFrame = screen.frame
        model.configure(for: screen)
        fullscreen.setScreen(screen)
        let pad = NotchModel.windowPadding
        let width = model.maxExpandedSize.width + pad * 2
        let height = model.maxExpandedSize.height + pad
        panel.setFrame(NSRect(x: screen.frame.midX - width / 2, y: screen.frame.maxY - height,
                              width: width, height: height), display: true)
    }

    private func applyAppearance() {
        panel.appearance = prefs.darkGlass ? NSAppearance(named: .darkAqua) : nil
    }

    // MARK: - Pointer tracking

    private func installMouseMonitors() {
        let mask: NSEvent.EventTypeMask = [.mouseMoved, .leftMouseDragged, .leftMouseDown, .leftMouseUp, .rightMouseDown]
        if let monitor = NSEvent.addGlobalMonitorForEvents(matching: mask, handler: { [weak self] event in
            let type = event.type
            MainActor.assumeIsolated { self?.handle(type) }
        }) {
            monitors.append(monitor)
        }
        if let monitor = NSEvent.addLocalMonitorForEvents(matching: mask, handler: { [weak self] event in
            let type = event.type
            MainActor.assumeIsolated { self?.handle(type) }
            return event
        }) {
            monitors.append(monitor)
        }
    }

    /// The area that keeps the notch open (or opens it), in screen coordinates.
    private func hotZone() -> CGRect {
        let size: CGSize
        switch model.phase {
        case .expanded:
            size = CGSize(width: model.expandedSize.width + 8, height: model.expandedSize.height + 6)
        case .peeking:
            size = CGSize(width: model.peekSize.width + 10, height: model.peekSize.height + 4)
        case .collapsed:
            size = CGSize(width: model.collapsedSize.width + 6, height: model.collapsedSize.height + 2)
        }
        // One extra point above so the very top pixel row of the screen counts as inside.
        return CGRect(x: screenFrame.midX - size.width / 2, y: screenFrame.maxY - size.height,
                      width: size.width, height: size.height + 1)
    }

    private func pointerInside() -> Bool {
        hotZone().contains(NSEvent.mouseLocation)
    }

    /// A generous area around the notch; approaching it reveals the wings in fullscreen.
    private func pointerIsNearNotch() -> Bool {
        let width = model.expandedSize.width + 200
        let height = model.notchSize.height + 100
        return CGRect(x: screenFrame.midX - width / 2, y: screenFrame.maxY - height, width: width, height: height + 1)
            .contains(NSEvent.mouseLocation)
    }

    private func handle(_ type: NSEvent.EventType) {
        guard pinned == nil, demoTimer == nil else { return }
        if fullscreen.isFullscreen {
            let near = pointerIsNearNotch()
            if near != pointerNearNotch {
                pointerNearNotch = near
                refreshActivity()
            }
        }
        let inside = pointerInside()
        switch type {
        case .leftMouseDown, .rightMouseDown:
            mouseIsDown = inside && type == .leftMouseDown
            if !inside && model.phase == .expanded {
                collapse()
                return
            }
            if inside && model.phase == .peeking {
                expand()
                return
            }
        case .leftMouseUp:
            mouseIsDown = false
        default:
            break
        }
        updateHover(inside: inside)
    }

    private func updateHover(inside: Bool) {
        if inside {
            collapseTask?.cancel()
            collapseTask = nil
            if model.phase == .collapsed {
                setPhase(.peeking)
                hoverTask?.cancel()
                let delay = max(0, prefs.hoverDelay)
                hoverTask = Task { @MainActor [weak self] in
                    try? await Task.sleep(for: .seconds(delay))
                    guard let self, !Task.isCancelled, self.model.phase == .peeking, self.pointerInside() else { return }
                    self.expand()
                }
            }
        } else {
            hoverTask?.cancel()
            hoverTask = nil
            switch model.phase {
            case .peeking:
                setPhase(.collapsed)
            case .expanded where !mouseIsDown && collapseTask == nil:
                collapseTask = Task { @MainActor [weak self] in
                    try? await Task.sleep(for: .milliseconds(160))
                    guard let self, !Task.isCancelled else { return }
                    self.collapseTask = nil
                    if !self.pointerInside() && !self.mouseIsDown { self.collapse() }
                }
            default:
                break
            }
        }
        updateMouseIgnoring(inside: inside)
    }

    private func updateMouseIgnoring(inside: Bool) {
        let accepts = inside && model.phase != .collapsed
        if panel.ignoresMouseEvents == accepts { panel.ignoresMouseEvents = !accepts }
    }

    /// Polls the pointer while the notch is open, since mouse-moved events are not guaranteed
    /// to reach a window that never becomes key.
    private func updatePolling() {
        if model.phase == .collapsed {
            pollTimer?.invalidate()
            pollTimer = nil
        } else if pollTimer == nil {
            let timer = Timer(timeInterval: 1.0 / 20, repeats: true) { [weak self] _ in
                MainActor.assumeIsolated { self?.poll() }
            }
            RunLoop.main.add(timer, forMode: .common)
            pollTimer = timer
        }
    }

    private func poll() {
        guard demoTimer == nil else { return }
        if mouseIsDown && NSEvent.pressedMouseButtons & 1 == 0 { mouseIsDown = false }
        updateHover(inside: pointerInside())
    }

    // MARK: - Phases

    private func expand() {
        hoverTask?.cancel()
        hoverTask = nil
        // While only Claude is showing in the notch, open straight to the Agents page; during a call,
        // open the call controls (they take over the Now Playing page).
        if model.activity == .agent { model.tab = .agents }
        if model.activity == .call { model.tab = .media }
        setPhase(.expanded)
        if prefs.haptics {
            NSHapticFeedbackManager.defaultPerformer.perform(.alignment, performanceTime: .now)
        }
    }

    /// Opens the notch for a moment (after the welcome window), then closes it unless hovered.
    func showHello() {
        model.tab = .media
        expand()
        Task { @MainActor [weak self] in
            try? await Task.sleep(for: .seconds(2.6))
            guard let self, self.model.phase == .expanded, !self.pointerInside() else { return }
            self.collapse()
        }
    }

    func collapse() {
        collapseTask?.cancel()
        collapseTask = nil
        setPhase(.collapsed)
    }

    private func setPhase(_ phase: NotchPhase) {
        guard model.phase != phase else { return }
        let animation: Animation = switch phase {
        case .expanded: .spring(response: 0.44, dampingFraction: 0.72)
        case .peeking: .spring(response: 0.32, dampingFraction: 0.68)
        case .collapsed: .spring(response: 0.40, dampingFraction: 0.86)
        }

        if phase != .collapsed {
            glassOffTask?.cancel()
            glassOffTask = nil
            model.glassActive = true
        }
        withAnimation(animation) { model.phase = phase }
        if phase == .collapsed {
            glassOffTask?.cancel()
            glassOffTask = Task { @MainActor [weak self] in
                try? await Task.sleep(for: .milliseconds(700))
                guard let self, !Task.isCancelled, self.model.phase == .collapsed else { return }
                self.model.glassActive = false
            }
        }
        updatePolling()
        updateMouseIgnoring(inside: pointerInside())
        if phase == .collapsed { refreshActivity() }
    }

    // MARK: - Live activity

    /// Shows a short confirmation in the collapsed notch.
    func showToast(symbol: String, text: String, success: Bool, duration: TimeInterval = 2.2) {
        toast = .toast(symbol: symbol, text: text, success: success)
        refreshActivity()
        toastTask?.cancel()
        toastTask = Task { @MainActor [weak self] in
            try? await Task.sleep(for: .seconds(duration))
            guard let self, !Task.isCancelled else { return }
            self.toast = nil
            self.refreshActivity()
        }
    }

    /// Priority: confirmation, then music and/or a working (or just finished) agent. In fullscreen, music and agents
    /// stay hidden until the pointer comes near the notch.
    private func refreshActivity() {
        let hiddenForFullscreen = fullscreen.isFullscreen && !pointerNearNotch && model.phase == .collapsed
            && ProcessInfo.processInfo.environment["GLASSNOTCH_IGNORE_FULLSCREEN"] == nil
        let agentVisible = prefs.showAgentActivity && (agents.workingCount > 0 || agents.completion != nil)
        let musicVisible = prefs.showMusicActivity && nowPlaying.isActive
        let next: LiveActivity
        if let toast {
            next = toast
        } else if hiddenForFullscreen {
            next = .none
        } else if prefs.showCallActivity && calls.call != nil {
            next = .call
        } else if agentVisible && musicVisible {
            next = .musicAndAgent
        } else if musicVisible {
            next = .music
        } else if agentVisible {
            next = .agent
        } else {
            next = .none
        }
        guard next != model.activity else { return }
        withAnimation(.spring(response: 0.42, dampingFraction: 0.74)) { model.activity = next }
    }

    // MARK: - Debug aids

    /// `GLASSNOTCH_DEMO=1`: opens and closes the notch on a loop.
    private func startDemo() {
        let timer = Timer(timeInterval: 1.6, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated {
                guard let self else { return }
                self.setPhase(self.model.phase == .expanded ? .collapsed : .expanded)
            }
        }
        RunLoop.main.add(timer, forMode: .common)
        demoTimer = timer
    }

    /// `GLASSNOTCH_BACKDROP=1`: a colorful window just below the notch, to judge the glass.
    private func showDebugBackdrop() {
        let window = NSWindow(contentRect: panel.frame, styleMask: .borderless, backing: .buffered, defer: false)
        window.level = NSWindow.Level(rawValue: panel.level.rawValue - 1)
        window.ignoresMouseEvents = true
        window.contentView = NSHostingView(rootView: DebugBackdrop())
        window.orderFrontRegardless()
        backdrop = window
    }
}
