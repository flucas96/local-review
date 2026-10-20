import AVFoundation
import Foundation
import ImageIO
import UniformTypeIdentifiers

/// Inspect the encoded deliverable and extract frames from the actual MP4 for visual QA.
@main struct DemoInspector {
    static func main() async throws {
        let arguments = CommandLine.arguments
        guard arguments.count == 3 else { fatalError("Usage: inspect <video.mp4> <output-directory>") }
        let asset = AVURLAsset(url: URL(fileURLWithPath: arguments[1]))
        let duration = try await asset.load(.duration)
        let track = try await asset.loadTracks(withMediaType: .video)[0]
        let size = try await track.load(.naturalSize)
        let rate = try await track.load(.nominalFrameRate)
        let descriptions = try await track.load(.formatDescriptions)
        let codec = CMFormatDescriptionGetMediaSubType(descriptions[0])
        let codecText = [24,16,8,0].map { String(UnicodeScalar(UInt8((codec >> $0) & 0xff))) }.joined()
        let generator = AVAssetImageGenerator(asset: asset)
        generator.appliesPreferredTrackTransform = true
        generator.requestedTimeToleranceBefore = .zero
        generator.requestedTimeToleranceAfter = .zero
        let moments: [Double] = [0,1.8,3.2,3.8,4.8,5.16,7,9.401,10.8,12.1,14.2,15,16.2,17.8,20,21.8,24.2,25.55,27.3,28,29.5]
        let output = URL(fileURLWithPath: arguments[2])
        try FileManager.default.createDirectory(at: output, withIntermediateDirectories: true)
        for second in moments {
            let result = try await generator.image(at: CMTime(seconds: second, preferredTimescale: 600))
            let path = output.appendingPathComponent("encoded-\(Int((second*1000).rounded())).png")
            guard let destination = CGImageDestinationCreateWithURL(path as CFURL, UTType.png.identifier as CFString, 1, nil) else { fatalError("Cannot create image destination") }
            CGImageDestinationAddImage(destination, result.image, nil)
            guard CGImageDestinationFinalize(destination) else { fatalError("Cannot write extracted video frame") }
        }
        let bytes = try FileManager.default.attributesOfItem(atPath: arguments[1])[.size] as? Int ?? 0
        let metadata: [String: Any] = ["duration_seconds":CMTimeGetSeconds(duration),"width":size.width,"height":size.height,"frames_per_second":rate,"codec":codecText,"bytes":bytes,"audio":false,"staged":true,"simulated_agent_responses":true]
        let data = try JSONSerialization.data(withJSONObject: metadata, options: [.prettyPrinted,.sortedKeys])
        try data.write(to: output.appendingPathComponent("metadata.json"))
        print(String(data: data, encoding: .utf8) ?? "")
    }
}
