import AppKit

/// Keeps desktop icons out from under the stats widget, the way macOS moves icons out of the way
/// of its own widgets.
///
/// Finder has no way to reserve part of the desktop, and it puts new files in the first free spot
/// from the top right, which is where the widget often sits. So when an icon ends up under the
/// widget (a new file, or the widget dragged over icons), GlassNotch asks Finder, through
/// AppleScript, to move it to the next free spot. macOS asks once for permission to control Finder.
///
/// Finder's `desktop position` is the centre of an icon, in points from the top left of the main
/// screen. Nothing happens when the desktop is sorted (Finder keeps sorted icons in order itself) or
/// grouped into stacks.
@MainActor
final class DesktopIconGuard {
    /// The widget's visible area in AppKit screen coordinates, or nil when it isn't showing.
    var widgetFrame: () -> CGRect? = { nil }

    private var folderSource: DispatchSourceFileSystemObject?
    private var pending: DispatchWorkItem?
    private var running = false
    /// Set once Finder refuses (permission declined), so GlassNotch stops asking until relaunched.
    private var refused = false
    private let queue = DispatchQueue(label: "GlassNotch.desktopIcons", qos: .utility)
    private static let trace = ProcessInfo.processInfo.environment["GLASSNOTCH_TRACE"] != nil

    func start() {
        guard !running else { return }
        running = true
        watchDesktopFolder()
        scheduleCheck(after: 1.5)
    }

    func stop() {
        running = false
        pending?.cancel()
        folderSource?.cancel()
        folderSource = nil
    }

    /// Checks again after things settle (Finder places a new icon a moment after the file appears;
    /// a drag sends many moves).
    func scheduleCheck(after delay: TimeInterval = 0.8) {
        guard running, !refused else { return }
        pending?.cancel()
        let work = DispatchWorkItem { [weak self] in
            MainActor.assumeIsolated { self?.check() }
        }
        pending = work
        DispatchQueue.main.asyncAfter(deadline: .now() + delay, execute: work)
    }

    // MARK: Private

    private func watchDesktopFolder() {
        let desktop = FileManager.default.urls(for: .desktopDirectory, in: .userDomainMask)[0]
        let descriptor = open(desktop.path, O_EVTONLY)
        guard descriptor >= 0 else { return }
        let source = DispatchSource.makeFileSystemObjectSource(fileDescriptor: descriptor, eventMask: .write, queue: .main)
        source.setEventHandler { [weak self] in
            MainActor.assumeIsolated { self?.scheduleCheck(after: 1.2) }
        }
        source.setCancelHandler { close(descriptor) }
        source.resume()
        folderSource = source
    }

    struct Layout {
        var iconSize: CGFloat
        var step: CGFloat
        var labelHeight: CGFloat
        /// "Snap to Grid" is on.
        var snaps = false
    }

    /// Finder's desktop view options, or nil when icons are sorted or stacked (not freely placed).
    private static func finderLayout() -> Layout? {
        let finder = UserDefaults(suiteName: "com.apple.finder")
        let view = finder?.dictionary(forKey: "DesktopViewSettings")
        if let groupBy = view?["GroupBy"] as? String, groupBy != "None" { return nil }
        let icons = view?["IconViewSettings"] as? [String: Any] ?? [:]
        let arrangeBy = icons["arrangeBy"] as? String ?? "none"
        guard arrangeBy == "none" || arrangeBy == "grid" else { return nil }
        let iconSize = CGFloat((icons["iconSize"] as? NSNumber)?.doubleValue ?? 64)
        let spacing = CGFloat((icons["gridSpacing"] as? NSNumber)?.doubleValue ?? 54)
        let textSize = CGFloat((icons["textSize"] as? NSNumber)?.doubleValue ?? 12)
        return Layout(iconSize: iconSize, step: max(iconSize + spacing, 80), labelHeight: textSize * 2.6 + 6,
                      snaps: arrangeBy == "grid")
    }

    private func check() {
        guard running, !refused, let frame = widgetFrame(), let layout = Self.finderLayout(),
              let primary = NSScreen.screens.first else { return }
        // Finder measures from the top left of the main screen, y going down.
        let height = primary.frame.maxY
        func finderRect(_ rect: CGRect) -> CGRect {
            CGRect(x: rect.minX, y: height - rect.maxY, width: rect.width, height: rect.height)
        }
        let widget = finderRect(frame)
        let screen = NSScreen.screens.first { $0.frame.intersects(frame) } ?? primary
        let area = finderRect(screen.visibleFrame)

        queue.async { [weak self] in
            let result = Self.runScript(Self.readScript, arguments: [])
            DispatchQueue.main.async {
                MainActor.assumeIsolated {
                    guard let self else { return }
                    switch result {
                    case .failure(let refusal):
                        self.giveUp(refusal)
                    case .success(let output):
                        let icons = Self.parse(output)
                        let moves = Self.plan(icons: icons, widget: widget, area: area, layout: layout)
                        if Self.trace {
                            NSLog("GlassNotch icons: \(icons.count) on desktop, widget \(widget), moving \(moves.count)")
                        }
                        guard !moves.isEmpty else { return }
                        let arguments = moves.flatMap { [$0.name, "\(Int($0.to.x))", "\(Int($0.to.y))"] }
                        self.queue.async {
                            if case .failure(let refusal) = Self.runScript(Self.moveScript, arguments: arguments) {
                                DispatchQueue.main.async { MainActor.assumeIsolated { self.giveUp(refusal) } }
                            }
                        }
                    }
                }
            }
        }
    }

    private func giveUp(_ refusal: ScriptRefusal) {
        guard refusal.notAllowed else { return }
        refused = true
        NSLog("GlassNotch: not allowed to move desktop icons (System Settings › Privacy & Security › Automation)")
    }

    // MARK: Planning

    struct Icon {
        let name: String
        let center: CGPoint
    }

    struct Move {
        let name: String
        let to: CGPoint
    }

    /// The area an icon and its label cover, around its centre.
    private nonisolated static func footprint(_ center: CGPoint, _ layout: Layout) -> CGRect {
        let width = min(layout.step, layout.iconSize + 36)
        return CGRect(x: center.x - width / 2, y: center.y - layout.iconSize / 2,
                      width: width, height: layout.iconSize + layout.labelHeight)
    }

    /// Moves every icon under the widget to the first free spot, filling columns from the top right
    /// like Finder does, and skipping the widget.
    nonisolated static func plan(icons: [Icon], widget: CGRect, area: CGRect, layout: Layout) -> [Move] {
        let covered = icons.filter { footprint($0.center, layout).intersects(widget) }
        guard !covered.isEmpty else { return [] }
        var taken = icons.filter { icon in !covered.contains { $0.name == icon.name } }.map(\.center)
        // With Snap to Grid, keep clear by half a step so snapping can't pull an icon back underneath.
        let padding = layout.snaps ? layout.step / 2 : 8
        let avoid = widget.insetBy(dx: -padding, dy: -padding)
        let margin: CGFloat = 12
        var moves: [Move] = []

        for icon in covered.sorted(by: { ($0.center.x, $0.center.y) > ($1.center.x, $1.center.y) }) {
            var spot: CGPoint?
            var x = area.maxX - margin - layout.step / 2
            search: while x - layout.step / 2 >= area.minX {
                var y = area.minY + margin + layout.iconSize / 2
                while y + layout.iconSize / 2 + layout.labelHeight <= area.maxY {
                    // Line up with a column of icons already there.
                    let column = taken.map(\.x).min { abs($0 - x) < abs($1 - x) }
                    let candidate = CGPoint(x: column.map { abs($0 - x) < layout.step / 2 ? $0 : x } ?? x, y: y)
                    let free = !footprint(candidate, layout).intersects(avoid) && !taken.contains {
                        abs($0.x - candidate.x) < layout.step * 0.75 && abs($0.y - candidate.y) < layout.step * 0.75
                    }
                    if free {
                        spot = candidate
                        break search
                    }
                    y += layout.step
                }
                x -= layout.step
            }
            guard let spot else { continue }
            taken.append(spot)
            moves.append(Move(name: icon.name, to: spot))
        }
        return moves
    }

    // MARK: AppleScript

    struct ScriptRefusal: Error {
        let message: String
        /// -1743: the user declined (or hasn't allowed) controlling Finder.
        var notAllowed: Bool { message.contains("-1743") || message.contains("Not authorized") }
    }

    /// Every desktop item as name, x, y; fields split by U+1F, items by U+1E.
    private nonisolated static let readScript = """
    set fieldSeparator to character id 31
    set itemSeparator to character id 30
    set output to ""
    tell application "Finder"
        repeat with anItem in (get every item of desktop)
            try
                set p to desktop position of anItem
                set output to output & (name of anItem) & fieldSeparator & (item 1 of p as text) & fieldSeparator & (item 2 of p as text) & itemSeparator
            end try
        end repeat
    end tell
    return output
    """

    /// Arguments: name, x, y for each icon to move.
    private nonisolated static let moveScript = """
    on run argv
        tell application "Finder"
            repeat with i from 1 to (count argv) by 3
                try
                    set desktop position of item (item i of argv) of desktop to {(item (i + 1) of argv) as integer, (item (i + 2) of argv) as integer}
                end try
            end repeat
        end tell
    end run
    """

    private nonisolated static func parse(_ output: String) -> [Icon] {
        output.split(separator: "\u{1E}").compactMap { record in
            let fields = record.split(separator: "\u{1F}", omittingEmptySubsequences: false)
            guard fields.count == 3, let x = Double(fields[1]), let y = Double(fields[2]) else { return nil }
            return Icon(name: String(fields[0]), center: CGPoint(x: x, y: y))
        }
    }

    /// Runs AppleScript with osascript (as a child process, so a slow Finder never blocks the app).
    private nonisolated static func runScript(_ source: String, arguments: [String]) -> Result<String, ScriptRefusal> {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/osascript")
        process.arguments = source.components(separatedBy: "\n").flatMap { ["-e", $0] } + arguments
        let output = Pipe()
        let errors = Pipe()
        process.standardOutput = output
        process.standardError = errors
        do {
            try process.run()
        } catch {
            return .failure(ScriptRefusal(message: error.localizedDescription))
        }
        let data = output.fileHandleForReading.readDataToEndOfFile()
        let errorData = errors.fileHandleForReading.readDataToEndOfFile()
        process.waitUntilExit()
        guard process.terminationStatus == 0 else {
            return .failure(ScriptRefusal(message: String(decoding: errorData, as: UTF8.self)))
        }
        return .success(String(decoding: data, as: UTF8.self).trimmingCharacters(in: .newlines))
    }
}
