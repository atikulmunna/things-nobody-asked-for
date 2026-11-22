import AppKit

/// Claude plan usage limits (5-hour and weekly), as Claude Code reports them.
///
/// Claude Code passes a JSON snapshot, including `rate_limits`, to its status line command. When
/// connected, GlassNotch sets a small bridge script as that command: it saves the snapshot for
/// GlassNotch and then runs the previous status line, if any, so the terminal looks the same.
/// No credentials are read and nothing is sent anywhere.
@MainActor
final class ClaudeUsageService: ObservableObject {
    struct Window: Equatable {
        let usedPercentage: Double
        let resetsAt: Date?
    }

    @Published private(set) var fiveHour: Window?
    @Published private(set) var sevenDay: Window?
    @Published private(set) var updated: Date?
    @Published private(set) var isConnected = false

    private var lastModified: Date?
    private var timer: Timer?

    nonisolated static let supportDirectory = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        .appendingPathComponent("GlassNotch", isDirectory: true)

    private var limitsFile: URL {
        if let path = ProcessInfo.processInfo.environment["GLASSNOTCH_LIMITS_FILE"] {
            return URL(fileURLWithPath: path)
        }
        return Self.supportDirectory.appendingPathComponent("claude-status/limits.json")
    }

    func start() {
        isConnected = StatusLineBridge.isInstalled()
            || ProcessInfo.processInfo.environment["GLASSNOTCH_LIMITS_FILE"] != nil
        reload()
        let timer = Timer(timeInterval: 5, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated { self?.reload() }
        }
        RunLoop.main.add(timer, forMode: .common)
        self.timer = timer
    }

    private func reload() {
        let url = limitsFile
        guard let modified = (try? url.resourceValues(forKeys: [.contentModificationDateKey]))?.contentModificationDate
        else { return }
        guard modified != lastModified else { return }
        lastModified = modified
        guard let data = try? Data(contentsOf: url),
              let object = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
              let limits = object["rate_limits"] as? [String: Any] else { return }

        func window(_ key: String) -> Window? {
            guard let entry = limits[key] as? [String: Any],
                  let used = (entry["used_percentage"] as? NSNumber)?.doubleValue else { return nil }
            let resets = (entry["resets_at"] as? NSNumber).map { Date(timeIntervalSince1970: $0.doubleValue) }
            return Window(usedPercentage: used, resetsAt: resets)
        }
        // A window may be missing from a single snapshot; keep the last known value until it resets.
        if let value = window("five_hour") { fiveHour = value }
        if let value = window("seven_day") { sevenDay = value }
        updated = modified
    }

    /// Fraction used (0...1), treating a window whose reset time has passed as empty.
    func fraction(of window: Window?, now: Date = Date()) -> Double? {
        guard let window else { return nil }
        if let resets = window.resetsAt, resets <= now { return 0 }
        return min(1, max(0, window.usedPercentage / 100))
    }

    // MARK: Connect / disconnect

    func connect() {
        let alert = NSAlert()
        alert.messageText = "Show Claude usage limits in the notch?"
        alert.informativeText = """
        GlassNotch will set a small status line script in Claude Code's settings \
        (\(StatusLineBridge.configFolderNames().joined(separator: ", "))). Claude Code gives that script \
        your 5-hour and weekly usage; the script saves it for GlassNotch.

        Your terminal looks the same (an existing status line keeps working). A backup of each \
        settings file is saved next to it. Nothing is sent anywhere. You can disconnect from this menu.
        """
        alert.addButton(withTitle: "Connect")
        alert.addButton(withTitle: "Cancel")
        NSApp.activate()
        guard alert.runModal() == .alertFirstButtonReturn else { return }
        do {
            try StatusLineBridge.install()
            isConnected = true
        } catch {
            NSAlert(error: error).runModal()
        }
    }

    func disconnect() {
        do {
            try StatusLineBridge.uninstall()
            isConnected = false
        } catch {
            NSApp.activate()
            NSAlert(error: error).runModal()
        }
    }
}

/// Installs the status line bridge into each Claude Code config folder (`~/.claude`,
/// `~/.claude-<name>`, …), remembering any previous status line so it keeps running.
enum StatusLineBridge {
    static let scriptName = "statusline-bridge.sh"
    private static var directory: URL { ClaudeUsageService.supportDirectory }
    private static var scriptURL: URL { directory.appendingPathComponent(scriptName) }

    private static let script = """
    #!/bin/sh
    # GlassNotch status line bridge.
    # Claude Code pipes its status JSON here; GlassNotch reads the usage limits from it.
    # A status line you had before still runs, and its output is what Claude Code shows.
    dir="$HOME/Library/Application Support/GlassNotch"
    mkdir -p "$dir/claude-status"
    input=$(cat)
    case "$input" in
      *'"rate_limits"'*)
        tmp="$dir/claude-status/.limits.$$"
        printf '%s' "$input" > "$tmp" && mv -f "$tmp" "$dir/claude-status/limits.json" ;;
    esac
    previous="$dir/previous-statusline-$1.command"
    if [ -n "$1" ] && [ -s "$previous" ]; then
      printf '%s' "$input" | sh -c "$(cat "$previous")"
    fi
    exit 0
    """

    static func configFolders() -> [URL] {
        let fm = FileManager.default
        let home = fm.homeDirectoryForCurrentUser
        return ((try? fm.contentsOfDirectory(at: home, includingPropertiesForKeys: [.isDirectoryKey])) ?? [])
            .filter { url in
                let name = url.lastPathComponent
                guard name == ".claude" || name.hasPrefix(".claude-") else { return false }
                var isDirectory: ObjCBool = false
                guard fm.fileExists(atPath: url.path, isDirectory: &isDirectory), isDirectory.boolValue else { return false }
                return fm.fileExists(atPath: url.appendingPathComponent("settings.json").path)
                    || fm.fileExists(atPath: url.appendingPathComponent("projects").path)
            }
            .sorted { $0.lastPathComponent < $1.lastPathComponent }
    }

    static func configFolderNames() -> [String] {
        configFolders().map { "~/" + $0.lastPathComponent }
    }

    private static func command(for folder: URL) -> String {
        "sh \"$HOME/Library/Application Support/GlassNotch/\(scriptName)\" \(folder.lastPathComponent)"
    }

    private static func previousCommandURL(for folder: URL) -> URL {
        directory.appendingPathComponent("previous-statusline-\(folder.lastPathComponent).command")
    }

    private static func isBridge(_ statusLine: Any?) -> Bool {
        ((statusLine as? [String: Any])?["command"] as? String)?.contains(scriptName) == true
    }

    static func isInstalled() -> Bool {
        configFolders().contains { folder in
            isBridge(readSettings(folder.appendingPathComponent("settings.json"))?["statusLine"])
        }
    }

    static func install() throws {
        let fm = FileManager.default
        try fm.createDirectory(at: directory, withIntermediateDirectories: true)
        try script.write(to: scriptURL, atomically: true, encoding: .utf8)
        try fm.setAttributes([.posixPermissions: 0o755], ofItemAtPath: scriptURL.path)

        for folder in configFolders() {
            let settingsURL = folder.appendingPathComponent("settings.json")
            let exists = fm.fileExists(atPath: settingsURL.path)
            guard var settings = exists ? readSettings(settingsURL) : [:] else {
                // Never overwrite a settings file we cannot parse.
                throw NSError(domain: "GlassNotch", code: 1, userInfo: [
                    NSLocalizedDescriptionKey: "Could not read ~/\(folder.lastPathComponent)/settings.json, so it was left unchanged."])
            }
            if isBridge(settings["statusLine"]) { continue }

            if exists {
                let backup = folder.appendingPathComponent("settings.json.glassnotch-backup")
                if !fm.fileExists(atPath: backup.path) { try fm.copyItem(at: settingsURL, to: backup) }
            }
            var statusLine: [String: Any] = ["type": "command", "command": command(for: folder)]
            if let previous = settings["statusLine"] as? [String: Any] {
                if let previousCommand = previous["command"] as? String {
                    try previousCommand.write(to: previousCommandURL(for: folder), atomically: true, encoding: .utf8)
                }
                for key in ["padding", "refreshInterval", "hideVimModeIndicator"] where previous[key] != nil {
                    statusLine[key] = previous[key]
                }
            }
            settings["statusLine"] = statusLine
            try writeSettings(settings, to: settingsURL)
        }
    }

    static func uninstall() throws {
        let fm = FileManager.default
        for folder in configFolders() {
            let settingsURL = folder.appendingPathComponent("settings.json")
            guard var settings = readSettings(settingsURL), isBridge(settings["statusLine"]) else { continue }
            let previousURL = previousCommandURL(for: folder)
            if let previous = try? String(contentsOf: previousURL, encoding: .utf8), !previous.isEmpty {
                var statusLine = settings["statusLine"] as? [String: Any] ?? [:]
                statusLine["command"] = previous
                settings["statusLine"] = statusLine
                try? fm.removeItem(at: previousURL)
            } else {
                settings.removeValue(forKey: "statusLine")
            }
            try writeSettings(settings, to: settingsURL)
        }
    }

    private static func readSettings(_ url: URL) -> [String: Any]? {
        guard let data = try? Data(contentsOf: url) else { return nil }
        return (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
    }

    private static func writeSettings(_ settings: [String: Any], to url: URL) throws {
        let data = try JSONSerialization.data(withJSONObject: settings,
                                              options: [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes])
        try data.write(to: url, options: .atomic)
    }
}
