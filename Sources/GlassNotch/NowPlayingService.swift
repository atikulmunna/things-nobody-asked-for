import AppKit
import SwiftUI

struct NowPlayingInfo: Equatable {
    var title = ""
    var artist = ""
    var album = ""
    var bundleID: String?
    /// Seconds.
    var duration: Double = 0
    /// Elapsed seconds at `timestamp`.
    var elapsed: Double = 0
    var timestamp = Date()
    var rate: Double = 1
    var playing = false

    var hasContent: Bool { !title.isEmpty }

    func elapsed(at date: Date) -> Double {
        var value = elapsed
        if playing { value += date.timeIntervalSince(timestamp) * (rate > 0 ? rate : 1) }
        if duration > 0 { value = min(value, duration) }
        return max(0, value)
    }
}

/// Now-playing information for whatever app is playing (Music, Spotify, browsers, ...).
///
/// MediaRemote is restricted for third-party apps on recent macOS, so this uses the bundled
/// MediaRemoteAdapter (loaded by the system `perl`) and streams its JSON output.
@MainActor
final class NowPlayingService: ObservableObject {
    @Published private(set) var info = NowPlayingInfo()
    @Published private(set) var artwork: NSImage?
    @Published private(set) var artworkColor: NSColor?
    @Published private(set) var sourceIcon: NSImage?
    @Published private(set) var sourceName: String?
    /// True while something plays, and for a short grace period after it pauses.
    @Published private(set) var isActive = false
    @Published private(set) var available = true

    private let perl = URL(fileURLWithPath: "/usr/bin/perl")
    private let scriptURL: URL?
    private let frameworkURL: URL?
    private var process: Process?
    private let parser = AdapterParser()
    private let queue = DispatchQueue(label: "GlassNotch.NowPlaying")
    private var idleTask: Task<Void, Never>?
    private var restartDelay: TimeInterval = 1
    private var stopped = false

    init() {
        scriptURL = Bundle.main.resourceURL?.appendingPathComponent("mediaremote-adapter.pl")
        frameworkURL = Bundle.main.privateFrameworksURL?.appendingPathComponent("MediaRemoteAdapter.framework")
    }

    func start() {
        stopped = false
        guard let script = scriptURL, let framework = frameworkURL,
              FileManager.default.fileExists(atPath: script.path),
              FileManager.default.fileExists(atPath: framework.path) else {
            available = false
            return
        }
        launch(script: script, framework: framework)
    }

    func stop() {
        stopped = true
        process?.terminate()
        process = nil
    }

    private func launch(script: URL, framework: URL) {
        let process = Process()
        process.executableURL = perl
        process.arguments = [script.path, framework.path, "stream", "--micros", "--debounce=80"]
        let pipe = Pipe()
        process.standardOutput = pipe
        process.standardError = FileHandle.nullDevice

        let parser = self.parser
        let queue = self.queue
        queue.async { parser.reset() }

        pipe.fileHandleForReading.readabilityHandler = { [weak self] handle in
            let data = handle.availableData
            guard !data.isEmpty else {
                handle.readabilityHandler = nil
                return
            }
            queue.async {
                guard let update = parser.feed(data) else { return }
                DispatchQueue.main.async {
                    MainActor.assumeIsolated { self?.apply(update) }
                }
            }
        }
        process.terminationHandler = { [weak self] _ in
            DispatchQueue.main.async {
                MainActor.assumeIsolated { self?.processEnded() }
            }
        }

        do {
            try process.run()
            self.process = process
            available = true
        } catch {
            available = false
        }
    }

    private func processEnded() {
        process = nil
        guard !stopped, let script = scriptURL, let framework = frameworkURL else { return }
        let delay = restartDelay
        restartDelay = min(restartDelay * 2, 30)
        Task { @MainActor [weak self] in
            try? await Task.sleep(for: .seconds(delay))
            guard let self, !self.stopped, self.process == nil else { return }
            self.launch(script: script, framework: framework)
        }
    }

    private func apply(_ update: AdapterUpdate) {
        restartDelay = 1
        let previousBundle = info.bundleID
        info = update.info

        switch update.artwork {
        case .unchanged: break
        case .cleared:
            artwork = nil
            artworkColor = nil
        case .image(let image, let color):
            artwork = image
            artworkColor = color
        }
        if !info.hasContent {
            artwork = nil
            artworkColor = nil
        }
        if info.bundleID != previousBundle { updateSource(info.bundleID) }
        updateActivity()
    }

    private func updateSource(_ bundleID: String?) {
        guard let bundleID,
              let url = NSWorkspace.shared.urlForApplication(withBundleIdentifier: bundleID) else {
            sourceIcon = nil
            sourceName = nil
            return
        }
        sourceIcon = NSWorkspace.shared.icon(forFile: url.path)
        let bundle = Bundle(url: url)
        sourceName = (bundle?.object(forInfoDictionaryKey: "CFBundleDisplayName") as? String)
            ?? (bundle?.object(forInfoDictionaryKey: "CFBundleName") as? String)
            ?? url.deletingPathExtension().lastPathComponent
    }

    private func updateActivity() {
        if info.hasContent && info.playing {
            idleTask?.cancel()
            idleTask = nil
            if !isActive { isActive = true }
        } else if !info.hasContent {
            idleTask?.cancel()
            idleTask = nil
            if isActive { isActive = false }
        } else if isActive && idleTask == nil {
            idleTask = Task { @MainActor [weak self] in
                try? await Task.sleep(for: .seconds(8))
                guard let self, !Task.isCancelled else { return }
                self.idleTask = nil
                if !self.info.playing { self.isActive = false }
            }
        }
    }

    // MARK: - Commands

    func togglePlayPause() {
        let now = Date()
        info.elapsed = info.elapsed(at: now)
        info.timestamp = now
        info.playing.toggle()
        updateActivity()
        run("send", "2")
    }

    func nextTrack() { run("send", "4") }
    func previousTrack() { run("send", "5") }

    func seek(to seconds: Double) {
        info.elapsed = seconds
        info.timestamp = Date()
        run("seek", String(Int64(max(0, seconds) * 1_000_000)))
    }

    func openSourceApp() {
        guard let id = info.bundleID,
              let url = NSWorkspace.shared.urlForApplication(withBundleIdentifier: id) else { return }
        NSWorkspace.shared.openApplication(at: url, configuration: NSWorkspace.OpenConfiguration())
    }

    private func run(_ args: String...) {
        guard let script = scriptURL, let framework = frameworkURL else { return }
        let process = Process()
        process.executableURL = perl
        process.arguments = [script.path, framework.path] + args
        process.standardOutput = FileHandle.nullDevice
        process.standardError = FileHandle.nullDevice
        try? process.run()
    }
}

// MARK: - Stream parsing (runs on a background queue)

enum ArtworkUpdate {
    case unchanged
    case cleared
    case image(NSImage, NSColor?)
}

struct AdapterUpdate {
    var info: NowPlayingInfo
    var artwork: ArtworkUpdate
}

/// Splits the adapter's JSON-lines output, merges diffs into a full state and decodes artwork.
final class AdapterParser: @unchecked Sendable {
    private var buffer = Data()
    private var state: [String: Any] = [:]

    func reset() {
        buffer.removeAll()
        state.removeAll()
    }

    func feed(_ chunk: Data) -> AdapterUpdate? {
        buffer.append(chunk)
        var changed = false
        var artworkChanged = false

        while let newline = buffer.firstIndex(of: 0x0A) {
            let line = buffer.subdata(in: buffer.startIndex..<newline)
            buffer.removeSubrange(buffer.startIndex...newline)
            guard !line.isEmpty,
                  let object = (try? JSONSerialization.jsonObject(with: line)) as? [String: Any],
                  object["type"] as? String == "data",
                  let payload = object["payload"] as? [String: Any] else { continue }

            if object["diff"] as? Bool == true {
                for (key, value) in payload {
                    if value is NSNull { state.removeValue(forKey: key) } else { state[key] = value }
                }
                if payload["artworkData"] != nil { artworkChanged = true }
            } else {
                state = payload
                artworkChanged = true
            }
            changed = true
        }
        guard changed else { return nil }

        var update = AdapterUpdate(info: makeInfo(), artwork: .unchanged)
        if artworkChanged {
            if let base64 = state["artworkData"] as? String,
               let data = Data(base64Encoded: base64),
               let image = NSImage(data: data) {
                update.artwork = .image(image, ArtworkColor.prominent(in: image))
            } else {
                update.artwork = .cleared
            }
        }
        return update
    }

    private func makeInfo() -> NowPlayingInfo {
        func number(_ key: String) -> Double? { (state[key] as? NSNumber)?.doubleValue }
        var info = NowPlayingInfo()
        info.title = state["title"] as? String ?? ""
        info.artist = state["artist"] as? String ?? ""
        info.album = state["album"] as? String ?? ""
        info.bundleID = state["bundleIdentifier"] as? String
        info.duration = (number("durationMicros") ?? 0) / 1_000_000
        info.elapsed = (number("elapsedTimeMicros") ?? 0) / 1_000_000
        if let micros = number("timestampEpochMicros") {
            info.timestamp = Date(timeIntervalSince1970: micros / 1_000_000)
        }
        info.rate = number("playbackRate") ?? 1
        info.playing = state["playing"] as? Bool ?? false
        return info
    }
}

enum ArtworkColor {
    /// A vivid average color of the artwork, used to tint the glass.
    static func prominent(in image: NSImage) -> NSColor? {
        guard let cg = image.cgImage(forProposedRect: nil, context: nil, hints: nil),
              let space = CGColorSpace(name: CGColorSpace.sRGB),
              let context = CGContext(data: nil, width: 8, height: 8, bitsPerComponent: 8, bytesPerRow: 32,
                                      space: space, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue),
              let raw = context.data else { return nil }
        context.interpolationQuality = .medium
        context.draw(cg, in: CGRect(x: 0, y: 0, width: 8, height: 8))
        let pixels = raw.assumingMemoryBound(to: UInt8.self)
        var r = 0.0, g = 0.0, b = 0.0
        for i in 0..<64 {
            r += Double(pixels[i * 4])
            g += Double(pixels[i * 4 + 1])
            b += Double(pixels[i * 4 + 2])
        }
        let average = NSColor(srgbRed: r / 64 / 255, green: g / 64 / 255, blue: b / 64 / 255, alpha: 1)
        var hue: CGFloat = 0, saturation: CGFloat = 0, brightness: CGFloat = 0, alpha: CGFloat = 0
        average.getHue(&hue, saturation: &saturation, brightness: &brightness, alpha: &alpha)
        return NSColor(hue: hue,
                       saturation: min(1, saturation * 1.4),
                       brightness: min(0.95, max(0.55, brightness * 1.2)),
                       alpha: 1)
    }
}
