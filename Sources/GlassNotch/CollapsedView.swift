import SwiftUI

/// The closed notch. With a live activity it grows black "wings" on either side of the
/// hardware notch.
struct CollapsedView: View {
    @ObservedObject var model: NotchModel
    @ObservedObject var nowPlaying: NowPlayingService
    @ObservedObject var agents: AgentMonitor
    @ObservedObject var calls: CallMonitor
    let namespace: Namespace.ID

    /// The session the wings describe: the first working one, else the one that just finished.
    private var activeSession: AgentSession? {
        agents.sessions.first(where: \.isWorking) ?? agents.completion
    }

    private var showDone: Bool { agents.workingCount == 0 && agents.completion != nil }

    var body: some View {
        HStack(spacing: 0) {
            leading
            Spacer(minLength: 0)
            trailing
        }
        .padding(.horizontal, 14)
        .frame(height: model.notchSize.height)
        .animation(.spring(response: 0.4, dampingFraction: 0.8), value: model.activity)
    }

    private var wingTransition: AnyTransition { .scale(scale: 0.4).combined(with: .opacity) }

    @ViewBuilder
    private var leading: some View {
        switch model.activity {
        case .none:
            EmptyView()
        case .music:
            ArtworkView(image: nowPlaying.artwork, size: 22, cornerRadius: 6)
                .matchedGeometryEffect(id: "artwork", in: namespace)
                .transition(wingTransition)
        case .agent, .musicAndAgent:
            AgentSprite(working: agents.workingCount > 0)
                .transition(wingTransition)
        case .call:
            ZStack(alignment: .bottomTrailing) {
                if let icon = calls.icon {
                    Image(nsImage: icon).resizable().frame(width: 20, height: 20)
                } else {
                    Image(systemName: "phone.fill").font(.system(size: 12, weight: .semibold)).foregroundStyle(.green)
                }
                Circle().fill(Color.green).frame(width: 6, height: 6).offset(x: 1, y: 1)
            }
            .transition(wingTransition)
        case .toast(let symbol, _, let success):
            Image(systemName: symbol)
                .font(.system(size: 13, weight: .semibold))
                .foregroundStyle(success ? Color.green : Color.orange)
                .symbolEffect(.bounce, value: symbol)
                .transition(wingTransition)
        }
    }

    @ViewBuilder
    private var trailing: some View {
        switch model.activity {
        case .none:
            EmptyView()
        case .music:
            EqualizerBars(color: nowPlaying.artworkColor.map { Color(nsColor: $0) } ?? .white,
                          playing: nowPlaying.info.playing)
                .frame(width: 22, height: 14)
                .transition(wingTransition)
        case .agent:
            Group {
                if showDone {
                    DoneBadge()
                } else {
                    PhaseRing(phase: activeSession?.phase ?? .thinking)
                }
            }
            .transition(wingTransition)
        case .musicAndAgent:
            Group {
                if showDone {
                    DoneBadge()
                } else {
                    EqualizerBars(color: nowPlaying.artworkColor.map { Color(nsColor: $0) } ?? .white,
                                  playing: nowPlaying.info.playing)
                        .frame(width: 22, height: 14)
                }
            }
            .transition(wingTransition)
        case .call:
            Group {
                if calls.isMicMuted {
                    Image(systemName: "mic.slash.fill")
                        .font(.system(size: 12, weight: .semibold))
                        .foregroundStyle(Color(red: 1, green: 0.38, blue: 0.36))
                } else if let call = calls.call {
                    CallTimer(start: call.startedAt)
                        .font(.system(size: 11.5, weight: .semibold).monospacedDigit())
                        .foregroundStyle(Color.green)
                }
            }
            .transition(wingTransition)
        case .toast(_, let text, let success):
            Text(text)
                .font(.system(size: 11.5, weight: .semibold))
                .foregroundStyle(success ? Color.green : Color.orange)
                .lineLimit(1)
                .fixedSize()
                .transition(wingTransition)
        }
    }
}

/// Four bars that bounce while audio plays.
struct EqualizerBars: View {
    var color: Color
    var playing: Bool

    private let speeds: [Double] = [5.1, 7.3, 4.2, 6.4]
    private let phases: [Double] = [0, 1.7, 3.1, 0.9]

    var body: some View {
        TimelineView(.animation(minimumInterval: 1.0 / 24, paused: !playing)) { context in
            let t = context.date.timeIntervalSinceReferenceDate
            HStack(alignment: .center, spacing: 2.5) {
                ForEach(0..<4, id: \.self) { i in
                    let wave = (sin(t * speeds[i] + phases[i]) + 0.5 * sin(t * speeds[i] * 1.7 + phases[i] * 2)) / 1.5
                    let height = playing ? 0.3 + 0.7 * (wave + 1) / 2 : 0.22
                    Capsule()
                        .fill(color.gradient)
                        .frame(width: 3, height: max(3, 14 * height))
                }
            }
            .frame(maxHeight: .infinity)
        }
    }
}
