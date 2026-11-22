import SwiftUI

/// Claude's coral, used for the agent character.
let agentCoral = Color(red: 0.87, green: 0.48, blue: 0.35)

/// A small pixel character that walks and blinks while the agent works.
struct AgentSprite: View {
    var working: Bool
    var color: Color = agentCoral
    var pixel: CGFloat = 1.6

    private static let body = [
        "..#######..",
        ".#########.",
        "##..###..##",
        "###########",
        ".#########.",
    ]
    private static let eyesClosed = "###########"
    private static let legs = [".##.....##.", "..##...##..", ".##.....##."]
    private static let legsResting = ".##.....##."

    var body: some View {
        TimelineView(.periodic(from: .now, by: 0.16)) { context in
            let tick = Int(context.date.timeIntervalSinceReferenceDate / 0.16)
            let blink = tick % 22 == 0
            let frame = working ? tick % 2 : 0
            let rows = Self.body.enumerated().map { index, row in index == 2 && blink ? Self.eyesClosed : row }
                + [working ? Self.legs[frame] : Self.legsResting]
            Canvas { context, _ in
                for (y, row) in rows.enumerated() {
                    for (x, cell) in row.enumerated() where cell == "#" {
                        let rect = CGRect(x: CGFloat(x) * pixel, y: CGFloat(y) * pixel, width: pixel, height: pixel)
                        context.fill(Path(rect.insetBy(dx: -0.05, dy: -0.05)), with: .color(color))
                    }
                }
            }
            .frame(width: 11 * pixel, height: CGFloat(rows.count) * pixel)
            .offset(y: working && frame == 1 ? -pixel * 0.6 : 0)
            .shadow(color: color.opacity(working ? 0.55 : 0.25), radius: working ? 3 : 1.5)
        }
    }
}

/// A ring that spins in the color of what the agent is doing, with the phase icon inside.
struct PhaseRing: View {
    var phase: AgentPhase
    var size: CGFloat = 16

    var body: some View {
        TimelineView(.animation(minimumInterval: 1.0 / 30)) { context in
            let period = 1.4
            let angle = context.date.timeIntervalSinceReferenceDate.truncatingRemainder(dividingBy: period) / period * 360
            ZStack {
                Circle().stroke(phase.color.opacity(0.22), lineWidth: 1.8)
                Circle()
                    .trim(from: 0, to: 0.34)
                    .stroke(AngularGradient(colors: [phase.color.opacity(0.05), phase.color], center: .center,
                                            startAngle: .degrees(0), endAngle: .degrees(122)),
                            style: StrokeStyle(lineWidth: 2, lineCap: .round))
                    .rotationEffect(.degrees(angle))
                Image(systemName: phase.symbol)
                    .font(.system(size: size * 0.4, weight: .bold))
                    .foregroundStyle(phase.color)
            }
            .frame(width: size, height: size)
            .shadow(color: phase.color.opacity(0.45), radius: 2.5)
        }
    }
}

/// Played when a session finishes: a green ring that pops in and draws a checkmark.
struct DoneBadge: View {
    var size: CGFloat = 16

    @State private var drawn: CGFloat = 0
    @State private var scale: CGFloat = 0.5

    private let green = AgentPhase.done.color

    var body: some View {
        ZStack {
            Circle().fill(green.opacity(0.2))
            Circle().stroke(green, lineWidth: 1.8)
            CheckShape()
                .trim(from: 0, to: drawn)
                .stroke(green, style: StrokeStyle(lineWidth: 1.9, lineCap: .round, lineJoin: .round))
                .padding(size * 0.28)
        }
        .frame(width: size, height: size)
        .scaleEffect(scale)
        .shadow(color: green.opacity(0.6), radius: 3)
        .onAppear {
            withAnimation(.spring(response: 0.35, dampingFraction: 0.55)) { scale = 1 }
            withAnimation(.easeOut(duration: 0.35).delay(0.15)) { drawn = 1 }
        }
    }
}

struct CheckShape: Shape {
    func path(in rect: CGRect) -> Path {
        var path = Path()
        path.move(to: CGPoint(x: rect.minX, y: rect.minY + rect.height * 0.55))
        path.addLine(to: CGPoint(x: rect.minX + rect.width * 0.38, y: rect.maxY - rect.height * 0.08))
        path.addLine(to: CGPoint(x: rect.maxX, y: rect.minY + rect.height * 0.1))
        return path
    }
}

/// "● Editing" capsule in the phase color.
struct PhaseBadge: View {
    var phase: AgentPhase

    var body: some View {
        Label(phase.title, systemImage: phase.symbol)
            .font(.system(size: 10.5, weight: .semibold))
            .foregroundStyle(phase.color)
            .padding(.horizontal, 7)
            .padding(.vertical, 2.5)
            .background(Capsule().fill(phase.color.opacity(0.16)))
            .symbolEffect(.pulse, options: .repeating, isActive: phase.isWorking)
    }
}

/// One usage window: label, bar, percentage and reset time.
struct UsageBar: View {
    var label: String
    var fraction: Double?
    var resetText: String?

    private var tint: Color {
        guard let fraction else { return .gray }
        if fraction >= 0.85 { return Color(red: 1, green: 0.38, blue: 0.36) }
        if fraction >= 0.6 { return Color(red: 1, green: 0.68, blue: 0.3) }
        return Color(red: 0.42, green: 0.86, blue: 0.62)
    }

    var body: some View {
        HStack(spacing: 6) {
            Text(label)
                .font(.system(size: 10, weight: .semibold))
                .foregroundStyle(.secondary)
                .fixedSize()
            GeometryReader { geometry in
                ZStack(alignment: .leading) {
                    Capsule().fill(Color.primary.opacity(0.14))
                    Capsule()
                        .fill(tint.gradient)
                        .frame(width: max(4, geometry.size.width * (fraction ?? 0)))
                        .animation(.spring(response: 0.6, dampingFraction: 0.8), value: fraction)
                }
            }
            .frame(height: 5)
            Text(fraction.map { "\(Int(($0 * 100).rounded()))%" } ?? "–")
                .font(.system(size: 10, weight: .semibold).monospacedDigit())
                .fixedSize()
            if let resetText {
                Text(resetText)
                    .font(.system(size: 9.5).monospacedDigit())
                    .foregroundStyle(.tertiary)
                    .fixedSize()
            }
        }
    }
}
