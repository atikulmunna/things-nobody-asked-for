import AppKit
import IOKit

/// CPU and GPU temperatures, memory and disk space, sampled while something shows them:
/// temperatures and memory every two seconds, the disk every 30.
@MainActor
final class SystemStatsService: ObservableObject {
    /// Average die temperatures in °C; nil until the first reading, or when the Mac has no such sensors.
    @Published private(set) var cpu: Double?
    @Published private(set) var gpu: Double?
    /// False when the Mac has no GPU sensors the app knows; the widget then leaves the GPU out.
    @Published private(set) var hasGPU = true
    @Published private(set) var memory: MemoryStats?
    @Published private(set) var disk: DiskStats?

    private let sampler = StatsSampler()
    private var timer: Timer?
    private var running = false
    private var ticks = 0
    private var observers: [NSObjectProtocol] = []

    private static let interval: TimeInterval = 2
    private static let diskEvery = 15
    /// Weight of each new temperature reading, to smooth out the sensors' jitter.
    private static let smoothing = 0.4

    init() {
        // No point reading sensors while the displays are off.
        let center = NSWorkspace.shared.notificationCenter
        observers.append(center.addObserver(forName: NSWorkspace.screensDidSleepNotification, object: nil,
                                            queue: .main) { [weak self] _ in
            MainActor.assumeIsolated { self?.pauseTimer() }
        })
        observers.append(center.addObserver(forName: NSWorkspace.screensDidWakeNotification, object: nil,
                                            queue: .main) { [weak self] _ in
            MainActor.assumeIsolated { self?.resumeTimer() }
        })
    }

    func start() {
        running = true
        resumeTimer()
    }

    func stop() {
        running = false
        pauseTimer()
    }

    /// Reads the disk again now (after freeing space, say) instead of at the next 30-second mark.
    func refreshDisk() {
        ticks = 0
        sample()
    }

    private func resumeTimer() {
        guard running, timer == nil else { return }
        ticks = 0
        sample()
        let timer = Timer(timeInterval: Self.interval, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated { self?.sample() }
        }
        timer.tolerance = 0.5
        RunLoop.main.add(timer, forMode: .common)
        self.timer = timer
    }

    private func pauseTimer() {
        timer?.invalidate()
        timer = nil
    }

    private func sample() {
        let includeDisk = ticks % Self.diskEvery == 0
        ticks += 1
        sampler.read(includeDisk: includeDisk) { [weak self] reading in self?.apply(reading) }
    }

    private func apply(_ reading: StatsSampler.Reading) {
        cpu = Self.smooth(cpu, reading.cpu)
        gpu = Self.smooth(gpu, reading.gpu)
        if hasGPU != reading.hasGPU { hasGPU = reading.hasGPU }
        if let memory = reading.memory, memory != self.memory { self.memory = memory }
        if let disk = reading.disk, disk != self.disk { self.disk = disk }
    }

    private static func smooth(_ old: Double?, _ new: Double?) -> Double? {
        guard let new else { return old }
        guard let old else { return new }
        return old + (new - old) * smoothing
    }
}

/// Keeps the SMC connection on a background queue.
private final class StatsSampler: @unchecked Sendable {
    struct Reading: Sendable {
        var cpu: Double?
        var gpu: Double?
        var hasGPU: Bool
        var memory: MemoryStats?
        var disk: DiskStats?
    }

    private let queue = DispatchQueue(label: "GlassNotch.stats", qos: .utility)
    private var reader: SMCReader?
    private var opened = false

    func read(includeDisk: Bool, _ completion: @escaping @MainActor (Reading) -> Void) {
        queue.async {
            if !self.opened {
                self.opened = true
                self.reader = SMCReader()
            }
            let reading = Reading(cpu: self.reader?.cpuTemperature, gpu: self.reader?.gpuTemperature,
                                  hasGPU: !(self.reader?.gpuSensors.isEmpty ?? true),
                                  memory: MemoryStats.current(), disk: includeDisk ? DiskStats.current() : nil)
            Task { @MainActor in completion(reading) }
        }
    }
}

struct MemoryStats: Equatable, Sendable {
    /// App memory + wired + compressed: what Activity Monitor calls Memory Used.
    var used: UInt64
    var total: UInt64

    var fraction: Double { total > 0 ? min(1, Double(used) / Double(total)) : 0 }

    static func current() -> MemoryStats? {
        var stats = vm_statistics64()
        var count = mach_msg_type_number_t(MemoryLayout<vm_statistics64>.size / MemoryLayout<integer_t>.size)
        let result = withUnsafeMutablePointer(to: &stats) {
            $0.withMemoryRebound(to: integer_t.self, capacity: Int(count)) {
                host_statistics64(mach_host_self(), HOST_VM_INFO64, $0, &count)
            }
        }
        guard result == KERN_SUCCESS else { return nil }
        var pageSize: vm_size_t = 0
        host_page_size(mach_host_self(), &pageSize)
        let appPages = UInt64(stats.internal_page_count) - min(UInt64(stats.internal_page_count), UInt64(stats.purgeable_count))
        let pages = appPages + UInt64(stats.wire_count) + UInt64(stats.compressor_page_count)
        return MemoryStats(used: pages * UInt64(pageSize), total: ProcessInfo.processInfo.physicalMemory)
    }
}

struct DiskStats: Equatable, Sendable {
    /// What Finder calls Available: free space plus purgeable files macOS clears when it needs room.
    var available: Int64
    var total: Int64

    /// Total minus Available, so purgeable files count as free.
    var used: Int64 { max(0, total - available) }

    var usedFraction: Double { total > 0 ? min(1, max(0, 1 - Double(available) / Double(total))) : 0 }

    /// The startup disk's Data volume.
    static func current() -> DiskStats? {
        let url = URL(fileURLWithPath: NSHomeDirectory())
        guard let values = try? url.resourceValues(forKeys: [.volumeAvailableCapacityForImportantUsageKey,
                                                             .volumeTotalCapacityKey]),
              let available = values.volumeAvailableCapacityForImportantUsage,
              let total = values.volumeTotalCapacity, total > 0 else { return nil }
        return DiskStats(available: available, total: Int64(total))
    }
}

/// Temperatures from the System Management Controller, through the AppleSMC user client (the way
/// macmon and Stats read them). Needs no permission and no root.
///
/// Which keys measure what isn't documented. On Apple silicon `Tp…` and `Te…` sit on the
/// performance and efficiency CPU cores and `Tg…` on the GPU, all 32-bit floats; Intel Macs use
/// `TC…` and `TG…` in sp78 fixed point.
final class SMCReader {
    struct Sensor {
        let key: UInt32
        let size: UInt32
        let type: UInt32
    }

    private(set) var cpuSensors: [Sensor] = []
    private(set) var gpuSensors: [Sensor] = []
    private var connection: io_connect_t = 0

    #if arch(arm64)
    private static let cpuPrefixes: Set<String> = ["Tp", "Te"]
    private static let gpuPrefixes: Set<String> = ["Tg"]
    #else
    private static let cpuPrefixes: Set<String> = ["TC"]
    private static let gpuPrefixes: Set<String> = ["TG"]
    #endif
    /// Readings outside this range come from sensors that are off or not wired up.
    private static let plausible = 5.0...130.0
    private static let floatType = fourCC("flt ")
    private static let sp78Type = fourCC("sp78")

    init?() {
        let service = IOServiceGetMatchingService(kIOMainPortDefault, IOServiceMatching("AppleSMC"))
        guard service != 0 else { return nil }
        let opened = IOServiceOpen(service, mach_task_self_, 0, &connection)
        IOObjectRelease(service)
        guard opened == kIOReturnSuccess else {
            connection = 0
            return nil
        }
        findSensors()
        if cpuSensors.isEmpty && gpuSensors.isEmpty {
            IOServiceClose(connection)
            connection = 0
            return nil
        }
    }

    deinit {
        if connection != 0 { IOServiceClose(connection) }
    }

    var cpuTemperature: Double? { average(cpuSensors) }
    var gpuTemperature: Double? { average(gpuSensors) }

    private func average(_ sensors: [Sensor]) -> Double? {
        let values = sensors.compactMap(value).filter(Self.plausible.contains)
        return values.isEmpty ? nil : values.reduce(0, +) / Double(values.count)
    }

    /// Walks the SMC's key list once (about 2,400 keys, well under 0.1 s) and keeps the readable
    /// temperature sensors.
    private func findSensors() {
        guard let countBytes = readBytes(key: Self.fourCC("#KEY"), size: 4) else { return }
        let count = countBytes.reduce(UInt32(0)) { $0 << 8 | UInt32($1) }
        for index in 0..<count {
            guard let output = call(.keyAtIndex, index: index) else { continue }
            let key = Self.load(output, at: Field.key)
            let prefix = String(Self.string(key).prefix(2))
            let isCPU = Self.cpuPrefixes.contains(prefix)
            guard isCPU || Self.gpuPrefixes.contains(prefix),
                  let sensor = sensorInfo(key), value(sensor) != nil else { continue }
            if isCPU { cpuSensors.append(sensor) } else { gpuSensors.append(sensor) }
        }
    }

    private func sensorInfo(_ key: UInt32) -> Sensor? {
        guard let output = call(.keyInfo, key: key) else { return nil }
        let sensor = Sensor(key: key, size: Self.load(output, at: Field.dataSize),
                            type: Self.load(output, at: Field.dataType))
        switch (sensor.type, sensor.size) {
        case (Self.floatType, 4), (Self.sp78Type, 2): return sensor
        default: return nil
        }
    }

    private func value(_ sensor: Sensor) -> Double? {
        guard let bytes = readBytes(key: sensor.key, size: sensor.size) else { return nil }
        switch sensor.type {
        case Self.floatType:
            return Double(bytes.withUnsafeBytes { $0.loadUnaligned(as: Float.self) })
        case Self.sp78Type:
            return Double(Int16(bitPattern: UInt16(bytes[0]) << 8 | UInt16(bytes[1]))) / 256
        default:
            return nil
        }
    }

    private func readBytes(key: UInt32, size: UInt32) -> [UInt8]? {
        guard size <= 32, let output = call(.read, key: key, dataSize: size) else { return nil }
        return Array(output[Field.bytes..<Field.bytes + Int(size)])
    }

    // MARK: - SMC user client

    /// Byte offsets in `SMCParamStruct` (80 bytes) of the fields used here.
    private enum Field {
        static let size = 80
        static let key = 0
        static let dataSize = 28  // keyInfo.dataSize
        static let dataType = 32  // keyInfo.dataType
        static let result = 40
        static let command = 42   // data8
        static let index = 44     // data32
        static let bytes = 48
    }

    private enum Command: UInt8 {
        case read = 5
        case keyAtIndex = 8
        case keyInfo = 9
    }

    /// kSMCHandleYPCEvent, the user client's single method.
    private static let selector: UInt32 = 2

    private func call(_ command: Command, key: UInt32 = 0, dataSize: UInt32 = 0, index: UInt32 = 0) -> [UInt8]? {
        var input = [UInt8](repeating: 0, count: Field.size)
        Self.store(key, in: &input, at: Field.key)
        Self.store(dataSize, in: &input, at: Field.dataSize)
        Self.store(index, in: &input, at: Field.index)
        input[Field.command] = command.rawValue
        var output = [UInt8](repeating: 0, count: Field.size)
        var outputSize = Field.size
        let result = IOConnectCallStructMethod(connection, Self.selector, input, Field.size, &output, &outputSize)
        guard result == kIOReturnSuccess, output[Field.result] == 0 else { return nil }
        return output
    }

    private static func store(_ value: UInt32, in buffer: inout [UInt8], at offset: Int) {
        withUnsafeBytes(of: value) { bytes in
            for i in 0..<4 { buffer[offset + i] = bytes[i] }
        }
    }

    private static func load(_ buffer: [UInt8], at offset: Int) -> UInt32 {
        buffer[offset..<offset + 4].withUnsafeBytes { $0.loadUnaligned(as: UInt32.self) }
    }

    private static func fourCC(_ text: String) -> UInt32 {
        text.utf8.reduce(0) { $0 << 8 | UInt32($1) }
    }

    private static func string(_ code: UInt32) -> String {
        String(bytes: [24, 16, 8, 0].map { UInt8((code >> $0) & 0xff) }, encoding: .ascii) ?? ""
    }
}
