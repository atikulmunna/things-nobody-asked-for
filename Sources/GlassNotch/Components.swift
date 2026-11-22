import SwiftUI

struct ArtworkView: View {
    let image: NSImage?
    let size: CGFloat
    let cornerRadius: CGFloat

    var body: some View {
        let shape = RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
        ZStack {
            if let image {
                Image(nsImage: image)
                    .resizable()
                    .aspectRatio(contentMode: .fill)
            } else {
                shape.fill(Color.primary.opacity(0.1))
                Image(systemName: "music.note")
                    .font(.system(size: size * 0.38, weight: .medium))
                    .foregroundStyle(.secondary)
            }
        }
        .frame(width: size, height: size)
        .clipShape(shape)
    }
}

/// Round icon button with a soft hover and press response.
struct IconButton: View {
    let symbol: String
    var pointSize: CGFloat = 16
    var box: CGFloat = 32
    let action: () -> Void

    @State private var hovering = false

    var body: some View {
        Button(action: action) {
            Image(systemName: symbol)
                .font(.system(size: pointSize, weight: .semibold))
                .contentTransition(.symbolEffect(.replace))
                .frame(width: box, height: box)
                .contentShape(Circle())
        }
        .buttonStyle(PressableStyle(hovering: hovering))
        .trackHover($hovering)
    }
}

struct PressableStyle: ButtonStyle {
    var hovering: Bool

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .foregroundStyle(.primary)
            .background(
                Circle().fill(Color.primary.opacity(configuration.isPressed ? 0.2 : (hovering ? 0.12 : 0)))
            )
            .scaleEffect(configuration.isPressed ? 0.86 : 1)
            .animation(.spring(response: 0.25, dampingFraction: 0.6), value: configuration.isPressed)
            .animation(.easeOut(duration: 0.15), value: hovering)
    }
}

extension View {
    /// Liquid Glass in `shape` on macOS 26+, a frosted material platter before.
    @ViewBuilder
    func liquidGlass<S: Shape>(in shape: S, interactive: Bool = false, darken: Double = 0) -> some View {
        if #available(macOS 26, *), !GlassSupport.forceFallback {
            let base: Glass = darken > 0 ? .regular.tint(.black.opacity(darken)) : .regular
            self.glassEffect(base.interactive(interactive), in: shape)
        } else {
            self
                .background(shape.fill(Color.black.opacity(darken)))
                .background(shape.fill(.ultraThinMaterial))
                .overlay(shape.stroke(Color.white.opacity(0.14), lineWidth: 0.5))
        }
    }

    /// The prominent glass button style on macOS 26+, the standard prominent style before.
    @ViewBuilder
    func prominentGlassButton() -> some View {
        if #available(macOS 26, *) {
            self.buttonStyle(.glassProminent)
        } else {
            self.buttonStyle(.borderedProminent)
        }
    }

    /// Hover tracking that also catches a pointer that is already inside the view when it appears
    /// (or when a view is inserted under it): any movement counts, not just entering. Plain
    /// `onHover` only reacts to entering, so controls under a resting pointer stayed inactive.
    func trackHover(_ hovering: Binding<Bool>, animation: Animation? = nil) -> some View {
        onContinuousHover { phase in
            let inside: Bool
            switch phase {
            case .active: inside = true
            case .ended: inside = false
            }
            guard hovering.wrappedValue != inside else { return }
            if let animation {
                withAnimation(animation) { hovering.wrappedValue = inside }
            } else {
                hovering.wrappedValue = inside
            }
        }
    }
}

/// Groups glass shapes so they can blend and morph together (macOS 26+); a plain container before.
struct GlassGroup<Content: View>: View {
    var spacing: CGFloat
    @ViewBuilder var content: Content

    var body: some View {
        if #available(macOS 26, *), !GlassSupport.forceFallback {
            GlassEffectContainer(spacing: spacing) { content }
        } else {
            content
        }
    }
}

/// Debug-only backdrop (see GLASSNOTCH_BACKDROP).
struct DebugBackdrop: View {
    var body: some View {
        ZStack {
            LinearGradient(colors: [.pink, .orange, .yellow, .green, .teal, .blue, .purple],
                           startPoint: .leading, endPoint: .trailing)
            VStack(spacing: 6) {
                ForEach(0..<9, id: \.self) { row in
                    Text(String(repeating: "Liquid Glass refraction test  ", count: 6))
                        .font(.system(size: 18, weight: .heavy))
                        .foregroundStyle(row.isMultiple(of: 2) ? Color.white : Color.black)
                        .fixedSize()
                }
            }
        }
    }
}
