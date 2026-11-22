import SwiftUI

/// What a coding agent is doing right now.
enum AgentPhase: String, Equatable {
    case thinking, editing, running, reading, searching, done, idle

    var title: String {
        switch self {
        case .thinking: "Thinking"
        case .editing: "Editing"
        case .running: "Running"
        case .reading: "Reading"
        case .searching: "Searching"
        case .done: "Done"
        case .idle: "Idle"
        }
    }

    var symbol: String {
        switch self {
        case .thinking: "brain"
        case .editing: "pencil"
        case .running: "terminal.fill"
        case .reading: "doc.text.magnifyingglass"
        case .searching: "magnifyingglass"
        case .done: "checkmark.circle.fill"
        case .idle: "moon.zzz.fill"
        }
    }

    var color: Color {
        switch self {
        case .thinking: Color(red: 0.72, green: 0.56, blue: 1.0)
        case .editing: Color(red: 0.36, green: 0.86, blue: 0.56)
        case .running: Color(red: 1.0, green: 0.66, blue: 0.30)
        case .reading: Color(red: 0.40, green: 0.80, blue: 1.0)
        case .searching: Color(red: 0.52, green: 0.64, blue: 1.0)
        case .done: Color(red: 0.30, green: 0.90, blue: 0.62)
        case .idle: Color.gray
        }
    }

    var isWorking: Bool { self != .done && self != .idle }

    static func forTool(_ name: String) -> AgentPhase {
        switch name {
        case "Edit", "MultiEdit", "Write", "NotebookEdit": .editing
        case "Bash", "BashOutput", "KillShell", "KillBash": .running
        case "Read", "NotebookRead": .reading
        case "Grep", "Glob", "WebSearch", "WebFetch", "ToolSearch": .searching
        default: .thinking
        }
    }
}

struct AgentSession: Identifiable, Equatable {
    let id: String
    let title: String
    let project: String
    let model: String?
    let phase: AgentPhase
    let action: String
    let steps: Int
    let filesEdited: Int
    let updated: Date

    var isWorking: Bool { phase.isWorking }
}

/// Live Claude Code activity, read from the session transcripts in `~/.claude*/projects`.
///
/// Read-only: nothing is installed into Claude Code. A session is listed while its transcript
/// changed in the last 20 minutes. Transcripts are read incrementally, so large ones are parsed
/// once and then only their new lines.
@MainActor
final class AgentMonitor: ObservableObject {
    @Published private(set) var sessions: [AgentSession] = []
    /// Set for a few seconds when a session finishes, to play the completion animation.
    @Published private(set) var completion: AgentSession?

    var workingCount: Int { sessions.filter(\.isWorking).count }

    /// Refresh faster while the Agents page is on screen.
    var fastMode = false {
        didSet { if fastMode != oldValue { schedule(); if fastMode { refresh() } } }
    }

    private let scanner = TranscriptScanner()
    private let queue = DispatchQueue(label: "GlassNotch.Agents", qos: .utility)
    private var timer: Timer?
    private var scanning = false
    private var completionTask: Task<Void, Never>?

    func start() {
        schedule()
        refresh()
    }

    private func schedule() {
        timer?.invalidate()
        let timer = Timer(timeInterval: fastMode ? 1 : 2, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated { self?.refresh() }
        }
        RunLoop.main.add(timer, forMode: .common)
        self.timer = timer
    }

    func refresh() {
        guard !scanning else { return }
        scanning = true
        let scanner = self.scanner
        queue.async { [weak self] in
            let result = scanner.scan()
            DispatchQueue.main.async {
                MainActor.assumeIsolated { self?.apply(result) }
            }
        }
    }

    private func apply(_ result: [AgentSession]) {
        scanning = false
        let wasWorking = Set(sessions.filter(\.isWorking).map(\.id))
        if let finished = result.first(where: { $0.phase == .done && wasWorking.contains($0.id) }) {
            completion = finished
            completionTask?.cancel()
            completionTask = Task { @MainActor [weak self] in
                try? await Task.sleep(for: .seconds(4))
                guard !Task.isCancelled else { return }
                self?.completion = nil
            }
        }
        if result != sessions { sessions = result }
    }
}

/// Reads transcripts on a background queue, keeping per-file parse state between scans.
final class TranscriptScanner: @unchecked Sendable {
    private final class FileState {
        var offset: UInt64 = 0
        var partial = Data()
        var size = 0
        var modified = Date.distantPast
        var title: String?
        var cwd: String?
        var model: String?
        var phase: AgentPhase = .idle
        var action = ""
        var steps = 0
        var editedFiles = Set<String>()
        var sawEntry = false
    }

    private var states: [URL: FileState] = [:]
    private let window: TimeInterval = 20 * 60

    func scan() -> [AgentSession] {
        let fm = FileManager.default
        let now = Date()
        let home = fm.homeDirectoryForCurrentUser
        let roots = ((try? fm.contentsOfDirectory(at: home, includingPropertiesForKeys: nil)) ?? [])
            .filter { $0.lastPathComponent.hasPrefix(".claude") }
            .map { $0.appendingPathComponent("projects").resolvingSymlinksInPath() }

        // Newest transcript per session id (config folders can link to the same files).
        var newest: [String: (url: URL, modified: Date, size: Int)] = [:]
        let keys: Set<URLResourceKey> = [.contentModificationDateKey, .fileSizeKey]
        for root in roots {
            guard let projects = try? fm.contentsOfDirectory(at: root, includingPropertiesForKeys: nil) else { continue }
            for project in projects {
                guard let files = try? fm.contentsOfDirectory(at: project.resolvingSymlinksInPath(),
                                                              includingPropertiesForKeys: Array(keys)) else { continue }
                for file in files where file.pathExtension == "jsonl" {
                    guard let values = try? file.resourceValues(forKeys: keys),
                          let modified = values.contentModificationDate,
                          now.timeIntervalSince(modified) < window else { continue }
                    let id = file.deletingPathExtension().lastPathComponent
                    if let existing = newest[id], existing.modified >= modified { continue }
                    newest[id] = (file, modified, values.fileSize ?? 0)
                }
            }
        }

        var sessions: [AgentSession] = []
        var live = Set<URL>()
        for (id, entry) in newest {
            live.insert(entry.url)
            let state = states[entry.url] ?? FileState()
            states[entry.url] = state
            if state.size != entry.size || state.modified != entry.modified {
                read(entry.url, into: state)
                state.size = entry.size
                state.modified = entry.modified
            }
            guard state.sawEntry else { continue }
            sessions.append(session(id: id, state: state, now: now))
        }
        states = states.filter { live.contains($0.key) }

        return sessions.sorted { a, b in
            if a.isWorking != b.isWorking { return a.isWorking }
            return a.updated > b.updated
        }
    }

    private func session(id: String, state: FileState, now: Date) -> AgentSession {
        let project = state.cwd.map { ($0 as NSString).lastPathComponent } ?? "Claude Code"
        var phase = state.phase
        var action = state.action
        // A working session whose transcript has gone quiet for a long time is shown as idle.
        if phase.isWorking, now.timeIntervalSince(state.modified) > 10 * 60 {
            phase = .idle
            action = "Idle"
        }
        return AgentSession(id: id, title: state.title ?? project, project: project, model: state.model,
                            phase: phase, action: action, steps: state.steps,
                            filesEdited: state.editedFiles.count, updated: state.modified)
    }

    // MARK: Incremental reading

    private func read(_ url: URL, into state: FileState) {
        guard let handle = try? FileHandle(forReadingFrom: url) else { return }
        defer { try? handle.close() }
        guard let end = try? handle.seekToEnd() else { return }
        if end < state.offset {  // Rewritten file: start over.
            state.offset = 0
            state.partial = Data()
        }
        try? handle.seek(toOffset: state.offset)
        guard let data = try? handle.readToEnd(), !data.isEmpty else { return }
        state.offset += UInt64(data.count)

        var buffer = state.partial
        buffer.append(data)
        var lineStart = buffer.startIndex
        while let newline = buffer[lineStart...].firstIndex(of: 0x0A) {
            process(buffer[lineStart..<newline], state: state)
            lineStart = buffer.index(after: newline)
        }
        state.partial = Data(buffer[lineStart...])
    }

    private static let userMarker = Data("\"type\":\"user\"".utf8)
    private static let assistantMarker = Data("\"type\":\"assistant\"".utf8)
    private static let titleMarker = Data("\"type\":\"ai-title\"".utf8)

    private func process(_ line: Data.SubSequence, state: FileState) {
        let isTitle = line.range(of: Self.titleMarker) != nil
        guard isTitle || line.range(of: Self.userMarker) != nil || line.range(of: Self.assistantMarker) != nil,
              let object = (try? JSONSerialization.jsonObject(with: Data(line))) as? [String: Any],
              let type = object["type"] as? String else { return }

        if type == "ai-title" {
            state.title = object["aiTitle"] as? String
            return
        }
        guard type == "user" || type == "assistant",
              object["isSidechain"] as? Bool != true, object["isMeta"] as? Bool != true else { return }

        state.sawEntry = true
        if let cwd = object["cwd"] as? String { state.cwd = cwd }
        let message = object["message"] as? [String: Any] ?? [:]
        let blocks = message["content"] as? [[String: Any]] ?? []

        if type == "assistant" {
            if let model = message["model"] as? String, !model.hasPrefix("<") { state.model = model }
            let tools = blocks.filter { $0["type"] as? String == "tool_use" }
            for tool in tools {
                state.steps += 1
                let input = tool["input"] as? [String: Any] ?? [:]
                if AgentPhase.forTool(tool["name"] as? String ?? "") == .editing,
                   let path = (input["file_path"] ?? input["notebook_path"]) as? String {
                    state.editedFiles.insert(path)
                }
            }
            if let tool = tools.last {
                let name = tool["name"] as? String ?? "Tool"
                state.phase = AgentPhase.forTool(name)
                state.action = Self.describe(tool: name, input: tool["input"] as? [String: Any] ?? [:])
            } else if blocks.contains(where: { $0["type"] as? String == "text" })
                        || message["stop_reason"] as? String == "end_turn" {
                state.phase = .done
                state.action = "Waiting for you"
            } else {
                state.phase = .thinking
                state.action = "Thinking…"
            }
        } else {
            // A prompt or a tool result: the model is working on its next step.
            let text = (message["content"] as? String)
                ?? blocks.compactMap { $0["text"] as? String }.joined(separator: " ")
            if text.contains("[Request interrupted") {
                state.phase = .done
                state.action = "Interrupted"
            } else {
                state.phase = .thinking
                state.action = blocks.contains(where: { $0["type"] as? String == "tool_result" })
                    ? "Thinking…" : "Reading your prompt…"
            }
        }
    }

    private static func describe(tool name: String, input: [String: Any]) -> String {
        func file(_ key: String) -> String {
            ((input[key] as? String).map { ($0 as NSString).lastPathComponent }) ?? ""
        }
        switch name {
        case "Bash":
            let command = (input["command"] as? String ?? "").split(separator: "\n").first.map(String.init) ?? ""
            return "$ " + command
        case "Read": return "Reading " + file("file_path")
        case "Edit", "MultiEdit": return "Editing " + file("file_path")
        case "Write": return "Writing " + file("file_path")
        case "NotebookEdit": return "Editing " + file("notebook_path")
        case "Grep", "Glob": return "Searching " + (input["pattern"] as? String ?? "")
        case "WebFetch": return "Reading the web"
        case "WebSearch": return "Searching the web"
        case "Task", "Agent": return "Running a subagent"
        case "TodoWrite": return "Planning"
        default: return name
        }
    }
}

extension AgentSession {
    /// "claude-opus-5-5" → "Opus 5.5".
    var modelDisplayName: String? {
        guard let model else { return nil }
        let parts = model.replacingOccurrences(of: "claude-", with: "").split(separator: "-")
        guard let family = parts.first else { return model }
        let version = parts.dropFirst().prefix(while: { $0.allSatisfy(\.isNumber) && $0.count <= 2 }).joined(separator: ".")
        return family.capitalized + (version.isEmpty ? "" : " " + version)
    }
}
