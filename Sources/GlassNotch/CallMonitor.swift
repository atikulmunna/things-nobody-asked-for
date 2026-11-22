import AppKit
import ApplicationServices
import CoreAudio

struct ActiveCall: Equatable {
    /// Bundle ID of the app on the call (helpers resolved to their app, e.g. Chrome for Meet).
    let bundleID: String
    let appName: String
    let startedAt: Date
}

/// Notices calls in WhatsApp, FaceTime, Zoom, Teams, browsers (Meet) and similar apps, and offers
/// mute and end-call controls.
///
/// - Detection needs no permission: Core Audio reports which apps are using the microphone
///   (macOS 14.2+).
/// - Mute needs no permission: it mutes the Mac's microphone itself, so it works in every app (the
///   app's own mute button doesn't change). GlassNotch unmutes when the call ends.
/// - End call uses Accessibility, only when you click End: it presses the app's own End / Leave /
///   Hang up button. GlassNotch explains before macOS asks.
@MainActor
final class CallMonitor: ObservableObject {
    @Published private(set) var call: ActiveCall?
    @Published private(set) var icon: NSImage?
    @Published private(set) var isMicMuted = false

    /// Shows a short confirmation in the collapsed notch.
    var onToast: ((_ symbol: String, _ text: String, _ success: Bool) -> Void)?

    private var timer: Timer?
    private var endTask: Task<Void, Never>?
    private var mutedByUs = false
    private var savedInputVolume: Float32?

    /// Apps whose microphone use means a call.
    private static let callApps = [
        "net.whatsapp.WhatsApp", "desktop.WhatsApp", "com.apple.FaceTime", "us.zoom.xos",
        "com.microsoft.teams2", "com.microsoft.teams", "com.tinyspeck.slackmacgap", "com.hnc.Discord",
        "ru.keepcoder.Telegram", "com.tdesktop.Telegram", "com.skype.skype", "org.whispersystems.signal-desktop",
        "Cisco-Systems.Spark", "com.cisco.webexmeetingsapp", "com.facebook.archon", "com.viber.osx",
    ]
    /// Browsers (Google Meet and other web calls). Their audio often runs in a helper process.
    private static let browsers = [
        "com.google.Chrome", "com.brave.Browser", "com.apple.Safari", "company.thebrowser.Browser",
        "com.microsoft.edgemac", "org.mozilla.firefox", "com.operasoftware.Opera", "com.vivaldi.Vivaldi",
    ]

    /// Debug aid (`GLASSNOTCH_FAKE_CALL=<bundle id>`): pretend that app is on a call.
    private let fakeCall = ProcessInfo.processInfo.environment["GLASSNOTCH_FAKE_CALL"]

    func start() {
        if let bundleID = fakeCall {
            let url = NSWorkspace.shared.urlForApplication(withBundleIdentifier: bundleID)
            icon = url.map { NSWorkspace.shared.icon(forFile: $0.path) }
            call = ActiveCall(bundleID: bundleID, appName: url?.deletingPathExtension().lastPathComponent ?? "Call",
                              startedAt: Date().addingTimeInterval(-754))
            return
        }
        guard #available(macOS 14.2, *) else { return }
        poll()
        let timer = Timer(timeInterval: 1, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated { self?.poll() }
        }
        RunLoop.main.add(timer, forMode: .common)
        self.timer = timer
    }

    /// Never leave the microphone muted behind.
    func stop() {
        if mutedByUs { setMuted(false) }
    }

    // MARK: Detection

    private func poll() {
        guard #available(macOS 14.2, *) else { return }
        let users = Self.microphoneUsers()
        let match = users.lazy.compactMap { Self.app(for: $0, in: Self.callApps) }.first
            ?? users.lazy.compactMap { Self.app(for: $0, in: Self.browsers) }.first

        if let bundleID = match {
            endTask?.cancel()
            endTask = nil
            if call?.bundleID != bundleID {
                let url = NSWorkspace.shared.urlForApplication(withBundleIdentifier: bundleID)
                let name = url.flatMap { Bundle(url: $0) }.flatMap {
                    ($0.object(forInfoDictionaryKey: "CFBundleDisplayName") ?? $0.object(forInfoDictionaryKey: "CFBundleName")) as? String
                } ?? url?.deletingPathExtension().lastPathComponent ?? "Call"
                icon = url.map { NSWorkspace.shared.icon(forFile: $0.path) }
                call = ActiveCall(bundleID: bundleID, appName: name, startedAt: Date())
            }
        } else if call != nil, endTask == nil {
            // Apps can pause the microphone briefly; end the call only after a few quiet seconds.
            endTask = Task { @MainActor [weak self] in
                try? await Task.sleep(for: .seconds(3))
                guard let self, !Task.isCancelled else { return }
                self.endTask = nil
                self.callEnded()
            }
        }
        if let device = Self.defaultInputDevice() {
            let muted = Self.isMuted(device)
            if muted != isMicMuted { isMicMuted = muted }
        }
    }

    private func callEnded() {
        if mutedByUs { setMuted(false) }
        call = nil
        icon = nil
    }

    /// Maps a microphone user (possibly a helper such as "com.google.Chrome.helper" or Safari's
    /// "com.apple.WebKit.GPU") to one of the given apps.
    private static func app(for bundleID: String, in apps: [String]) -> String? {
        if bundleID.hasPrefix("com.apple.WebKit"), apps.contains("com.apple.Safari"),
           NSWorkspace.shared.frontmostApplication?.bundleIdentifier == "com.apple.Safari"
            || !NSRunningApplication.runningApplications(withBundleIdentifier: "com.apple.Safari").isEmpty {
            return "com.apple.Safari"
        }
        return apps.first { bundleID == $0 || bundleID.hasPrefix($0 + ".") }
    }

    @available(macOS 14.2, *)
    private static func microphoneUsers() -> [String] {
        var address = Self.address(kAudioHardwarePropertyProcessObjectList)
        let system = AudioObjectID(kAudioObjectSystemObject)
        var size: UInt32 = 0
        guard AudioObjectGetPropertyDataSize(system, &address, 0, nil, &size) == noErr, size > 0 else { return [] }
        var processes = [AudioObjectID](repeating: 0, count: Int(size) / MemoryLayout<AudioObjectID>.size)
        guard AudioObjectGetPropertyData(system, &address, 0, nil, &size, &processes) == noErr else { return [] }

        return processes.compactMap { process in
            var inputAddress = Self.address(kAudioProcessPropertyIsRunningInput)
            var running: UInt32 = 0
            var runningSize = UInt32(MemoryLayout<UInt32>.size)
            guard AudioObjectGetPropertyData(process, &inputAddress, 0, nil, &runningSize, &running) == noErr,
                  running != 0 else { return nil }
            var bundleAddress = Self.address(kAudioProcessPropertyBundleID)
            var bundle: Unmanaged<CFString>?
            var bundleSize = UInt32(MemoryLayout<Unmanaged<CFString>?>.size)
            guard AudioObjectGetPropertyData(process, &bundleAddress, 0, nil, &bundleSize, &bundle) == noErr else { return nil }
            return bundle?.takeRetainedValue() as String?
        }
    }

    // MARK: Mute (the Mac's microphone)

    func toggleMute() {
        setMuted(!isMicMuted)
    }

    private func setMuted(_ muted: Bool) {
        guard let device = Self.defaultInputDevice() else { return }
        var muteAddress = Self.address(kAudioDevicePropertyMute, kAudioObjectPropertyScopeInput)
        var settable: DarwinBoolean = false
        if AudioObjectHasProperty(device, &muteAddress),
           AudioObjectIsPropertySettable(device, &muteAddress, &settable) == noErr, settable.boolValue {
            var value: UInt32 = muted ? 1 : 0
            AudioObjectSetPropertyData(device, &muteAddress, 0, nil, UInt32(MemoryLayout<UInt32>.size), &value)
        } else {
            // No mute switch on this device: turn the input level down instead, and restore it later.
            var volumeAddress = Self.address(kAudioDevicePropertyVolumeScalar, kAudioObjectPropertyScopeInput)
            var size = UInt32(MemoryLayout<Float32>.size)
            if muted {
                var current: Float32 = 1
                AudioObjectGetPropertyData(device, &volumeAddress, 0, nil, &size, &current)
                savedInputVolume = current
                var zero: Float32 = 0
                AudioObjectSetPropertyData(device, &volumeAddress, 0, nil, size, &zero)
            } else {
                var restored = savedInputVolume ?? 1
                AudioObjectSetPropertyData(device, &volumeAddress, 0, nil, size, &restored)
                savedInputVolume = nil
            }
        }
        mutedByUs = muted
        isMicMuted = muted
    }

    private static func isMuted(_ device: AudioObjectID) -> Bool {
        var muteAddress = address(kAudioDevicePropertyMute, kAudioObjectPropertyScopeInput)
        if AudioObjectHasProperty(device, &muteAddress) {
            var value: UInt32 = 0
            var size = UInt32(MemoryLayout<UInt32>.size)
            if AudioObjectGetPropertyData(device, &muteAddress, 0, nil, &size, &value) == noErr, value != 0 { return true }
        }
        var volumeAddress = address(kAudioDevicePropertyVolumeScalar, kAudioObjectPropertyScopeInput)
        var volume: Float32 = 1
        var size = UInt32(MemoryLayout<Float32>.size)
        if AudioObjectGetPropertyData(device, &volumeAddress, 0, nil, &size, &volume) == noErr { return volume < 0.001 }
        return false
    }

    private static func defaultInputDevice() -> AudioObjectID? {
        var address = address(kAudioHardwarePropertyDefaultInputDevice)
        var device = AudioObjectID(0)
        var size = UInt32(MemoryLayout<AudioObjectID>.size)
        guard AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &address, 0, nil, &size, &device) == noErr,
              device != kAudioObjectUnknown else { return nil }
        return device
    }

    private static func address(_ selector: AudioObjectPropertySelector,
                                _ scope: AudioObjectPropertyScope = kAudioObjectPropertyScopeGlobal) -> AudioObjectPropertyAddress {
        AudioObjectPropertyAddress(mSelector: selector, mScope: scope, mElement: kAudioObjectPropertyElementMain)
    }

    // MARK: App

    func showApp() {
        guard let call, let url = NSWorkspace.shared.urlForApplication(withBundleIdentifier: call.bundleID) else { return }
        NSWorkspace.shared.openApplication(at: url, configuration: NSWorkspace.OpenConfiguration())
    }

    // MARK: End call (Accessibility)

    func endCall() {
        guard let call, ensureAccessibility(),
              let pid = NSRunningApplication.runningApplications(withBundleIdentifier: call.bundleID).first?.processIdentifier
        else { return }
        Task { @MainActor [weak self] in
            let pressed = await Task.detached(priority: .userInitiated) { CallMonitor.pressEndButton(pid: pid) }.value
            if pressed {
                self?.onToast?("phone.down.fill", "Ended", true)
            } else {
                // No End button found: bring the app forward so it can be ended there.
                self?.onToast?("phone.fill", "Open app", false)
                self?.showApp()
            }
        }
    }

    private static let askedForAccessibilityKey = "accessibilityAsked"

    private func ensureAccessibility() -> Bool {
        if AXIsProcessTrusted() { return true }
        let defaults = UserDefaults.standard
        let alert = NSAlert()
        NSApp.activate()
        if !defaults.bool(forKey: Self.askedForAccessibilityKey) {
            alert.messageText = "Allow Accessibility to end calls"
            alert.informativeText = """
            GlassNotch uses it only when you click End: it presses the End, Leave or Hang up button \\
            in your call app's window. It doesn't type, read your messages or watch what you do. \\
            Mute and call detection work without it.

            macOS will ask next. Turn on GlassNotch in System Settings, then click End again.
            """
            alert.addButton(withTitle: "Continue")
            alert.addButton(withTitle: "Not Now")
            guard alert.runModal() == .alertFirstButtonReturn else { return false }
            defaults.set(true, forKey: Self.askedForAccessibilityKey)
            let options = [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary
            return AXIsProcessTrustedWithOptions(options)
        }
        alert.messageText = "Accessibility is off for GlassNotch"
        alert.informativeText = "Turn on GlassNotch in System Settings › Privacy & Security › Accessibility, then click End again."
        alert.addButton(withTitle: "Open System Settings")
        alert.addButton(withTitle: "Cancel")
        if alert.runModal() == .alertFirstButtonReturn,
           let url = URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility") {
            NSWorkspace.shared.open(url)
        }
        return false
    }

    /// Finds the best End / Leave / Hang up button in the app's windows and presses it. Meeting
    /// apps that ask "Leave meeting?" get that confirmation pressed too; "End for all" is never pressed.
    nonisolated private static func pressEndButton(pid: pid_t) -> Bool {
        let app = AXUIElementCreateApplication(pid)
        AXUIElementSetMessagingTimeout(app, 1.0)
        guard let button = findButton(in: app, minimumScore: 1) else { return false }
        guard AXUIElementPerformAction(button, kAXPressAction as CFString) == .success else { return false }
        Thread.sleep(forTimeInterval: 0.7)
        if let confirm = findButton(in: app, minimumScore: 70, confirmOnly: true) {
            AXUIElementPerformAction(confirm, kAXPressAction as CFString)
        }
        return true
    }

    nonisolated private static func findButton(in app: AXUIElement, minimumScore: Int, confirmOnly: Bool = false) -> AXUIElement? {
        guard let windows = attribute(app, kAXWindowsAttribute) as? [AXUIElement] else { return nil }
        var best: (element: AXUIElement, score: Int)?
        var visited = 0

        func visit(_ element: AXUIElement, depth: Int) {
            guard visited < 6000, depth < 30 else { return }
            visited += 1
            if attribute(element, kAXRoleAttribute) as? String == kAXButtonRole as String {
                let label = [kAXTitleAttribute, kAXDescriptionAttribute, kAXHelpAttribute, kAXIdentifierAttribute]
                    .compactMap { attribute(element, $0) as? String }
                    .joined(separator: " ")
                if let score = score(label, confirmOnly: confirmOnly), score >= minimumScore, score > (best?.score ?? 0) {
                    best = (element, score)
                }
            }
            for child in attribute(element, kAXChildrenAttribute) as? [AXUIElement] ?? [] {
                visit(child, depth: depth + 1)
            }
        }
        for window in windows { visit(window, depth: 0) }
        return best?.element
    }

    nonisolated private static func score(_ rawLabel: String, confirmOnly: Bool) -> Int? {
        let label = rawLabel.lowercased().trimmingCharacters(in: .whitespacesAndNewlines)
        guard !label.isEmpty else { return nil }
        for unsafe in ["for all", "everyone", "share", "record", "chat", "camera", "video"] where label.contains(unsafe) {
            return nil
        }
        if label.contains("leave meeting") || label.contains("leave call") { return 90 }
        if confirmOnly { return nil }
        if label.contains("end call") || label.contains("hang up") || label.contains("hangup") { return 100 }
        if label == "end" { return 80 }
        if label == "leave" { return 75 }
        if label.contains("disconnect") { return 50 }
        return nil
    }

    nonisolated private static func attribute(_ element: AXUIElement, _ name: String) -> AnyObject? {
        var value: AnyObject?
        guard AXUIElementCopyAttributeValue(element, name as CFString, &value) == .success else { return nil }
        return value
    }
}
