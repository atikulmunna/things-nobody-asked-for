import AppKit

/// Reports whether the notch display is currently showing a fullscreen Space (a fullscreen video,
/// app or game).
///
/// Uses the window server's managed-display-spaces list (SkyLight, private): the current Space of
/// each display carries a `type`, where 4 means fullscreen. If the symbols are missing on a future
/// macOS, it always reports `false`.
@MainActor
final class FullscreenDetector {
    private(set) var isFullscreen = false
    var onChange: ((Bool) -> Void)?

    private var displayUUID: String?
    private var observers: [NSObjectProtocol] = []
    private var timer: Timer?
    private var recheckTask: Task<Void, Never>?

    private typealias MainConnectionFn = @convention(c) () -> Int32
    private typealias CopySpacesFn = @convention(c) (Int32) -> Unmanaged<CFArray>?

    private static let skyLight = dlopen("/System/Library/PrivateFrameworks/SkyLight.framework/SkyLight", RTLD_LAZY)
    private static let mainConnection: MainConnectionFn? = dlsym(skyLight, "SLSMainConnectionID")
        .map { unsafeBitCast($0, to: MainConnectionFn.self) }
    private static let copySpaces: CopySpacesFn? = dlsym(skyLight, "SLSCopyManagedDisplaySpaces")
        .map { unsafeBitCast($0, to: CopySpacesFn.self) }

    func start() {
        let center = NSWorkspace.shared.notificationCenter
        for name in [NSWorkspace.activeSpaceDidChangeNotification, NSWorkspace.didActivateApplicationNotification] {
            observers.append(center.addObserver(forName: name, object: nil, queue: .main) { [weak self] _ in
                MainActor.assumeIsolated { self?.checkSoon() }
            })
        }
        // Cheap fallback in case a transition is not announced.
        let timer = Timer(timeInterval: 2, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated { self?.check() }
        }
        RunLoop.main.add(timer, forMode: .common)
        self.timer = timer
        check()
    }

    func setScreen(_ screen: NSScreen) {
        if let number = screen.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? CGDirectDisplayID,
           let uuid = CGDisplayCreateUUIDFromDisplayID(number)?.takeRetainedValue() {
            displayUUID = CFUUIDCreateString(nil, uuid) as String
        } else {
            displayUUID = nil
        }
        check()
    }

    /// Checks now and again once the Space-switch animation has finished.
    private func checkSoon() {
        check()
        recheckTask?.cancel()
        recheckTask = Task { @MainActor [weak self] in
            try? await Task.sleep(for: .milliseconds(700))
            guard !Task.isCancelled else { return }
            self?.check()
        }
    }

    func check() {
        let value = currentSpaceIsFullscreen()
        guard value != isFullscreen else { return }
        isFullscreen = value
        onChange?(value)
    }

    private func currentSpaceIsFullscreen() -> Bool {
        guard let mainConnection = Self.mainConnection, let copySpaces = Self.copySpaces,
              let displays = copySpaces(mainConnection())?.takeRetainedValue() as? [[String: Any]] else { return false }
        for display in displays {
            let id = display["Display Identifier"] as? String
            // "Main" is used when "Displays have separate Spaces" is turned off.
            guard displayUUID == nil || id == displayUUID || id == "Main" else { continue }
            if let current = display["Current Space"] as? [String: Any], current["type"] as? Int == 4 {
                return true
            }
        }
        return false
    }
}
