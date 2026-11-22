// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "GlassNotch",
    platforms: [.macOS(.v14)],
    targets: [
        .executableTarget(
            name: "GlassNotch",
            path: "Sources/GlassNotch",
            swiftSettings: [.swiftLanguageMode(.v5)],
            linkerSettings: [
                .linkedFramework("ServiceManagement"),
            ]
        )
    ]
)
