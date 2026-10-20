import AVFoundation
import AudioToolbox
import Foundation
import ImageIO
import UniformTypeIdentifiers

/// Inspect the delivered MP4, decode its audio, and extract timeline keyframes for visual QA.
@main struct DemoInspector {
    static func main() async throws {
        let arguments=CommandLine.arguments
        guard arguments.count>=3 else {fatalError("Usage: inspect <video.mp4> <output-directory> [motion.json]")}
        let asset=AVURLAsset(url:URL(fileURLWithPath:arguments[1]))
        let duration=try await asset.load(.duration)
        let track=try await asset.loadTracks(withMediaType:.video)[0]
        let size=try await track.load(.naturalSize)
        let rate=try await track.load(.nominalFrameRate)
        let descriptions=try await track.load(.formatDescriptions)
        let codec=CMFormatDescriptionGetMediaSubType(descriptions[0])
        let codecText=[24,16,8,0].map{String(UnicodeScalar(UInt8((codec >> $0)&0xff)))}.joined()
        let motionPath=arguments.count>3 ? arguments[3] : "demo/motion.json"
        let motion=try JSONSerialization.jsonObject(with:Data(contentsOf:URL(fileURLWithPath:motionPath))) as? [String:Any]
        let moments=motion?["moments"] as? [Double] ?? [0,26000,31000,43000]
        let output=URL(fileURLWithPath:arguments[2])
        try FileManager.default.createDirectory(at:output,withIntermediateDirectories:true)
        let generator=AVAssetImageGenerator(asset:asset)
        generator.appliesPreferredTrackTransform=true
        generator.requestedTimeToleranceBefore = .zero
        generator.requestedTimeToleranceAfter = .zero
        for millisecond in moments {
            let result=try await generator.image(at:CMTime(seconds:millisecond/1000,preferredTimescale:600))
            let path=output.appendingPathComponent("encoded-\(Int(millisecond)).png")
            guard let destination=CGImageDestinationCreateWithURL(path as CFURL,UTType.png.identifier as CFString,1,nil) else {fatalError("Cannot create image destination")}
            CGImageDestinationAddImage(destination,result.image,nil)
            guard CGImageDestinationFinalize(destination) else {fatalError("Cannot write extracted video frame")}
        }
        let audioTracks=try await asset.loadTracks(withMediaType:.audio)
        var audioMetadata:[String:Any]=["present":false]
        if let audioTrack=audioTracks.first {
            let audioDescriptions=try await audioTrack.load(.formatDescriptions)
            let audioDescription=audioDescriptions[0]
            let audioCodec=CMFormatDescriptionGetMediaSubType(audioDescription)
            let audioCodecText=[24,16,8,0].map{String(UnicodeScalar(UInt8((audioCodec >> $0)&0xff)))}.joined()
            let basic=CMAudioFormatDescriptionGetStreamBasicDescription(audioDescription)!.pointee
            let reader=try AVAssetReader(asset:asset)
            let readerOutput=AVAssetReaderTrackOutput(track:audioTrack,outputSettings:[
                AVFormatIDKey:kAudioFormatLinearPCM,
                AVLinearPCMBitDepthKey:32,
                AVLinearPCMIsFloatKey:true,
                AVLinearPCMIsNonInterleaved:false,
                AVLinearPCMIsBigEndianKey:false,
            ])
            reader.add(readerOutput)
            guard reader.startReading() else {throw reader.error ?? NSError(domain:"DemoInspector",code:1)}
            var sampleCount=0
            var peak=0.0
            var squares=0.0
            var clipped=0
            var previous=0.0
            var maxDelta=0.0
            var bins=Array(repeating:0.0,count:45)
            var binCounts=Array(repeating:0,count:45)
            while let sample=readerOutput.copyNextSampleBuffer() {
                guard let block=CMSampleBufferGetDataBuffer(sample) else {continue}
                let byteCount=CMBlockBufferGetDataLength(block)
                var samples=Array(repeating:Float(0),count:byteCount/MemoryLayout<Float>.size)
                samples.withUnsafeMutableBytes {pointer in
                    _=CMBlockBufferCopyDataBytes(block,atOffset:0,dataLength:byteCount,destination:pointer.baseAddress!)
                }
                for sample in samples {
                    let value=Double(sample)
                    peak=max(peak,abs(value));squares+=value*value
                    if abs(value)>=1 {clipped+=1}
                    maxDelta=max(maxDelta,abs(value-previous));previous=value
                    let bin=min(44,Int(Double(sampleCount)/(basic.mSampleRate*Double(basic.mChannelsPerFrame))))
                    bins[bin]+=value*value;binCounts[bin]+=1;sampleCount+=1
                }
            }
            guard reader.status == .completed else {throw reader.error ?? NSError(domain:"DemoInspector",code:2)}
            let rms=sqrt(squares/Double(max(1,sampleCount)))
            let levelBins=zip(bins,binCounts).map{20*log10(max(1e-10,sqrt($0.0/Double(max(1,$0.1)))))}
            audioMetadata=["present":true,"codec":audioCodecText,"sample_rate":basic.mSampleRate,"channels":basic.mChannelsPerFrame,"peak_dbfs":20*log10(max(peak,1e-10)),"rms_dbfs":20*log10(max(rms,1e-10)),"clipped_samples":clipped,"one_second_rms_dbfs":levelBins,"max_interleaved_sample_delta":maxDelta,"origin":"Original procedural ambient composition: Quiet Current. No external samples or recordings."]
        }
        let bytes=try FileManager.default.attributesOfItem(atPath:arguments[1])[.size] as? Int ?? 0
        let metadata:[String:Any]=["duration_seconds":CMTimeGetSeconds(duration),"width":size.width,"height":size.height,"frames_per_second":rate,"codec":codecText,"bytes":bytes,"audio":audioMetadata,"staged":true,"simulated_coding":true,"simulated_agent_responses":true,"simulated_pr_publish":true]
        let data=try JSONSerialization.data(withJSONObject:metadata,options:[.prettyPrinted,.sortedKeys])
        try data.write(to:output.appendingPathComponent("metadata.json"))
        print(String(data:data,encoding:.utf8) ?? "")
    }
}
