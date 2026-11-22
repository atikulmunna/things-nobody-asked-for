import AppKit
import QuickLookThumbnailing
import ScreenCaptureKit
import Vision

/// Recent screenshots, plus area capture and "capture text" (OCR to the clipboard).
@MainActor
final class ScreenshotService: ObservableObject {
    struct Shot: Identifiable, Equatable {
        let url: URL
        let date: Date
        var id: URL { url }
    }

    @Published private(set) var recent: [Shot] = []
    @Published private(set) var thumbnails: [URL: NSImage] = [:]

    /// Asks the notch to close before the capture crosshair appears.
    var requestCollapse: (() -> Void)?
    /// Shows a short confirmation in the collapsed notch.
    var onToast: ((_ symbol: String, _ text: String, _ success: Bool) -> Void)?

    /// Where macOS saves screenshots (System Settings or `screencapture` defaults), else the Desktop.
    var folder: URL {
        if let path = UserDefaults(suiteName: "com.apple.screencapture")?.string(forKey: "location"), !path.isEmpty {
            return URL(fileURLWithPath: (path as NSString).expandingTildeInPath, isDirectory: true)
        }
        return FileManager.default.urls(for: .desktopDirectory, in: .userDomainMask)[0]
    }

    func refresh() {
        let folder = self.folder
        DispatchQueue.global(qos: .utility).async { [weak self] in
            let shots = Self.findScreenshots(in: folder)
            DispatchQueue.main.async {
                MainActor.assumeIsolated {
                    guard let self else { return }
                    if shots != self.recent { self.recent = shots }
                    self.loadThumbnails()
                }
            }
        }
    }

    nonisolated private static func findScreenshots(in folder: URL) -> [Shot] {
        let files = (try? FileManager.default.contentsOfDirectory(
            at: folder, includingPropertiesForKeys: [.creationDateKey], options: [.skipsHiddenFiles])) ?? []
        let extensions: Set<String> = ["png", "jpg", "jpeg", "heic", "tiff"]
        let prefixes = ["Screenshot", "Screen Shot", "CleanShot"]
        let shots: [Shot] = files.compactMap { url in
            guard extensions.contains(url.pathExtension.lowercased()),
                  prefixes.contains(where: { url.lastPathComponent.hasPrefix($0) }),
                  let date = (try? url.resourceValues(forKeys: [.creationDateKey]))?.creationDate else { return nil }
            return Shot(url: url, date: date)
        }
        return Array(shots.sorted { $0.date > $1.date }.prefix(6))
    }

    private func loadThumbnails() {
        let wanted = Set(recent.map(\.url))
        thumbnails = thumbnails.filter { wanted.contains($0.key) }
        for shot in recent where thumbnails[shot.url] == nil {
            let request = QLThumbnailGenerator.Request(fileAt: shot.url, size: CGSize(width: 200, height: 130),
                                                       scale: 2, representationTypes: .thumbnail)
            QLThumbnailGenerator.shared.generateBestRepresentation(for: request) { [weak self] representation, _ in
                guard let image = representation?.nsImage else { return }
                DispatchQueue.main.async {
                    MainActor.assumeIsolated { self?.thumbnails[shot.url] = image }
                }
            }
        }
    }

    func open(_ shot: Shot) {
        NSWorkspace.shared.open(shot.url)
    }

    /// Puts the screenshot on the clipboard: image data for apps, and the file for Finder.
    func copy(_ shot: Shot) {
        let item = NSPasteboardItem()
        if let data = try? Data(contentsOf: shot.url) {
            if shot.url.pathExtension.lowercased() == "png" {
                item.setData(data, forType: .png)
            } else if let tiff = NSImage(data: data)?.tiffRepresentation {
                item.setData(tiff, forType: .tiff)
            }
        }
        item.setString(shot.url.absoluteString, forType: .fileURL)
        NSPasteboard.general.clearContents()
        NSPasteboard.general.writeObjects([item])
    }

    /// Moves the screenshot to the Trash (recoverable), removing it from the row right away.
    func moveToTrash(_ shot: Shot) {
        recent.removeAll { $0.url == shot.url }
        thumbnails.removeValue(forKey: shot.url)
        NSWorkspace.shared.recycle([shot.url]) { [weak self] _, _ in
            DispatchQueue.main.async {
                MainActor.assumeIsolated { self?.refresh() }
            }
        }
    }

    func openFolder() {
        NSWorkspace.shared.open(folder)
    }

    // MARK: Capture

    /// Interactive area capture, saved where macOS saves screenshots.
    func captureArea() {
        let formatter = DateFormatter()
        formatter.dateFormat = "yyyy-MM-dd 'at' HH.mm.ss"
        let url = folder.appendingPathComponent("Screenshot \(formatter.string(from: Date())).png")
        capture(to: url) { [weak self] captured in
            guard captured else { return }
            self?.onToast?("camera.fill", "Saved", true)
            self?.refresh()
        }
    }

    /// Interactive area capture whose text is recognized and copied to the clipboard.
    func captureText() {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("GlassNotch-\(UUID().uuidString).png")
        capture(to: url) { [weak self] captured in
            guard captured else { return }
            DispatchQueue.global(qos: .userInitiated).async {
                let text = Self.recognizeText(at: url)
                try? FileManager.default.removeItem(at: url)
                DispatchQueue.main.async {
                    MainActor.assumeIsolated {
                        guard let self else { return }
                        if let text, !text.isEmpty {
                            NSPasteboard.general.clearContents()
                            NSPasteboard.general.setString(text, forType: .string)
                            self.onToast?("doc.on.doc.fill", "Copied", true)
                        } else {
                            self.onToast?("text.magnifyingglass", "No text", false)
                        }
                    }
                }
            }
        }
    }

    private func capture(to url: URL, completion: @escaping @MainActor (Bool) -> Void) {
        guard ensureScreenRecordingAccess() else { return }
        requestCollapse?()
        // Let the notch close before the crosshair appears.
        Task { @MainActor in
            try? await Task.sleep(for: .milliseconds(250))
            let process = Process()
            process.executableURL = URL(fileURLWithPath: "/usr/sbin/screencapture")
            process.arguments = ["-i", "-x", url.path]
            process.terminationHandler = { _ in
                let captured = FileManager.default.fileExists(atPath: url.path)
                DispatchQueue.main.async {
                    MainActor.assumeIsolated { completion(captured) }
                }
            }
            do { try process.run() } catch { completion(false) }
        }
    }

    private static let askedForScreenRecordingKey = "screenRecordingAsked"
    private static let screenRecordingSettings =
        URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture")

    /// Without Screen Recording, a capture would contain only the wallpaper. macOS's prompt can't
    /// carry an app's reason, so explain first, then let macOS ask. macOS applies a newly granted
    /// permission only after the app restarts, so later attempts offer to reopen GlassNotch.
    private func ensureScreenRecordingAccess() -> Bool {
        if CGPreflightScreenCaptureAccess() { return true }
        let defaults = UserDefaults.standard
        let alert = NSAlert()
        NSApp.activate()

        if !defaults.bool(forKey: Self.askedForScreenRecordingKey) {
            alert.messageText = "Allow Screen Recording to capture"
            alert.informativeText = """
            GlassNotch uses it only to capture the area you select with Capture Area or Capture Text. \
            It never records your screen on its own, and captures stay on your Mac.

            macOS will ask next. After you turn GlassNotch on in System Settings, reopen GlassNotch \
            when macOS offers to, then capture again.
            """
            alert.addButton(withTitle: "Continue")
            alert.addButton(withTitle: "Not Now")
            guard alert.runModal() == .alertFirstButtonReturn else { return false }
            defaults.set(true, forKey: Self.askedForScreenRecordingKey)
            if CGRequestScreenCaptureAccess() { return true }
            Self.registerForScreenRecording()
            return false
        }

        // Make sure GlassNotch is listed in System Settings before sending people there.
        Self.registerForScreenRecording()

        alert.messageText = "Screen Recording is off for GlassNotch"
        alert.informativeText = """
        Turn on GlassNotch in System Settings › Privacy & Security › Screen & System Audio Recording. \
        If it isn't in the list, click + below the list and choose GlassNotch in Applications.

        Already on? macOS applies it only after GlassNotch reopens.
        """
        alert.addButton(withTitle: "Reopen GlassNotch")
        alert.addButton(withTitle: "Open System Settings")
        alert.addButton(withTitle: "Cancel")
        switch alert.runModal() {
        case .alertFirstButtonReturn:
            Self.relaunch()
        case .alertSecondButtonReturn:
            if let url = Self.screenRecordingSettings { NSWorkspace.shared.open(url) }
        default:
            break
        }
        return false
    }

    /// Asking ScreenCaptureKit for shareable content makes macOS add GlassNotch to the Screen
    /// Recording list (and show its prompt); the older request alone may not on recent macOS.
    private static func registerForScreenRecording() {
        Task.detached {
            _ = try? await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
        }
    }

    private static func relaunch() {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/bin/sh")
        process.arguments = ["-c", "sleep 0.6; /usr/bin/open \"$0\"", Bundle.main.bundlePath]
        try? process.run()
        NSApp.terminate(nil)
    }

    nonisolated private static func recognizeText(at url: URL) -> String? {
        let request = VNRecognizeTextRequest()
        request.recognitionLevel = .accurate
        request.usesLanguageCorrection = true
        let handler = VNImageRequestHandler(url: url)
        guard (try? handler.perform([request])) != nil else { return nil }
        let lines = (request.results ?? []).compactMap { $0.topCandidates(1).first?.string }
        return lines.joined(separator: "\n")
    }
}
