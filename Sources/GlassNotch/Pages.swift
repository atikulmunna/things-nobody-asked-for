import SwiftUI
import UniformTypeIdentifiers

// MARK: - Now playing

struct MediaPage: View {
    @ObservedObject var nowPlaying: NowPlayingService
    let namespace: Namespace.ID

    private let artworkSize: CGFloat = 52

    var body: some View {
        let info = nowPlaying.info
        HStack(spacing: 12) {
            Button(action: nowPlaying.openSourceApp) {
                ArtworkView(image: nowPlaying.artwork, size: artworkSize, cornerRadius: 13)
                    .matchedGeometryEffect(id: "artwork", in: namespace)
                    .overlay(alignment: .bottomTrailing) {
                        if let icon = nowPlaying.sourceIcon {
                            Image(nsImage: icon)
                                .resizable()
                                .frame(width: 18, height: 18)
                                .offset(x: 5, y: 5)
                        }
                    }
            }
            .buttonStyle(.plain)
            .help(nowPlaying.sourceName.map { "Open \($0)" } ?? "")

            VStack(alignment: .leading, spacing: 0) {
                Text(info.hasContent ? info.title : "Not playing")
                    .font(.system(size: 13, weight: .semibold))
                Text(subtitle(info))
                    .font(.system(size: 11.5))
                    .foregroundStyle(.secondary)
                    .padding(.top, 1)
                Spacer(minLength: 2)
                if info.hasContent && info.duration > 0 {
                    ProgressRow(nowPlaying: nowPlaying)
                }
            }
            .lineLimit(1)
            .frame(height: artworkSize)
        }
        .frame(maxHeight: .infinity)
    }

    private func subtitle(_ info: NowPlayingInfo) -> String {
        guard info.hasContent else { return "Play something to control it here" }
        return info.artist.isEmpty ? (nowPlaying.sourceName ?? " ") : info.artist
    }
}

struct ProgressRow: View {
    @ObservedObject var nowPlaying: NowPlayingService

    var body: some View {
        TimelineView(.periodic(from: .now, by: 0.5)) { context in
            let info = nowPlaying.info
            let elapsed = info.elapsed(at: context.date)
            HStack(spacing: 8) {
                Text(Self.format(elapsed))
                    .frame(minWidth: 26, alignment: .leading)
                ScrubBar(progress: info.duration > 0 ? elapsed / info.duration : 0,
                         tint: nowPlaying.artworkColor.map { Color(nsColor: $0) } ?? .white) { fraction in
                    nowPlaying.seek(to: fraction * info.duration)
                }
                Text("-" + Self.format(max(0, info.duration - elapsed)))
                    .frame(minWidth: 30, alignment: .trailing)
            }
            .font(.system(size: 9.5, weight: .medium).monospacedDigit())
            .foregroundStyle(.secondary)
        }
    }

    static func format(_ seconds: Double) -> String {
        let total = Int(seconds.rounded(.down))
        let h = total / 3600, m = (total % 3600) / 60, s = total % 60
        return h > 0 ? String(format: "%d:%02d:%02d", h, m, s) : String(format: "%d:%02d", m, s)
    }
}

struct ScrubBar: View {
    var progress: Double
    var tint: Color
    var onSeek: (Double) -> Void

    @State private var dragFraction: Double?
    @State private var hovering = false

    var body: some View {
        GeometryReader { geometry in
            let fraction = min(1, max(0, dragFraction ?? progress))
            let active = hovering || dragFraction != nil
            ZStack(alignment: .leading) {
                Capsule().fill(Color.primary.opacity(0.18))
                Capsule()
                    .fill(tint.gradient)
                    .frame(width: max(active ? 6 : 4, geometry.size.width * fraction))
                    .animation(dragFraction == nil ? .linear(duration: 0.5) : nil, value: fraction)
            }
            .frame(height: active ? 6 : 4)
            .frame(maxHeight: .infinity)
            .contentShape(Rectangle())
            .gesture(
                DragGesture(minimumDistance: 0)
                    .onChanged { value in
                        dragFraction = min(1, max(0, value.location.x / max(1, geometry.size.width)))
                    }
                    .onEnded { value in
                        onSeek(min(1, max(0, value.location.x / max(1, geometry.size.width))))
                        dragFraction = nil
                    }
            )
            .trackHover($hovering)
            .animation(.spring(response: 0.25, dampingFraction: 0.7), value: active)
        }
        .frame(height: 12)
    }
}

// MARK: - Call

/// Shown on the Now Playing page while a call is in progress.
struct CallPage: View {
    @ObservedObject var calls: CallMonitor
    let call: ActiveCall

    var body: some View {
        HStack(spacing: 12) {
            Button(action: calls.showApp) {
                Group {
                    if let icon = calls.icon {
                        Image(nsImage: icon).resizable()
                    } else {
                        Image(systemName: "phone.fill").font(.system(size: 22)).foregroundStyle(.green)
                    }
                }
                .frame(width: 48, height: 48)
            }
            .buttonStyle(.plain)
            .help("Show \(call.appName)")

            VStack(alignment: .leading, spacing: 3) {
                Text(call.appName)
                    .font(.system(size: 13, weight: .semibold))
                HStack(spacing: 4) {
                    Text("On a call ·")
                    CallTimer(start: call.startedAt)
                }
                .font(.system(size: 11.5).monospacedDigit())
                .foregroundStyle(.secondary)
                Label(calls.isMicMuted ? "Your microphone is muted" : "Microphone on",
                      systemImage: calls.isMicMuted ? "mic.slash.fill" : "mic.fill")
                    .font(.system(size: 10.5, weight: .medium))
                    .foregroundStyle(calls.isMicMuted ? Color(red: 1, green: 0.4, blue: 0.38) : Color.green)
                    .contentTransition(.symbolEffect(.replace))
            }
            Spacer(minLength: 0)
        }
        .frame(maxHeight: .infinity)
    }
}

/// "12:04", or "1h02" past an hour, counting up from `start`.
struct CallTimer: View {
    let start: Date

    var body: some View {
        TimelineView(.periodic(from: .now, by: 1)) { context in
            let seconds = max(0, Int(context.date.timeIntervalSince(start)))
            Text(seconds >= 3600
                 ? String(format: "%dh%02d", seconds / 3600, (seconds % 3600) / 60)
                 : String(format: "%d:%02d", seconds / 60, seconds % 60))
        }
    }
}

// MARK: - Clipboard

/// Recent clipboard items as a vertical list of Liquid Glass cards. Rows near the edges shrink,
/// blur and fade as they scroll, and new items spring in at the top.
struct ClipboardPage: View {
    @ObservedObject var clipboard: ClipboardMonitor

    var body: some View {
        if clipboard.items.isEmpty {
            EmptyHint(symbol: "doc.on.clipboard", text: "Copied text and images show up here")
        } else {
            ScrollView(.vertical, showsIndicators: false) {
                GlassGroup(spacing: 6) {
                    LazyVStack(spacing: 6) {
                        ForEach(clipboard.items) { item in
                            ClipRow(item: item, onCopy: { clipboard.copy(item) }, onRemove: { clipboard.remove(item) })
                                .transition(.asymmetric(insertion: .scale(scale: 0.85, anchor: .top).combined(with: .opacity),
                                                        removal: .scale(scale: 0.9).combined(with: .opacity)))
                                .scrollTransition(.interactive, axis: .vertical) { content, phase in
                                    content
                                        .scaleEffect(phase.isIdentity ? 1 : 0.93)
                                        .opacity(phase.isIdentity ? 1 : 0.35)
                                        .blur(radius: phase.isIdentity ? 0 : 1.5)
                                }
                        }
                    }
                    .padding(.vertical, 4)
                    .padding(.horizontal, 2)
                }
            }
            .scrollClipDisabled()
            .mask(LinearGradient(stops: [.init(color: .clear, location: 0), .init(color: .black, location: 0.08),
                                         .init(color: .black, location: 0.9), .init(color: .clear, location: 1)],
                                 startPoint: .top, endPoint: .bottom))
            .animation(.spring(response: 0.42, dampingFraction: 0.8), value: clipboard.items.map(\.id))
        }
    }
}

struct ClipRow: View {
    let item: ClipboardMonitor.Item
    let onCopy: () -> Void
    let onRemove: () -> Void

    @State private var hovering = false
    @State private var copied = false

    var body: some View {
        let shape = RoundedRectangle(cornerRadius: 11, style: .continuous)
        HStack(spacing: 9) {
            leading
            Text(preview)
                .font(.system(size: 11.5))
                .lineLimit(1)
                .truncationMode(.tail)
            Spacer(minLength: 6)
            trailing
        }
        .padding(.horizontal, 10)
        .frame(height: 30)
        .contentShape(shape)
        .liquidGlass(in: shape, interactive: true)
        .onTapGesture {
            onCopy()
            withAnimation(.spring(response: 0.3, dampingFraction: 0.7)) { copied = true }
            Task { @MainActor in
                try? await Task.sleep(for: .milliseconds(900))
                withAnimation(.easeOut(duration: 0.2)) { copied = false }
            }
        }
        .trackHover($hovering, animation: .easeOut(duration: 0.15))
        .help("Click to copy")
    }

    @ViewBuilder
    private var leading: some View {
        switch item.content {
        case .text:
            Image(systemName: "text.alignleft")
                .font(.system(size: 10, weight: .semibold))
                .foregroundStyle(.secondary)
                .frame(width: 20)
        case .image(let image):
            Image(nsImage: image)
                .resizable()
                .aspectRatio(contentMode: .fill)
                .frame(width: 20, height: 20)
                .clipShape(RoundedRectangle(cornerRadius: 5, style: .continuous))
        case .files(let urls):
            Image(nsImage: NSWorkspace.shared.icon(forFile: urls[0].path))
                .resizable()
                .frame(width: 20, height: 20)
        }
    }

    @ViewBuilder
    private var trailing: some View {
        if copied {
            Label("Copied", systemImage: "checkmark")
                .font(.system(size: 10.5, weight: .semibold))
                .foregroundStyle(AgentPhase.done.color)
                .transition(.scale.combined(with: .opacity))
        } else if hovering {
            Button(action: onRemove) {
                Image(systemName: "xmark")
                    .font(.system(size: 9, weight: .bold))
                    .foregroundStyle(.secondary)
                    .frame(width: 18, height: 18)
                    .contentShape(Circle())
            }
            .buttonStyle(.plain)
            .help("Remove")
            .transition(.scale.combined(with: .opacity))
        } else {
            TimelineView(.periodic(from: .now, by: 30)) { context in
                Text(Self.age(of: item.date, now: context.date))
            }
                .font(.system(size: 9.5).monospacedDigit())
                .foregroundStyle(.tertiary)
                .fixedSize()
        }
    }

    /// "now", "4m", "2h", "3d".
    static func age(of date: Date, now: Date) -> String {
        let seconds = max(0, now.timeIntervalSince(date))
        if seconds < 60 { return "now" }
        if seconds < 3600 { return "\(Int(seconds / 60))m" }
        if seconds < 86400 { return "\(Int(seconds / 3600))h" }
        return "\(Int(seconds / 86400))d"
    }

    private var preview: String {
        switch item.content {
        case .text(let text):
            text.trimmingCharacters(in: .whitespacesAndNewlines)
                .components(separatedBy: .newlines).first ?? ""
        case .image(let image):
            "Image · \(Int(image.size.width))×\(Int(image.size.height))"
        case .files(let urls):
            urls.count == 1 ? urls[0].lastPathComponent : "\(urls.count) files"
        }
    }
}

// MARK: - Agents

/// The selected Claude Code session (what it is doing, steps, files) and the plan usage limits.
struct AgentsPage: View {
    @ObservedObject var model: NotchModel
    @ObservedObject var agents: AgentMonitor
    @ObservedObject var usage: ClaudeUsageService

    private var session: AgentSession? {
        if let id = model.selectedAgentID, let match = agents.sessions.first(where: { $0.id == id }) { return match }
        return agents.sessions.first
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 7) {
            if let session {
                AgentCard(session: session)
                    .id(session.id)
                    .transition(.liquid)
            } else {
                HStack(spacing: 8) {
                    AgentSprite(working: false, pixel: 1.4)
                    Text("No Claude Code sessions in the last 20 minutes")
                        .font(.system(size: 11.5, weight: .medium))
                        .foregroundStyle(.secondary)
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
            UsageRow(usage: usage)
        }
        .frame(maxHeight: .infinity, alignment: .top)
        .animation(.spring(response: 0.38, dampingFraction: 0.8), value: session?.id)
    }
}

struct AgentCard: View {
    let session: AgentSession

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 7) {
                AgentSprite(working: session.isWorking, pixel: 1.3)
                Text(session.title)
                    .font(.system(size: 12.5, weight: .semibold))
                    .lineLimit(1)
                Spacer(minLength: 6)
                if let model = session.modelDisplayName {
                    Text(model)
                        .font(.system(size: 10, weight: .medium))
                        .foregroundStyle(.tertiary)
                        .fixedSize()
                }
                PhaseBadge(phase: session.phase)
                    .fixedSize()
            }
            .frame(height: 18)

            HStack(spacing: 7) {
                Image(systemName: session.phase.symbol)
                    .font(.system(size: 10, weight: .semibold))
                    .foregroundStyle(session.phase.color)
                    .frame(width: 14)
                Text(session.action)
                    .font(.system(size: 11).monospaced())
                    .lineLimit(1)
                    .truncationMode(.tail)
                Spacer(minLength: 6)
                Text("\(session.steps) steps · \(session.filesEdited) \(session.filesEdited == 1 ? "file" : "files")")
                    .font(.system(size: 10).monospacedDigit())
                    .foregroundStyle(.secondary)
                    .fixedSize()
            }
            .padding(.horizontal, 8)
            .frame(height: 22)
            .background(RoundedRectangle(cornerRadius: 8, style: .continuous).fill(Color.primary.opacity(0.07)))
        }
    }
}

/// 5-hour and weekly plan usage, or a prompt to connect them.
struct UsageRow: View {
    @ObservedObject var usage: ClaudeUsageService

    var body: some View {
        TimelineView(.periodic(from: .now, by: 30)) { context in
            if !usage.isConnected {
                Button(action: usage.connect) {
                    Label("Show your 5-hour and weekly usage limits", systemImage: "gauge.with.dots.needle.33percent")
                        .font(.system(size: 10.5, weight: .medium))
                        .foregroundStyle(.secondary)
                }
                .buttonStyle(.plain)
                .frame(maxWidth: .infinity, alignment: .leading)
            } else if usage.fiveHour == nil && usage.sevenDay == nil {
                Label("Usage limits appear after Claude's next reply", systemImage: "gauge.with.dots.needle.33percent")
                    .font(.system(size: 10.5, weight: .medium))
                    .foregroundStyle(.tertiary)
                    .frame(maxWidth: .infinity, alignment: .leading)
            } else {
                HStack(spacing: 14) {
                    UsageBar(label: "5h", fraction: usage.fraction(of: usage.fiveHour, now: context.date),
                             resetText: Self.shortReset(usage.fiveHour?.resetsAt, now: context.date))
                    UsageBar(label: "Week", fraction: usage.fraction(of: usage.sevenDay, now: context.date),
                             resetText: Self.dayReset(usage.sevenDay?.resetsAt, now: context.date))
                }
            }
        }
        .frame(height: 14)
    }

    /// "2h 14m"
    static func shortReset(_ date: Date?, now: Date) -> String? {
        guard let date, date > now else { return nil }
        let minutes = Int(date.timeIntervalSince(now) / 60)
        return minutes >= 60 ? "\(minutes / 60)h \(minutes % 60)m" : "\(minutes)m"
    }

    /// "Sat 9 AM"
    static func dayReset(_ date: Date?, now: Date) -> String? {
        guard let date, date > now else { return nil }
        return date.formatted(.dateTime.weekday(.abbreviated).hour())
    }
}

// MARK: - Screenshots

struct ScreenshotsPage: View {
    @ObservedObject var screenshots: ScreenshotService

    var body: some View {
        if screenshots.recent.isEmpty {
            EmptyHint(symbol: "camera.viewfinder", text: "Your recent screenshots show up here")
        } else {
            HStack(spacing: 8) {
                ForEach(screenshots.recent.prefix(4)) { shot in
                    ShotThumbnail(image: screenshots.thumbnails[shot.url], url: shot.url,
                                  onOpen: { screenshots.open(shot) },
                                  onCopy: { screenshots.copy(shot) },
                                  onDelete: { screenshots.moveToTrash(shot) })
                        .transition(.scale(scale: 0.6).combined(with: .opacity))
                }
                Spacer(minLength: 0)
            }
            .frame(maxHeight: .infinity)
            .animation(.spring(response: 0.38, dampingFraction: 0.78), value: screenshots.recent.map(\.url))
        }
    }
}

struct ShotThumbnail: View {
    let image: NSImage?
    let url: URL
    let onOpen: () -> Void
    let onCopy: () -> Void
    let onDelete: () -> Void

    @State private var hovering = false
    @State private var copied = false

    /// Debug aid (`GLASSNOTCH_SHOW_ACTIONS=1`): show the corner buttons without hovering.
    private static let alwaysShowActions = ProcessInfo.processInfo.environment["GLASSNOTCH_SHOW_ACTIONS"] != nil

    var body: some View {
        let shape = RoundedRectangle(cornerRadius: 10, style: .continuous)
        Button(action: onOpen) {
            ZStack {
                shape.fill(Color.primary.opacity(0.09))
                if let image {
                    Image(nsImage: image)
                        .resizable()
                        .aspectRatio(contentMode: .fill)
                }
            }
            .frame(width: 84, height: 56)
            .clipShape(shape)
            .overlay(shape.strokeBorder(Color.white.opacity(hovering ? 0.5 : 0.12), lineWidth: 1))
            .scaleEffect(hovering ? 1.04 : 1)
        }
        .buttonStyle(.plain)
        // Copy and delete: small glass buttons in the top-right corner, shown on hover.
        .overlay(alignment: .topTrailing) {
            if hovering || copied || Self.alwaysShowActions {
                HStack(spacing: 3) {
                    ThumbnailAction(symbol: copied ? "checkmark" : "doc.on.doc",
                                    tint: copied ? AgentPhase.done.color : .white,
                                    help: "Copy screenshot") {
                        onCopy()
                        withAnimation(.spring(response: 0.3, dampingFraction: 0.65)) { copied = true }
                        Task { @MainActor in
                            try? await Task.sleep(for: .milliseconds(1100))
                            withAnimation(.easeOut(duration: 0.2)) { copied = false }
                        }
                    }
                    ThumbnailAction(symbol: "trash", tint: .white, help: "Move to Trash", action: onDelete)
                }
                .padding(4)
                .transition(.scale(scale: 0.5, anchor: .topTrailing).combined(with: .opacity))
            }
        }
        .trackHover($hovering, animation: .spring(response: 0.25, dampingFraction: 0.7))
        .onDrag { NSItemProvider(contentsOf: url) ?? NSItemProvider() }
        .help("Click to open, drag to use it somewhere")
    }
}

/// Tiny round glass button used on screenshot thumbnails.
private struct ThumbnailAction: View {
    let symbol: String
    let tint: Color
    let help: String
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Image(systemName: symbol)
                .font(.system(size: 8.5, weight: .bold))
                .foregroundStyle(tint)
                .contentTransition(.symbolEffect(.replace))
                .frame(width: 19, height: 19)
                .contentShape(Circle())
        }
        .buttonStyle(.plain)
        .liquidGlass(in: Circle(), interactive: true, darken: 0.35)
        .help(help)
    }
}
