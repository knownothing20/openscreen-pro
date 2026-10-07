import AVFoundation
import CoreGraphics

// The colour every recording is decoded as: BT.709 primaries, transfer and matrix, studio
// range. The compositor assumes it for every file, and the Windows (#929) and Linux (#932)
// helpers write it. Left to the defaults, ScreenCaptureKit hands over the display's own colour
// space (P3 on most Macs) and VideoToolbox picks the matrix and the tags
// (getopenscreen/openscreen#943).
//
// Range has no key here: it comes from the pixel format, and the stream captures `420v`, the
// studio-range one.

/// The matrix ScreenCaptureKit converts to YCbCr with. It has to be the one the file is tagged
/// with in `videoColorProperties`, which `VideoColorTests` pins.
public let captureYCbCrMatrix: CFString = CGDisplayStream.yCbCrMatrix_ITU_R_709_2

/// `AVVideoColorPropertiesKey` for the H.264 writer input.
public let videoColorProperties: [String: String] = [
	AVVideoColorPrimariesKey: AVVideoColorPrimaries_ITU_R_709_2,
	AVVideoTransferFunctionKey: AVVideoTransferFunction_ITU_R_709_2,
	AVVideoYCbCrMatrixKey: AVVideoYCbCrMatrix_ITU_R_709_2,
]
