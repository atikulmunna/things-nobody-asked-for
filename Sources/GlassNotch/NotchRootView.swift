import SwiftUI

struct NotchRootView: View {
    @ObservedObject var model: NotchModel
    @ObservedObject var nowPlaying: NowPlayingService
    @ObservedObject var clipboard: ClipboardMonitor
    @ObservedObject var agents: AgentMonitor
    @ObservedObject var screenshots: ScreenshotService
    @ObservedObject var usage: ClaudeUsageService
    @ObservedObject var calls: CallMonitor
    @ObservedObject var prefs: Prefs

    @Namespace private var namespace

    private var isExpanded: Bool { model.phase == .expanded }

    private var artworkTint: NSColor? {
        guard prefs.tintWithArtwork, nowPlaying.info.hasContent else { return nil }
        return nowPlaying.artworkColor
    }

    var body: some View {
        let shape = LiquidNotchShape(collapsedHeight: model.collapsedGlassHeight,
                                     expandedHeight: model.openReferenceHeight)
        let glassSize = model.glassSize
        let blackSize = model.blackSize
        let visibleSize = model.visibleSize

        ZStack(alignment: .top) {
            // 1. Liquid Glass. Hidden under the black notch until the pill opens, then it springs
            //    out from behind the notch.
            ZStack {
                GlassLayer(style: prefs.glassStyle, frost: prefs.frost, tint: artworkTint,
                           collapsedHeight: model.collapsedGlassHeight, expandedHeight: model.openReferenceHeight,
                           active: model.glassActive)
                scrim(in: shape)
                // Specular rim along the flares and sides, fading out before the bottom edge
                // (the lens already lights the bottom).
                LiquidNotchShape(collapsedHeight: model.collapsedGlassHeight,
                                 expandedHeight: model.openReferenceHeight, closed: false)
                    .stroke(LinearGradient(stops: [.init(color: .white.opacity(0.34), location: 0),
                                                   .init(color: .white.opacity(0.08), location: 0.55),
                                                   .init(color: .clear, location: 0.85)],
                                           startPoint: .top, endPoint: .bottom),
                            lineWidth: 1)
            }
            .frame(width: glassSize.width, height: glassSize.height)
            .opacity(model.glassActive ? 1 : 0)

            // 2. Black notch. While collapsed it is the whole shape (blending into the hardware
            //    notch); while open it shrinks back to just the hardware notch.
            NotchShape(topRadius: 6, bottomRadius: isExpanded ? 13 : model.bottomRadius)
                .fill(Color.black)
                .frame(width: blackSize.width, height: blackSize.height)

            // 3. Content.
            ZStack(alignment: .top) {
                if isExpanded {
                    ExpandedView(model: model, nowPlaying: nowPlaying, clipboard: clipboard, agents: agents,
                                 screenshots: screenshots, usage: usage, calls: calls, namespace: namespace)
                        .shadow(color: .black.opacity(prefs.glassStyle == .clear ? 0.55 : 0.3), radius: 3, y: 1)
                        .transition(.asymmetric(
                            insertion: .liquid.animation(.smooth(duration: 0.32).delay(0.07)),
                            removal: .liquid.animation(.smooth(duration: 0.14))))
                } else {
                    CollapsedView(model: model, nowPlaying: nowPlaying, agents: agents, calls: calls, namespace: namespace)
                        .transition(.asymmetric(
                            insertion: .liquid.animation(.smooth(duration: 0.3).delay(0.12)),
                            removal: .liquid.animation(.smooth(duration: 0.12))))
                }
            }
            .frame(width: visibleSize.width, height: visibleSize.height, alignment: .top)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
    }

    /// Darkening layer for legibility. Darkest at the top so the glass melts into the black
    /// hardware notch; picks up the album color on clear glass when tinting is on.
    @ViewBuilder
    private func scrim(in shape: LiquidNotchShape) -> some View {
        let dark = prefs.darkGlass
        let colors: [Color] = switch prefs.glassStyle {
        case .clear: [.black.opacity(dark ? 0.52 : 0.32), .black.opacity(dark ? 0.32 : 0.18)]
        case .waterdrop: [.black.opacity(dark ? 0.26 : 0.1), .black.opacity(dark ? 0.06 : 0)]
        case .frosted: [.black.opacity(dark ? 0.2 : 0), .black.opacity(0)]
        }
        ZStack {
            shape.fill(LinearGradient(colors: colors, startPoint: .top, endPoint: .bottom))
            if prefs.glassStyle == .clear, let tint = artworkTint {
                shape.fill(LinearGradient(colors: [Color(nsColor: tint).opacity(0.06), Color(nsColor: tint).opacity(0.18)],
                                          startPoint: .top, endPoint: .bottom))
            }
        }
    }
}

/// Content dissolves in and out with a blur, like it is condensing on the glass.
private struct LiquidModifier: ViewModifier {
    let active: Bool

    func body(content: Content) -> some View {
        content
            .blur(radius: active ? 10 : 0)
            .opacity(active ? 0 : 1)
            .scaleEffect(active ? 0.94 : 1, anchor: .top)
    }
}

extension AnyTransition {
    static var liquid: AnyTransition {
        .modifier(active: LiquidModifier(active: true), identity: LiquidModifier(active: false))
    }
}
