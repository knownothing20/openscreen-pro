import AVFoundation
import XCTest

import OpenScreenCaptureCore

/// The file has to say what its samples are: a matrix that converts with one standard and tags
/// another is the shifted-hue defect #943 exists to remove.
final class VideoColorTests: XCTestCase {
	func testCaptureMatrixIsTheOneTheFileIsTaggedWith() {
		XCTAssertEqual(captureYCbCrMatrix as String, videoColorProperties[AVVideoYCbCrMatrixKey])
	}

	func testFileIsTaggedBT709() {
		XCTAssertEqual(videoColorProperties[AVVideoColorPrimariesKey], "ITU_R_709_2")
		XCTAssertEqual(videoColorProperties[AVVideoTransferFunctionKey], "ITU_R_709_2")
		XCTAssertEqual(videoColorProperties[AVVideoYCbCrMatrixKey], "ITU_R_709_2")
	}
}
