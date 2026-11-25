import AppKit
import Combine
import SwiftUI

/// System stats floating on the desktop, with no panel behind them: CPU and GPU temperature as rings
/// with Liquid Glass tracks, memory and free disk space as glass tablets.
///
/// It's a borderless window just above the desktop icons, so it sits on the wallpaper under every
/// window, on all Spaces, like the system's desktop widgets. (A WidgetKit widget would run
/// sandboxed, which can't read the SMC.) Drag it by a ring or tablet; right-click to hide it.
@MainActor
final class DesktopWidgetController: NSObject {
    private let prefs = Prefs.shared
    let stats = SystemStatsService()
    private var panel: DesktopWidgetPanel?
    /// Called when the widget is dragged or shown, so desktop icons can be moved out of its way.
    var onPlaced: (() -> Void)?

    /// The rings and tablets on screen (without the clear margin around them), or nil when hidden.
    var contentFrame: CGRect? {
        guard let panel, panel.isVisible else { return nil }
        return panel.frame.insetBy(dx: StatsWidgetView.margin, dy: StatsWidgetView.margin)
    }
    private var bag = Set<AnyCancellable>()
    private var observers: [NSObjectProtocol] = []

    /// The window's top left corner, so the spot survives size changes.
    private static let positionKey = "statsWidgetTopLeft"
    /// Distance from the screen's top left corner when first shown.
    private static let screenInset: CGFloat = 24

    func start() {
        prefs.$showStatsWidget.removeDuplicates()
            .receive(on: DispatchQueue.main)
            .sink { [weak self] visible in visible ? self?.show() : self?.hide() }
            .store(in: &bag)
        observers.append(NotificationCenter.default.addObserver(
            forName: NSApplication.didChangeScreenParametersNotification, object: nil, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated { self?.keepOnScreen() }
        })
    }

    func stop() {
        stats.stop()
    }

    private func show() {
        let panel = self.panel ?? makePanel()
        self.panel = panel
        stats.start()
        panel.orderFrontRegardless()
        onPlaced?()
    }

    private func hide() {
        panel?.orderOut(nil)
        stats.stop()
    }

    private func makePanel() -> DesktopWidgetPanel {
        let size = StatsWidgetView.windowSize
        let panel = DesktopWidgetPanel(size: size)
        // White on the wallpaper, whatever the system appearance (like desktop icon labels).
        panel.appearance = NSAppearance(named: .darkAqua)

        let container = WidgetContainerView(frame: CGRect(origin: .zero, size: size))
        let host = NSHostingView(rootView: StatsWidgetView(stats: stats, prefs: prefs))
        host.sizingOptions = []
        host.frame = container.bounds
        host.autoresizingMask = [.width, .height]
        container.addSubview(host)
        let menu = NSMenu()
        let hideItem = NSMenuItem(title: "Hide Widget", action: #selector(hideFromMenu), keyEquivalent: "")
        hideItem.target = self
        menu.addItem(hideItem)
        container.menu = menu
        panel.contentView = container

        panel.setFrameTopLeftPoint(savedTopLeft(for: size) ?? defaultTopLeft())
        observers.append(NotificationCenter.default.addObserver(
            forName: NSWindow.didMoveNotification, object: panel, queue: .main) { [weak self, weak panel] _ in
            MainActor.assumeIsolated {
                guard let frame = panel?.frame else { return }
                UserDefaults.standard.set(NSStringFromPoint(CGPoint(x: frame.minX, y: frame.maxY)),
                                          forKey: DesktopWidgetController.positionKey)
                self?.onPlaced?()
            }
        })
        return panel
    }

    @objc private func hideFromMenu() {
        prefs.showStatsWidget = false
    }

    /// Where the user last dragged it, if that's still on a connected screen.
    private func savedTopLeft(for size: CGSize) -> CGPoint? {
        guard let text = UserDefaults.standard.string(forKey: Self.positionKey) else { return nil }
        let topLeft = NSPointFromString(text)
        let frame = CGRect(x: topLeft.x, y: topLeft.y - size.height, width: size.width, height: size.height)
        return Self.isOnScreen(frame) ? topLeft : nil
    }

    /// Top left of the main screen, where macOS puts new desktop widgets.
    private func defaultTopLeft() -> CGPoint {
        let visible = NSScreen.screens.first?.visibleFrame ?? .zero
        let margin = StatsWidgetView.margin
        return CGPoint(x: visible.minX + Self.screenInset - margin, y: visible.maxY - Self.screenInset + margin)
    }

    private func keepOnScreen() {
        guard let panel, !Self.isOnScreen(panel.frame) else { return }
        panel.setFrameTopLeftPoint(defaultTopLeft())
    }

    private static func isOnScreen(_ frame: CGRect) -> Bool {
        let center = CGPoint(x: frame.midX, y: frame.midY)
        return NSScreen.screens.contains { $0.frame.contains(center) }
    }
}

/// Borderless panel on the desktop: above the wallpaper and icons, under every window, on all Spaces.
final class DesktopWidgetPanel: NSPanel {
    init(size: CGSize) {
        super.init(contentRect: CGRect(origin: .zero, size: size),
                   styleMask: [.borderless, .nonactivatingPanel],
                   backing: .buffered,
                   defer: false)
        level = NSWindow.Level(rawValue: Int(CGWindowLevelForKey(.desktopIconWindow)) + 1)
        collectionBehavior = [.canJoinAllSpaces, .stationary, .ignoresCycle]
        isOpaque = false
        backgroundColor = .clear
        hasShadow = false
        hidesOnDeactivate = false
        isReleasedWhenClosed = false
        animationBehavior = .none
        isMovable = true
    }

    override var canBecomeKey: Bool { false }
    override var canBecomeMain: Bool { false }
}

/// Takes every click on a ring or tablet so the widget drags from it. Clicks on clear pixels
/// (between and around them) go through to the desktop.
final class WidgetContainerView: NSView {
    override func hitTest(_ point: NSPoint) -> NSView? {
        let local = convert(point, from: superview)
        let content = bounds.insetBy(dx: StatsWidgetView.margin, dy: StatsWidgetView.margin)
        return content.contains(local) ? self : nil
    }

    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }

    override func mouseDown(with event: NSEvent) {
        if event.modifierFlags.contains(.control) {
            super.mouseDown(with: event)
        } else {
            window?.performDrag(with: event)
        }
    }
}

struct StatsWidgetView: View {
    @ObservedObject var stats: SystemStatsService
    /// The Glass menu's look applies here too.
    @ObservedObject var prefs: Prefs

    static let spacing: CGFloat = 14
    /// Two rings, then the two tablets stacked.
    static let contentSize = CGSize(width: StatGauge.diameter * 2 + spacing * 2 + StatTablet.size.width,
                                    height: StatGauge.diameter)
    /// Room around the rings for their shadows.
    static let margin: CGFloat = 12
    static var windowSize: CGSize {
        CGSize(width: contentSize.width + 2 * margin, height: contentSize.height + 2 * margin)
    }

    /// Temperatures fill the ring from 20 °C to 105 °C (Apple silicon throttles around 105).
    private static let heatRange = 20.0...105.0

    var body: some View {
        HStack(spacing: Self.spacing) {
            temperatureGauge("CPU", stats.cpu)
            if stats.hasGPU { temperatureGauge("GPU", stats.gpu) }
            VStack(spacing: StatGauge.diameter - 2 * StatTablet.size.height) {
                memoryTablet
                diskTablet
            }
        }
        .frame(width: Self.contentSize.width, height: Self.contentSize.height, alignment: .leading)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .environment(\.glassLook, GlassLook(style: prefs.glassStyle, frost: prefs.frost))
    }

    private func temperatureGauge(_ label: String, _ celsius: Double?) -> some View {
        let range = Self.heatRange
        let fraction = celsius.map { ($0 - range.lowerBound) / (range.upperBound - range.lowerBound) } ?? 0
        let shown = celsius.map { Self.usesFahrenheit ? $0 * 9 / 5 + 32 : $0 }
        return StatGauge(label: label, fraction: fraction,
                         color: StatGauge.scale(((celsius ?? 0) - 45) / 55),
                         number: shown.map { "\(Int($0.rounded()))°" }, value: shown ?? 0)
    }

    /// Fills with Memory Used, as in Activity Monitor.
    private var memoryTablet: some View {
        let percent = stats.memory.map { "\(Int(($0.fraction * 100).rounded()))" }
        let value = percent.map { Text("\($0)\(Text("%").font(StatTablet.unitFont))") } ?? Text("–")
        return StatTablet(label: "RAM", fraction: stats.memory?.fraction ?? 0, value: value, valueID: percent ?? "")
    }

    /// Fills with used space and reads used / total ("250 GB / 494 GB").
    private var diskTablet: some View {
        let disk = stats.disk
        let value = disk.map { disk in
            Text("\(Self.size(disk.used)) \(Text("/").foregroundStyle(.white.opacity(0.6))) \(Self.size(disk.total))")
        } ?? Text("–")
        return StatTablet(label: "DISK", fraction: disk?.usedFraction ?? 0, value: value,
                          valueID: disk.map { "\($0.used / 1_000_000_000)/\($0.total)" } ?? "")
    }

    /// "245 GB", "1.2 TB", "9.5 GB" (decimal units, like Finder), with a smaller unit.
    private static func size(_ bytes: Int64) -> Text {
        let gb = Double(bytes) / 1e9
        let (number, unit) = gb >= 1000 ? (String(format: "%.1f", gb / 1000), "TB")
            : gb >= 10 ? ("\(Int(gb.rounded()))", "GB")
            : (String(format: "%.1f", gb), "GB")
        return Text("\(number)\(Text(" " + unit).font(StatTablet.unitFont))")
    }

    /// Follows System Settings › General › Language & Region › Temperature.
    private static var usesFahrenheit: Bool {
        UserDefaults.standard.string(forKey: "AppleTemperatureUnit") == "Fahrenheit"
    }
}

/// An open ring, like the system's circular gauges, with the temperature in the middle and a label
/// in the gap. The track is a glass tube (a pure lens in Waterdrop); everything else floats straight
/// on the wallpaper.
struct StatGauge: View {
    let label: String
    let fraction: Double
    let color: Color
    /// nil before the first reading.
    let number: String?
    /// Drives the rolling-digits animation.
    let value: Double

    static let diameter: CGFloat = 52
    private static let lineWidth: CGFloat = 6
    /// Keeps the white text and the arc readable on light wallpapers too.
    private static let shadow = Color.black.opacity(0.5)

    var body: some View {
        let fraction = min(1, max(0, fraction))
        ZStack {
            // Nearly invisible, but not fully clear, so a click inside the ring drags the widget
            // instead of falling through to the desktop.
            Circle().fill(Color.white.opacity(0.012))
            GaugeArc(fraction: fraction)
                .stroke(color, style: StrokeStyle(lineWidth: Self.lineWidth - 2, lineCap: .round))
                .shadow(color: Self.shadow, radius: 2, y: 1)
            Group {
                Text(number ?? "–")
                    .font(.system(size: 15.5, weight: .semibold, design: .rounded))
                    .monospacedDigit()
                    .contentTransition(.numericText(value: value))
                    .foregroundStyle(.white)
                    .offset(y: -1)
                Text(label)
                    .font(.system(size: 7.5, weight: .bold, design: .rounded))
                    .foregroundStyle(.white.opacity(0.8))
                    .frame(maxHeight: .infinity, alignment: .bottom)
                    .offset(y: 2)
            }
            .shadow(color: Self.shadow, radius: 3, y: 1)
        }
        .padding(Self.lineWidth / 2)
        .background {
            ShapedGlass(shape: GaugeTrack(lineWidth: Self.lineWidth, inset: Self.lineWidth / 2), frostInset: nil)
        }
        .frame(width: Self.diameter, height: Self.diameter)
        .animation(.smooth(duration: 0.8), value: fraction)
    }

    /// Green at 0, through yellow and orange, to red at 1.
    static func scale(_ t: Double) -> Color {
        let t = min(1, max(0, t))
        return Color(hue: 0.36 * (1 - t), saturation: 0.72, brightness: 1)
    }
}

/// A glass capsule with a fill, a label on the left and the value on the right. In Waterdrop the
/// rim is a lens and the middle is frosted, like the notch.
///
/// The fill is a gradient laid across the whole tablet (green to half full, then yellow, red at
/// the end) and revealed up to the current level, so it warms toward red as it nears 100%.
struct StatTablet: View {
    let label: String
    let fraction: Double
    let value: Text
    /// Changes whenever `value` does; drives the rolling-digits animation.
    let valueID: String

    static let size = CGSize(width: 144, height: 23)
    static let unitFont = Font.system(size: 8.5, weight: .semibold, design: .rounded)
    private static let fillInset: CGFloat = 2.5
    private static let frostInset: CGFloat = 3
    private static let shadow = Color.black.opacity(0.5)
    private static let gradient = Gradient(stops: [
        .init(color: StatGauge.scale(0), location: 0),
        .init(color: StatGauge.scale(0), location: 0.5),
        .init(color: StatGauge.scale(0.5), location: 0.75),
        .init(color: StatGauge.scale(1), location: 1),
    ])

    var body: some View {
        let fraction = min(1, max(0, fraction))
        ZStack(alignment: .leading) {
            ShapedGlass(shape: Capsule(), frostInset: Self.frostInset)
            GeometryReader { geometry in
                let width = fraction > 0 ? max(geometry.size.height, geometry.size.width * fraction) : 0
                LinearGradient(gradient: Self.gradient, startPoint: .leading, endPoint: .trailing)
                    .opacity(0.72)
                    .mask(alignment: .leading) {
                        Capsule().frame(width: width)
                    }
            }
            .padding(Self.fillInset)
            HStack(spacing: 5) {
                Text(label)
                    .font(.system(size: 7.5, weight: .bold, design: .rounded))
                    .foregroundStyle(.white.opacity(0.85))
                Spacer(minLength: 0)
                value
                    .font(.system(size: 11, weight: .semibold, design: .rounded))
                    .monospacedDigit()
                    .lineLimit(1)
                    .contentTransition(.numericText())
                    .foregroundStyle(.white)
            }
            .padding(.horizontal, 9)
            .shadow(color: Self.shadow, radius: 2, y: 1)
        }
        .frame(width: Self.size.width, height: Self.size.height)
        .animation(.smooth(duration: 0.8), value: fraction)
        .animation(.smooth(duration: 0.4), value: valueID)
    }
}

/// 270° of a circle, open at the bottom, drawn clockwise from the lower left.
private struct GaugeArc: Shape {
    var fraction: Double

    var animatableData: Double {
        get { fraction }
        set { fraction = newValue }
    }

    func path(in rect: CGRect) -> Path {
        var path = Path()
        guard fraction > 0 else { return path }
        path.addArc(center: CGPoint(x: rect.midX, y: rect.midY), radius: min(rect.width, rect.height) / 2,
                    startAngle: .degrees(135), endAngle: .degrees(135 + 270 * fraction), clockwise: false)
        return path
    }
}

/// The full arc as a filled outline, so glass can take its shape. The arc's center line runs
/// `inset` inside the rect, so a stroke of `lineWidth` up to twice that stays within it.
private struct GaugeTrack: Shape {
    var lineWidth: CGFloat
    var inset: CGFloat = 0

    func path(in rect: CGRect) -> Path {
        GaugeArc(fraction: 1).path(in: rect.insetBy(dx: inset, dy: inset))
            .strokedPath(StrokeStyle(lineWidth: lineWidth, lineCap: .round))
    }
}
