import AVFoundation
import Foundation

/// Encode the original ambient composition as AAC and mux it with the unchanged H.264 master.
@main struct DemoAudioMixer {
    static func main() async throws {
        let arguments=CommandLine.arguments
        guard arguments.count==4 else { fatalError("Usage: mix-audio <silent-master.mp4> <ambient.wav> <final.mp4>") }
        let videoURL=URL(fileURLWithPath:arguments[1])
        let audioURL=URL(fileURLWithPath:arguments[2])
        let outputURL=URL(fileURLWithPath:arguments[3])
        let encodedAudioURL=audioURL.deletingPathExtension().appendingPathExtension("m4a")
        for url in [encodedAudioURL,outputURL] {
            if FileManager.default.fileExists(atPath:url.path) {try FileManager.default.removeItem(at:url)}
        }
        let sourceAudio=AVURLAsset(url:audioURL)
        guard let audioExport=AVAssetExportSession(asset:sourceAudio,presetName:AVAssetExportPresetAppleM4A) else {fatalError("AAC exporter unavailable")}
        audioExport.shouldOptimizeForNetworkUse=true
        try await audioExport.export(to:encodedAudioURL,as:.m4a)
        let video=AVURLAsset(url:videoURL)
        let audio=AVURLAsset(url:encodedAudioURL)
        let videoTracks=try await video.loadTracks(withMediaType:.video)
        let audioTracks=try await audio.loadTracks(withMediaType:.audio)
        let duration=try await video.load(.duration)
        let composition=AVMutableComposition()
        guard let videoTrack=composition.addMutableTrack(withMediaType:.video,preferredTrackID:kCMPersistentTrackID_Invalid),
              let audioTrack=composition.addMutableTrack(withMediaType:.audio,preferredTrackID:kCMPersistentTrackID_Invalid) else {fatalError("Composition tracks unavailable")}
        let range=CMTimeRange(start:.zero,duration:duration)
        try videoTrack.insertTimeRange(range,of:videoTracks[0],at:.zero)
        try audioTrack.insertTimeRange(range,of:audioTracks[0],at:.zero)
        guard let export=AVAssetExportSession(asset:composition,presetName:AVAssetExportPresetPassthrough) else {fatalError("MP4 muxer unavailable")}
        export.shouldOptimizeForNetworkUse=true
        try await export.export(to:outputURL,as:.mp4)
        let final=AVURLAsset(url:outputURL)
        let finalAudio=try await final.loadTracks(withMediaType:.audio)
        print("Exported H.264 master with AAC ambient bed: \(outputURL.path) · \(CMTimeGetSeconds(duration))s · \(finalAudio.count) audio track")
    }
}
