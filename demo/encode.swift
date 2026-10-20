import AVFoundation
import CoreGraphics
import CoreVideo
import Foundation
import ImageIO

/// Encode a deterministic PNG frame sequence as a broadly playable H.264 MP4.
@main struct DemoEncoder {
    static func main() async throws {
        let arguments = CommandLine.arguments
        guard arguments.count >= 3 else {
            throw NSError(domain: "DemoEncoder", code: 1, userInfo: [NSLocalizedDescriptionKey: "Usage: encode <frame-directory> <output.mp4> [frame-count]"])
        }
        let framesURL = URL(fileURLWithPath: arguments[1])
        let outputURL = URL(fileURLWithPath: arguments[2])
        let frameCount = arguments.count > 3 ? Int(arguments[3]) ?? 1350 : 1350
        let width = 1920
        let height = 1080
        let fps: Int32 = 30
        if FileManager.default.fileExists(atPath: outputURL.path) {
            try FileManager.default.removeItem(at: outputURL)
        }
        let writer = try AVAssetWriter(outputURL: outputURL, fileType: .mp4)
        writer.shouldOptimizeForNetworkUse = true
        let input = AVAssetWriterInput(mediaType: .video, outputSettings: [
            AVVideoCodecKey: AVVideoCodecType.h264,
            AVVideoWidthKey: width,
            AVVideoHeightKey: height,
            AVVideoCompressionPropertiesKey: [
                AVVideoAverageBitRateKey: 6_000_000,
                AVVideoProfileLevelKey: AVVideoProfileLevelH264HighAutoLevel,
                AVVideoMaxKeyFrameIntervalKey: 60,
            ],
        ])
        input.expectsMediaDataInRealTime = false
        input.mediaTimeScale = fps
        let adaptor = AVAssetWriterInputPixelBufferAdaptor(assetWriterInput: input, sourcePixelBufferAttributes: [
            kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32ARGB,
            kCVPixelBufferWidthKey as String: width,
            kCVPixelBufferHeightKey as String: height,
            kCVPixelBufferCGImageCompatibilityKey as String: true,
            kCVPixelBufferCGBitmapContextCompatibilityKey as String: true,
        ])
        writer.add(input)
        guard writer.startWriting() else { throw writer.error ?? NSError(domain: "DemoEncoder", code: 2) }
        writer.startSession(atSourceTime: .zero)
        for index in 0..<frameCount {
            while !input.isReadyForMoreMediaData {
                try await Task.sleep(nanoseconds: 1_000_000)
            }
            try autoreleasepool {
                let url = framesURL.appendingPathComponent(String(format: "frame-%04d.png", index))
                guard let source = CGImageSourceCreateWithURL(url as CFURL, nil),
                      let image = CGImageSourceCreateImageAtIndex(source, 0, nil),
                      let pool = adaptor.pixelBufferPool else {
                    throw NSError(domain: "DemoEncoder", code: 3, userInfo: [NSLocalizedDescriptionKey: "Missing frame or pixel pool: \(url.path)"])
                }
                var optionalBuffer: CVPixelBuffer?
                CVPixelBufferPoolCreatePixelBuffer(nil, pool, &optionalBuffer)
                guard let buffer = optionalBuffer else { throw NSError(domain: "DemoEncoder", code: 4) }
                CVPixelBufferLockBaseAddress(buffer, [])
                defer { CVPixelBufferUnlockBaseAddress(buffer, []) }
                guard let context = CGContext(data: CVPixelBufferGetBaseAddress(buffer), width: width, height: height,
                                              bitsPerComponent: 8, bytesPerRow: CVPixelBufferGetBytesPerRow(buffer),
                                              space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.noneSkipFirst.rawValue) else {
                    throw NSError(domain: "DemoEncoder", code: 5)
                }
                context.draw(image, in: CGRect(x: 0, y: 0, width: width, height: height))
                let timestamp = CMTime(value: Int64(index), timescale: fps)
                guard adaptor.append(buffer, withPresentationTime: timestamp) else {
                    throw writer.error ?? NSError(domain: "DemoEncoder", code: 6)
                }
            }
            if index.isMultiple(of: 150) { print("Encoded \(index) / \(frameCount)") }
        }
        writer.endSession(atSourceTime: CMTime(value: Int64(frameCount), timescale: fps))
        input.markAsFinished()
        await writer.finishWriting()
        guard writer.status == .completed else { throw writer.error ?? NSError(domain: "DemoEncoder", code: 7) }
        let asset = AVURLAsset(url: outputURL)
        let duration = try await asset.load(.duration)
        let tracks = try await asset.loadTracks(withMediaType: .video)
        let track = tracks[0]
        let size = try await track.load(.naturalSize)
        let rate = try await track.load(.nominalFrameRate)
        let attributes = try FileManager.default.attributesOfItem(atPath: outputURL.path)
        print("Finished: \(outputURL.path) · \(CMTimeGetSeconds(duration))s · \(Int(size.width))×\(Int(size.height)) · \(rate)fps · \(attributes[.size] ?? 0) bytes")
    }
}
