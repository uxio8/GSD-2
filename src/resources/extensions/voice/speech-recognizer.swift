import Foundation
import Speech
import AVFoundation

setbuf(stdout, nil)

guard SFSpeechRecognizer.authorizationStatus() == .authorized ||
      SFSpeechRecognizer.authorizationStatus() == .notDetermined else {
    print("ERROR:Speech recognition not authorized")
    exit(1)
}

SFSpeechRecognizer.requestAuthorization { status in
    guard status == .authorized else {
        print("ERROR:Speech recognition denied")
        exit(1)
    }
}

let recognizer = SFSpeechRecognizer(locale: Locale(identifier: "en-US"))!
guard recognizer.isAvailable else {
    print("ERROR:Speech recognizer not available")
    exit(1)
}

let audioEngine = AVAudioEngine()
let request = SFSpeechAudioBufferRecognitionRequest()
request.shouldReportPartialResults = true
request.requiresOnDeviceRecognition = true

let node = audioEngine.inputNode
let format = node.outputFormat(forBus: 0)

node.installTap(onBus: 0, bufferSize: 1024, format: format) { buffer, _ in
    request.append(buffer)
}

audioEngine.prepare()
do {
    try audioEngine.start()
    print("READY")
} catch {
    print("ERROR:Failed to start audio engine: \(error.localizedDescription)")
    exit(1)
}

var accumulated = ""
var lastPartialText = ""
var lastEmitted = ""

recognizer.recognitionTask(with: request) { result, error in
    if let result = result {
        let text = result.bestTranscription.formattedString

        if result.isFinal {
            let full: String
            if !accumulated.isEmpty && !text.lowercased().hasPrefix(accumulated.lowercased()) {
                full = accumulated + " " + text
            } else if !accumulated.isEmpty && text.count < accumulated.count {
                full = accumulated + " " + text
            } else {
                full = text
            }
            accumulated = ""
            lastPartialText = ""
            if full != lastEmitted {
                lastEmitted = full
                print("FINAL:\(full)")
            }
            return
        }

        let prevText = lastPartialText
        if !prevText.isEmpty && !text.isEmpty {
            let prevWords = prevText.split(separator: " ")
            let newWords = text.split(separator: " ")

            let looksLikeReset: Bool
            if newWords.count < prevWords.count / 2 {
                looksLikeReset = true
            } else if newWords.count < prevWords.count &&
                      !prevWords.isEmpty && !newWords.isEmpty &&
                      newWords[0] != prevWords[0] {
                looksLikeReset = true
            } else {
                looksLikeReset = false
            }

            if looksLikeReset {
                if accumulated.isEmpty {
                    accumulated = prevText
                } else {
                    accumulated = accumulated + " " + prevText
                }
                print("FINAL:\(accumulated)")
                lastEmitted = accumulated
            }
        }

        lastPartialText = text

        let displayText: String
        if accumulated.isEmpty {
            displayText = text
        } else {
            displayText = accumulated + " " + text
        }

        if displayText != lastEmitted {
            lastEmitted = displayText
            print("PARTIAL:\(displayText)")
        }
    }
    if let error = error {
        let nsError = error as NSError
        if nsError.code != 216 {
            print("ERROR:\(error.localizedDescription)")
        }
    }
}

signal(SIGTERM) { _ in
    exit(0)
}
signal(SIGINT) { _ in
    exit(0)
}

RunLoop.current.run()
